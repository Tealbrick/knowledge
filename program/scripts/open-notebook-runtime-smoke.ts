/**
 * Opt-in, disposable Open Notebook runtime smoke driver.
 *
 * This driver assumes that a dedicated loopback Open Notebook + SurrealDB
 * fixture has already been started by its owner. It creates only synthetic
 * notebooks/source data, exercises the real Knowledge route adapter, and
 * removes only IDs created during this run. It never accepts the upstream
 * bearer token on argv or prints it.
 *
 * Required environment:
 *   KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE=disposable
 *   KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_URL=http://127.0.0.1:<port>
 *   KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_TOKEN=<private fixture secret>
 *
 * Optional:
 *   KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_TIMEOUT_MS=15000..60000 (default 30000)
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildKnowledgeApp } from "../src/app.js";
import type { KnowledgeConfig } from "../src/types.js";
import { startChatModelFixture, type ChatModelFixture } from "./open-notebook-chat-fixture.js";

type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST" | "DELETE";

const FIXTURE_MARKER = "disposable";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

class SmokeError extends Error {
  constructor(
    readonly code:
      | "configuration_required"
      | "invalid_loopback_url"
      | "timeout"
      | "request_failed"
      | "malformed_response"
      | "assertion_failed"
      | "ambiguous_write"
      | "write_rejected"
      | "cleanup_failed",
    message: string,
  ) {
    super(message);
  }
}

type CreatedIds = {
  upstreamNotebookA: string | null;
  upstreamNotebookB: string | null;
  upstreamSource: string | null;
  localNotebook: string | null;
  localNotebookB: string | null;
};

type FixtureResponse = {
  readonly status: number;
  readonly body: unknown;
};

type KnowledgeWriteReceipt = {
  readonly sourceId: string;
  readonly state: "succeeded";
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function hermesSmoke(baseUrl: string, token: string, siblingToken: string, otherToken: string, input: JsonObject): Promise<JsonObject> {
  const script = fileURLToPath(new URL("./open-notebook-hermes-smoke.py", import.meta.url));
  const child = spawn("python3", [script], { env: {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PYTHONDONTWRITEBYTECODE: "1",
    KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE: "disposable", KNOWLEDGE_BASE_URL: baseUrl,
    KNOWLEDGE_RESEARCH_SERVICE_TOKEN: token, KNOWLEDGE_FIXTURE_SIBLING_TOKEN: siblingToken,
    KNOWLEDGE_FIXTURE_OTHER_COMPANY_TOKEN: otherToken,
  }, stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  let exceeded = false;
  const timer = setTimeout(() => { exceeded = true; child.kill("SIGKILL"); }, 45_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", () => reject(new SmokeError("request_failed", "Hermes fixture process failed")));
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output) > 1024 * 1024) { exceeded = true; child.kill("SIGKILL"); }
      });
      child.once("close", resolve);
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify(input));
    });
    if (exceeded) throw new SmokeError("timeout", "Hermes fixture exceeded deadline or output bound");
    let result: unknown;
    try { result = JSON.parse(output); } catch { throw new SmokeError("malformed_response", "Hermes fixture result was not JSON"); }
    const detail = isObject(result) && typeof result.error === "string" && /^handler_[a-z_]+_failed_[a-z_]+_(?:[0-9]+|none)$/.test(result.error) ? result.error : "hermes_fixture_failed";
    assert(code === 0 && isObject(result) && result.ok === true, detail);
    return result;
  } finally { clearTimeout(timer); }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeError("assertion_failed", message);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new SmokeError("configuration_required", `${name} is required`);
  return value;
}

function loopbackBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SmokeError("invalid_loopback_url", "fixture URL is not a valid URL");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
  if (!loopback || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new SmokeError("invalid_loopback_url", "fixture URL must be a loopback HTTP(S) origin without credentials, path, query, or fragment");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function timeoutMs(): number {
  const raw = process.env.KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw new SmokeError("configuration_required", `KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_TIMEOUT_MS must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return parsed;
}

function jsonId(value: unknown): string | null {
  if (!isObject(value)) return null;
  if (typeof value.id === "string" && value.id.trim()) return value.id;
  for (const key of ["notebook", "source", "data", "result"]) {
    const nested = jsonId(value[key]);
    if (nested) return nested;
  }
  return null;
}

function jsonArray(value: unknown): readonly JsonObject[] {
  if (Array.isArray(value)) return value.filter(isObject);
  if (isObject(value)) {
    for (const key of ["data", "items", "results"] as const) {
      if (Array.isArray(value[key])) return value[key].filter(isObject);
    }
  }
  return [];
}

function containsMarker(value: unknown, marker: string): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) return value.some((item) => containsMarker(item, marker));
  if (isObject(value)) return Object.values(value).some((item) => containsMarker(item, marker));
  return false;
}

function hasNotebookMembership(value: unknown, notebookId: string): boolean {
  if (!isObject(value)) return false;
  const notebooks = value.notebooks;
  return Array.isArray(notebooks) && notebooks.some((item) => item === notebookId || (isObject(item) && item.id === notebookId));
}

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new SmokeError("request_failed", "fixture response exceeded the bounded smoke response limit");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value < 1) throw new SmokeError("timeout", "overall smoke deadline expired");
  return value;
}

async function request(
  baseUrl: string,
  token: string,
  method: HttpMethod,
  route: string,
  deadline: number,
  body?: JsonObject,
  includeAuthorization = true,
): Promise<FixtureResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining(deadline));
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          accept: "application/json",
          ...(includeAuthorization ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw new SmokeError("timeout", `fixture ${method} request timed out`);
      throw new SmokeError("request_failed", `fixture ${method} request could not be completed`);
    }
    const text = await readBounded(response);
    let parsed: unknown = null;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new SmokeError("malformed_response", `fixture ${method} response was not JSON`);
      }
    }
    return { status: response.status, body: parsed };
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

async function writeJson(
  baseUrl: string,
  token: string,
  route: string,
  body: JsonObject,
  operation: string,
  deadline: number,
): Promise<unknown> {
  try {
    const response = await request(baseUrl, token, "POST", route, deadline, body);
    if (response.status >= 500) throw new SmokeError("ambiguous_write", `${operation} returned HTTP ${response.status}`);
    if (response.status < 200 || response.status >= 300) throw new SmokeError("write_rejected", `${operation} returned HTTP ${response.status}`);
    return response.body;
  } catch (error) {
    if (error instanceof SmokeError && ["write_rejected", "ambiguous_write"].includes(error.code)) throw error;
    throw new SmokeError("ambiguous_write", `${operation} outcome is ambiguous; no retry was attempted`);
  }
}

function parseKnowledgeWriteResponse(
  response: { readonly statusCode: number; readonly json: () => unknown },
  expectedStatus: number,
  expectedReplayed: boolean,
  operation: string,
): { readonly receipt: KnowledgeWriteReceipt; readonly replayed: boolean } {
  if (response.statusCode >= 500) throw new SmokeError("ambiguous_write", `${operation} returned HTTP ${response.statusCode}`);
  if (response.statusCode !== expectedStatus) throw new SmokeError("write_rejected", `${operation} returned HTTP ${response.statusCode}`);
  let body: unknown;
  try {
    body = response.json();
  } catch {
    throw new SmokeError("ambiguous_write", `${operation} returned a malformed response; no retry was attempted`);
  }
  if (!isObject(body) || body.replayed !== expectedReplayed || !isObject(body.receipt) || body.receipt.state !== "succeeded" || typeof body.receipt.sourceId !== "string" || !body.receipt.sourceId.trim()) {
    throw new SmokeError("ambiguous_write", `${operation} returned an unexpected receipt; no retry was attempted`);
  }
  return {
    receipt: { state: "succeeded", sourceId: body.receipt.sourceId },
    replayed: expectedReplayed,
  };
}

async function writeKnowledgeTextSource(
  app: Awaited<ReturnType<typeof buildKnowledgeApp>>,
  localNotebookId: string,
  principalToken: string,
  idempotencyKey: string,
  body: { readonly title: string; readonly content: string },
  expectedStatus: number,
  expectedReplayed: boolean,
  operation: string,
  deadline: number,
): Promise<{ readonly receipt: KnowledgeWriteReceipt; readonly replayed: boolean }> {
  remaining(deadline);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/research/notebooks/${pathPart(localNotebookId)}/engine/sources`,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${principalToken}`,
        "idempotency-key": idempotencyKey,
      },
      payload: body,
    });
    remaining(deadline);
    return parseKnowledgeWriteResponse(response, expectedStatus, expectedReplayed, operation);
  } catch (error) {
    if (error instanceof SmokeError && ["ambiguous_write", "write_rejected", "timeout"].includes(error.code)) throw error;
    throw new SmokeError("ambiguous_write", `${operation} outcome is ambiguous; no retry was attempted`);
  }
}

async function deleteKnown(
  baseUrl: string,
  token: string,
  route: string,
  operation: string,
  deadline: number,
): Promise<void> {
  const response = await request(baseUrl, token, "DELETE", route, deadline);
  if (response.status < 200 || response.status >= 300) throw new SmokeError("cleanup_failed", `${operation} returned HTTP ${response.status}`);
}

async function main(): Promise<void> {
  if (process.env.KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE !== FIXTURE_MARKER) {
    throw new SmokeError("configuration_required", "set KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE=disposable to opt in");
  }
  const baseUrl = loopbackBaseUrl(requiredEnvironment("KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_URL"));
  const upstreamToken = requiredEnvironment("KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE_TOKEN");
  const overallTimeout = timeoutMs();
  const deadline = Date.now() + overallTimeout;
  const localPrincipalTokenA = `knowledge-smoke-principal-a-${randomUUID()}`;
  const localPrincipalTokenB = `knowledge-smoke-principal-b-${randomUUID()}`;
  const marker = `knowledge-open-notebook-runtime-smoke-${randomUUID()}`;
  const created: CreatedIds = { upstreamNotebookA: null, upstreamNotebookB: null, upstreamSource: null, localNotebook: null, localNotebookB: null };
  const disposableRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-open-notebook-runtime-smoke-"));
  const knowledgeDatabasePath = path.join(disposableRoot, "knowledge.sqlite");
  const researchWriteLedgerPath = path.join(disposableRoot, "research-write-ledger.sqlite");
  let app: Awaited<ReturnType<typeof buildKnowledgeApp>> | null = null;
  let bootstrap: Awaited<ReturnType<typeof buildKnowledgeApp>> | null = null;
  let cleanupError: string | null = null;
  let successSummary: JsonObject | null = null;
  let chatFixture: ChatModelFixture | null = null;
  const upstreamChatSessions: string[] = [];
  const extraUpstreamSources: string[] = [];
  const upstreamNotes: string[] = [];

  const cleanup = async () => {
    const cleanupDeadline = Math.min(deadline + 10_000, Date.now() + 10_000);
    const errors: string[] = [];
    if (app) {
      for (const [id, label] of [[created.localNotebookB, "local notebook B cleanup"], [created.localNotebook, "local notebook A cleanup"]] as const) {
        if (!id) continue;
        try {
          const response = await app.inject({ method: "DELETE", url: `/api/research/notebooks/${pathPart(id)}` });
          if (response.statusCode < 200 || response.statusCode >= 300) errors.push(`${label} returned HTTP ${response.statusCode}`);
        } catch {
          errors.push(label);
        }
      }
    }
    if (app) {
      try { await app.close(); } catch { errors.push("Knowledge app close failed"); }
      app = null;
    }
    if (bootstrap) {
      try { await bootstrap.close(); } catch { errors.push("Knowledge bootstrap close failed"); }
      bootstrap = null;
    }
    if (created.upstreamSource) {
      try { await deleteKnown(baseUrl, upstreamToken, `/api/sources/${pathPart(created.upstreamSource)}`, "source cleanup", cleanupDeadline); } catch { errors.push("upstream source cleanup failed"); }
    }
    for (const id of extraUpstreamSources) {
      try { await deleteKnown(baseUrl, upstreamToken, `/api/sources/${pathPart(id)}`, "Hermes source cleanup", cleanupDeadline); } catch { errors.push("Hermes upstream source cleanup failed"); }
    }
    for (const id of upstreamChatSessions) {
      try { await deleteKnown(baseUrl, upstreamToken, `/api/chat/sessions/${pathPart(id)}`, "chat cleanup", cleanupDeadline); } catch { errors.push("upstream chat cleanup failed"); }
    }
    for (const id of upstreamNotes) {
      try { await deleteKnown(baseUrl, upstreamToken, `/api/notes/${pathPart(id)}`, "note cleanup", cleanupDeadline); } catch { errors.push("upstream note cleanup failed"); }
    }
    if (chatFixture) {
      try { await chatFixture.close(); } catch { errors.push("chat model fixture cleanup failed"); }
    }
    for (const [id, label] of [[created.upstreamNotebookB, "notebook B cleanup"], [created.upstreamNotebookA, "notebook A cleanup"]] as const) {
      if (!id) continue;
      try { await deleteKnown(baseUrl, upstreamToken, `/api/notebooks/${pathPart(id)}`, label, cleanupDeadline); } catch { errors.push(`${label} failed`); }
    }
    try { await fs.rm(disposableRoot, { recursive: true, force: true }); } catch { errors.push("temporary Knowledge fixture cleanup failed"); }
    cleanupError = errors.length ? errors.join(", ") : null;
  };

  try {
    const health = await request(baseUrl, upstreamToken, "GET", "/health", deadline);
    assert(health.status >= 200 && health.status < 300, `fixture health returned HTTP ${health.status}`);
    const preflightInventory = await request(baseUrl, upstreamToken, "GET", "/api/notebooks", deadline);
    assert(preflightInventory.status >= 200 && preflightInventory.status < 300, `fixture notebook preflight returned HTTP ${preflightInventory.status}`);
    assert(Array.isArray(preflightInventory.body) && preflightInventory.body.length === 0, "fixture notebook preflight was not a valid empty inventory; refusing to write synthetic data");

    const notebookA = await writeJson(baseUrl, upstreamToken, "/api/notebooks", {
      name: `Knowledge smoke A ${marker}`,
      description: "Disposable Knowledge runtime smoke notebook A",
    }, "upstream notebook A creation", deadline);
    created.upstreamNotebookA = jsonId(notebookA);
    if (!created.upstreamNotebookA) throw new SmokeError("ambiguous_write", "upstream notebook A creation returned no ID; no retry was attempted");

    const missingUpstreamBearer = await request(baseUrl, upstreamToken, "GET", `/api/notebooks/${pathPart(created.upstreamNotebookA)}`, deadline, undefined, false);
    assert([401, 403].includes(missingUpstreamBearer.status), `missing upstream bearer was not rejected (HTTP ${missingUpstreamBearer.status})`);
    const wrongUpstreamBearer = await request(baseUrl, `wrong-${randomUUID()}`, "GET", `/api/notebooks/${pathPart(created.upstreamNotebookA)}`, deadline);
    assert([401, 403].includes(wrongUpstreamBearer.status), `wrong upstream bearer was not rejected (HTTP ${wrongUpstreamBearer.status})`);

    const notebookB = await writeJson(baseUrl, upstreamToken, "/api/notebooks", {
      name: `Knowledge smoke B ${marker}`,
      description: "Disposable Knowledge runtime smoke notebook B",
    }, "upstream notebook B creation", deadline);
    created.upstreamNotebookB = jsonId(notebookB);
    if (!created.upstreamNotebookB) throw new SmokeError("ambiguous_write", "upstream notebook B creation returned no ID; no retry was attempted");

    const baseConfig: Partial<KnowledgeConfig> & { researchWriteLedgerPath: string } = {
      dataDir: disposableRoot,
      knowledgeDatabasePath,
      researchWriteLedgerPath,
      defaultDocsSourceConfig: null,
      gbrainAutoStart: false,
      gbrainBaseUrl: null,
      gbrainToken: null,
      openNotebookBaseUrl: null,
      openNotebookToken: null,
      knowledgeServicePrincipals: [],
      openNotebookBindings: [],
      rulesBaseUrl: null,
      rulesAuthToken: null,
    };
    bootstrap = await buildKnowledgeApp({ environment: "test", config: baseConfig });
    const localNotebook = await bootstrap.inject({ method: "POST", url: "/api/companies/company-smoke/research/notebooks", payload: { title: "Durable Knowledge smoke map" } });
    if (localNotebook.statusCode >= 500) throw new SmokeError("ambiguous_write", `local Knowledge notebook creation returned HTTP ${localNotebook.statusCode}`);
    if (localNotebook.statusCode !== 201) throw new SmokeError("write_rejected", `local Knowledge notebook creation returned HTTP ${localNotebook.statusCode}`);
    created.localNotebook = jsonId(localNotebook.json());
    if (!created.localNotebook) throw new SmokeError("ambiguous_write", "local Knowledge notebook creation returned no ID; no retry was attempted");
    const localNotebookB = await bootstrap.inject({ method: "POST", url: "/api/companies/company-smoke-b/research/notebooks", payload: { title: "Durable Knowledge smoke map B" } });
    if (localNotebookB.statusCode >= 500) throw new SmokeError("ambiguous_write", `local Knowledge notebook B creation returned HTTP ${localNotebookB.statusCode}`);
    if (localNotebookB.statusCode !== 201) throw new SmokeError("write_rejected", `local Knowledge notebook B creation returned HTTP ${localNotebookB.statusCode}`);
    created.localNotebookB = jsonId(localNotebookB.json());
    if (!created.localNotebookB) throw new SmokeError("ambiguous_write", "local Knowledge notebook B creation returned no ID; no retry was attempted");
    await bootstrap.close();
    bootstrap = null;

    const connectedOptions = {
      environment: "test" as const,
      config: {
        ...baseConfig,
        openNotebookBaseUrl: baseUrl,
        openNotebookToken: upstreamToken,
        knowledgeServicePrincipals: [
          { token: localPrincipalTokenA, principalId: "knowledge-smoke-service-a", companyId: "company-smoke", capabilities: ["research:read", "research:write"] },
          { token: localPrincipalTokenB, principalId: "knowledge-smoke-service-b", companyId: "company-smoke-b", capabilities: ["research:read", "research:write"] },
        ],
        openNotebookBindings: [
          { knowledgeNotebookId: created.localNotebook, companyId: "company-smoke", externalNotebookId: created.upstreamNotebookA },
          { knowledgeNotebookId: created.localNotebookB, companyId: "company-smoke-b", externalNotebookId: created.upstreamNotebookB },
        ],
      },
    };
    app = await buildKnowledgeApp(connectedOptions);

    const writeBody = { title: `Knowledge smoke source ${marker}`, content: marker } as const;
    const missingWriteBearer = await app.inject({
      method: "POST",
      url: `/api/research/notebooks/${pathPart(created.localNotebook)}/engine/sources`,
      headers: { "idempotency-key": `knowledge-smoke-missing-${randomUUID()}` },
      payload: writeBody,
    });
    assert(missingWriteBearer.statusCode === 401, `missing bearer was not rejected by Knowledge write route (HTTP ${missingWriteBearer.statusCode})`);

    const idempotencyKey = `knowledge-smoke-write-${randomUUID()}`;
    const writeResult = await writeKnowledgeTextSource(
      app,
      created.localNotebook,
      localPrincipalTokenA,
      idempotencyKey,
      writeBody,
      201,
      false,
      "Knowledge text source creation",
      deadline,
    );
    created.upstreamSource = writeResult.receipt.sourceId;
    await app.close();
    app = null;
    app = await buildKnowledgeApp(connectedOptions);
    const replayResult = await writeKnowledgeTextSource(
      app,
      created.localNotebook,
      localPrincipalTokenA,
      idempotencyKey,
      writeBody,
      200,
      true,
      "Knowledge text source idempotent replay",
      deadline,
    );
    assert(replayResult.receipt.sourceId === created.upstreamSource, "idempotent replay returned a different source ID");

    const crossCompanyWrite = await app.inject({
      method: "POST",
      url: `/api/research/notebooks/${pathPart(created.localNotebook)}/engine/sources`,
      headers: {
        authorization: `Bearer ${localPrincipalTokenB}`,
        "idempotency-key": `knowledge-smoke-cross-company-${randomUUID()}`,
      },
      payload: { title: `Knowledge cross-company source ${marker}`, content: marker },
    });
    assert(crossCompanyWrite.statusCode === 403, `cross-company Knowledge write was not rejected (HTTP ${crossCompanyWrite.statusCode})`);

    const sourceAList = await request(baseUrl, upstreamToken, "GET", `/api/sources?notebook_id=${encodeURIComponent(created.upstreamNotebookA)}`, deadline);
    assert(sourceAList.status >= 200 && sourceAList.status < 300, `filtered notebook A source read returned HTTP ${sourceAList.status}`);
    const sourceAItems = jsonArray(sourceAList.body);
    assert(sourceAItems.length === 1, `filtered notebook A source read returned ${sourceAItems.length} sources; expected exactly one after idempotent replay`);
    assert(sourceAItems[0]?.id === created.upstreamSource, "filtered notebook A source read did not contain the receipt source");
    const sourceBList = await request(baseUrl, upstreamToken, "GET", `/api/sources?notebook_id=${encodeURIComponent(created.upstreamNotebookB)}`, deadline);
    assert(sourceBList.status >= 200 && sourceBList.status < 300, `filtered notebook B source read returned HTTP ${sourceBList.status}`);
    assert(!containsMarker(sourceBList.body, marker), "filtered notebook B read disclosed the A source marker");

    const sourceDetail = await request(baseUrl, upstreamToken, "GET", `/api/sources/${pathPart(created.upstreamSource)}`, deadline);
    assert(sourceDetail.status >= 200 && sourceDetail.status < 300, `source detail returned HTTP ${sourceDetail.status}`);
    assert(containsMarker(sourceDetail.body, marker), "source detail did not contain the created marker");
    if (isObject(sourceDetail.body) && sourceDetail.body.notebooks !== undefined) {
      assert(hasNotebookMembership(sourceDetail.body, created.upstreamNotebookA), "source detail did not prove A notebook membership");
    }

    const missingBearer = await app.inject({ method: "GET", url: `/api/research/notebooks/${pathPart(created.localNotebook)}/engine/sources` });
    assert(missingBearer.statusCode === 401, `missing bearer was not rejected by Knowledge route (HTTP ${missingBearer.statusCode})`);
    const routeSources = await app.inject({ method: "GET", url: `/api/research/notebooks/${pathPart(created.localNotebook)}/engine/sources`, headers: { authorization: `Bearer ${localPrincipalTokenA}` } });
    assert(routeSources.statusCode === 200, `Knowledge filtered source route returned HTTP ${routeSources.statusCode}`);
    assert(routeSources.json().sources.some((item: unknown) => isObject(item) && item.id === created.upstreamSource), "Knowledge filtered route did not expose the mapped A source");
    const routeDetail = await app.inject({ method: "GET", url: `/api/research/notebooks/${pathPart(created.localNotebook)}/engine/sources/${pathPart(created.upstreamSource)}`, headers: { authorization: `Bearer ${localPrincipalTokenA}` } });
    assert(routeDetail.statusCode === 200, `Knowledge source detail route returned HTTP ${routeDetail.statusCode}`);
    assert(routeDetail.json().source?.fullText === marker, "Knowledge source detail route did not return the marker");
    assert(JSON.stringify(routeDetail.json()).includes('"provider":"open_notebook"'), "Knowledge route omitted provider projection");
    const routeBSources = await app.inject({ method: "GET", url: `/api/research/notebooks/${pathPart(created.localNotebookB)}/engine/sources`, headers: { authorization: `Bearer ${localPrincipalTokenB}` } });
    assert(routeBSources.statusCode === 200 && Array.isArray(routeBSources.json().sources) && routeBSources.json().sources.length === 0, "Knowledge B mapping did not return an empty source list");
    const crossCompany = await app.inject({ method: "GET", url: `/api/research/notebooks/${pathPart(created.localNotebook)}/engine/sources`, headers: { authorization: `Bearer ${localPrincipalTokenB}` } });
    assert(crossCompany.statusCode === 403, `cross-company Knowledge request was not rejected (HTTP ${crossCompany.statusCode})`);

    const contextPath = `/api/research/notebooks/${pathPart(created.localNotebook)}/engine/context`;
    const contextResponse = await app.inject({ url: contextPath, headers: { authorization: `Bearer ${localPrincipalTokenA}` } });
    assert(contextResponse.statusCode === 200, `Knowledge context returned HTTP ${contextResponse.statusCode}`);
    const contextBody = contextResponse.json();
    assert(contextBody.modelInvoked === false && contextBody.contextPolicy === "server-selected-full-content", "context policy or model boundary missing");
    assert(Array.isArray(contextBody.context?.sources) && contextBody.context.sources.length === 1 && contextBody.context.sources[0].id === created.upstreamSource && contextBody.context.sources[0].fullText === marker, "Research context did not contain the exact scoped source text");
    const emptyContext = await app.inject({ url: `/api/research/notebooks/${pathPart(created.localNotebookB)}/engine/context`, headers: { authorization: `Bearer ${localPrincipalTokenB}` } });
    assert(emptyContext.statusCode === 200 && emptyContext.json().context.sources.length === 0 && emptyContext.json().context.notes.length === 0, "empty B context was not empty");
    const crossContext = await app.inject({ url: contextPath, headers: { authorization: `Bearer ${localPrincipalTokenB}` } });
    assert(crossContext.statusCode === 403, "cross-company context was not rejected");
    const forgedContext = await app.inject({ url: `${contextPath}?sourceId=source:forged`, headers: { authorization: `Bearer ${localPrincipalTokenA}` } });
    assert(forgedContext.statusCode === 400, "caller-supplied context selector was not rejected");

    chatFixture = await startChatModelFixture(baseUrl, upstreamToken);
    const siblingToken = `knowledge-smoke-sibling-${randomUUID()}`;
    const chatOptions = { ...connectedOptions, config: { ...connectedOptions.config,
      openNotebookChatModelId: chatFixture.modelId,
      researchChatLedgerPath: path.join(disposableRoot, "research-chat.sqlite"),
      knowledgeServicePrincipals: [...connectedOptions.config.knowledgeServicePrincipals,
        { token: siblingToken, principalId: "knowledge-smoke-sibling", companyId: "company-smoke", capabilities: ["research:read", "research:write"] }],
    } };
    await app.close();
    app = await buildKnowledgeApp(chatOptions);
    const chatPath = `/api/research/notebooks/${pathPart(created.localNotebook)}/engine/chat`;
    const createKey = `chat-create-${randomUUID()}`;
    const messageKey = `chat-message-${randomUUID()}`;
    const chatRequest = (method: "POST" | "GET", route: string, token = localPrincipalTokenA, key?: string, payload?: JsonObject) => app!.inject({
      method, url: `${chatPath}${route}`, headers: { authorization: `Bearer ${token}`, ...(key ? { "idempotency-key": key } : {}) }, ...(payload ? { payload } : {}),
    });
    const sessionResponse = await chatRequest("POST", "/sessions", localPrincipalTokenA, createKey, { title: "Disposable scoped research chat" });
    assert(sessionResponse.statusCode === 201, `chat session creation returned HTTP ${sessionResponse.statusCode}: ${sessionResponse.json().error ?? "unknown"}`);
    const localSessionId = sessionResponse.json().receipt?.sessionId;
    assert(typeof localSessionId === "string", "chat creation omitted local session receipt");
    const inventory = await request(baseUrl, upstreamToken, "GET", `/api/chat/sessions?notebook_id=${encodeURIComponent(created.upstreamNotebookA)}`, deadline);
    const sessions = jsonArray(inventory.body);
    for (const session of sessions) if (typeof session.id === "string") upstreamChatSessions.push(session.id);
    assert(inventory.status === 200 && sessions.length === 1, "chat session inventory was not exactly one");
    assert(localSessionId !== sessions[0].id, "upstream session identifier escaped local mapping");
    const sessionPath = `/sessions/${pathPart(localSessionId)}`;
    const messageBody = { message: "Summarize the notebook source." };
    const answer = await chatRequest("POST", `${sessionPath}/messages`, localPrincipalTokenA, messageKey, messageBody);
    assert(answer.statusCode === 201, `chat execution returned HTTP ${answer.statusCode}: ${answer.json().error ?? "unknown"}`);
    assert(answer.json().receipt?.answer?.content?.includes("KNOWLEDGE_FAKE_CHAT_OK"), "chat answer omitted fixture proof");
    assert(chatFixture.providerCalls.length === 1 && containsMarker(chatFixture.providerCalls[0].messages, marker), "provider did not receive exact server-scoped source context");
    await app.close();
    app = await buildKnowledgeApp(chatOptions);
    const sessionReplay = await chatRequest("POST", "/sessions", localPrincipalTokenA, createKey, { title: "Disposable scoped research chat" });
    const answerReplay = await chatRequest("POST", `${sessionPath}/messages`, localPrincipalTokenA, messageKey, messageBody);
    assert(sessionReplay.statusCode === 200 && answerReplay.statusCode === 200 && answerReplay.json().replayed === true && chatFixture.providerCalls.length === 1, "restart replay repeated chat side effects");
    const history = await chatRequest("GET", sessionPath);
    assert(history.statusCode === 200 && history.json().messages?.length === 2, "durable upstream chat history missing");
    const sibling = await chatRequest("GET", sessionPath, siblingToken);
    const foreign = await chatRequest("GET", sessionPath, localPrincipalTokenB);
    assert(sibling.statusCode === 404 && foreign.statusCode === 403, "chat principal/company isolation failed");
    const forgedChat = await chatRequest("POST", `${sessionPath}/messages`, localPrincipalTokenA, `forged-${randomUUID()}`, { message: "test", context: {} });
    assert(forgedChat.statusCode === 400, "caller-controlled chat context accepted");
    chatFixture.setFailureMode("reject");
    const failureKey = `chat-failure-${randomUUID()}`;
    const failure = await chatRequest("POST", `${sessionPath}/messages`, localPrincipalTokenA, failureKey, { message: "Fixture rejection test." });
    const callsAfterFailure = chatFixture.providerCalls.length;
    assert(failure.statusCode === 503 && failure.json().receipt?.state === "uncertain", "upstream graph failure was not held for reconciliation");
    const heldReplay = await chatRequest("POST", `${sessionPath}/messages`, localPrincipalTokenA, failureKey, { message: "Fixture rejection test." });
    const heldNewTurn = await chatRequest("POST", `${sessionPath}/messages`, localPrincipalTokenA, `held-${randomUUID()}`, { message: "Must not execute." });
    assert(heldReplay.statusCode === 409 && heldNewTurn.statusCode === 409 && chatFixture.providerCalls.length === callsAfterFailure, "uncertain session was resubmitted");
    const retrySession = await chatRequest("POST", "/sessions", localPrincipalTokenA, `retry-session-${randomUUID()}`, { title: "Disposable SDK retry observation" });
    assert(retrySession.statusCode === 201, "retry observation session creation failed");
    const retryInventory = await request(baseUrl, upstreamToken, "GET", `/api/chat/sessions?notebook_id=${encodeURIComponent(created.upstreamNotebookA)}`, deadline);
    for (const session of jsonArray(retryInventory.body)) if (typeof session.id === "string" && !upstreamChatSessions.includes(session.id)) upstreamChatSessions.push(session.id);
    const retryPath = `/sessions/${pathPart(retrySession.json().receipt.sessionId)}/messages`;
    chatFixture.setFailureMode("disconnect");
    const disconnectKey = `disconnect-${randomUUID()}`;
    const disconnected = await chatRequest("POST", retryPath, localPrincipalTokenA, disconnectKey, { message: "Observe SDK retries in a local fixture." });
    const callsAfterDisconnect = chatFixture.providerCalls.length;
    const sdkDisconnectAttempts = callsAfterDisconnect - callsAfterFailure;
    assert(disconnected.statusCode === 503 && sdkDisconnectAttempts > 1, "expected upstream SDK retries were not observed on disconnect");
    const disconnectReplay = await chatRequest("POST", retryPath, localPrincipalTokenA, disconnectKey, { message: "Observe SDK retries in a local fixture." });
    assert(disconnectReplay.statusCode === 409 && chatFixture.providerCalls.length === callsAfterDisconnect, "Knowledge retried ambiguous disconnect");

    chatFixture.setFailureMode("none");
    // Seed after the original context/chat regression, but before the harness
    // invocation so it must discover and retrieve real saved note content.
    const noteBody = `${marker}: saved note body omitted from upstream list`;
    const savedNote = await writeJson(baseUrl, upstreamToken, "/api/notes", {
      notebook_id: created.upstreamNotebookA, title: "Explicit provider-free note title",
      content: noteBody, note_type: "human",
    }, "upstream note creation", deadline);
    const savedNoteId = jsonId(savedNote);
    if (!savedNoteId) throw new SmokeError("ambiguous_write", "upstream note creation returned no ID; no retry was attempted");
    upstreamNotes.push(savedNoteId);
    const knowledgeUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const harness = await hermesSmoke(knowledgeUrl, localPrincipalTokenA, siblingToken, localPrincipalTokenB, {
      notebookId: created.localNotebook, sourceId: created.upstreamSource, marker, writeReceiptKey: idempotencyKey,
      noteId: savedNoteId, noteBody,
    });
    if (typeof harness.sourceId === "string") extraUpstreamSources.push(harness.sourceId);
    const harnessSessions = await request(baseUrl, upstreamToken, "GET", `/api/chat/sessions?notebook_id=${encodeURIComponent(created.upstreamNotebookA)}`, deadline);
    for (const session of jsonArray(harnessSessions.body)) if (typeof session.id === "string" && !upstreamChatSessions.includes(session.id)) upstreamChatSessions.push(session.id);
    assert(chatFixture.providerCalls.length === callsAfterDisconnect + 1, "Hermes replay or denial invoked an extra provider call");

    const notesPath = `/api/research/notebooks/${pathPart(created.localNotebook)}/engine/notes`;
    const noteHeaders = { authorization: `Bearer ${localPrincipalTokenA}` };
    const notesInventory = await app.inject({ url: notesPath, headers: noteHeaders });
    assert(notesInventory.statusCode === 200 && notesInventory.json().notes?.length === 1, "mapped note inventory missing");
    assert(notesInventory.json().notes[0].id === savedNoteId && notesInventory.json().notes[0].content === null, "pinned upstream list no longer omits saved note body; review contract");
    const noteDetail = await app.inject({ url: `${notesPath}/${pathPart(savedNoteId)}`, headers: noteHeaders });
    assert(noteDetail.statusCode === 200 && noteDetail.json().note?.id === savedNoteId && noteDetail.json().note?.content === noteBody, "mapped saved note detail did not return exact body");
    const missingNoteAuth = await app.inject({ url: `${notesPath}/${pathPart(savedNoteId)}` });
    const foreignNoteCompany = await app.inject({ url: `${notesPath}/${pathPart(savedNoteId)}`, headers: { authorization: `Bearer ${localPrincipalTokenB}` } });
    const foreignNoteMembership = await app.inject({ url: `/api/research/notebooks/${pathPart(created.localNotebookB)}/engine/notes/${pathPart(savedNoteId)}`, headers: { authorization: `Bearer ${localPrincipalTokenB}` } });
    assert(missingNoteAuth.statusCode === 401 && foreignNoteCompany.statusCode === 403, "note detail authentication/company isolation failed");
    assert(foreignNoteMembership.statusCode >= 400 && !foreignNoteMembership.body.includes(noteBody), "foreign notebook detail disclosed saved note body");
    assert(chatFixture.providerCalls.length === callsAfterDisconnect + 1, "saved-note read unexpectedly invoked a model");

    successSummary = {
      ok: true,
      evidence: "disposable loopback Open Notebook runtime plus real Knowledge route adapter",
      marker,
      upstream: { notebookA: created.upstreamNotebookA, notebookB: created.upstreamNotebookB, sourceA: created.upstreamSource },
      knowledge: { localNotebookA: created.localNotebook, localNotebookB: created.localNotebookB, missingBearerStatus: missingBearer.statusCode, missingWriteBearerStatus: missingWriteBearer.statusCode, writeStatus: 201, replayStatus: 200, replayed: replayResult.replayed, replayAfterKnowledgeRestart: true, filteredSourceStatus: routeSources.statusCode, sourceDetailStatus: routeDetail.statusCode, emptyBStatus: routeBSources.statusCode, crossCompanyStatus: crossCompany.statusCode, crossCompanyWriteStatus: crossCompanyWrite.statusCode },
      scope: { sourceAContainsMarker: true, sourceBContainsMarker: false, sourceDetailBoundToA: true },
      context: { status: contextResponse.statusCode, fullTextMatches: true, emptyBStatus: emptyContext.statusCode, crossCompanyStatus: crossContext.statusCode, forgedSelectorStatus: forgedContext.statusCode, modelInvoked: false },
      harness: { ...harness, providerCalls: 1, transport: "registered Hermes handlers over real Knowledge HTTP; disposable upstream" },
      notes: { inventoryStatus: notesInventory.statusCode, inventoryOmitsBody: true, detailStatus: noteDetail.statusCode, savedBodyMatches: true, missingBearerStatus: missingNoteAuth.statusCode, crossCompanyStatus: foreignNoteCompany.statusCode, foreignMembershipStatus: foreignNoteMembership.statusCode, modelInvoked: false },
      chat: { sessionStatus: 201, answerStatus: 201, scopedSourceReachedProvider: true, historyMessages: 2, replayAfterKnowledgeRestart: true, sameCompanyOtherPrincipalStatus: sibling.statusCode, crossCompanyStatus: foreign.statusCode, forgedContextStatus: forgedChat.statusCode, uncertainFailureStatus: failure.statusCode, heldReplayStatus: heldReplay.statusCode, heldNewTurnStatus: heldNewTurn.statusCode, providerCalls: callsAfterDisconnect, sdkDisconnectAttempts, disconnectReplayStatus: disconnectReplay.statusCode, provider: "disposable loopback fixture; no paid model", providerRetryPolicy: "upstream-controlled" },
    };
  } finally {
    await cleanup();
  }
  if (cleanupError) throw new SmokeError("cleanup_failed", cleanupError);
  if (!successSummary) throw new SmokeError("assertion_failed", "smoke completed without a success summary");
  console.log(JSON.stringify(successSummary, null, 2));
}

try {
  await main();
} catch (error) {
  if (error instanceof SmokeError) {
    console.error(JSON.stringify({ ok: false, code: error.code, message: error.message }));
    process.exitCode = error.code === "configuration_required" ? 2 : 1;
  } else {
    console.error(JSON.stringify({ ok: false, code: "smoke_failed", message: "unexpected smoke failure" }));
    process.exitCode = 1;
  }
}
