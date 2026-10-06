import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { managedBrainToken } from "./gbrain-managed-auth.js";
import { nativeMemoryToken } from "./brain-native-auth.js";
import { MEMORY_VERBS, NATIVE_MEMORY_GUIDANCE, nativeMemoryCapabilities, nativeMemoryOperation, nativeMemoryWrites } from "./brain-native-policy.js";
import { GBrainServiceConnection, GBrainServiceError } from "./gbrain-service.js";
import { sanitizeGBrainResult } from "./gbrain-privacy.js";
import { readModelSettings, modelSettingsEnvironment } from "./model-settings.js";
import { callGBrainTool } from "./gbrain-transport.js";
import { probeGBrainHealth } from "./gbrain-health.js";

import type { KnowledgeDocument, ResearchSource, KnowledgeConfig } from "./types.js";
import { knowledgePartitionSourceId, normalizeKnowledgePartitionKey } from "./partition-authority.js";
import {
  KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
  installKnowledgeGBrainSchemaPack,
  type KnowledgeGBrainSchemaInstallResult,
} from "./gbrain-schema.js";
import { gbrainHomeFilePath } from "./legacy-ids.js";
import { gbrainServiceExposure, portalCapabilityForScope, type NativeOperationPolicy } from "./engine-exposure.js";

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
      readonly name: typeof KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME;
      readonly status: "not-managed";
      readonly detail: string;
    }
  | {
      readonly name: typeof KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME;
      readonly status: "installed";
      readonly path: string;
      readonly active: boolean;
      readonly installedDuringBootstrap: boolean;
    }
  | {
      readonly name: typeof KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME;
      readonly status: "degraded";
      readonly detail: string;
    };

export interface ToolCallResult {
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

export function documentToMarkdown(document: KnowledgeDocument): string {
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

export function researchSourceToMarkdown(source: ResearchSource): string {
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
  return gbrainHomeFilePath(gbrainHome, ".tealbrick-token");
}

function gbrainRuntimeFilePath(gbrainHome: string) {
  return gbrainHomeFilePath(gbrainHome, ".tealbrick-gbrain-runtime.json");
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
  readonly engine = "gbrain" as const;
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
  /** Separate upstream GBrain service; mutually exclusive with the managed sidecar. */
  private service: GBrainServiceConnection | null = null;
  private modelEnv: NodeJS.ProcessEnv = {};
  private schemaPack: GBrainSchemaPackState = {
    name: KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
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
    this.service = null;
    if (this.config.gbrainServiceUrl || this.config.gbrainServiceAdminToken) {
      this.schemaPack = { name: KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME, status: "not-managed", detail: "The GBrain service manages its own schema" };
      try {
        if (!this.config.gbrainServiceUrl || !this.config.gbrainServiceAdminToken) throw new Error("KNOWLEDGE_GBRAIN_URL and KNOWLEDGE_GBRAIN_ADMIN_TOKEN must be set together");
        this.service = new GBrainServiceConnection({ baseUrl: this.config.gbrainServiceUrl, adminToken: this.config.gbrainServiceAdminToken, dataDir: this.config.dataDir });
        this.baseUrl = this.service.baseUrl;
        const health = await probeGBrainHealth({ baseUrl: this.baseUrl, timeoutMs: 5_000 });
        this.observedVersion = health.status === "healthy" ? health.version : null;
        this.state = health.status === "healthy" ? "online" : "degraded";
        this.detail = health.status === "healthy" ? null : `GBrain service unavailable: ${health.reason}`;
      } catch (error) {
        this.state = "degraded";
        this.detail = error instanceof Error ? error.message : String(error);
      }
      return;
    }
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
        name: KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
        status: "not-managed",
        detail: "Configured external GBrain endpoint manages its own schema pack",
      };
      return;
    }
    if (!this.config.gbrainAutoStart) {
      this.state = "disabled";
      this.detail = "GBrain autostart disabled";
      this.schemaPack = {
        name: KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
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
        await installKnowledgeGBrainSchemaPack(this.config.gbrainHome),
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
        name: KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME,
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
      status: this.state === "online" ? "online" as const : this.state,
      runtime: "gbrain" as const,
      observedVersion: this.observedVersion,
      baseUrl: this.baseUrl,
      home: this.config.gbrainHome,
      repoPath: this.config.gbrainRepoPath,
      schemaPack: this.schemaPack,
      tokenConfigured: Boolean(this.token) || Boolean(this.service),
      topology: this.service ? "service" as const : this.managedSecret ? "managed" as const : this.config.gbrainBaseUrl ? "external" as const : "none" as const,
      // A separate service treats every caller as remote: partition facts are world-tier inside a partition-bound source.
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
    if (this.service) return this.serviceResult("put_page", document.companyId, sourceId => this.service!.putCanonicalPage(sourceId, `knowledge-docs/${document.id}`, neutralizeFenceMarkers(documentToMarkdown(document))));
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
    if (this.service) return this.serviceResult("put_page", source.companyId, sourceId => this.service!.putCanonicalPage(sourceId, `knowledge-research/sources/${source.id}`, neutralizeFenceMarkers(researchSourceToMarkdown(source))));
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
      // Upstream hides and cannot forget private facts for remote (HTTP) callers, and every
      // service caller is remote: partition facts are world-tier inside a partition-bound source.
      visibility: this.service ? "world" : "private",
      ...(input.sourceSlug ? { source_slug: input.sourceSlug } : {}),
      ...(input.validFrom ? { valid_from: input.validFrom } : {}),
    }, input.partitionKey);
  }

  async deleteProjection(id: string, partitionKey: string, kind: "document" | "research") {
    const slug = kind === "document" ? `knowledge-docs/${id}` : `knowledge-research/sources/${id}`;
    if (this.service) return this.serviceResult("delete_projection", partitionKey, async sourceId => {
      // Forget the projection's session facts first, then soft-delete the page with its revision.
      const sessionId = `${kind}:${id}`;
      for (let batch = 0; batch < 10; batch++) {
        const found = await this.service!.call(sourceId, "recall", { session_id: sessionId, limit: 100 }) as { facts?: Array<{ id?: unknown }> } | null;
        const facts = (found?.facts ?? []).filter(fact => typeof fact.id === "string" || typeof fact.id === "number");
        if (!facts.length) return this.service!.deleteCanonicalPage(sourceId, slug);
        for (const fact of facts) await this.service!.call(sourceId, "forget", { id: String(fact.id), reason: "Canonical Knowledge record removed" });
      }
      throw new Error("deletion_batch_incomplete");
    });
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

  /**
   * Agent-callable native operations. The separate upstream service exposes the
   * full pinned GBrain surface minus documented exclusions (engine-exposure.ts);
   * the embedded managed worker keeps its fixed native-memory v1 contract.
   */
  nativeOperationPolicy(name: string): NativeOperationPolicy | null {
    if (this.config.gbrainServiceUrl || this.config.gbrainServiceAdminToken) return gbrainServiceExposure().exposed.get(name) ?? null;
    if (!nativeMemoryOperation(name)) return null;
    return { name, scope: nativeMemoryWrites(name) ? "write" : "read", capabilities: nativeMemoryCapabilities(name), destructive: name === "forget" };
  }

  /** Full native memory protocol, separately attested per principal and operation. */
  async nativeOperation(operation: string, args: Record<string, unknown>, partitionKey: string, principalId: string): Promise<Record<string, any>> {
    const partition = normalizeKnowledgePartitionKey(partitionKey);
    const policy = operation === "catalog" ? null : this.nativeOperationPolicy(operation);
    if (!partition || !principalId || !(operation === "catalog" || policy)) return {ok:false,error:{error:"scope_denied",suggestion:"Use an authorized partition and advertised operation."}};
    if (brainWritesPaused() && policy?.scope === "write") return { ok: false, error: { error: "unavailable", message: "Memory writes are paused for maintenance", suggestion: "Retry later with the same Idempotency-Key.", protocol_version: 1 } };
    if (this.service) return this.serviceNativeOperation(operation, args, partition, principalId);
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

  private async serviceResult(tool: string, partitionKey: string | undefined, run: (sourceId: string) => Promise<unknown>): Promise<ToolCallResult> {
    if (brainWritesPaused() && BRAIN_WRITE_TOOLS.has(tool)) return pausedResult(tool);
    const partition = partitionKey ? normalizeKnowledgePartitionKey(partitionKey) : null;
    if (!partition) return { ok: false, status: "degraded", tool, data: null, error: "brain_partition_binding_required: select an authorized Knowledge partition" };
    if (this.state !== "online") return { ok: false, status: "degraded", tool, data: null, error: this.detail ?? "GBrain service is not online" };
    const sourceId = knowledgePartitionSourceId(partition);
    // Upstream privacy gaps are closed here before any result leaves Knowledge.
    try { return { ok: true, status: "ready", tool, data: sanitizeGBrainResult(await run(sourceId), sourceId) }; }
    catch (error) {
      const message = error instanceof GBrainServiceError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
      return { ok: false, status: "degraded", tool, data: null, error: message };
    }
  }

  /**
   * Native memory against the upstream service: the catalog is upstream's own tools/list
   * (so every upstream capability at the pin is exposed with its real schema), calls run
   * under a (source, principal)-bound OAuth client, and upstream errors keep their native
   * protocol fields after secret redaction.
   */
  private async serviceNativeOperation(operation: string, args: Record<string, unknown>, partition: string, principalId: string): Promise<Record<string, any>> {
    const engineVersion = this.observedVersion;
    if (this.state !== "online" || !this.service) return { ok: false, error: { error: "unavailable", suggestion: "The GBrain service is not online." } };
    const sourceId = knowledgePartitionSourceId(partition);
    try {
      if (operation === "catalog") {
        const upstream = await this.service.tools(sourceId, principalId);
        const byName = new Map(upstream.map(tool => [tool.name, tool]));
        const exposure = gbrainServiceExposure();
        const tools = [...exposure.exposed.values()].flatMap(policy => {
          const name = policy.name;
          const tool = byName.get(name) as Record<string, any> | undefined;
          if (!tool) return [];
          const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema as Record<string, any> : { type: "object", properties: {} };
          const { source_id: _source, ...properties } = (schema.properties ?? {}) as Record<string, unknown>;
          return [{ name, description: tool.description, inputSchema: { ...schema, properties, required: (schema.required ?? []).filter((key: string) => key !== "source_id") },
            annotations: tool.annotations, scope: policy.scope, requiredCapabilities: policy.capabilities,
            portalCapability: portalCapabilityForScope(policy.scope),
            protocolVersion: (MEMORY_VERBS as readonly string[]).includes(name) ? 1 : null }];
        });
        const missing = [...exposure.exposed.keys()].filter(name => !byName.has(name));
        return { ok: true, data: { engine: "gbrain", engineVersion, contract: "knowledge.native-memory/v1", trust: "remote-source-bound", topology: "service", tools,
          unavailable: missing.map(name => ({ name, error: "engine_capability_unavailable" })),
          excluded: [...exposure.excluded].map(([name, reason]) => ({ name, reason })), guidance: NATIVE_MEMORY_GUIDANCE,
          sourceSelection: "The OAuth client is bound to the authorized partition's GBrain source; caller source_id is rejected" } };
      }
      const refused = gbrainServiceArgumentRefusal(operation, args);
      if (refused) return { ok: false, error: { error: "argument_refused", message: refused, suggestion: "Omit or change the refused argument; Knowledge owns source selection, model selection, host access and its canonical projection pages.", protocol_version: 1 } };
      let failure: Record<string, unknown> | null = null;
      const data = await this.service.call(sourceId, operation, args, { principalId, timeoutMs: GBRAIN_LONG_OPERATIONS.has(operation) ? 300_000 : 60_000,
        onToolError: payload => { failure = redactNativeError(payload); return null; } });
      // Upstream image errors carry file bytes, sizes and existence hints; never relay them.
      if (failure) return { ok: false, engine: "gbrain", engineVersion, error: imageOperation(operation, args) ? IMAGE_INPUT_ERROR : failure };
      return { ok: true, engine: "gbrain", engineVersion, operation, data: sanitizeGBrainResult(data, sourceId), metadata: { topology: "service" } };
    } catch (error) {
      if (error instanceof GBrainServiceError) return { ok: false, engine: "gbrain", engineVersion, error: { error: error.code === "brain_partition_binding_required" ? "scope_denied" : "unavailable", message: error.message } };
      // Transport failures are thrown: mutating receipts must remain uncertain.
      throw error;
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    partitionKey?: string,
  ): Promise<ToolCallResult> {
    if (brainWritesPaused() && BRAIN_WRITE_TOOLS.has(name)) return pausedResult(name);
    if (this.service) {
      const { source_id: _source, ...upstreamArgs } = args;
      let retrieval: Record<string, unknown> | undefined;
      const result = await this.serviceResult(name, partitionKey, sourceId => this.service!.call(sourceId, name, upstreamArgs, {
        timeoutMs: name === "extract_facts" ? 1_800_000 : name === "query" || (name === "recall" && typeof args.query === "string") ? 600_000 : 120_000,
        onMeta: meta => { if (meta.retrieval && typeof meta.retrieval === "object" && !Array.isArray(meta.retrieval)) retrieval = meta.retrieval as Record<string, unknown>; },
      }));
      if (!result.ok) return result;
      const degraded = (Array.isArray(retrieval?.degraded) && retrieval.degraded.length > 0)
        || (result.data !== null && typeof result.data === "object" && Boolean((result.data as Record<string, unknown>).search_degraded));
      return { ...result, status: degraded ? "degraded" : "ready", ...(retrieval ? { retrieval } : {}) };
    }
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
  result: KnowledgeGBrainSchemaInstallResult,
): GBrainSchemaPackState {
  return {
    name: result.packName,
    status: "installed",
    path: result.packPath,
    active: result.activated,
    installedDuringBootstrap: result.installed,
  };
}

/** Native operations allowed 300 s upstream (model synthesis, extraction, hybrid retrieval); all others get 60 s. */
export const GBRAIN_LONG_OPERATIONS: ReadonlySet<string> = new Set([
  "think", "synthesize", "query", "assemble_evidence", "extract_facts", "extract_entities", "remember", "capture", "put_page",
]);

/** Knowledge-owned canonical projection namespaces: agents read them, never rewrite or delete them. */
const RESERVED_PAGE_PREFIXES = ["knowledge-docs/", "knowledge-research/"];
const PAGE_CONTENT_WRITES = new Set(["put_page", "delete_page", "restore_page", "edit_page", "revert_version", "capture", "put_raw_data"]);

/** Argument guards the service topology applies before any upstream call; null when admitted. */
export function gbrainServiceArgumentRefusal(operation: string, args: Record<string, unknown>): string | null {
  const present = (key: string) => Object.hasOwn(args, key) && args[key] !== undefined && args[key] !== null;
  if (Object.hasOwn(args, "source_id") || Object.hasOwn(args, "source_ids")) return "source_id is selected by Knowledge";
  // Private facts are unreachable for every service caller; refuse to create write-only memory.
  if (["remember", "extract_facts", "ontology_propose"].includes(operation) && args.visibility === "private") return "Private visibility is not available through Knowledge; partition memory is shared within its Knowledge partition";
  if (operation === "capture" && Object.hasOwn(args, "local_file")) return "local_file reads the GBrain host filesystem and is not delegated";
  if (operation === "extract_entities" && args.trusted_extraction === true) return "trusted_extraction bypasses upstream review and is not delegated";
  // Host files: upstream loadImageInput reads paths and file:// URLs from the GBrain host.
  if (present("image_path")) return "image_path reads the GBrain host filesystem and is not delegated";
  // Upstream fetches only when the raw string starts with lowercase "http://" or "https://"
  // and reads the host filesystem for file:// URIs and absolute paths, so require that exact
  // prefix on the raw value (no whitespace, other casing or encodings) before any URL parsing.
  if (present("image_url")) {
    const raw = args.image_url;
    let parsed: URL | null = null;
    try { parsed = typeof raw === "string" ? new URL(raw) : null; } catch { parsed = null; }
    if (typeof raw !== "string" || !/^https?:\/\/[^\s/?#\\]/u.test(raw) || /[\s\u0000-\u001f\u007f]/u.test(raw)
      || !parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      return "image_url must be an http(s) URL";
    }
  }
  // Paid model and host CLI selection stays with the deployment's model settings.
  if ((operation === "think" || operation === "synthesize") && present("model")) return "model selection is owned by the deployment's model settings";
  // Remote think may not persist takes or pages.
  if (operation === "think" && ((present("save") && args.save !== false) || (present("take") && args.take !== false))) return "think save/take persistence is not delegated";
  if (operation === "request_tools" && present("surface")) return "request_tools surface changes persist on Knowledge's OAuth client and are not delegated";
  if (operation === "get_calibration_profile" && present("holder")) return "Only the default calibration holder is delegated";
  if (PAGE_CONTENT_WRITES.has(operation) && typeof args.slug === "string" && RESERVED_PAGE_PREFIXES.some(prefix => args.slug!.toString().toLowerCase().startsWith(prefix))) {
    return "Pages under knowledge-docs/ and knowledge-research/ are Knowledge's canonical projections; change the Knowledge document or source instead";
  }
  return null;
}

/** Operations that load an image upstream (by URL or inline data). */
function imageOperation(operation: string, args: Record<string, unknown>): boolean {
  return operation === "search_by_image" || ["image_url", "image_data", "image", "image_path"].some(key => Object.hasOwn(args, key));
}
const IMAGE_INPUT_ERROR = Object.freeze({ error: "image_input_rejected", message: "The image could not be loaded or processed.", suggestion: "Pass a reachable public http(s) image URL or inline image_data.", protocol_version: 1 });

/** Keep upstream's native error fields, never a credential that leaked into a message. */
function redactNativeError(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { error: "internal", message: "Native memory operation failed", protocol_version: 1 };
  const secrets = Object.entries(process.env).filter(([key, value]) => /(?:TOKEN|SECRET|API_KEY|PASSWORD)/u.test(key) && value && value.length >= 8).map(([, value]) => value!);
  const text = secrets.reduce((current, secret) => current.split(secret).join("[REDACTED]"), JSON.stringify(payload));
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Canonical Knowledge text is content, never GBrain structure: upstream refuses remote pages
 * containing privacy-fence markers, so literal marker text is escaped before projection.
 */
export function neutralizeFenceMarkers(markdown: string): string {
  return markdown.replace(/<!---(\s*gbrain:)/giu, "&lt;!---$1");
}

/** Every GBrain tool that changes memory; frozen by KNOWLEDGE_BRAIN_WRITES=paused (migration). */
const BRAIN_WRITE_TOOLS: ReadonlySet<string> = new Set(["put_page", "extract_facts", "delete_page", "delete_projection", "knowledge_delete_projection", "remember", "forget", "forget_fact"]);
/** Read per call so an operator can freeze writes for a migration without code changes. */
export function brainWritesPaused(): boolean {
  return process.env.KNOWLEDGE_BRAIN_WRITES?.trim() === "paused";
}
function pausedResult(tool: string): ToolCallResult {
  // Not-ok results keep projection ledger rows pending, so reconcile retries after the freeze.
  return { ok: false, status: "degraded", tool, data: null, error: "brain_writes_paused" };
}
