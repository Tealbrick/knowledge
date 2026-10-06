import { createHash } from "node:crypto";

import { hindsightExposure, hindsightOpenApi, hindsightOperationSpecs, PORTAL_BRAIN_READ, PORTAL_BRAIN_WRITE,
  type HindsightOperationSpec, type NativeOperationPolicy } from "./engine-exposure.js";
import { brainWritesPaused, documentToMarkdown, researchSourceToMarkdown, type ToolCallResult } from "./gbrain.js";
import { deterministicRequestId } from "./gbrain-service.js";
import { HindsightClient, HindsightError, hindsightBankForPartition } from "./hindsight-client.js";
import { KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME } from "./gbrain-schema.js";
import { normalizeKnowledgePartitionKey } from "./partition-authority.js";
import type { KnowledgeConfig, KnowledgeDocument, ResearchSource } from "./types.js";

/**
 * Hindsight (vectorize-io/hindsight, pinned upstream service) behind the
 * Knowledge MemoryEngine boundary.
 *
 * - Every bank-scoped call targets the bank derived from the already-authorized
 *   partition (`hindsightBankForPartition`); a caller-supplied `bank_id` is
 *   refused, and the built URL is re-checked to stay under that bank.
 * - The native surface is the full pinned HTTP API minus the documented
 *   exclusions in engine-exposure.ts, with per-operation argument guards for
 *   the few routes that are not bank-scoped by path.
 * - Program surfaces that have no Hindsight equivalent (GBrain page links,
 *   timelines, graph traversal, entity cards) fail explicitly with
 *   `engine_capability_unavailable`.
 */

type State = "disabled" | "online" | "degraded";

const RESERVED_DOCUMENT_PREFIXES = ["knowledge-doc:", "knowledge-research:"];
const NATIVE_TIMEOUT_MS = 600_000;
const MAX_DETAIL_CHARS = 2_000;

export const HINDSIGHT_NATIVE_GUIDANCE = `Knowledge memory is served by Hindsight for this deployment; Open Notebook research is separate.
Discover operations with knowledge_brain_tools (GET /api/brain/native/tools); add ?operation=<name> for one operation's full input schema, or ?query=<text> to search. Arguments are the operation's path parameters (except bank_id), its query parameters, and "body" for the request body, all inside "arguments".
The memory bank is selected by Knowledge from your authorized partition. Never pass bank_id; it is rejected.
Use recall_memories for facts, reflect for a synthesized answer (model cost), retain_memories to store new memory (writes need an Idempotency-Key; retry an uncertain write only with the same key). Long-running work returns an operation_id: poll get_operation_status.
Documents knowledge-doc:* and knowledge-research:* are Knowledge's canonical projections: read them, but change the Knowledge document instead of rewriting or deleting them here.
Multipart uploads take each file as {"filename","contentBase64","contentType"}. Binary results come back base64-encoded.
Never claim an unconfigured capability (for example an LLM-backed operation without a model) succeeded; report upstream errors as they are.`;

function unavailable(tool: string, detail: string): ToolCallResult {
  return { ok: false, status: "degraded", tool, data: null, error: detail };
}

const capabilityUnavailable = (tool: string) => unavailable(tool,
  `engine_capability_unavailable: ${tool} is not provided by the Hindsight engine; use the native memory surface (/api/brain/native/tools)`);

function redact(text: string, extra: readonly string[]): string {
  const secrets = [...extra, ...Object.entries(process.env).filter(([key, value]) => /(?:TOKEN|SECRET|API_KEY|PASSWORD)/u.test(key) && value && value.length >= 8).map(([, value]) => value!)];
  return secrets.filter(Boolean).reduce((current, secret) => current.split(secret).join("[REDACTED]"), text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every document_id anywhere in a payload, including JSON-encoded multipart fields. */
function documentIds(value: unknown, depth = 0, found: string[] = []): string[] {
  if (depth > 32) return found;
  if (typeof value === "string" && depth > 0 && /^\s*[{[]/u.test(value)) {
    try { documentIds(JSON.parse(value), depth + 1, found); } catch { /* plain text */ }
  } else if (Array.isArray(value)) value.forEach(item => documentIds(item, depth + 1, found));
  else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if ((key === "document_id" || key === "document_ids") && (typeof item === "string" || Array.isArray(item))) found.push(...[item].flat().filter((id): id is string => typeof id === "string"));
      else documentIds(item, depth + 1, found);
    }
  }
  return found;
}

const reservedDocument = (id: string) => RESERVED_DOCUMENT_PREFIXES.some(prefix => id.toLowerCase().startsWith(prefix));

function pathValueRefusal(name: string, value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 1024) return `${name} must be a non-empty string`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/u.test(value) || value.split("/").some(segment => segment === "." || segment === "..")) return `${name} contains a forbidden path segment`;
  return null;
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/** OpenAPI → agent input schema; component refs become local $defs. */
function inputSchema(spec: HindsightOperationSpec): Record<string, unknown> {
  const components = hindsightOpenApi().components.schemas;
  const defs: Record<string, unknown> = {};
  const binaryFile = { type: "object", description: "File content for a multipart field.", additionalProperties: false,
    properties: { filename: { type: "string" }, contentBase64: { type: "string" }, contentType: { type: "string" } }, required: ["contentBase64"] };
  const rewrite = (value: unknown): unknown => {
    // $ref targets and discriminator mappings both name components.
    if (typeof value === "string" && value.startsWith("#/components/schemas/")) {
      const name = value.slice("#/components/schemas/".length);
      if (!(name in defs)) { defs[name] = {}; defs[name] = rewrite(components[name]); }
      return `#/$defs/${name}`;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (!isRecord(value)) return value;
    if (spec.body === "multipart" && value.type === "string" && typeof value.contentMediaType === "string") return binaryFile;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
  };
  const properties: Record<string, unknown> = {};
  for (const name of spec.pathParams) properties[name] = { type: "string", description: "Path parameter" };
  for (const query of spec.queryParams) properties[query.name] = rewrite({ ...(isRecord(query.schema) ? query.schema : {}), ...(query.description ? { description: query.description } : {}) });
  if (spec.body) properties.body = rewrite(spec.bodySchema ?? { type: "object" });
  const required = [...spec.pathParams, ...spec.queryParams.filter(q => q.required).map(q => q.name), ...(spec.body && spec.bodyRequired ? ["body"] : [])];
  return { type: "object", properties, required, additionalProperties: false, ...(Object.keys(defs).length ? { $defs: defs } : {}) };
}

export class HindsightMemoryEngine {
  readonly engine = "hindsight" as const;
  private state: State = "disabled";
  private detail: string | null = null;
  private observedVersion: string | null = null;
  private client: HindsightClient | null = null;

  constructor(private readonly config: KnowledgeConfig, private readonly options: { readonly fetch?: typeof fetch } = {}) {}

  async start(): Promise<void> {
    this.client = null;
    this.observedVersion = null;
    try {
      if (!this.config.hindsightUrl || !this.config.hindsightApiKey) throw new Error("KNOWLEDGE_HINDSIGHT_URL and KNOWLEDGE_HINDSIGHT_API_KEY must be set for KNOWLEDGE_MEMORY_ENGINE=hindsight");
      this.client = new HindsightClient({ baseUrl: this.config.hindsightUrl, apiKey: this.config.hindsightApiKey, fetch: this.options.fetch, timeoutMs: 120_000 });
      const healthy = await this.client.health();
      this.observedVersion = healthy ? await this.client.version() : null;
      this.state = healthy ? "online" : "degraded";
      this.detail = healthy ? null : "Hindsight service unavailable";
    } catch (error) {
      this.state = "degraded";
      this.detail = error instanceof Error ? error.message : String(error);
    }
  }

  async close(): Promise<void> { this.state = "disabled"; }

  status() {
    return {
      status: this.state,
      runtime: "hindsight" as const,
      observedVersion: this.observedVersion,
      baseUrl: this.client ? new URL(this.config.hindsightUrl!).origin : null,
      home: this.config.gbrainHome,
      repoPath: null,
      schemaPack: { name: KNOWLEDGE_GBRAIN_SCHEMA_PACK_NAME, status: "not-managed" as const, detail: "The Hindsight service manages its own schema" },
      tokenConfigured: Boolean(this.config.hindsightApiKey),
      topology: "hindsight-service" as const,
      // One bank per authorized partition: everything retained is visible only inside that partition.
      factsVisibility: "partition_private" as const,
      detail: this.detail,
    };
  }

  nativeCapabilityReadiness() {
    const ready = this.state === "online";
    const gap = (operation: string) => ({ operation, status: "unavailable" as const });
    return {
      status: ready ? "ready" as const : "degraded" as const,
      capabilities: {
        pageEnumeration: { operation: "list_documents", status: ready ? "unknown" as const : "unavailable" as const },
        entityCard: gap("entity"),
        timeline: gap("get_timeline"),
        typedRelationships: gap("get_links + traverse_graph"),
      },
      capabilityGaps: [
        ...(ready ? [] : [{ code: "hindsight_unavailable", detail: this.detail ?? "Hindsight is not online" }]),
        ...["entity", "get_timeline", "get_links + traverse_graph"].map(operation => ({ code: "engine_capability_unavailable", detail: `${operation} is not provided by the Hindsight engine` })),
      ],
    };
  }

  nativeOperationPolicy(name: string): NativeOperationPolicy | null {
    return hindsightExposure().exposed.get(name) ?? null;
  }

  // ------------------------------------------------- Program surfaces ---

  private async program(tool: string, partitionKey: string | undefined, write: boolean, run: (client: HindsightClient, partition: string) => Promise<unknown>): Promise<ToolCallResult> {
    if (write && brainWritesPaused()) return unavailable(tool, "brain_writes_paused");
    const partition = partitionKey ? normalizeKnowledgePartitionKey(partitionKey) : null;
    if (!partition) return unavailable(tool, "brain_partition_binding_required: select an authorized Knowledge partition");
    if (this.state !== "online" || !this.client) return unavailable(tool, this.detail ?? "Hindsight service is not online");
    try { return { ok: true, status: "ready", tool, data: await run(this.client, partition) }; }
    catch (error) {
      const code = error instanceof HindsightError ? `${error.code}${error.status ? ` (HTTP ${error.status})` : ""}` : "hindsight_unavailable";
      return unavailable(tool, code);
    }
  }

  private retainCanonical(tool: string, partitionKey: string, documentId: string, content: string, metadata: Record<string, string>) {
    return this.program(tool, partitionKey, true, (client, partition) => client.retain(partition, [{ content, documentId, context: "Knowledge canonical record", metadata }],
      // Identical content replays the same async operation instead of enqueueing duplicate work.
      deterministicRequestId("hindsight_retain", partition, documentId, createHash("sha256").update(content).digest("hex")), { async: true }));
  }

  projectDocument(document: KnowledgeDocument): Promise<ToolCallResult> {
    return this.retainCanonical("retain", document.companyId, `knowledge-doc:${document.id}`, documentToMarkdown(document), { knowledge_kind: "document", knowledge_id: document.id });
  }

  projectResearchSource(source: ResearchSource): Promise<ToolCallResult> {
    return this.retainCanonical("retain", source.companyId, `knowledge-research:${source.id}`, researchSourceToMarkdown(source), { knowledge_kind: "research_source", knowledge_id: source.id });
  }

  async deleteProjection(id: string, partitionKey: string, kind: "document" | "research"): Promise<ToolCallResult> {
    return this.program("delete_document", partitionKey, true, async (client, partition) => {
      try { return await client.deleteDocument(partition, `${kind === "document" ? "knowledge-doc" : "knowledge-research"}:${id}`); }
      catch (error) { if (error instanceof HindsightError && error.status === 404) return { status: "absent" }; throw error; }
    });
  }

  /** Retain extracts facts itself; a projection's extraction is subsumed by its retain. */
  async extractFacts(input: { readonly text: string; readonly sessionId?: string | null; readonly entityHints?: readonly string[]; readonly partitionKey?: string; readonly sourceSlug?: string; readonly validFrom?: string }): Promise<ToolCallResult> {
    if (input.sourceSlug) return this.program("extract_facts", input.partitionKey, true, async () => ({ status: "subsumed_by_retain", sourceSlug: input.sourceSlug }));
    const documentId = `knowledge-extract:${createHash("sha256").update(input.sessionId ?? input.text).digest("hex").slice(0, 32)}`;
    return this.program("extract_facts", input.partitionKey, true, (client, partition) => client.retain(partition, [{ content: input.text, documentId, context: "Knowledge extract-facts",
      ...(input.validFrom ? { timestamp: input.validFrom } : {}) }]));
  }

  recall(input: { readonly query?: string; readonly entity?: string; readonly limit?: number; readonly partitionKey?: string; readonly budgetTokens?: number }): Promise<ToolCallResult> {
    if (!input.query) return Promise.resolve(capabilityUnavailable("recall"));
    return this.program("recall", input.partitionKey, false, (client, partition) => client.recall(partition, { query: input.query!, ...(input.budgetTokens ? { maxTokens: input.budgetTokens } : {}) }));
  }

  query(input: { readonly query: string; readonly limit?: number; readonly partitionKey?: string }): Promise<ToolCallResult> {
    return this.program("query", input.partitionKey, false, (client, partition) => client.recall(partition, { query: input.query }));
  }

  listPages(input: { readonly limit?: number; readonly offset?: number; readonly partitionKey?: string } = {}): Promise<ToolCallResult> {
    return this.program("list_documents", input.partitionKey, false, async (client, partition) => {
      const query = new URLSearchParams({ limit: String(Math.min(Math.max(input.limit ?? 100, 1), 100)), offset: String(input.offset ?? 0) });
      const response = await client.invoke(`${client.bankPrefix(partition)}/documents?${query}`, "GET");
      if (response.status < 200 || response.status >= 300) throw new HindsightError(response.status >= 500 ? "hindsight_unavailable" : "hindsight_rejected", response.status);
      const items = (JSON.parse(response.bytes.toString("utf8")) as { items?: unknown[] }).items ?? [];
      // Page-shaped rows for the Brain register; ids are Hindsight document ids.
      return items.filter(isRecord).map(item => ({ slug: String(item.id), title: String(item.id), type: "document", updated_at: item.updated_at ?? item.created_at ?? null }));
    });
  }

  listEntities(input: { readonly limit?: number; readonly offset?: number; readonly type?: string; readonly partitionKey?: string } = {}) {
    return this.listPages(input);
  }

  getPage(input: { readonly slug: string; readonly partitionKey?: string }): Promise<ToolCallResult> {
    const id = input.slug.startsWith("knowledge-docs/") ? `knowledge-doc:${input.slug.slice("knowledge-docs/".length)}`
      : input.slug.startsWith("knowledge-research/sources/") ? `knowledge-research:${input.slug.slice("knowledge-research/sources/".length)}` : input.slug;
    if (pathValueRefusal("slug", id)) return Promise.resolve(unavailable("get_document", "hindsight_invalid_input"));
    return this.program("get_document", input.partitionKey, false, async (client, partition) => {
      const response = await client.invoke(`${client.bankPrefix(partition)}/documents/${encodeURIComponent(id)}`, "GET");
      if (response.status < 200 || response.status >= 300) throw new HindsightError(response.status >= 500 ? "hindsight_unavailable" : "hindsight_rejected", response.status);
      return JSON.parse(response.bytes.toString("utf8"));
    });
  }

  async getLinks(_input: { readonly slug: string; readonly partitionKey?: string }) { return capabilityUnavailable("get_links"); }
  async getTimeline(_input: { readonly slug: string; readonly partitionKey?: string }) { return capabilityUnavailable("get_timeline"); }
  async getEntityCard(_input: { readonly name: string; readonly partitionKey?: string }) { return capabilityUnavailable("entity"); }
  async traverseGraph(_input: { readonly slug: string; readonly partitionKey?: string }) { return capabilityUnavailable("traverse_graph"); }

  // --------------------------------------------------- native surface ---

  private catalog(args: Record<string, unknown>) {
    const exposure = hindsightExposure();
    const specs = hindsightOperationSpecs();
    const describe = typeof args.operation === "string" ? args.operation : null;
    const search = typeof args.query === "string" ? args.query.toLowerCase() : null;
    const tools = [...exposure.exposed.values()].filter(policy => !describe || policy.name === describe).map(policy => {
      const spec = specs.get(policy.name)!;
      const text = `${spec.summary}${spec.description && spec.description !== spec.summary ? `\n\n${spec.description}` : ""}`;
      return {
        name: policy.name, tag: spec.tag, scope: policy.scope, requiredCapabilities: policy.capabilities,
        portalCapability: policy.scope === "write" ? PORTAL_BRAIN_WRITE : PORTAL_BRAIN_READ,
        description: describe ? text : text.length > 400 ? `${text.slice(0, 400)}…` : text,
        annotations: { readOnlyHint: policy.scope === "read", destructiveHint: policy.destructive, openWorldHint: false },
        http: { method: spec.method, path: spec.path.replace("{bank_id}", "<partition bank>"), bankScoped: spec.bankScoped, body: spec.body, response: spec.response },
        ...(describe ? { inputSchema: inputSchema(spec) } : { describe: `/api/brain/native/tools?operation=${policy.name}` }),
      };
    }).filter(tool => !search || `${tool.name} ${tool.tag} ${tool.description}`.toLowerCase().includes(search));
    return { ok: true, data: {
      engine: "hindsight", engineVersion: this.observedVersion ?? exposure.version, pinnedVersion: exposure.version,
      contract: "knowledge.native-memory/v1", trust: "partition-bank-bound", topology: "hindsight-service", tools,
      excluded: [...exposure.excluded].map(([name, reason]) => ({ name, reason })),
      guidance: HINDSIGHT_NATIVE_GUIDANCE,
      bankSelection: "The bank is derived from the authorized Knowledge partition; caller bank_id is rejected",
    } };
  }

  async nativeOperation(operation: string, args: Record<string, unknown>, partitionKey: string, principalId: string): Promise<Record<string, any>> {
    const partition = normalizeKnowledgePartitionKey(partitionKey);
    const policy = operation === "catalog" ? null : this.nativeOperationPolicy(operation);
    if (!partition || !principalId || !(operation === "catalog" || policy)) return { ok: false, error: { error: "scope_denied", suggestion: "Use an authorized partition and advertised operation." } };
    if (operation === "catalog") return this.catalog(args);
    if (brainWritesPaused() && policy!.scope === "write") return { ok: false, error: { error: "unavailable", message: "Memory writes are paused for maintenance", suggestion: "Retry later with the same Idempotency-Key." } };
    if (this.state !== "online" || !this.client) return { ok: false, error: { error: "unavailable", suggestion: "The Hindsight service is not online." } };
    const spec = hindsightOperationSpecs().get(operation)!;
    const bank = hindsightBankForPartition(partition);
    const invalid = (message: string) => ({ ok: false, engine: "hindsight", engineVersion: this.observedVersion, error: { error: "invalid_params", message,
      suggestion: "Read the operation's inputSchema (GET /api/brain/native/tools?operation=<name>). The bank is selected by Knowledge." } });

    // ---- argument validation and isolation guards (before any upstream call)
    const allowed = new Set([...spec.pathParams, ...spec.queryParams.map(q => q.name), ...(spec.body ? ["body"] : [])]);
    for (const key of Object.keys(args)) {
      if (key === "bank_id" || key === "target_bank_id") return invalid(`${key} is selected by Knowledge`);
      if (!allowed.has(key)) return invalid(`Unknown argument: ${key}`);
    }
    for (const name of spec.pathParams) { const refused = pathValueRefusal(name, args[name]); if (refused) return invalid(refused); }
    for (const query of spec.queryParams) {
      const value = args[query.name];
      if (value === undefined) { if (query.required) return invalid(`Missing query parameter: ${query.name}`); continue; }
      if (!(scalar(value) || (Array.isArray(value) && value.every(scalar)))) return invalid(`${query.name} must be a scalar or an array of scalars`);
    }
    if (spec.body && args.body === undefined && spec.bodyRequired) return invalid("Missing body");
    if (args.body !== undefined && !(isRecord(args.body) || (spec.body === "json" && Array.isArray(args.body)))) return invalid("body must be an object");
    if (policy!.scope === "write" && documentIds({ path: Object.fromEntries(spec.pathParams.map(name => [name, args[name]])), body: args.body }).some(reservedDocument)
      || (policy!.scope === "write" && spec.pathParams.includes("document_id") && reservedDocument(String(args.document_id)))) {
      return invalid("Documents knowledge-doc:* and knowledge-research:* are Knowledge's canonical projections; change the Knowledge document or source instead");
    }
    if (operation === "get_chunk" && !String(args.chunk_id).startsWith(`${bank}_`)) return invalid("chunk_id must belong to this partition's bank");
    if (operation === "download_file") {
      const parts = String(args.key).split("/");
      const keyBank = parts[0] === "tenants" && parts[2] === "banks" ? decodeURIComponent(parts[3] ?? "") : parts[0] === "banks" ? parts[1] : null;
      if (keyBank !== bank) return invalid("key must be a storage key of this partition's bank");
    }
    if (operation === "import_bank_transfer") {
      if (args.mode !== "merge") return invalid("Only mode=merge (into this partition's bank) is delegated; restore mode creates a caller-named bank");
      for (const key of ["include_data", "include_bank_config", "include_history"]) if (args[key] !== undefined) return invalid(`${key} applies to restore mode only`);
    }

    // ---- request
    let path = spec.path.replace("{bank_id}", encodeURIComponent(bank));
    for (const name of spec.pathParams) path = path.replace(`{${name}}`, encodeURIComponent(String(args[name])));
    const search = new URLSearchParams();
    for (const query of spec.queryParams) {
      const value = args[query.name];
      if (value !== undefined) for (const item of [value].flat()) search.append(query.name, String(item));
    }
    const target = `${path}${search.size ? `?${search}` : ""}`;
    const resolved = new URL(target, "http://hindsight.invalid").pathname;
    const prefix = `/v1/default/banks/${encodeURIComponent(bank)}`;
    if (spec.bankScoped && resolved !== prefix && !resolved.startsWith(`${prefix}/`)) return invalid("Arguments may not leave this partition's bank");
    let payload: { json?: unknown; form?: FormData } = {};
    if (spec.body === "json" && args.body !== undefined) payload = { json: args.body };
    if (spec.body === "multipart" && isRecord(args.body)) {
      const form = new FormData();
      for (const [field, value] of Object.entries(args.body)) {
        for (const item of Array.isArray(value) && value.some(entry => isRecord(entry) && "contentBase64" in entry) ? value : [value]) {
          if (isRecord(item) && typeof item.contentBase64 === "string") {
            form.append(field, new Blob([Buffer.from(item.contentBase64, "base64")], { type: typeof item.contentType === "string" ? item.contentType : "application/octet-stream" }),
              typeof item.filename === "string" ? item.filename : "upload.bin");
          } else form.append(field, typeof item === "string" ? item : JSON.stringify(item));
        }
      }
      payload = { form };
    }

    // ---- call (transport failures throw so mutating receipts stay uncertain)
    const response = await this.client.invoke(target, spec.method, payload, NATIVE_TIMEOUT_MS);
    const engineVersion = this.observedVersion;
    const text = () => response.bytes.toString("utf8");
    if (response.status >= 500) return { ok: false, engine: "hindsight", engineVersion, error: { error: "unavailable", status: response.status, suggestion: "Inspect the Hindsight service. Do not retry a write with a new key." } };
    if (response.status >= 400) {
      let detail: unknown = null;
      try { detail = (JSON.parse(text()) as { detail?: unknown }).detail ?? null; } catch { detail = null; }
      const code = response.status === 404 ? "not_found" : response.status === 409 ? "conflict" : response.status === 400 || response.status === 422 ? "invalid_params"
        : response.status === 401 || response.status === 403 ? "upstream_auth_failed" : "rejected";
      const detailText = detail === null ? undefined : redact(typeof detail === "string" ? detail : JSON.stringify(detail), [this.config.hindsightApiKey ?? ""]).slice(0, MAX_DETAIL_CHARS);
      return { ok: false, engine: "hindsight", engineVersion, error: { error: code, status: response.status, ...(detailText ? { detail: detailText } : {}) } };
    }
    let data: unknown;
    if (spec.response === "binary" || (response.contentType && !/json/iu.test(response.contentType) && response.bytes.length)) {
      data = { contentType: response.contentType, encoding: "base64", byteLength: response.bytes.length, data: response.bytes.toString("base64") };
    } else {
      try { data = response.bytes.length ? JSON.parse(text()) : null; }
      catch { return { ok: false, engine: "hindsight", engineVersion, error: { error: "invalid_response" } }; }
    }
    // get_chunk is not bank-scoped by path: refuse a chunk owned by another bank.
    if (operation === "get_chunk" && (!isRecord(data) || data.bank_id !== bank)) return { ok: false, engine: "hindsight", engineVersion, error: { error: "not_found", status: 404 } };
    return { ok: true, engine: "hindsight", engineVersion, operation, data, metadata: { topology: "hindsight-service", status: response.status } };
  }
}
