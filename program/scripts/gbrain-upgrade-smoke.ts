/**
 * Disposable, keyless acceptance for the Knowledge GBrain adapter against a
 * staged upstream sidecar.
 *
 * Run with the Program's existing Bun/TS loader, for example:
 *
 *   bun scripts/gbrain-upgrade-smoke.ts \
 *     /tmp/knowledge-gbrain-upgrade.oiqmgV/upstream-v0.48.2.0
 *
 * The script creates a fresh GBRAIN_HOME, lets the production GBrainRuntime
 * start the real loopback HTTP MCP server, writes only synthetic pages, reads
 * them over MCP, adds one typed fixture edge over the same transport, closes
 * the sidecar, and reopens the same PGLite home to prove persistence.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { callGBrainTool } from "../src/gbrain-transport.js";
import { GBrainRuntime } from "../src/gbrain.js";
import type { KnowledgeConfig, KnowledgeDocument, ResearchSource } from "../src/types.js";

type UnknownRecord = Record<string, unknown>;
const SMOKE_TIMEOUT_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 10_000;
let activeCleanup: (() => Promise<void>) | null = null;

const repoArgument = process.argv[2] ?? process.env.KNOWLEDGE_GBRAIN_SMOKE_REPO;
if (!repoArgument) {
  throw new Error("Usage: bun scripts/gbrain-upgrade-smoke.ts <staged-gbrain-repo>");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function record(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function graphEdges(value: unknown): readonly UnknownRecord[] {
  if (Array.isArray(value)) return value.filter(record);
  if (record(value)) {
    for (const key of ["paths", "edges", "data", "result"]) {
      const candidate = value[key];
      if (Array.isArray(candidate)) return candidate.filter(record);
    }
  }
  return [];
}

function scrubEnvironment() {
  const keep = new Set(["PATH", "BUN_INSTALL", "TMPDIR", "TMP", "TEMP", "HOME", "USER", "LOGNAME", "SHELL"]);
  for (const key of Object.keys(process.env)) {
    if (!keep.has(key) && !key.startsWith("LC_") && !key.startsWith("LANG")) delete process.env[key];
  }
  process.env.NODE_ENV = "test";
}

function fixtureDocument(now: string): KnowledgeDocument {
  return {
    id: "upgrade-smoke-document",
    companyId: "company-upgrade-smoke",
    collectionId: "collection-upgrade-smoke",
    parentDocumentId: null,
    title: "Upgrade smoke document",
    slug: "upgrade-smoke-document",
    summary: "Synthetic document for disposable GBrain acceptance.",
    body: "This synthetic document depends on [[knowledge-research/sources/upgrade-smoke-source]].",
    bodyFormat: "markdown",
    status: "published",
    source: null,
    createdByAgentId: "agent-upgrade-smoke",
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fixtureResearchSource(now: string): ResearchSource {
  return {
    id: "upgrade-smoke-source",
    companyId: "company-upgrade-smoke",
    notebookId: "notebook-upgrade-smoke",
    title: "Upgrade smoke research source",
    sourceType: "synthetic",
    url: null,
    storagePath: null,
    originalFilename: null,
    contentType: "text/plain",
    size: null,
    author: null,
    publisher: null,
    publishedAt: null,
    summary: "Synthetic research source for disposable GBrain acceptance.",
    citation: null,
    apiConfig: null,
    apiSnapshot: null,
    status: "ready",
    content: "Synthetic research content retained across the sidecar restart.",
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function readJson(filePath: string): Promise<UnknownRecord> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as UnknownRecord;
}

async function closeWithin(runtime: GBrainRuntime | null): Promise<void> {
  if (!runtime) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runtime.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`GBrain runtime close exceeded ${CLEANUP_TIMEOUT_MS}ms`)),
          CLEANUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readHealth(baseUrl: string, expectedVersion: string): Promise<UnknownRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    assert(response.ok, `GBrain /health returned HTTP ${response.status}`);
    const body = (await response.json()) as unknown;
    assert(record(body), "GBrain /health returned a non-object body");
    assert(body.version === expectedVersion, `GBrain /health version ${String(body.version)} != ${expectedVersion}`);
    assert(body.status === "ok", `GBrain /health status was ${String(body.status)}`);
    return body;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function contentString(value: unknown): string | null {
  if (record(value)) {
    if (typeof value.content === "string") return value.content;
    for (const child of Object.values(value)) {
      const nested = contentString(child);
      if (nested !== null) return nested;
    }
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const nested = contentString(child);
      if (nested !== null) return nested;
    }
  }
  return null;
}

async function readPageWithContent(
  runtime: GBrainRuntime,
  baseUrl: string,
  token: string,
  slug: string,
  expectedType: string,
  expectedMarker: string,
) {
  const runtimePage = await runtime.getPage({ slug, fuzzy: false });
  assert(
    runtimePage.ok && record(runtimePage.data) && runtimePage.data.slug === slug,
    `GBrainRuntime get_page did not return exact slug metadata for ${slug}`,
  );
  const wirePage = await callGBrainTool({
    baseUrl,
    token,
    name: "get_page",
    args: { slug, fuzzy: false, include_content: true },
  });
  assert(record(wirePage) && wirePage.slug === slug, `MCP get_page did not return exact slug metadata for ${slug}`);
  const content = contentString(wirePage);
  assert(content, `MCP get_page did not return canonical content for ${slug}`);
  assert(/^---\n/u.test(content), `MCP get_page content for ${slug} has no frontmatter`);
  assert(new RegExp(`^type:\\s*${expectedType}\\s*$`, "mu").test(content), `MCP get_page content for ${slug} has wrong type`);
  assert(content.includes(expectedMarker), `MCP get_page content for ${slug} omitted its synthetic body marker`);
  return { runtimePage, wirePage, content };
}

async function main() {
  scrubEnvironment();
  const resolvedRepoPath = path.resolve(repoArgument);
  const repoVersion = (await fs.readFile(path.join(resolvedRepoPath, "VERSION"), "utf8")).trim();
  const disposableRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-gbrain-smoke-"));
  const gbrainHome = path.join(disposableRoot, "gbrain-home");
  const configPath = path.join(gbrainHome, ".gbrain", "config.json");
  const now = new Date().toISOString();
  const document = fixtureDocument(now);
  const source = fixtureResearchSource(now);
  const documentSlug = `knowledge-docs/${document.id}`;
  const sourceSlug = `knowledge-research/sources/${source.id}`;
  let firstRuntime: GBrainRuntime | null = null;
  let secondRuntime: GBrainRuntime | null = null;
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = () =>
    cleanupPromise ??= (async () => {
      let closeError: unknown = null;
      for (const runtime of [secondRuntime, firstRuntime]) {
        try {
          await closeWithin(runtime);
        } catch (error) {
          closeError ??= error;
        }
      }
      await fs.rm(disposableRoot, { recursive: true, force: true });
      if (closeError) throw closeError;
    })();
  activeCleanup = cleanup;

  try {
    await fs.mkdir(gbrainHome, { recursive: true });
    process.env.GBRAIN_HOME = gbrainHome;
    process.env.KNOWLEDGE_GBRAIN_HOME = gbrainHome;

    const config = loadConfig({
      environment: "development",
      config: {
        dataDir: disposableRoot,
        gbrainHome,
        gbrainRepoPath: resolvedRepoPath,
        gbrainAutoStart: true,
        gbrainBaseUrl: null,
        gbrainToken: null,
        rulesBaseUrl: null,
        rulesAuthToken: null,
        knowledgeDatabaseUrl: null,
        knowledgeDatabasePath: null,
      },
    }) as KnowledgeConfig;

    firstRuntime = new GBrainRuntime(config);
    await firstRuntime.start();
    const firstStatus = firstRuntime.status();
    assert(firstStatus.status === "online", `first runtime did not become online: ${firstStatus.detail ?? "unknown"}`);
    assert(firstStatus.baseUrl?.startsWith("http://127.0.0.1:"), "first runtime was not loopback HTTP");
    const firstHealth = await readHealth(firstStatus.baseUrl, repoVersion);
    assert(firstStatus.schemaPack.status === "installed", "Teal Brick schema pack was not installed");
    assert(firstStatus.schemaPack.active, "Teal Brick schema pack was not activated");
    const installedPack = await readJson(firstStatus.schemaPack.path);
    assert(installedPack.version === "1.1.0", `unexpected schema pack version: ${String(installedPack.version)}`);
    const pageTypes = Array.isArray(installedPack.page_types) ? installedPack.page_types : [];
    assert(
      ["knowledge_document", "research_source"].every((name) =>
        pageTypes.some((entry) => record(entry) && entry.name === name && entry.extractable === false),
      ),
      "schema pack is missing the non-extractable Knowledge document/research page types",
    );

    const projectedSource = await firstRuntime.projectResearchSource(source);
    assert(projectedSource.ok, `research projection failed: ${projectedSource.error ?? "unknown"}`);
    const projectedDocument = await firstRuntime.projectDocument(document);
    assert(projectedDocument.ok, `document projection failed: ${projectedDocument.error ?? "unknown"}`);

    const token = (await fs.readFile(path.join(gbrainHome, ".doppelganger-token"), "utf8")).trim();
    assert(token.length > 0, "managed runtime did not create a disposable token");
    await readPageWithContent(
      firstRuntime,
      firstStatus.baseUrl,
      token,
      sourceSlug,
      "research_source",
      "Synthetic research content retained across the sidecar restart.",
    );
    await readPageWithContent(
      firstRuntime,
      firstStatus.baseUrl,
      token,
      documentSlug,
      "knowledge_document",
      "This synthetic document depends on [[knowledge-research/sources/upgrade-smoke-source]].",
    );
    const linkResult = await callGBrainTool({
      baseUrl: firstStatus.baseUrl!,
      token,
      name: "add_link",
      args: {
        from: documentSlug,
        to: sourceSlug,
        link_type: "depends_on",
        context: "synthetic upgrade smoke edge",
      },
    });
    assert(record(linkResult), "MCP add_link returned an invalid result");

    const graph = await firstRuntime.traverseGraph({
      slug: documentSlug,
      depth: 2,
      direction: "both",
    });
    assert(graph.ok, `MCP traverse_graph failed: ${graph.error ?? "unknown"}`);
    const edges = graphEdges(graph.data);
    assert(
      edges.some(
        (edge) => edge.from_slug === documentSlug && edge.to_slug === sourceSlug && edge.link_type === "depends_on",
      ),
      `explicit direction=both graph did not return the synthetic edge: ${JSON.stringify(graph.data)}`,
    );

    const tokenBeforeClose = token;
    await firstRuntime.close();
    firstRuntime = null;
    assert((await fs.readFile(path.join(gbrainHome, ".doppelganger-token"), "utf8")).trim() === tokenBeforeClose, "managed close changed the token");
    const persistedConfig = await readJson(configPath);
    const databasePath = typeof persistedConfig.database_path === "string" ? persistedConfig.database_path : null;
    assert(databasePath, "disposable GBrain config did not expose a PGLite database_path");
    assert(persistedConfig.engine === "pglite", `expected keyless PGLite, got ${String(persistedConfig.engine)}`);

    secondRuntime = new GBrainRuntime(config);
    await secondRuntime.start();
    const secondStatus = secondRuntime.status();
    assert(secondStatus.status === "online", `reopened runtime did not become online: ${secondStatus.detail ?? "unknown"}`);
    assert(secondStatus.baseUrl?.startsWith("http://127.0.0.1:"), "reopened runtime was not loopback HTTP");
    const secondHealth = await readHealth(secondStatus.baseUrl, repoVersion);
    const tokenAfterReopen = (await fs.readFile(path.join(gbrainHome, ".doppelganger-token"), "utf8")).trim();
    assert(tokenAfterReopen === tokenBeforeClose, "reopened runtime did not reuse the managed token");
    await readPageWithContent(
      secondRuntime,
      secondStatus.baseUrl,
      tokenAfterReopen,
      sourceSlug,
      "research_source",
      "Synthetic research content retained across the sidecar restart.",
    );
    await readPageWithContent(
      secondRuntime,
      secondStatus.baseUrl,
      tokenAfterReopen,
      documentSlug,
      "knowledge_document",
      "This synthetic document depends on [[knowledge-research/sources/upgrade-smoke-source]].",
    );
    const reopenedGraph = await secondRuntime.traverseGraph({ slug: documentSlug, depth: 2, direction: "both" });
    assert(reopenedGraph.ok, `reopened MCP traverse_graph failed: ${reopenedGraph.error ?? "unknown"}`);
    assert(
      graphEdges(reopenedGraph.data).some(
        (edge) => edge.from_slug === documentSlug && edge.to_slug === sourceSlug && edge.link_type === "depends_on",
      ),
      "synthetic graph edge was not retained after reopen",
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          evidence: "disposable source-level smoke; no live service or provider key",
          sidecarVersion: repoVersion,
          repoPath: resolvedRepoPath,
          engine: persistedConfig.engine,
          databasePath,
          firstTransport: firstStatus.baseUrl,
          secondTransport: secondStatus.baseUrl,
          health: { firstVersion: firstHealth.version, secondVersion: secondHealth.version },
          tokenReused: true,
          schemaPack: { ...firstStatus.schemaPack, version: installedPack.version, pageTypes: ["knowledge_document", "research_source"] },
          projectedSlugs: [documentSlug, sourceSlug],
          graph: { direction: "both", edge: [documentSlug, sourceSlug, "depends_on"] },
          reopened: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanup();
    activeCleanup = null;
  }
}

let outerTimer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    main(),
    new Promise<never>((_, reject) => {
      outerTimer = setTimeout(
        () => reject(new Error(`GBrain upgrade smoke exceeded ${SMOKE_TIMEOUT_MS}ms`)),
        SMOKE_TIMEOUT_MS,
      );
    }),
  ]);
} catch (error) {
  await activeCleanup?.().catch(() => undefined);
  throw error;
} finally {
  if (outerTimer) clearTimeout(outerTimer);
}
