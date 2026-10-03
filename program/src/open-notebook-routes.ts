import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ResearchPrincipalProvider } from './portal-research-principal.js';
import {
  OPEN_NOTEBOOK_CONTRACT_BASELINE,
  OPEN_NOTEBOOK_OBSERVED_VERSION,
  OpenNotebookAdapterError,
  type OpenNotebookAdapter,
  type OpenNotebookNote,
  type OpenNotebookNotebook,
  type OpenNotebookSourceListOptions,
  type OpenNotebookSource,
} from "./open-notebook.js";
import type {
  KnowledgePrincipalResolver,
  KnowledgeServicePrincipal,
} from "./knowledge-principal.js";
import { authorizeKnowledgePartition, effectiveKnowledgePartitionGrants } from "./partition-authority.js";
import { ResearchWriteLedgerError, type ResearchWriteLedger, type ResearchWriteIntent, type ResearchWriteScope, type TextSourceWriteRequest } from "./research-write-ledger.js";
import { registerOpenNotebookChatRoutes } from "./open-notebook-chat-routes.js";
import type { OpenNotebookChatAdapter } from "./open-notebook-chat.js";
import type { ResearchChatLedger } from "./research-chat-ledger.js";
import {
  browserSessionErrorStatus,
  ResearchBrowserSessionAuthority,
  ResearchBrowserSessionError,
} from "./research-browser-session.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set only after server-side principal and notebook-company checks pass. */
    knowledgePrincipal?: KnowledgeServicePrincipal;
  }
}

export interface OpenNotebookNotebookBinding {
  readonly knowledgeNotebookId: string;
  readonly companyId: string;
  readonly externalNotebookId: string;
}

/** Local Knowledge metadata used by the mapped-notebook discovery contract. */
export interface OpenNotebookNotebookSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export type OpenNotebookRouteAdapter = Pick<
  OpenNotebookAdapter,
  "getNotebook" | "listNotebookSources" | "listNotebookNotes" | "getNotebookSource"
> & Partial<Pick<OpenNotebookAdapter, "getNotebookNote" | "createNotebookTextSource" | "getNotebookContext">>;

export interface OpenNotebookRouteOptions {
  readonly researchPrincipalProvider?: ResearchPrincipalProvider;
  readonly adapter: OpenNotebookRouteAdapter | null;
  readonly principals: KnowledgePrincipalResolver;
  readonly bindings: readonly OpenNotebookNotebookBinding[];
  readonly resolveNotebookCompany: (knowledgeNotebookId: string) => string | null;
  /** Resolve current local metadata; never returns upstream notebook data. */
  readonly resolveNotebookSummary?: (knowledgeNotebookId: string) => OpenNotebookNotebookSummary | null;
  readonly ledger?: ResearchWriteLedger | null;
  readonly chatAdapter?: OpenNotebookChatAdapter | null;
  readonly chatLedger?: ResearchChatLedger | null;
  readonly chatModelId?: string | null;
  readonly browserSession?: ResearchBrowserSessionAuthority | null;
}

interface NotebookParams {
  readonly notebookId: string;
}

interface SourceParams extends NotebookParams {
  readonly sourceId: string;
}

interface NoteParams extends NotebookParams {
  readonly noteId: string;
}

interface SourceQuerystring {
  readonly limit?: string;
  readonly offset?: string;
}

interface DiscoveryQuerystring {
  readonly limit?: string;
  readonly offset?: string;
}

type PrincipalRequest = Pick<FastifyRequest, "headers" | "method"> & {
  knowledgePrincipal?: KnowledgeServicePrincipal;
  knowledgePartitionKey?: string;
};

type NotebookRequest = PrincipalRequest & {
  readonly params: NotebookParams;
};

interface StoredNotebookBinding {
  readonly knowledgeNotebookId: string;
  readonly companyId: string;
  readonly externalNotebookId: string;
}

interface MappingIndex {
  readonly invalid: boolean;
  readonly byKnowledgeId: ReadonlyMap<string, StoredNotebookBinding>;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const BINDING_KEYS = new Set(["knowledgeNotebookId", "companyId", "externalNotebookId"]);
const DISCOVERY_DEFAULT_LIMIT = 50;
const DISCOVERY_MAX_LIMIT = 50;
const DISCOVERY_MAX_OFFSET = 200;
const DISCOVERY_MAX_MAPPINGS = 200;
const DISCOVERY_NAME_MAX_BYTES = 4096;
const DISCOVERY_DESCRIPTION_MAX_BYTES = 16_384;

function safeId(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

function buildMappingIndex(bindings: readonly OpenNotebookNotebookBinding[]): MappingIndex {
  if (!Array.isArray(bindings)) return { invalid: true, byKnowledgeId: new Map() };
  const byKnowledgeId = new Map<string, StoredNotebookBinding>();
  const externalIds = new Set<string>();
  for (const value of bindings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { invalid: true, byKnowledgeId: new Map() };
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== BINDING_KEYS.size || keys.some((key) => !BINDING_KEYS.has(key))) {
      return { invalid: true, byKnowledgeId: new Map() };
    }
    const knowledgeNotebookId = safeId(record.knowledgeNotebookId);
    const companyId = safeId(record.companyId);
    const externalNotebookId = safeId(record.externalNotebookId);
    if (!knowledgeNotebookId || !companyId || !externalNotebookId || byKnowledgeId.has(knowledgeNotebookId) || externalIds.has(externalNotebookId)) {
      return { invalid: true, byKnowledgeId: new Map() };
    }
    const stored = Object.freeze({ knowledgeNotebookId, companyId, externalNotebookId });
    byKnowledgeId.set(knowledgeNotebookId, stored);
    externalIds.add(externalNotebookId);
  }
  return { invalid: false, byKnowledgeId };
}

function bearerToken(request: Pick<FastifyRequest, "headers">): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const parts = header.trim().split(/\s+/u);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer" || !parts[1]) return null;
  return parts[1];
}

function sendError(reply: FastifyReply, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503, error: string) {
  return reply.code(status).send({ error });
}

function sendBrowserError(reply: FastifyReply, error: unknown) {
  const status = browserSessionErrorStatus(error) as 401 | 403 | 429 | 503;
  const code = error instanceof ResearchBrowserSessionError ? error.code : "browser_session_authority_unavailable";
  return sendError(reply, status, code);
}

function adapterError(error: unknown): { readonly status: 409 | 413 | 502 | 503; readonly code: string } {
  if (error instanceof OpenNotebookAdapterError) {
    if (error.code === "context_limit_exceeded") return { status: 413, code: "research_context_limit_exceeded" };
    if (error.code === "context_membership_changed") return { status: 409, code: "research_context_membership_changed" };
    if (error.code === "incomplete_context") return { status: 502, code: "research_context_incomplete" };
    if (["invalid_config", "invalid_identifier", "identifier_mismatch", "malformed_response", "unexpected_content_type", "notebook_membership_denied"].includes(error.code)) {
      return { status: 502, code: "research_engine_contract_error" };
    }
  }
  return { status: 503, code: "research_engine_unavailable" };
}

function responseEnvelope<T>(field: string, value: T): Record<string, unknown> {
  return {
    provider: "open_notebook",
    contractBaseline: OPEN_NOTEBOOK_CONTRACT_BASELINE,
    observedVersion: OPEN_NOTEBOOK_OBSERVED_VERSION,
    [field]: value,
  };
}

function projectNotebook(notebook: OpenNotebookNotebook) {
  return {
    id: notebook.id,
    name: notebook.name,
    description: notebook.description,
    archived: notebook.archived,
    created: notebook.created,
    updated: notebook.updated,
    sourceCount: notebook.sourceCount,
    noteCount: notebook.noteCount,
  };
}

function projectSource(source: OpenNotebookSource, includeFullText: boolean) {
  return {
    id: source.id,
    title: source.title,
    topics: source.topics,
    asset: source.asset ? { url: source.asset.url } : null,
    ...(includeFullText ? { fullText: source.fullText } : {}),
    embedded: source.embedded,
    embeddedChunks: source.embeddedChunks,
    insightsCount: source.insightsCount,
    fileAvailable: source.fileAvailable,
    created: source.created,
    updated: source.updated,
    commandId: source.commandId,
    status: source.status,
  };
}

function projectNote(note: OpenNotebookNote) {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    noteType: note.noteType,
    created: note.created,
    updated: note.updated,
    commandId: note.commandId,
  };
}

function parsePagination(request: FastifyRequest<{ Querystring: SourceQuerystring }>): { readonly options: OpenNotebookSourceListOptions; readonly limit: number; readonly offset: number } | null {
  const query = request.query;
  if (!query || typeof query !== "object" || Object.keys(query).some((key) => !["limit", "offset"].includes(key))) return null;
  const parse = (value: unknown, fallback: number, minimum: number, maximum: number): number | null => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
  };
  const limit = parse(query.limit, 50, 1, 100);
  const offset = parse(query.offset, 0, 0, 10_000_000);
  if (limit === null || offset === null) return null;
  return {
    options: { limit, offset, sortBy: "updated", sortOrder: "desc" },
    limit,
    offset,
  };
}

function parseDiscoveryPagination(
  request: FastifyRequest<{ Querystring: DiscoveryQuerystring }>,
): { readonly limit: number; readonly offset: number } | null {
  const query = request.query;
  if (!query || typeof query !== "object" || Object.keys(query).some((key) => !["limit", "offset"].includes(key))) return null;
  const parse = (value: unknown, fallback: number, minimum: number, maximum: number): number | null => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
  };
  const limit = parse(query.limit, DISCOVERY_DEFAULT_LIMIT, 1, DISCOVERY_MAX_LIMIT);
  const offset = parse(query.offset, 0, 0, DISCOVERY_MAX_OFFSET);
  return limit === null || offset === null ? null : { limit, offset };
}

function validNotebookSummary(summary: OpenNotebookNotebookSummary, mapping: StoredNotebookBinding): boolean {
  return Boolean(
    summary &&
    typeof summary === "object" &&
    safeId(summary.id) === mapping.knowledgeNotebookId &&
    typeof summary.name === "string" &&
    summary.name.trim().length > 0 &&
    Buffer.byteLength(summary.name, "utf8") <= DISCOVERY_NAME_MAX_BYTES &&
    typeof summary.description === "string" &&
    Buffer.byteLength(summary.description, "utf8") <= DISCOVERY_DESCRIPTION_MAX_BYTES,
  );
}

function samePrincipal(left: KnowledgeServicePrincipal | undefined, right: KnowledgeServicePrincipal): boolean {
  if (!left || left.kind !== right.kind || left.principalId !== right.principalId || left.companyId !== right.companyId || left.capabilities.length !== right.capabilities.length) return false;
  const capabilities = new Set(left.capabilities);
  if (!right.capabilities.every((capability) => capabilities.has(capability))) return false;
  const grantSignature = (principal: KnowledgeServicePrincipal) => effectiveKnowledgePartitionGrants(principal)
    .map((grant) => JSON.stringify({
      partitionKey: grant.partitionKey,
      breadth: grant.breadth,
      maxDepth: grant.maxDepth,
      capabilities: grant.capabilities ? [...grant.capabilities].sort() : null,
    }))
    .sort();
  return JSON.stringify(grantSignature(left)) === JSON.stringify(grantSignature(right));
}

function hasFramedBody(request: Pick<FastifyRequest, "headers" | "body">): boolean {
  const transferEncoding = request.headers["transfer-encoding"];
  const contentLength = request.headers["content-length"];
  return transferEncoding !== undefined ||
    (contentLength !== undefined && (Array.isArray(contentLength) || contentLength !== "0")) ||
    request.body !== undefined;
}

export function registerOpenNotebookRoutes(
  app: FastifyInstance,
  options: OpenNotebookRouteOptions,
): void {
  const mappings = buildMappingIndex(options.bindings);

  const resolvePrincipal = async (
    request: PrincipalRequest,
    reply: FastifyReply,
    capability: string,
  ): Promise<KnowledgeServicePrincipal | null> => {
    if (!options.researchPrincipalProvider && (!options.principals || !options.principals.configured || typeof options.principals.resolve !== "function")) {
      sendError(reply, 503, "principal_authority_unavailable");
      return null;
    }

    const hasAuthorizationHeader = request.headers.authorization !== undefined;
    const hasBrowserRequestHeaders =
      request.headers.origin !== undefined ||
      request.headers.cookie !== undefined ||
      request.headers["sec-fetch-site"] !== undefined;
    if (!options.browserSession && request.headers.origin !== undefined) {
      // Engine routes never opt into cross-origin browser bearer use. A
      // server-to-server bearer without browser headers remains supported.
      sendError(reply, 403, "research_origin_denied");
      return null;
    }
    if (options.browserSession && (hasBrowserRequestHeaders || !hasAuthorizationHeader)) {
      try {
        // Browser-enabled Research is same-origin-only even when a bearer is
        // used. A server-to-server bearer with no Origin remains supported.
        options.browserSession.assertSameOrigin(request.headers, request.method);
      } catch (error) {
        sendBrowserError(reply, error);
        return null;
      }
    }

    let principal: KnowledgeServicePrincipal | null;
    if (!hasAuthorizationHeader && options.browserSession) {
      try {
        principal = options.browserSession.authenticate(request.headers, request.method);
      } catch (error) {
        sendBrowserError(reply, error);
        return null;
      }
      if (!principal) {
        sendError(reply, 401, "authentication_required");
        return null;
      }
    } else {
      const token = bearerToken(request);
      if (!token) {
        sendError(reply, 401, "authentication_required");
        return null;
      }
      try {
        // An installed provider owns bearer admission; denial never falls back
        // to a static service token. Standalone defaults remain unchanged.
        principal = options.researchPrincipalProvider
          ? await options.researchPrincipalProvider(request, capability)
          : options.principals.resolve(token);
      } catch {
        sendError(reply, 503, "principal_authority_unavailable");
        return null;
      }
      if (!principal) {
        sendError(reply, 401, "authentication_required");
        return null;
      }
    }
    if (principal.kind !== "service" || !principal.capabilities.includes(capability)) {
      sendError(reply, 403, "insufficient_capability");
      return null;
    }
    return principal;
  };

  const authorize = async (
    request: FastifyRequest<{ Params: NotebookParams }>,
    reply: FastifyReply,
    capability: string,
  ): Promise<void> => {
    const principal = await resolvePrincipal(request, reply, capability);
    if (reply.sent || !principal) return;
    if (mappings.invalid) {
      sendError(reply, 503, "notebook_mapping_unavailable");
      return;
    }
    const notebookId = request.params?.notebookId;
    const mapping = mappings.byKnowledgeId.get(notebookId);
    if (!mapping) {
      sendError(reply, 404, "notebook_not_found");
      return;
    }
    let currentCompany: string | null;
    try {
      currentCompany = options.resolveNotebookCompany(notebookId);
    } catch {
      sendError(reply, 503, "notebook_owner_unavailable");
      return;
    }
    if (currentCompany === null) {
      sendError(reply, 404, "notebook_not_found");
      return;
    }
    const partition = authorizeKnowledgePartition(principal, mapping.companyId, capability);
    if (typeof currentCompany !== "string" || !currentCompany || currentCompany !== mapping.companyId || !partition.allowed) {
      sendError(reply, 403, "notebook_scope_denied");
      return;
    }
    request.knowledgePrincipal = principal;
    request.knowledgePartitionKey = partition.partitionKey;
  };

  const withAdapter = async (
    reply: FastifyReply,
    action: (adapter: OpenNotebookRouteAdapter, mapping: StoredNotebookBinding) => Promise<unknown>,
    request: NotebookRequest,
    capability = "research:read",
  ) => {
    if (reply.sent) return undefined;
    const mapping = mappings.byKnowledgeId.get(request.params.notebookId);
    if (!mapping) return undefined;

    // The app's global Rules hook may run between this route's onRequest hook
    // and the handler. Re-read both authorities immediately before any
    // upstream call so deletion, revocation, or ownership changes fail closed.
    const principal = await resolvePrincipal(request, reply, capability);
    if (reply.sent || !principal) return undefined;
    let currentCompany: string | null;
    try {
      currentCompany = options.resolveNotebookCompany(request.params.notebookId);
    } catch {
      return sendError(reply, 503, "notebook_owner_unavailable");
    }
    if (currentCompany === null) return sendError(reply, 404, "notebook_not_found");
    const partition = authorizeKnowledgePartition(principal, mapping.companyId, capability);
    if (typeof currentCompany !== "string" || !currentCompany || currentCompany !== mapping.companyId || !partition.allowed) {
      return sendError(reply, 403, "notebook_scope_denied");
    }
    request.knowledgePrincipal = principal;
    request.knowledgePartitionKey = partition.partitionKey;
    if (!options.adapter) {
      return sendError(reply, 503, "research_engine_unavailable");
    }
    try {
      return await action(options.adapter, mapping);
    } catch (error) {
      const mapped = adapterError(error);
      return sendError(reply, mapped.status, mapped.code);
    }
  };

  const authorizeRead = async (request: FastifyRequest<{ Params: NotebookParams }>, reply: FastifyReply) => authorize(request, reply, "research:read");
  const authorizeDiscovery = async (request: FastifyRequest<{ Querystring: DiscoveryQuerystring }>, reply: FastifyReply) => {
    if (!parseDiscoveryPagination(request) || hasFramedBody(request)) {
      sendError(reply, 400, "invalid_notebook_discovery_request");
      return;
    }
    const principal = await resolvePrincipal(request, reply, "research:read");
    if (reply.sent || !principal) return;
    request.knowledgePrincipal = principal;
  };

  app.get<{ Querystring: DiscoveryQuerystring }>("/api/research/engine/notebooks", { onRequest: authorizeDiscovery }, async (request, reply) => {
    const pagination = parseDiscoveryPagination(request);
    if (!pagination) return sendError(reply, 400, "invalid_notebook_discovery_request");
    if (mappings.invalid || mappings.byKnowledgeId.size > DISCOVERY_MAX_MAPPINGS) return sendError(reply, 503, "notebook_mapping_unavailable");
    if (typeof options.resolveNotebookSummary !== "function") return sendError(reply, 503, "notebook_summary_unavailable");

    // Re-resolve the bearer/cookie principal after Rules' preHandler boundary
    // and build the complete filtered set before applying pagination. No
    // upstream adapter call occurs on this bootstrap route.
    const onRequestPrincipal = request.knowledgePrincipal;
    const principal = await resolvePrincipal(request, reply, "research:read");
    if (reply.sent || !principal) return undefined;
    if (!samePrincipal(onRequestPrincipal, principal)) return sendError(reply, 401, "authentication_required");
    request.knowledgePrincipal = principal;
    const notebooks: OpenNotebookNotebookSummary[] = [];
    for (const mapping of mappings.byKnowledgeId.values()) {
      if (!authorizeKnowledgePartition(principal, mapping.companyId, "research:read").allowed) continue;
      let owner: string | null;
      let summary: OpenNotebookNotebookSummary | null;
      try {
        owner = options.resolveNotebookCompany(mapping.knowledgeNotebookId);
        summary = options.resolveNotebookSummary(mapping.knowledgeNotebookId);
      } catch {
        return sendError(reply, 503, "notebook_summary_unavailable");
      }
      // A missing or changed local notebook makes a stale configured mapping;
      // omit it rather than exposing configuration or upstream identifiers.
      if (owner === null || owner !== mapping.companyId || summary === null) continue;
      if (!validNotebookSummary(summary, mapping)) return sendError(reply, 503, "notebook_summary_unavailable");
      notebooks.push({ id: summary.id, name: summary.name, description: summary.description });
    }
    notebooks.sort((left, right) => left.id.localeCompare(right.id));
    const page = notebooks.slice(pagination.offset, pagination.offset + pagination.limit);
    return reply.send({
      provider: "open_notebook",
      notebooks: page,
      pagination: {
        limit: pagination.limit,
        offset: pagination.offset,
        hasMore: pagination.offset + page.length < notebooks.length,
      },
    });
  });

  registerOpenNotebookChatRoutes(app, {
    adapter: options.chatAdapter ?? null, ledger: options.chatLedger ?? null, modelId: options.chatModelId ?? null,
    access: {
      authorize,
      run: (request, reply, capability, action) => withAdapter(reply, (engine, mapping) => action(engine, mapping, request.knowledgePrincipal!), request, capability),
    },
  });
  app.get<{ Params: NotebookParams }>("/api/research/notebooks/:notebookId/engine", { onRequest: authorizeRead }, async (request, reply) =>
    withAdapter(reply, async (adapter, mapping) => responseEnvelope("notebook", projectNotebook(await adapter.getNotebook(mapping.externalNotebookId))), request),
  );

  app.get<{ Params: NotebookParams; Querystring: SourceQuerystring }>("/api/research/notebooks/:notebookId/engine/sources", { onRequest: authorizeRead }, async (request, reply) => {
    const pagination = parsePagination(request);
    if (!pagination) return sendError(reply, 400, "invalid_pagination");
    return withAdapter(reply, async (adapter, mapping) => ({
      ...responseEnvelope("sources", (await adapter.listNotebookSources(mapping.externalNotebookId, pagination.options)).map((source) => projectSource(source, false))),
      pagination: { limit: pagination.limit, offset: pagination.offset },
    }), request);
  },
  );

  app.get<{ Params: NotebookParams }>("/api/research/notebooks/:notebookId/engine/notes", { onRequest: authorizeRead }, async (request, reply) =>
    withAdapter(reply, async (adapter, mapping) => responseEnvelope("notes", (await adapter.listNotebookNotes(mapping.externalNotebookId)).map(projectNote)), request),
  );

  app.get<{ Params: NotebookParams }>("/api/research/notebooks/:notebookId/engine/context", { onRequest: authorizeRead }, async (request, reply) => {
    // Context membership/configuration is constructed on the server. This is
    // not a passthrough for upstream's arbitrary-ID context builder.
    // Fastify does not parse GET bodies; inspect framing too so a supplied
    // body is explicitly rejected rather than silently ignored.
    const framedBody = request.headers["transfer-encoding"] !== undefined ||
      (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0");
    if (Object.keys(request.query as object).length || request.body !== undefined || framedBody) return sendError(reply, 400, "invalid_context_request");
    reply.header("cache-control", "no-store");
    return withAdapter(reply, async (adapter, mapping) => {
      if (!adapter.getNotebookContext) return sendError(reply, 503, "research_context_unavailable");
      const context = await adapter.getNotebookContext(mapping.externalNotebookId);
      await authorizeRead(request, reply);
      if (reply.sent) return undefined;
      return { ...responseEnvelope("context", context), contextPolicy: "server-selected-full-content", contentTrust: "untrusted-source-data", modelInvoked: false };
    }, request);
  });

  app.get<{ Params: SourceParams }>("/api/research/notebooks/:notebookId/engine/sources/:sourceId", { onRequest: authorizeRead }, async (request, reply) =>
    withAdapter(reply, async (adapter, mapping) => responseEnvelope("source", projectSource(await adapter.getNotebookSource(mapping.externalNotebookId, request.params.sourceId), true)), request),
  );

  app.get<{ Params: NoteParams }>("/api/research/notebooks/:notebookId/engine/notes/:noteId", { onRequest: authorizeRead }, async (request, reply) => {
    if (Object.keys(request.query as object).length || hasFramedBody(request)) return sendError(reply, 400, "invalid_note_request");
    reply.header("cache-control", "no-store");
    return withAdapter(reply, async (adapter, mapping) => {
      if (!adapter.getNotebookNote) return sendError(reply, 503, "research_engine_unavailable");
      const note = await adapter.getNotebookNote(mapping.externalNotebookId, request.params.noteId);
      await authorizeRead(request, reply);
      if (reply.sent) return undefined;
      return responseEnvelope("note", projectNote(note));
    }, request);
  });

  const authorizeWrite = async (request: FastifyRequest<{ Params: NotebookParams }>, reply: FastifyReply) => authorize(request, reply, "research:write");
  const scopeFor = (request: NotebookRequest, mapping: StoredNotebookBinding): ResearchWriteScope => ({
    principalId: request.knowledgePrincipal!.principalId,
    companyId: mapping.companyId,
    knowledgeNotebookId: mapping.knowledgeNotebookId,
    externalNotebookId: mapping.externalNotebookId,
  });
  const receipt = (intent: ResearchWriteIntent) => ({
    idempotencyKey: intent.idempotencyKey, state: intent.state, sourceId: intent.sourceId,
    errorCode: intent.errorCode, createdAt: intent.createdAt, updatedAt: intent.updatedAt,
  });

  app.post<{ Params: NotebookParams; Body: TextSourceWriteRequest }>("/api/research/notebooks/:notebookId/engine/sources", { onRequest: authorizeWrite, bodyLimit: 4 * 1024 * 1024 }, async (request, reply) =>
    withAdapter(reply, async (adapter, mapping) => {
      const ledger = options.ledger;
      if (!ledger || !adapter.createNotebookTextSource) return sendError(reply, 503, "research_write_unavailable");
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") return sendError(reply, 400, "idempotency_key_required");
      const scope = scopeFor(request, mapping);
      let claim;
      try { claim = ledger.begin(scope, key, request.body); }
      catch (error) {
        return sendError(reply, error instanceof ResearchWriteLedgerError && error.code === "invalid_input" ? 400 : 503, error instanceof ResearchWriteLedgerError && error.code === "invalid_input" ? "invalid_write_request" : "research_write_unavailable");
      }
      if (claim.kind === "conflict") return sendError(reply, 409, claim.code);
      if (claim.kind === "reconciliation_required") return reply.code(409).send({ ...responseEnvelope("receipt", receipt(claim.intent)), error: "reconciliation_required" });
      if (claim.kind === "replay") return reply.code(claim.result.state === "succeeded" ? 200 : 409).send({ ...responseEnvelope("receipt", receipt(claim.intent)), replayed: true });

      // Only the durable claim owner submits. Upstream has no idempotency
      // guarantee: a timeout or a crash must hold this key, never resubmit it.
      let submitted = false;
      try {
        const source = await adapter.createNotebookTextSource(mapping.externalNotebookId, request.body);
        submitted = true;
        await adapter.getNotebookSource(mapping.externalNotebookId, source.id);
        const intent = ledger.succeed(scope, key, claim.claimToken, source.id);
        return reply.code(201).send({ ...responseEnvelope("receipt", receipt(intent)), replayed: false });
      } catch (error) {
        const rejected = !submitted && error instanceof OpenNotebookAdapterError && error.disposition === "rejected";
        try {
          const intent = rejected
            ? ledger.reject(scope, key, claim.claimToken, "upstream_rejected")
            : ledger.markUncertain(scope, key, claim.claimToken, "ambiguous_response");
          return reply.code(rejected ? 502 : 503).send({ ...responseEnvelope("receipt", receipt(intent)), error: rejected ? "research_engine_rejected" : "reconciliation_required" });
        } catch {
          // A failed receipt update leaves the durable pending claim in place.
          return sendError(reply, 503, "reconciliation_required");
        }
      }
    }, request, "research:write"),
  );

  app.get<{ Params: NotebookParams & { idempotencyKey: string } }>("/api/research/notebooks/:notebookId/engine/write-receipts/:idempotencyKey", { onRequest: authorizeWrite }, async (request, reply) =>
    withAdapter(reply, async (_adapter, mapping) => {
      if (!options.ledger) return sendError(reply, 503, "research_write_unavailable");
      try {
        const intent = options.ledger.get(scopeFor(request, mapping), request.params.idempotencyKey);
        return intent ? responseEnvelope("receipt", receipt(intent)) : sendError(reply, 404, "write_receipt_not_found");
      } catch (error) {
        return sendError(reply, error instanceof ResearchWriteLedgerError && error.code === "invalid_input" ? 400 : 503, "write_receipt_unavailable");
      }
    }, request, "research:write"),
  );
}
