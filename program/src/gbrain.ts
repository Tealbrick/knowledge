import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { managedBrainToken } from "./gbrain-managed-auth.js";
import { nativeMemoryToken } from "./brain-native-auth.js";
import { nativeMemoryOperation } from "./brain-native-policy.js";
import { readModelSettings, modelSettingsEnvironment } from "./model-settings.js";
import { callGBrainTool } from "./gbrain-transport.js";
import { probeGBrainHealth } from "./gbrain-health.js";

import type { KnowledgeDocument, ResearchSource, KnowledgeConfig } from "./types.js";
import { knowledgePartitionSourceId, normalizeKnowledgePartitionKey } from "./partition-authority.js";
import {
  DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
  installDoppelgangerGBrainSchemaPack,
  type DoppelgangerGBrainSchemaInstallResult,
} from "./gbrain-schema.js";

type GBrainState = "disabled" | "starting" | "online" | "degraded";

/**
 * Native read surfaces used by the Brain UI/API. These names intentionally
 * mirror the GBrain operation catalog so the adapter cannot quietly fall back
 * to fact-shaped approximations when a surface is unavailable.
 */
export const GBRAIN_NATIVE_BRAIN_CAPABILITIES = {
  pageEnumeration: "list_pages",
  entityCard: "entity",
  timeline: "get_timeline",
  typedRelationships: "get_links + traverse_graph",
} as const;

export type GBrainNativeCapability = keyof typeof GBRAIN_NATIVE_BRAIN_CAPABILITIES;

export type GBrainNativeCapabilityStatus = "ready" | "unknown" | "unavailable";

type GBrainSchemaPackState =
  | {
      readonly name: typeof DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME;
      readonly status: "not-managed";
      readonly detail: string;
    }
  | {
      readonly name: typeof DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME;
      readonly status: "installed";
      readonly path: string;
      readonly active: boolean;
      readonly installedDuringBootstrap: boolean;
    }
  | {
      readonly name: typeof DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME;
      readonly status: "degraded";
      readonly detail: string;
    };

interface ToolCallResult {
  readonly ok: boolean;
  readonly status: "ready" | "degraded";
  readonly tool: string;
  readonly data: unknown;
  readonly error?: string;
  readonly retrieval?: Record<string, unknown>;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/u, "");
}

function frontmatterString(value: string | null | undefined): string {
  return JSON.stringify(value ?? "");
}

function documentToMarkdown(document: KnowledgeDocument): string {
  return `---
type: knowledge_document
knowledge_document_id: ${frontmatterString(document.id)}
company_id: ${frontmatterString(document.companyId)}
collection_id: ${frontmatterString(document.collectionId)}
status: ${frontmatterString(document.status)}
title: ${frontmatterString(document.title)}
updated_at: ${frontmatterString(document.updatedAt)}
---

# ${document.title}

${document.summary ? `${document.summary}\n\n` : ""}${document.body}`;
}

function researchSourceToMarkdown(source: ResearchSource): string {
  return `---
type: research_source
research_source_id: ${frontmatterString(source.id)}
company_id: ${frontmatterString(source.companyId)}
notebook_id: ${frontmatterString(source.notebookId)}
source_type: ${frontmatterString(source.sourceType)}
title: ${frontmatterString(source.title)}
url: ${frontmatterString(source.url)}
updated_at: ${frontmatterString(source.updatedAt)}
---

# ${source.title}

${source.summary ? `${source.summary}\n\n` : ""}${source.content}`;
}

function partitionSourceArgs(partitionKey: string | undefined): Record<string, unknown> {
  return partitionKey ? { source_id: knowledgePartitionSourceId(partitionKey) } : {};
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a TCP port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function tokenFilePath(gbrainHome: string) {
  return path.join(gbrainHome, ".doppelganger-token");
}

function gbrainRuntimeFilePath(gbrainHome: string) {
  return path.join(gbrainHome, ".doppelganger-gbrain-runtime.json");
}

async function isHealthyGBrainBaseUrl(baseUrl: string, timeoutMs = 1_500): Promise<boolean> {
  return (await probeGBrainHealth({ baseUrl, timeoutMs })).status === "healthy";
}

async function discoverGBrainRuntime(gbrainHome: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(gbrainRuntimeFilePath(gbrainHome), "utf8")) as {
      readonly baseUrl?: unknown;
    };
    const baseUrl =
      typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
        ? trimTrailingSlash(parsed.baseUrl.trim())
        : null;
    if (baseUrl && (await isHealthyGBrainBaseUrl(baseUrl))) {
      return baseUrl;
    }
  } catch {
    // Missing or stale runtime files are ignored; startup can launch a new sidecar.
  }
  return null;
}

async function writeGBrainRuntimeFile(input: {
  readonly baseUrl: string;
  readonly gbrainHome: string;
  readonly pid?: number;
}) {
  const filePath = gbrainRuntimeFilePath(input.gbrainHome);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    tempPath,
    `${JSON.stringify(
      {
        baseUrl: trimTrailingSlash(input.baseUrl),
        pid: input.pid ?? null,
        runtime: "gbrain",
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.rename(tempPath, filePath);
}

async function removeGBrainRuntimeFile(gbrainHome: string, pid?: number) {
  const filePath = gbrainRuntimeFilePath(gbrainHome);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      readonly pid?: unknown;
    };
    if (typeof pid === "number" && typeof parsed.pid === "number" && parsed.pid !== pid) {
      return;
    }
    await fs.rm(filePath, { force: true });
  } catch {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
}

async function runBunCommand(
  repoPath: string,
  gbrainHome: string,
  args: readonly string[],
  modelEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const configuredBun = process.env.BUN_INSTALL
      ? path.join(process.env.BUN_INSTALL, "bin", "bun")
      : null;
    const bunCommand = configuredBun && existsSync(configuredBun) ? configuredBun : "bun";
    const child = spawn(bunCommand, args, {
      cwd: repoPath,
      env: {
        ...process.env,
        ...modelEnv,
        GBRAIN_HOME: gbrainHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${bunCommand} ${args.join(" ")} exited ${code ?? "unknown"}: ${stderr || stdout}`));
    });
  });
}

async function ensureGBrainInitialized(repoPath: string, gbrainHome: string, modelEnv: NodeJS.ProcessEnv = {}) {
  const configPath = path.join(gbrainHome, ".gbrain", "config.json");
  if (existsSync(configPath)) {
    return;
  }
  await fs.mkdir(gbrainHome, { recursive: true });
  const env = { ...process.env, ...modelEnv };
  const model = env.GBRAIN_EMBEDDING_MODEL;
  const dimensions = env.GBRAIN_EMBEDDING_DIMENSIONS;
  const embeddingArgs = model
    ? ["--embedding-model", model, ...(dimensions ? ["--embedding-dimensions", dimensions] : [])]
    : env.OPENAI_API_KEY ? ["--embedding-model", "openai:text-embedding-3-small", "--embedding-dimensions", "1536"] : ["--no-embedding"];
  await runBunCommand(repoPath, gbrainHome, ["run", "src/cli.ts", "init", "--pglite", ...embeddingArgs], modelEnv);
}

async function ensureGBrainDependencies(repoPath: string, gbrainHome: string) {
  if (existsSync(path.join(repoPath, "node_modules", "@electric-sql", "pglite"))) {
    return;
  }
  // Install the reviewed lockfile without running upstream postinstall, which
  // can migrate a brain. Schema/bootstrap remains an explicit app-owned step.
  await runBunCommand(repoPath, gbrainHome, ["install", "--frozen-lockfile", "--ignore-scripts"]);
}

async function ensureGBrainToken(repoPath: string, gbrainHome: string, configuredToken: string | null) {
  if (configuredToken) {
    return configuredToken;
  }
  const filePath = tokenFilePath(gbrainHome);
  try {
    const existing = (await fs.readFile(filePath, "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Create a token below.
  }
  const create = async () =>
    runBunCommand(repoPath, gbrainHome, [
      "run",
      "src/cli.ts",
      "auth",
      "create",
      "doppelganger-knowledge",
      "--takes-holders",
      "world",
    ]);
  let output: Awaited<ReturnType<typeof create>>;
  try {
    output = await create();
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) {
      throw new Error("GBrain identity already exists but its local token is missing. Restore the token file or configure GBRAIN_TOKEN; credentials will not be revoked automatically.");
    } else {
      throw error;
    }
  }
  const token = output.stdout.match(/gbrain_[a-f0-9]+/u)?.[0];
  if (!token) {
    throw new Error("GBrain token creation did not return a token");
  }
  await fs.writeFile(filePath, `${token}\n`, { mode: 0o600 });
  return token;
}

export class GBrainRuntime {
  private state: GBrainState = "disabled";
  private baseUrl: string | null = null;
  private token: string | null = null;
  private observedVersion: string | null = null;
  private child: ChildProcess | null = null;
  private detail: string | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private closing = false;
  private readonly partitionTokens: ReadonlyMap<string, string>;
  private managedSecret: string | null = null;
  private modelEnv: NodeJS.ProcessEnv = {};
  private schemaPack: GBrainSchemaPackState = {
    name: DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
    status: "not-managed",
    detail: "GBrain runtime has not started",
  };

  constructor(private readonly config: KnowledgeConfig) {
    const entries: Array<readonly [string, string]> = [];
    for (const { partitionKey, token } of config.gbrainPartitionTokens) {
      const normalizedPartitionKey = normalizeKnowledgePartitionKey(partitionKey);
      if (normalizedPartitionKey) {
        entries.push([normalizedPartitionKey, token]);
      }
    }
    this.partitionTokens = new Map(entries);
  }

  async start(): Promise<void> {
    this.closing = false;
    this.observedVersion = null;
    if (this.config.gbrainBaseUrl) {
      this.baseUrl = trimTrailingSlash(this.config.gbrainBaseUrl);
      this.token = this.config.gbrainToken;
      const health = await probeGBrainHealth({ baseUrl: this.baseUrl });
      if (health.status === "unavailable" && health.reason === "invalid_url") this.baseUrl = null;
      this.observedVersion = health.status === "healthy" ? health.version : null;
      this.state = this.token && health.status === "healthy" ? "online" : "degraded";
      this.detail = !this.token
        ? "GBRAIN_TOKEN is required for MCP calls"
        : health.status === "unavailable" ? `GBrain health unavailable: ${health.reason}` : null;
      this.schemaPack = {
        name: DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
        status: "not-managed",
        detail: "Configured external GBrain endpoint manages its own schema pack",
      };
      return;
    }
    if (!this.config.gbrainAutoStart) {
      this.state = "disabled";
      this.detail = "GBrain autostart disabled";
      this.schemaPack = {
        name: DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
        status: "not-managed",
        detail: "GBrain autostart disabled",
      };
      return;
    }
    const repoPath = this.config.gbrainRepoPath;
    if (!repoPath || !existsSync(path.join(repoPath, "src", "cli.ts"))) {
      this.state = "degraded";
      this.detail = `GBrain sidecar source not found at ${repoPath ?? "<unset>"}`;
      return;
    }
    this.state = "starting";
    try {
      await ensureGBrainDependencies(repoPath, this.config.gbrainHome);
      this.modelEnv = modelSettingsEnvironment(await readModelSettings(this.config.dataDir));
      const env = { ...process.env, ...this.modelEnv };
      if (!existsSync(path.join(this.config.gbrainHome, ".gbrain/config.json")) && !env.GBRAIN_EMBEDDING_MODEL && !env.OPENAI_API_KEY) {
        this.state = "disabled";
        this.detail = "setup_required: open Settings → Models and add your model keys";
        return;
      }
      await ensureGBrainInitialized(repoPath, this.config.gbrainHome, this.modelEnv);
      this.schemaPack = schemaPackStateFromInstall(
        await installDoppelgangerGBrainSchemaPack(this.config.gbrainHome),
      );
      // Separate from legacy GBrain identities: never revoke or reuse one.
      const secretPath = path.join(this.config.gbrainHome, ".knowledge-managed-secret");
      try { await fs.writeFile(secretPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      this.managedSecret = (await fs.readFile(secretPath, "utf8")).trim();
      if (this.managedSecret.length < 32) throw new Error("Managed Brain credential is invalid; restore its secret file");
      this.token = this.managedSecret;
      await this.spawnManagedSidecar(repoPath);
    } catch (error) {
      this.state = "degraded";
      this.detail = error instanceof Error ? error.message : String(error);
      this.schemaPack = {
        name: DOPPELGANGER_GBRAIN_SCHEMA_PACK_NAME,
        status: "degraded",
        detail: this.detail,
      };
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.state = "disabled";
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.child = null;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
    await removeGBrainRuntimeFile(this.config.gbrainHome, child.pid);
  }

  status() {
    return {
      status: this.state === "online" ? "online" : this.state,
      runtime: "gbrain",
      observedVersion: this.observedVersion,
      baseUrl: this.baseUrl,
      home: this.config.gbrainHome,
      repoPath: this.config.gbrainRepoPath,
      schemaPack: this.schemaPack,
      tokenConfigured: Boolean(this.token),
      factsVisibility: this.managedSecret ? "partition_private" as const : "world_only" as const,
      detail: this.detail,
    };
  }

  /**
   * Transport readiness is distinct from an operation result. An online
   * sidecar proves only that the MCP transport answered; it does not prove
   * that every native operation is enabled by this token/schema. Callers
   * replace `unknown` with the observed result of each operation they invoke.
   */
  nativeCapabilityReadiness() {
    const ready = this.state === "online";
    const capabilityGaps = ready
      ? []
      : [
          {
            code: "gbrain_unavailable",
            detail: this.detail ?? "GBrain runtime is not online",
          },
        ];
    return {
      status: ready ? ("ready" as const) : ("degraded" as const),
      capabilities: Object.fromEntries(
        Object.entries(GBRAIN_NATIVE_BRAIN_CAPABILITIES).map(([name, operation]) => [
          name,
          { operation, status: ready ? "unknown" : "unavailable" },
        ]),
      ) as Record<GBrainNativeCapability, { operation: string; status: GBrainNativeCapabilityStatus }>,
      capabilityGaps,
    };
  }

  async projectDocument(document: KnowledgeDocument): Promise<ToolCallResult> {
    return this.callTool("put_page", {
      ...partitionSourceArgs(document.companyId),
      slug: `knowledge-docs/${document.id}`,
      content: documentToMarkdown(document),
      source_kind: "put_page",
      source_uri: `knowledge-document:${document.id}`,
      ingested_via: "knowledge-program",
    }, document.companyId);
  }

  async projectResearchSource(source: ResearchSource): Promise<ToolCallResult> {
    return this.callTool("put_page", {
      ...partitionSourceArgs(source.companyId),
      slug: `knowledge-research/sources/${source.id}`,
      content: researchSourceToMarkdown(source),
      source_kind: "put_page",
      source_uri: `research-source:${source.id}`,
      ingested_via: "knowledge-program",
    }, source.companyId);
  }

  async extractFacts(input: {
    readonly text: string;
    readonly sessionId?: string | null;
    readonly entityHints?: readonly string[];
    readonly partitionKey?: string;
    readonly sourceSlug?: string;
    readonly validFrom?: string;
  }): Promise<ToolCallResult> {
    return this.callTool("extract_facts", {
      ...partitionSourceArgs(input.partitionKey),
      turn_text: input.text,
      session_id: input.sessionId ?? undefined,
      entity_hints: input.entityHints ? [...input.entityHints] : undefined,
      visibility: "private",
      ...(input.sourceSlug ? { source_slug: input.sourceSlug } : {}),
      ...(input.validFrom ? { valid_from: input.validFrom } : {}),
    }, input.partitionKey);
  }

  async deleteProjection(id: string, partitionKey: string, kind: "document" | "research") {
    const slug = kind === "document" ? `knowledge-docs/${id}` : `knowledge-research/sources/${id}`;
    return this.callTool(this.managedSecret ? "knowledge_delete_projection" : "delete_page", {
      slug,
      ...(this.managedSecret ? { session_id: `${kind}:${id}` } : partitionSourceArgs(partitionKey)),
    }, partitionKey);
  }

  async query(input: { readonly query: string; readonly limit?: number; readonly partitionKey?: string; readonly expand?: boolean; readonly detail?: "low" | "medium" | "high" }): Promise<ToolCallResult> {
    return this.callTool("query", {
      ...partitionSourceArgs(input.partitionKey),
      query: input.query,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.expand === undefined ? {} : { expand: input.expand }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    }, input.partitionKey);
  }

  /** Full native memory protocol, separately attested per principal and operation. */
  async nativeOperation(operation: string, args: Record<string, unknown>, partitionKey: string, principalId: string): Promise<Record<string, any>> {
    const partition = normalizeKnowledgePartitionKey(partitionKey);
    if (!partition || !principalId || !(operation === "catalog" || nativeMemoryOperation(operation))) return {ok:false,error:{error:"scope_denied",suggestion:"Use an authorized partition and advertised operation."}};
    if (!this.managedSecret || !this.baseUrl || this.state !== "online") return {ok:false,error:{error:"unavailable",suggestion:"Start the bundled managed Knowledge memory engine. External GBrain native-contract attestation is not configured."}};
    const token = nativeMemoryToken(this.managedSecret,knowledgePartitionSourceId(partition),principalId,operation);
    // Transport failures are intentionally thrown: mutating receipts must remain uncertain.
    const result = await callGBrainTool({baseUrl:this.baseUrl,token,name:"knowledge_native",args,timeoutMs:600_000});
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof (result as any).ok !== "boolean") throw new Error("Invalid native memory result");
    return result as Record<string, any>;
  }

  async recall(input: {
    readonly query?: string;
    readonly entity?: string;
    readonly limit?: number;
    readonly partitionKey?: string;
    readonly grep?: string;
    readonly sessionId?: string;
    readonly includeExpired?: boolean;
    readonly budgetTokens?: number;
    readonly since?: string;
    readonly supersessions?: boolean;
    readonly includePending?: boolean;
  }): Promise<ToolCallResult> {
    return this.callTool("recall", {
      ...partitionSourceArgs(input.partitionKey),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.includePending === undefined ? {} : { include_pending: input.includePending }),
      ...(input.entity ? { entity: input.entity } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.grep ? { grep: input.grep } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.includeExpired === undefined ? {} : { include_expired: input.includeExpired }),
      ...(input.budgetTokens === undefined ? {} : { budget_tokens: input.budgetTokens }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.supersessions === undefined ? {} : { supersessions: input.supersessions }),
    }, input.partitionKey);
  }

  async listPages(input: {
    readonly limit?: number;
    readonly offset?: number;
    readonly type?: string;
    readonly partitionKey?: string;
  } = {}): Promise<ToolCallResult> {
    return this.callTool("list_pages", {
      ...partitionSourceArgs(input.partitionKey),
      limit: input.limit ?? 100,
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.type ? { type: input.type } : {}),
      sort: "updated_desc",
    }, input.partitionKey);
  }

  /** Compatibility name retained for the existing route; the wire operation is native list_pages. */
  async listEntities(input: { readonly limit?: number; readonly offset?: number; readonly type?: string; readonly partitionKey?: string } = {}): Promise<ToolCallResult> {
    return this.listPages(input);
  }

  async getEntityCard(input: { readonly name: string; readonly partitionKey?: string }): Promise<ToolCallResult> {
    return this.callTool("entity", { ...partitionSourceArgs(input.partitionKey), name: input.name }, input.partitionKey);
  }

  async getTimeline(input: {
    readonly slug: string;
    readonly after?: string;
    readonly before?: string;
    readonly limit?: number;
    readonly partitionKey?: string;
  }): Promise<ToolCallResult> {
    return this.callTool("get_timeline", {
      ...partitionSourceArgs(input.partitionKey),
      slug: input.slug,
      ...(input.after ? { after: input.after } : {}),
      ...(input.before ? { before: input.before } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }, input.partitionKey);
  }

  async findTrajectory(input: {
    readonly entitySlug: string;
    readonly metric?: string;
    readonly kind?: "metric" | "event" | "all";
    readonly since?: string;
    readonly until?: string;
    readonly limit?: number;
    readonly partitionKey?: string;
  }): Promise<ToolCallResult> {
    return this.callTool("find_trajectory", {
      ...partitionSourceArgs(input.partitionKey),
      entity_slug: input.entitySlug,
      ...(input.metric ? { metric: input.metric } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.since ? { since: input.since } : {}),
      ...(input.until ? { until: input.until } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }, input.partitionKey);
  }

  async getPage(input: { readonly slug: string; readonly fuzzy?: boolean; readonly partitionKey?: string }): Promise<ToolCallResult> {
    return this.callTool("get_page", {
      ...partitionSourceArgs(input.partitionKey),
      slug: input.slug,
      fuzzy: input.fuzzy ?? true,
    }, input.partitionKey);
  }

  async getLinks(input: { readonly slug: string; readonly partitionKey?: string }): Promise<ToolCallResult> {
    return this.callTool("get_links", {
      ...partitionSourceArgs(input.partitionKey),
      slug: input.slug,
    }, input.partitionKey);
  }

  async traverseGraph(input: {
    readonly slug: string;
    readonly depth?: number;
    readonly linkType?: string | null;
    readonly direction?: "in" | "out" | "both" | null;
    readonly partitionKey?: string;
  }): Promise<ToolCallResult> {
    return this.callTool("traverse_graph", {
      ...partitionSourceArgs(input.partitionKey),
      slug: input.slug,
      depth: input.depth ?? 2,
      link_type: input.linkType ?? undefined,
      // Explicit direction selects GraphPath[] on both the old and new sidecars.
      direction: input.direction ?? "both",
    }, input.partitionKey);
  }

  private async spawnManagedSidecar(repoPath: string): Promise<void> {
    const port = await reservePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    const configuredBun = process.env.BUN_INSTALL
      ? path.join(process.env.BUN_INSTALL, "bin", "bun")
      : null;
    const bunCommand = configuredBun && existsSync(configuredBun) ? configuredBun : "bun";
    const child = spawn(
      bunCommand,
      [
        "run",
        fileURLToPath(new URL("./gbrain-managed-worker.mjs", import.meta.url)),
      ],
      {
        cwd: repoPath,
        env: {
          ...process.env,
          ...this.modelEnv,
          GBRAIN_HOME: this.config.gbrainHome,
          KNOWLEDGE_GBRAIN_REPO_PATH: repoPath,
          KNOWLEDGE_MANAGED_BRAIN_SECRET: this.managedSecret ?? "",
          KNOWLEDGE_MANAGED_BRAIN_PORT: String(port),
          GBRAIN_ADMIN_BOOTSTRAP_TOKEN:
            process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN ?? randomBytes(32).toString("hex"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout?.on("data", (chunk) => {
      // Drain the pipe. Only bounded app-owned operation metadata is logged.
      for (const line of String(chunk).split("\n")) {
        try { const value = JSON.parse(line); if (["knowledge.brain.operation", "knowledge.brain.native"].includes(value.event)) console.info(JSON.stringify({ event: value.event, operation: value.operation, ok: value.ok, code: value.code, reason: value.reason, durationMs: value.durationMs })); } catch { /* discard upstream console output */ }
      }
    });
    child.stderr?.on("data", () => { /* Drain: raw upstream diagnostics may contain private content. Retrieval degradation travels through structured metadata. */ });
    child.on("exit", (code, signal) => {
      this.handleManagedSidecarExit(child, code, signal, repoPath);
    });
    let exitBeforeHealthyListener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | null = null;
    const exitBeforeHealthy = new Promise<never>((_, reject) => {
      exitBeforeHealthyListener = (code, signal) => {
        reject(new Error(`GBrain sidecar exited before healthy (${signal ?? code ?? "unknown"})`));
      };
      child.once("exit", exitBeforeHealthyListener);
    });
    try {
      await Promise.race([this.waitForHealth(this.baseUrl), exitBeforeHealthy]);
    } catch (error) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      throw error;
    } finally {
      if (exitBeforeHealthyListener) {
        child.off("exit", exitBeforeHealthyListener);
      }
    }
    await writeGBrainRuntimeFile({
      baseUrl: this.baseUrl,
      gbrainHome: this.config.gbrainHome,
      pid: child.pid,
    });
    this.restartAttempt = 0;
    this.state = "online";
    this.detail = null;
  }

  private handleManagedSidecarExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    repoPath: string,
  ) {
    void removeGBrainRuntimeFile(this.config.gbrainHome, child.pid);
    if (this.child === child) {
      this.child = null;
    }
    if (this.closing) {
      return;
    }
    if (this.state === "online" || this.state === "starting") {
      this.state = "degraded";
      this.detail = `GBrain sidecar exited (${signal ?? code ?? "unknown"})`;
    }
    this.scheduleRestart(repoPath);
  }

  private scheduleRestart(repoPath: string) {
    if (this.restartTimer || this.closing || !this.config.gbrainAutoStart) {
      return;
    }
    const delayMs = Math.min(30_000, 1_000 * 2 ** this.restartAttempt);
    this.restartAttempt += 1;
    this.detail = `${this.detail ?? "GBrain sidecar exited"}; restart scheduled in ${delayMs}ms`;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.closing) {
        return;
      }
      this.state = "starting";
      void this.spawnManagedSidecar(repoPath).catch((error: unknown) => {
        this.state = "degraded";
        this.detail = error instanceof Error ? error.message : String(error);
        this.scheduleRestart(repoPath);
      });
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private async waitForHealth(baseUrl: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const health = await probeGBrainHealth({ baseUrl });
      if (health.status === "healthy") {
        this.observedVersion = health.version;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("Timed out waiting for GBrain health");
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    partitionKey?: string,
  ): Promise<ToolCallResult> {
    const normalizedPartitionKey = partitionKey
      ? normalizeKnowledgePartitionKey(partitionKey)
      : null;
    const token = normalizedPartitionKey && this.managedSecret
      ? managedBrainToken(this.managedSecret, knowledgePartitionSourceId(normalizedPartitionKey))
      : partitionKey ? (normalizedPartitionKey ? this.partitionTokens.get(normalizedPartitionKey) : undefined)
      : this.managedSecret ? null : this.token;
    if (!token && (partitionKey || this.managedSecret)) {
      return { ok: false, status: "degraded", tool: name, data: null,
        error: "brain_partition_binding_required: select an authorized Knowledge partition; external engines require a source-scoped credential" };
    }
    if (this.state !== "online" || !this.baseUrl || !token) {
      return {
        ok: false,
        status: "degraded",
        tool: name,
        data: null,
        error: this.detail ?? "GBrain runtime is not online",
      };
    }
    try {
      let retrieval: Record<string, unknown> | undefined;
      const data = await callGBrainTool({
        baseUrl: this.baseUrl,
        token,
        name,
        args,
        // Native recall(query) also runs hybrid retrieval, not just a DB read.
        timeoutMs: name === "extract_facts" ? 1_800_000 : name === "query" || (name === "recall" && typeof args.query === "string") ? 600_000 : 120_000,
        onMeta: meta => { if (meta.retrieval && typeof meta.retrieval === "object" && !Array.isArray(meta.retrieval)) retrieval = meta.retrieval as Record<string, unknown>; },
      });
      return {
        ok: true,
        status: (Array.isArray(retrieval?.degraded) && retrieval.degraded.length > 0)
          || (data !== null && typeof data === "object" && Boolean((data as Record<string, unknown>).search_degraded))
          ? "degraded" : "ready",
        tool: name,
        data,
        ...(retrieval ? { retrieval } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        status: "degraded",
        tool: name,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function schemaPackStateFromInstall(
  result: DoppelgangerGBrainSchemaInstallResult,
): GBrainSchemaPackState {
  return {
    name: result.packName,
    status: "installed",
    path: result.packPath,
    active: result.activated,
    installedDuringBootstrap: result.installed,
  };
}
