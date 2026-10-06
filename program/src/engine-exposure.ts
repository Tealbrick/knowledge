import { readFileSync } from "node:fs";

/**
 * Upstream engine surfaces and the Knowledge exposure policy for each of them.
 *
 * The vendored snapshots under ./engine-surfaces/ are the complete operation
 * lists of the pinned upstream services (provenance inside each file). Every
 * upstream operation is either EXPOSED to agents through the native memory
 * route (`/api/brain/native/<operation>`) with an explicit read/write scope and
 * Portal capability mapping, or EXCLUDED with a reason. The coverage test
 * (engine-coverage.test.ts) and `scripts/engine-coverage-report.ts` prove the
 * two sets account for 100% of upstream.
 */

export type NativeScope = "read" | "write";

export interface NativeOperationPolicy {
  readonly name: string;
  readonly scope: NativeScope;
  /**
   * Program capabilities a CRUD-derived principal (Portal runtime grant,
   * static service principal) needs, all of them. A Portal attachment with
   * `knowledge:engine:write` reaches every write through `brain:native:write`.
   */
  readonly capabilities: readonly string[];
  readonly destructive: boolean;
}

export interface EngineExclusion {
  readonly name: string;
  readonly reason: string;
}

export interface EngineExposure {
  readonly engine: "gbrain" | "hindsight";
  readonly version: string;
  readonly provenance: Readonly<Record<string, string>>;
  /** Every upstream operation name at the pin, in upstream order. */
  readonly upstream: readonly string[];
  readonly exposed: ReadonlyMap<string, NativeOperationPolicy>;
  readonly excluded: ReadonlyMap<string, string>;
}

/**
 * Portal attachment capabilities for the native engine route. Deliberately new:
 * `knowledge:brain:read` keeps meaning Brain recall/context only and never
 * reaches the engine surface.
 */
export const PORTAL_ENGINE_READ = "knowledge:engine:read";
export const PORTAL_ENGINE_WRITE = "knowledge:engine:write";
/** Program capabilities the edge maps knowledge:engine:read / :write to; native route only. */
export const BRAIN_NATIVE_READ = "brain:native:read";
export const BRAIN_NATIVE_WRITE = "brain:native:write";

export function portalCapabilityForScope(scope: NativeScope): string {
  return scope === "write" ? PORTAL_ENGINE_WRITE : PORTAL_ENGINE_READ;
}

const READ = ["brain:read"] as const;
const C = "knowledge:create", U = "knowledge:update", D = "knowledge:delete";

function loadSurface<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./engine-surfaces/${name}`, import.meta.url), "utf8")) as T;
}

// ---------------------------------------------------------------- GBrain ---

interface GBrainUpstreamOperation {
  readonly name: string;
  readonly scope: "read" | "write" | "admin" | "sources_admin" | "users_admin" | "agent";
  readonly mutating: boolean;
  readonly localOnly: boolean;
  readonly cliOnly: boolean;
  readonly publishGateKey: string | null;
  readonly params: readonly string[];
}

/**
 * CRUD capabilities for every GBrain write a CRUD-derived principal may run.
 * remember/forget keep their existing contract.
 */
const GBRAIN_WRITE_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  remember: [C, U], forget: [D], put_page: [C, U], delete_page: [D], restore_page: [U], capture: [C], edit_page: [U],
  cancel_write_request: [U], add_tag: [U], remove_tag: [U], add_link: [C], remove_link: [D], add_timeline_entry: [C],
  revert_version: [U], put_raw_data: [C, U], log_ingest: [C], takes_add: [C], takes_update: [U], takes_resolve: [U],
  takes_supersede: [C, U], ontology_propose: [C], extract_entities: [C, U], extract_facts: [C, U], forget_fact: [D],
  mute_notice: [U],
};
const GBRAIN_DESTRUCTIVE = new Set(["forget", "delete_page", "remove_tag", "remove_link", "forget_fact"]);

/** Callable by Knowledge's read+write OAuth clients, but not delegated to agents. */
const GBRAIN_POLICY_EXCLUSIONS: Readonly<Record<string, string>> = {
  sources_list: "Enumerates every GBrain source in the service, i.e. other Knowledge partitions. Partition-to-source mapping is Knowledge-owned.",
  sources_status: "Reports on arbitrary GBrain sources (other Knowledge partitions). Partition-to-source mapping is Knowledge-owned.",
  whoami: "Describes Knowledge's internal OAuth client (client id, scopes, source binding), not the agent. The agent identity is its Knowledge principal.",
  request_tools: "MCP session tool-loading meta-op; {surface} persists a wider surface on Knowledge's OAuth client. The Knowledge catalog (/api/brain/native/tools) is the discovery surface.",
  join_brain: "Brain-wide shared-skill enrollment for the OAuth client; shared skills are a host-level registry, not partition memory.",
  sync_brain_skills: "Brain-wide shared-skill sync; shared skills are a host-level registry, not partition memory.",
  leave_brain: "Brain-wide shared-skill enrollment for the OAuth client; shared skills are a host-level registry, not partition memory.",
  put_skill: "Writes the brain-wide skill registry, which is shared across every partition in the service.",
  delete_skill: "Deletes from the brain-wide skill registry, which is shared across every partition in the service.",
  open_loops: "Delta A13: open loops are not source/world-filtered for remote callers at the pin, so Knowledge withholds them (also from entity cards).",
  loops_close: "Delta A13: acts on open loops, which Knowledge withholds because their evidence visibility is not provable at the pin.",
  loops_mute: "Delta A13: acts on open loops, which Knowledge withholds because their evidence visibility is not provable at the pin.",
  loops_unmute: "Delta A13: acts on open loops, which Knowledge withholds because their evidence visibility is not provable at the pin.",
};

let gbrainCache: EngineExposure | null = null;

/** The pinned GBrain service (`gbrain serve --http`, one OAuth client per source and principal). */
export function gbrainServiceExposure(): EngineExposure {
  if (gbrainCache) return gbrainCache;
  const surface = loadSurface<{ provenance: Record<string, string>; operations: GBrainUpstreamOperation[] }>("gbrain-0.60.57.0.json");
  const exposed = new Map<string, NativeOperationPolicy>();
  const excluded = new Map<string, string>();
  for (const op of surface.operations) {
    if (op.scope !== "read" && op.scope !== "write") {
      excluded.set(op.name, `Upstream requires the '${op.scope}' OAuth scope. Knowledge partition clients hold read+write only; host/source/agent administration is not delegated to agents.`);
    } else if (op.cliOnly) {
      excluded.set(op.name, "Upstream cliOnly: refused on every agent transport; only the trusted local CLI runs it.");
    } else if (op.localOnly) {
      excluded.set(op.name, "Upstream localOnly: refused over the HTTP transport (host filesystem/connector access).");
    } else if (op.publishGateKey) {
      excluded.set(op.name, `Upstream hides it from remote callers unless ${op.publishGateKey} is enabled; the Knowledge GBrain template does not enable it.`);
    } else if (GBRAIN_POLICY_EXCLUSIONS[op.name]) {
      excluded.set(op.name, GBRAIN_POLICY_EXCLUSIONS[op.name]!);
    } else {
      const write = op.scope === "write" && op.mutating;
      const capabilities = write ? GBRAIN_WRITE_CAPABILITIES[op.name] : READ;
      if (!capabilities) throw new Error(`GBrain write ${op.name} has no capability mapping`);
      exposed.set(op.name, { name: op.name, scope: write ? "write" : "read", capabilities, destructive: GBRAIN_DESTRUCTIVE.has(op.name) });
    }
  }
  gbrainCache = { engine: "gbrain", version: surface.provenance.tag!.replace(/^v/u, ""), provenance: surface.provenance,
    upstream: surface.operations.map(op => op.name), exposed, excluded };
  return gbrainCache;
}

// ------------------------------------------------------------- Hindsight ---

export interface HindsightQueryParam { readonly name: string; readonly required: boolean; readonly schema: unknown; readonly description?: string }
export interface HindsightOperationSpec {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly description: string;
  /** Path parameters other than bank_id, in path order. */
  readonly pathParams: readonly string[];
  readonly queryParams: readonly HindsightQueryParam[];
  readonly body: "json" | "multipart" | null;
  readonly bodyRequired: boolean;
  readonly bodySchema: unknown;
  readonly response: "json" | "binary";
  /** True when the route is under /v1/default/banks/{bank_id}. */
  readonly bankScoped: boolean;
}

interface OpenApi {
  info: { version: string };
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, unknown> };
}

let openApiCache: OpenApi | null = null;
export function hindsightOpenApi(): OpenApi {
  return openApiCache ??= loadSurface<OpenApi>("hindsight-0.10.2.openapi.json");
}

let specCache: ReadonlyMap<string, HindsightOperationSpec> | null = null;
export function hindsightOperationSpecs(): ReadonlyMap<string, HindsightOperationSpec> {
  if (specCache) return specCache;
  const specs = new Map<string, HindsightOperationSpec>();
  for (const [path, item] of Object.entries(hindsightOpenApi().paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const params = (op.parameters ?? []) as Array<{ name: string; in: string; required?: boolean; schema?: unknown; description?: string }>;
      const content = op.requestBody?.content ?? {};
      const responses = op.responses?.["200"]?.content ?? op.responses?.["201"]?.content ?? op.responses?.["202"]?.content ?? {};
      specs.set(op.operationId, {
        name: op.operationId, method: method.toUpperCase() as HindsightOperationSpec["method"], path, tag: (op.tags ?? [""])[0],
        summary: op.summary ?? "", description: op.description ?? "",
        pathParams: params.filter(p => p.in === "path" && p.name !== "bank_id").map(p => p.name),
        queryParams: params.filter(p => p.in === "query").map(p => ({ name: p.name, required: Boolean(p.required), schema: p.schema, ...(p.description ? { description: p.description } : {}) })),
        body: content["multipart/form-data"] ? "multipart" : content["application/json"] ? "json" : null,
        bodyRequired: Boolean(op.requestBody?.required),
        bodySchema: (content["multipart/form-data"] ?? content["application/json"])?.schema ?? null,
        response: Object.keys(responses).length && !responses["application/json"] ? "binary" : "json",
        bankScoped: path.startsWith("/v1/default/banks/{bank_id}"),
      });
    }
  }
  specCache = specs;
  return specs;
}

/** POSTs that only read (synthesis, previews, dry runs, exports of this bank). */
const HINDSIGHT_READ_POSTS = new Set([
  "recall_memories", "reflect", "dry_run_extract_memories", "preview_prompt", "test_bank_llm",
  "dry_run_refresh_mental_model", "preview_consolidation_strategies",
]);
// export_documents / export_bank_transfer stay writes: they create an operation and a stored archive.
/** Writes that may create or replace (upsert semantics). */
const HINDSIGHT_UPSERTS = new Set(["retain_memories", "file_retain", "import_documents", "import_bank_template", "create_or_update_bank"]);
/** POST actions on existing objects. */
const HINDSIGHT_UPDATE_POSTS = new Set([
  "refresh_mental_model", "clear_mental_model", "regenerate_entity_observations", "reprocess_document", "retry_operation",
  "recover_consolidation", "trigger_consolidation", "add_bank_background",
]);

const HINDSIGHT_EXCLUSIONS: Readonly<Record<string, string>> = {
  health_endpoint_health_get: "Host liveness probe. Knowledge reports engine health in its own status (/healthz, /api/status).",
  get_readiness: "Host readiness probe. Knowledge reports engine health in its own status (/healthz, /api/status).",
  get_liveness: "Host liveness probe. Knowledge reports engine health in its own status (/healthz, /api/status).",
  metrics_endpoint_metrics_get: "Host-wide Prometheus metrics spanning every bank (every partition).",
  list_banks: "Enumerates every bank in the service, i.e. other Knowledge partitions. The bank is derived from the authorized partition, never listed or chosen.",
  delete_bank: "Admin/destructive: deletes the partition's whole bank. Partition lifecycle is owned by Knowledge and its operator.",
  clear_bank_memories: "Admin/destructive: wipes every memory in the partition, including Knowledge's canonical document projections. A partition reset is an operator action.",
  clone_bank: "Writes a caller-named target bank (target_bank_id), which could be another partition's derived bank.",
  import_bank_transfer: "Upstream restore inserts archive rows verbatim with their own bank_id when target==manifest source → cross-bank write (all Knowledge partitions share one Hindsight schema).",
  create_bank_alias: "Aliases are a global namespace resolved before bank lookup; an alias could capture another partition's derived bank id.",
  set_bank_alias_primary: "Aliases are a global namespace resolved before bank lookup; an alias could capture another partition's derived bank id.",
  delete_bank_alias: "Aliases are a global namespace; alias management is not delegated (only listing this bank's aliases is).",
  create_webhook: "The Hindsight service would POST memory content to a caller-chosen URL from the private network (SSRF and off-platform exfiltration).",
  update_webhook: "Can change a webhook URL: the Hindsight service would POST memory content to a caller-chosen URL from the private network (SSRF and off-platform exfiltration).",
  export_documents_sync_removed: "Retired upstream: always answers 410 Gone at the pin; export_documents / export_bank_transfer replace it.",
  get_bank_profile: "Retired upstream: always answers 410 Gone at the pin; disposition and reflect mission are read with get_bank_config (exposed).",
  update_bank_disposition: "Retired upstream: always answers 410 Gone at the pin; disposition is written with update_bank_config (exposed).",
  add_bank_background: "Retired upstream: always answers 410 Gone at the pin; the background is reflect_mission, written with update_bank_config (exposed).",
  regenerate_entity_observations: "Retired upstream: always answers 410 Gone at the pin; entity observations were replaced by mental models (exposed).",
};

function hindsightPolicy(spec: HindsightOperationSpec): NativeOperationPolicy {
  const read = spec.method === "GET" || HINDSIGHT_READ_POSTS.has(spec.name);
  if (read) return { name: spec.name, scope: "read", capabilities: READ, destructive: false };
  const capabilities = HINDSIGHT_UPSERTS.has(spec.name) ? [C, U]
    : spec.method === "DELETE" ? [D]
    : spec.method === "PATCH" || spec.method === "PUT" || HINDSIGHT_UPDATE_POSTS.has(spec.name) ? [U]
    : [C];
  return { name: spec.name, scope: "write", capabilities, destructive: spec.method === "DELETE" || spec.name === "clear_mental_model" };
}

let hindsightCache: EngineExposure | null = null;
export function hindsightExposure(): EngineExposure {
  if (hindsightCache) return hindsightCache;
  const surface = loadSurface<{ provenance: Record<string, string> }>("hindsight-0.10.2.json");
  const specs = hindsightOperationSpecs();
  const exposed = new Map<string, NativeOperationPolicy>();
  const excluded = new Map<string, string>();
  for (const spec of specs.values()) {
    const reason = HINDSIGHT_EXCLUSIONS[spec.name];
    if (reason) excluded.set(spec.name, reason);
    else exposed.set(spec.name, hindsightPolicy(spec));
  }
  hindsightCache = { engine: "hindsight", version: hindsightOpenApi().info.version, provenance: surface.provenance,
    upstream: [...specs.keys()], exposed, excluded };
  return hindsightCache;
}

/** MCP tools Hindsight ships at the pin, each mapped to the HTTP operation it wraps. */
export function hindsightMcpTools(): readonly { name: string; operationId: string }[] {
  return loadSurface<{ mcpTools: { name: string; operationId: string }[] }>("hindsight-0.10.2.json").mcpTools;
}
