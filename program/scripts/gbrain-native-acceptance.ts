/**
 * Disposable native GBrain acceptance for the Knowledge adapter.
 *
 * This is deliberately separate from the app's mock-HTTP tests. It starts the
 * staged sidecar through GBrainRuntime, performs real MCP writes/reads against
 * a fresh keyless PGLite home, and removes that home on every exit.
 *
 * Usage:
 *   bun scripts/gbrain-native-acceptance.ts <staged-gbrain-repo>
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { callGBrainTool } from "../src/gbrain-transport.js";
import { GBrainRuntime } from "../src/gbrain.js";
import { loadConfig } from "../src/config.js";

type UnknownRecord = Record<string, unknown>;

const repoArgument = process.argv[2] ?? process.env.KNOWLEDGE_GBRAIN_SMOKE_REPO;
if (!repoArgument) {
  throw new Error("Usage: bun scripts/gbrain-native-acceptance.ts <staged-gbrain-repo>");
}

function record(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function scrubEnvironment(): void {
  const keep = new Set(["PATH", "BUN_INSTALL", "TMPDIR", "TMP", "TEMP", "HOME", "USER", "LOGNAME", "SHELL"]);
  for (const key of Object.keys(process.env)) {
    if (!keep.has(key) && !key.startsWith("LC_") && !key.startsWith("LANG")) delete process.env[key];
  }
  process.env.NODE_ENV = "test";
}

function pageContent(type: string, title: string, body: string, aliases?: readonly string[]): string {
  const aliasBlock = aliases?.length
    ? `aliases:\n${aliases.map((alias) => `  - ${alias}`).join("\n")}\n`
    : "";
  return `---\ntype: ${type}\ntitle: ${JSON.stringify(title)}\n${aliasBlock}---\n\n# ${title}\n\n${body}\n`;
}

function facts(value: unknown): readonly UnknownRecord[] {
  if (!record(value) || !Array.isArray(value.facts)) return [];
  return value.facts.filter(record);
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

async function health(baseUrl: string, version: string): Promise<void> {
  const response = await fetch(`${baseUrl}/health`);
  assert(response.ok, `GBrain health returned HTTP ${response.status}`);
  const body = (await response.json()) as unknown;
  assert(record(body) && body.status === "ok", "GBrain health was not ok");
  assert(body.version === version, `GBrain health version ${String(body.version)} != ${version}`);
}

async function main(): Promise<void> {
  scrubEnvironment();
  const repoPath = path.resolve(repoArgument as string);
  const version = (await fs.readFile(path.join(repoPath, "VERSION"), "utf8")).trim();
  const disposableRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-gbrain-native-"));
  const gbrainHome = path.join(disposableRoot, "gbrain-home");
  await fs.mkdir(gbrainHome, { recursive: true });

  const config = loadConfig({
    environment: "development",
    config: {
      dataDir: disposableRoot,
      gbrainHome,
      gbrainRepoPath: repoPath,
      gbrainAutoStart: true,
      gbrainBaseUrl: null,
      gbrainToken: null,
      rulesBaseUrl: null,
      rulesAuthToken: null,
      knowledgeDatabaseUrl: null,
      knowledgeDatabasePath: null,
    },
  });
  const personSlug = "people/native-acceptance-person";
  const companySlug = "companies/native-acceptance-company";
  const personMarker = "NATIVE_ENTITY_PERSON_MARKER";
  const companyMarker = "NATIVE_ENTITY_COMPANY_MARKER";
  let runtime: GBrainRuntime | null = new GBrainRuntime(config);

  try {
    await runtime.start();
    const firstStatus = runtime.status();
    assert(firstStatus.status === "online" && firstStatus.baseUrl, "real GBrain runtime did not become online");
    assert(firstStatus.baseUrl.startsWith("http://127.0.0.1:"), "real GBrain runtime was not loopback HTTP");
    await health(firstStatus.baseUrl, version);
    const token = (await fs.readFile(path.join(gbrainHome, ".doppelganger-token"), "utf8")).trim();
    assert(token.length > 0, "real GBrain runtime did not create a managed token");

    for (const [slug, type, title, marker, aliases] of [
      [personSlug, "person", "Native Acceptance Person", personMarker, ["NAP", "Native Alias"]],
      [companySlug, "company", "Native Acceptance Company", companyMarker, []],
    ] as const) {
      const written = await callGBrainTool({
        baseUrl: firstStatus.baseUrl,
        token,
        name: "put_page",
        args: {
          slug,
          content: pageContent(type, title, `Synthetic body ${marker}.`, aliases),
        },
      });
      assert(record(written) && written.slug === slug, `real put_page did not write ${slug}`);
    }

    const linked = await callGBrainTool({
      baseUrl: firstStatus.baseUrl,
      token,
      name: "add_link",
      args: {
        from: personSlug,
        to: companySlug,
        link_type: "works_at",
        context: "native disposable acceptance edge",
      },
    });
    assert(record(linked), "real add_link returned an invalid result");

    const timelineWrite = await callGBrainTool({
      baseUrl: firstStatus.baseUrl,
      token,
      name: "add_timeline_entry",
      args: {
        slug: personSlug,
        date: "2026-09-05",
        summary: "Native acceptance timeline marker",
        source: "knowledge-native-acceptance",
      },
    });
    assert(record(timelineWrite), "real add_timeline_entry returned an invalid result");

    for (const [entity, fact] of [
      [personSlug, personMarker],
      [companySlug, companyMarker],
    ] as const) {
      const remembered = await callGBrainTool({
        baseUrl: firstStatus.baseUrl,
        token,
        name: "remember",
        args: {
          fact,
          entity,
          provenance: "knowledge-native-acceptance synthetic fixture",
          visibility: "world",
        },
      });
      assert(record(remembered) && typeof remembered.status === "string", `real remember failed for ${entity}`);
    }

    const pages = await runtime.listPages({ limit: 100, type: "person" });
    assert(pages.ok && Array.isArray(pages.data), "native list_pages did not return a page array");
    assert(pages.data.some((row) => record(row) && row.slug === personSlug && row.type === "person"), "native list_pages omitted person");

    const card = await runtime.getEntityCard({ name: "Native Alias" });
    assert(card.ok && record(card.data) && card.data.found === true, "native entity alias lookup did not find person");
    const cardPayload = record(card.data?.card) ? card.data.card : null;
    assert(cardPayload && record(cardPayload.entity) && cardPayload.entity.slug === personSlug, "native entity card had wrong slug");
    assert(Array.isArray(cardPayload.aka) && cardPayload.aka.includes("native alias"), "native entity card omitted normalized alias");

    const links = await runtime.getLinks({ slug: personSlug });
    assert(links.ok && graphEdges(links.data).some((edge) => edge.to_slug === companySlug && edge.link_type === "works_at"), "native get_links omitted typed edge");
    const graph = await runtime.traverseGraph({ slug: personSlug, depth: 2, direction: "both" });
    assert(graph.ok && graphEdges(graph.data).some((edge) => edge.to_slug === companySlug && edge.link_type === "works_at"), "native traverse_graph(direction=both) omitted typed edge");

    const timeline = await runtime.getTimeline({ slug: personSlug, limit: 10 });
    assert(timeline.ok && Array.isArray(timeline.data) && timeline.data.some((row) => record(row) && row.summary === "Native acceptance timeline marker"), "native get_timeline omitted marker");

    const personRecall = await runtime.recall({ entity: personSlug, limit: 20 });
    assert(personRecall.ok, "native entity-scoped person recall failed");
    const personFacts = facts(personRecall.data);
    assert(personFacts.some((row) => row.fact === personMarker && row.entity_slug === personSlug), "person recall omitted exact entity fact");
    assert(!personFacts.some((row) => row.fact === companyMarker), "person recall leaked company fact");

    const companyRecall = await runtime.recall({ entity: companySlug, limit: 20 });
    assert(companyRecall.ok, "native entity-scoped company recall failed");
    const companyFacts = facts(companyRecall.data);
    assert(companyFacts.some((row) => row.fact === companyMarker && row.entity_slug === companySlug), "company recall omitted exact entity fact");
    assert(!companyFacts.some((row) => row.fact === personMarker), "company recall leaked person fact");

    const tokenBeforeClose = token;
    await runtime.close();
    runtime = null;
    const tokenAfterClose = (await fs.readFile(path.join(gbrainHome, ".doppelganger-token"), "utf8")).trim();
    assert(tokenAfterClose === tokenBeforeClose, "managed close changed the disposable token");

    runtime = new GBrainRuntime(config);
    await runtime.start();
    const reopenedStatus = runtime.status();
    assert(reopenedStatus.status === "online" && reopenedStatus.baseUrl, "reopened real GBrain runtime did not become online");
    await health(reopenedStatus.baseUrl, version);
    const reopenedCard = await runtime.getEntityCard({ name: "NAP" });
    assert(reopenedCard.ok && record(reopenedCard.data) && reopenedCard.data.found === true, "reopened native card was not retained");
    const reopenedTimeline = await runtime.getTimeline({ slug: personSlug, limit: 10 });
    assert(reopenedTimeline.ok && Array.isArray(reopenedTimeline.data) && reopenedTimeline.data.some((row) => record(row) && row.summary === "Native acceptance timeline marker"), "reopened native timeline was not retained");
    const reopenedRecall = await runtime.recall({ entity: personSlug, limit: 20 });
    assert(reopenedRecall.ok && facts(reopenedRecall.data).some((row) => row.fact === personMarker), "reopened native entity fact was not retained");

    console.log(JSON.stringify({
      ok: true,
      evidence: "real staged GBrain sidecar over loopback MCP; disposable PGLite; synthetic world-visible fixtures only",
      sidecarVersion: version,
      repoPath,
      engine: "pglite",
      transport: { first: firstStatus.baseUrl, reopened: reopenedStatus.baseUrl },
      tokenReused: true,
      native: {
        listPages: personSlug,
        entityCard: { slug: personSlug, alias: "native alias", envelope: "found/card" },
        typedLinks: { type: "works_at", direction: "both" },
        timeline: "Native acceptance timeline marker",
        entityScopedRecall: true,
      },
      reopened: true,
    }, null, 2));
  } finally {
    await runtime?.close().catch(() => undefined);
    await fs.rm(disposableRoot, { recursive: true, force: true });
  }
}

await main();
