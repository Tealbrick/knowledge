export const KNOWLEDGE_FRONTEND_VERSION = "0.1.0";

type Operation = {
  readonly summary: string;
  readonly tags: readonly string[];
  readonly description?: string;
  readonly requestBody?: Record<string, unknown>;
  readonly parameters?: readonly Record<string, unknown>[];
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly responses?: Readonly<Record<string, { readonly description: string }>>;
};

const operation = (
  summary: string,
  tag: string,
  extra: Omit<Operation, "summary" | "tags"> = {},
): Operation => ({
  summary,
  tags: [tag],
  ...extra,
});

const company = {
  name: "companyId",
  in: "path",
  required: true,
  schema: { type: "string" },
  example: "default",
};
const pathId = (name: string, example: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  example,
});

export function buildKnowledgeOpenApi() {
  const document = {
    openapi: "3.1.0",
    info: {
      title: "Teal Brick Knowledge Program API",
      version: KNOWLEDGE_FRONTEND_VERSION,
      description:
        "Program-owned contracts for canonical documents, research, GBrain-backed recall, bindings, ingestion, and runtime inspection. The portable web application uses domain routes directly.",
    },
    servers: [{ url: "/", description: "Current Knowledge Program origin" }],
    tags: [
      { name: "Program" },
      { name: "Documents" },
      { name: "Ingest" },
      { name: "Research" },
      { name: "Brain" },
      { name: "Bindings" },
      { name: "Legacy presentation" },
    ],
    paths: {
      "/api/research/browser-session": {
        get: operation("Read optional Research browser session", "Research", {
          description: "No-store status. Disabled by default. Enabled mode requires the exact configured Host and same-origin browser metadata; only authenticated status includes CSRF and principal metadata. This is not general Program authentication.",
        }),
        post: operation("Sign in to the configured single-operator Research principal", "Research", {
          description: "Requires exact Origin and Host, a distinct operator login code, bounded login rate and 4096-byte JSON body limit. Issues an HttpOnly SameSite=Strict host-only cookie; never returns a service or upstream token.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["secret"], properties: { secret: { type: "string", maxLength: 1024, writeOnly: true } } } } } },
        }),
        delete: operation("Revoke this Research browser session", "Research", {
          description: "Requires exact Origin/Host plus the cookie and synchronizer CSRF token. Clears this session only.",
          security: [{ researchBrowserCookie: [], researchBrowserCsrf: [] }],
        }),
      },
      "/healthz": { get: operation("Read liveness", "Program") },
      "/status": { get: operation("Read redacted runtime status", "Program") },
      "/bootstrap.json": {
        get: operation("Read redacted frontend bootstrap", "Program"),
      },
      "/openapi.json": {
        get: operation("Read this OpenAPI document", "Program"),
      },
      "/swagger.json": {
        get: operation("Download this OpenAPI document", "Program"),
      },
      "/api/status": {
        get: operation("Read operator runtime diagnostics", "Program", {
          description:
            "Contains local runtime paths and is not used by the ordinary frontend.",
        }),
      },
      "/api/events": {
        get: operation("List recent in-memory Program events", "Program"),
      },
      "/api/companies/{companyId}/knowledge/collections": {
        get: operation("List collections", "Documents", {
          parameters: [company],
        }),
        post: operation("Create collection", "Documents", {
          parameters: [company],
        }),
      },
      "/api/knowledge/collections": {
        get: operation("List default-company collections", "Documents"),
      },
      "/api/knowledge/collections/{collectionId}": {
        delete: operation("Delete a collection", "Documents", {
          parameters: [pathId("collectionId", "kcol_0001")],
        }),
      },
      "/api/knowledge/collections/{collectionId}/tree": {
        get: operation("Read a collection tree", "Documents", {
          parameters: [pathId("collectionId", "kcol_0001")],
        }),
      },
      "/api/knowledge/collections/{collectionId}/documents": {
        post: operation("Create a canonical document", "Documents", {
          parameters: [pathId("collectionId", "kcol_0001")],
        }),
      },
      "/api/companies/{companyId}/knowledge/search": {
        get: operation("Search canonical documents", "Documents", {
          parameters: [
            company,
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "collectionId", in: "query", schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", maximum: 200 },
            },
          ],
        }),
      },
      "/api/companies/{companyId}/knowledge/ingest-runs": {
        post: operation("Run repository-backed collection ingest", "Ingest", {
          parameters: [company],
        }),
      },
      "/api/companies/{companyId}/knowledge/ingest-files": {
        post: operation("Ingest document files", "Ingest", {
          parameters: [company],
          description:
            "multipart/form-data with one or more file fields and optional collectionId/title fields",
        }),
      },
      "/api/knowledge/documents/{documentId}": {
        get: operation("Read a canonical document", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
        patch: operation("Update a canonical document", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
        delete: operation("Delete a canonical document", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
      },
      "/api/knowledge/documents/{documentId}/revisions": {
        get: operation("List immutable document revisions", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
      },
      "/api/knowledge/documents/{documentId}/comments": {
        get: operation("List document comments", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
        post: operation("Add a document comment", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
      },
      "/api/knowledge/documents/{documentId}/access": {
        get: operation("Read document access policy", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
        put: operation("Replace document access policy", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
      },
      "/api/knowledge/documents/{documentId}/attachments": {
        get: operation("List document attachments", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
      },
      "/api/companies/{companyId}/knowledge/documents/{documentId}/attachments":
        {
          post: operation("Upload a document attachment", "Documents", {
            parameters: [company, pathId("documentId", "kdoc_0001")],
          }),
        },
      "/api/knowledge/attachments/{attachmentId}": {
        get: operation("Read attachment metadata", "Documents", {
          parameters: [pathId("attachmentId", "katt_example")],
        }),
        delete: operation("Delete an attachment", "Documents", {
          parameters: [pathId("attachmentId", "katt_example")],
        }),
      },
      "/api/knowledge/attachments/{attachmentId}/content": {
        get: operation("Read attachment content", "Documents", {
          parameters: [pathId("attachmentId", "katt_example")],
        }),
      },
      "/api/knowledge/documents/{documentId}/links": {
        get: operation("List document links", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
        post: operation("Create a document link", "Documents", {
          parameters: [pathId("documentId", "kdoc_0001")],
        }),
      },
      "/api/knowledge/links/{linkId}": {
        get: operation("Read a document link", "Documents", {
          parameters: [pathId("linkId", "klink_example")],
        }),
        delete: operation("Delete a document link", "Documents", {
          parameters: [pathId("linkId", "klink_example")],
        }),
      },
      "/api/research/summary": {
        get: operation("Read research posture and counts", "Research"),
      },
      "/api/companies/{companyId}/research/notebooks": {
        get: operation("List research notebooks", "Research", {
          parameters: [company],
        }),
        post: operation("Create a research notebook", "Research", {
          parameters: [company],
        }),
      },
      "/api/research/engine/notebooks": {
        get: operation("Discover mapped Open Notebook workspaces", "Research", {
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 200, default: 0 } },
          ],
          security: [{ bearerAuth: [] }, { researchBrowserCookie: [] }],
          description: "Returns only server-mapped local Knowledge notebook IDs, titles, and summaries for the authenticated principal's current company. It does not probe Open Notebook or expose upstream IDs, credentials, or health state; company and filter selectors are not accepted.",
        }),
      },
      "/api/research/notebooks/{notebookId}/engine": {
        get: operation("Read mapped Open Notebook metadata", "Research", {
          parameters: [pathId("notebookId", "notebook_0001")],
          security: [{ bearerAuth: [] }],
          description: "Requires a server-configured Knowledge principal with research:read and matching company/notebook mapping. The upstream token remains server-side. This is not the local fallback notebook response.",
        }),
      },
      "/api/research/notebooks/{notebookId}/engine/sources": {
        post: {
          summary: "Create a mapped Open Notebook text source (research:write)",
          tags: ["Research"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "notebookId", in: "path", required: true, schema: { type: "string" } },
            { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", maxLength: 256 } },
          ],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", additionalProperties: false, required: ["title", "content"],
            properties: { title: { type: "string", description: "Nonblank, at most 4096 UTF-8 bytes" }, content: { type: "string", description: "Nonblank, at most 512 KiB UTF-8" } },
          } } } },
          responses: {
            "201": { description: "Created and notebook membership verified; durable receipt" },
            "200": { description: "Historical successful receipt replay; no new upstream write" },
            "400": { description: "Invalid body or idempotency key" },
            "401": { description: "Authentication required" },
            "403": { description: "Capability, company scope or policy denied" },
            "409": { description: "Key conflict, held/rejected receipt, or policy review required" },
            "502": { description: "Upstream rejected the write" },
            "503": { description: "Unavailable or uncertain outcome; inspect receipt, do not resubmit with a new key" },
          },
        },
        get: operation("Read mapped Open Notebook sources", "Research", {
          parameters: [
            pathId("notebookId", "notebook_0001"),
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 10000000, default: 0 } },
          ],
          security: [{ bearerAuth: [] }],
        }),
      },
      "/api/research/notebooks/{notebookId}/engine/notes": {
        get: operation("Read mapped Open Notebook notes", "Research", {
          parameters: [pathId("notebookId", "notebook_0001")],
          security: [{ bearerAuth: [] }],
        }),
      },
      "/api/research/notebooks/{notebookId}/engine/context": {
        get: {
          summary: "Build bounded mapped Research context (research:read)", tags: ["Research"],
          security: [{ bearerAuth: [] }],
          parameters: [pathId("notebookId", "notebook_0001")],
          description: "Server-enumerated source/note IDs only. Caller query/body/context selectors are rejected. Full-content snapshot, no model invocation; not an atomic upstream snapshot.",
          responses: {
            "200": { description: "Projected full-content sources, notes and upstream token/character estimates" },
            "400": { description: "Caller context/query/body overrides are not accepted" },
            "401": { description: "Authentication required" }, "403": { description: "Read capability, company scope or policy denied" },
            "409": { description: "Membership changed during assembly; no context returned" },
            "413": { description: "Notebook context exceeds bounded source/note count" },
            "502": { description: "Malformed, foreign or incomplete upstream context" }, "503": { description: "Research engine unavailable" },
          },
        },
      },
      "/api/research/notebooks/{notebookId}/engine/chat/sessions": {
        post: operation("Create principal-owned Open Notebook chat (research:write)", "Research", {
          security: [{ bearerAuth: [] }],
          parameters: [pathId("notebookId", "notebook_0001"), { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", maxLength: 256 } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { title: { type: "string", description: "Nonblank, maximum 4096 UTF-8 bytes" } } } } } },
          responses: { "201": { description: "Verified session; durable local receipt" }, "200": { description: "Successful receipt replay" }, "400": { description: "Invalid body/key" }, "401": { description: "Bearer required" }, "403": { description: "Scope/capability/policy denied" }, "409": { description: "Conflict or held/rejected claim" }, "502": { description: "Known upstream rejection" }, "503": { description: "Unavailable or uncertain creation; do not retry with a new key" } },
        }),
      },
      "/api/research/notebooks/{notebookId}/engine/chat/sessions/{sessionId}": {
        get: operation("Read this principal's scoped chat history (research:read)", "Research", {
          security: [{ bearerAuth: [] }], parameters: [pathId("notebookId", "notebook_0001"), pathId("sessionId", "chat_session:local-id")],
          description: "Local principal/company/notebook/model mapping is authoritative. No raw upstream session identifier or credential is returned. Uncertain turns are not reconciled by reading history.",
          responses: { "200": { description: "Bounded upstream history" }, "401": { description: "Bearer required" }, "403": { description: "Scope/capability/policy denied" }, "404": { description: "No session in current scope" }, "409": { description: "Upstream session model changed" }, "503": { description: "Unavailable" } },
        }),
      },
      "/api/research/notebooks/{notebookId}/engine/chat/sessions/{sessionId}/messages": {
        post: operation("Execute scoped Research chat (research:write and research:read)", "Research", {
          security: [{ bearerAuth: [] }],
          parameters: [pathId("notebookId", "notebook_0001"), pathId("sessionId", "chat_session:local-id"), { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", maxLength: 256 } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["message"], properties: { message: { type: "string", description: "Nonblank, maximum 32 KiB UTF-8 bytes" } } } } } },
          description: "Server selects context, history and explicit model. Durable per-session serialization and no Knowledge resubmission; provider SDK retries remain upstream-controlled, not exactly-once. Pending/uncertain turns hold the session for explicit reconciliation.",
          responses: { "201": { description: "Durable bounded assistant receipt" }, "200": { description: "Successful receipt replay without provider call" }, "400": { description: "Invalid body/key" }, "401": { description: "Bearer required" }, "403": { description: "Scope/capability/policy denied" }, "404": { description: "No owned session" }, "409": { description: "Conflict, held claim or session busy" }, "502": { description: "Known pre-dispatch rejection" }, "503": { description: "Unavailable or uncertain outcome; do not resubmit" } },
        }),
      },
      "/api/research/notebooks/{notebookId}/engine/chat/receipts/{idempotencyKey}": {
        get: operation("Read scoped chat receipt (research:write and research:read)", "Research", {
          security: [{ bearerAuth: [] }], parameters: [pathId("notebookId", "notebook_0001"), pathId("idempotencyKey", "request-1")],
          responses: { "200": { description: "Historical receipt only; no reconciliation" }, "401": { description: "Bearer required" }, "403": { description: "Scope/capability/policy denied" }, "404": { description: "No receipt in current scope" }, "503": { description: "Unavailable" } },
        }),
      },
      "/api/research/notebooks/{notebookId}/engine/write-receipts/{idempotencyKey}": {
        get: {
          summary: "Read this principal's mapped durable write receipt (research:write)",
          tags: ["Research"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "notebookId", in: "path", required: true, schema: { type: "string" } },
            { name: "idempotencyKey", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Historical receipt, not current source existence" }, "404": { description: "No receipt in this principal and notebook scope" } },
        },
      },
      "/api/research/notebooks/{notebookId}/engine/sources/{sourceId}": {
        get: operation("Read a mapped notebook member source", "Research", {
          parameters: [pathId("notebookId", "notebook_0001"), pathId("sourceId", "source:example")],
          security: [{ bearerAuth: [] }],
          description: "Verifies source membership via the mapped notebook inventory before reading source detail. No upstream filesystem path is returned.",
        }),
      },
      "/api/research/notebooks/{notebookId}": {
        get: operation("Read a research notebook", "Research", {
          parameters: [pathId("notebookId", "rnotebook_example")],
        }),
        patch: operation("Update a research notebook", "Research", {
          parameters: [pathId("notebookId", "rnotebook_example")],
        }),
        delete: operation("Delete a research notebook", "Research", {
          parameters: [pathId("notebookId", "rnotebook_example")],
        }),
      },
      "/api/research/notebook": {
        get: operation("Read a complete notebook workspace", "Research"),
      },
      "/api/research/notebooks/{notebookId}/entries": {
        get: operation("List notebook entries", "Research", {
          parameters: [pathId("notebookId", "rnotebook_example")],
        }),
        post: operation("Create a notebook entry", "Research", {
          parameters: [pathId("notebookId", "rnotebook_example")],
        }),
      },
      "/api/research/entries/{entryId}": {
        delete: operation("Delete a notebook entry", "Research", {
          parameters: [pathId("entryId", "rentry_example")],
        }),
      },
      "/api/companies/{companyId}/research/sources": {
        get: operation("List research sources", "Research", {
          parameters: [company],
        }),
      },
      "/api/research/sources": {
        post: operation("Create a research source", "Research"),
      },
      "/api/research/notebooks/{notebookId}/imports": {
        post: operation("Import a file as a research source", "Research", {
          parameters: [pathId("notebookId", "rnotebook_example")],
        }),
      },
      "/api/research/sources/{sourceId}": {
        get: operation("Read a research source", "Research", {
          parameters: [pathId("sourceId", "rsource_example")],
        }),
        patch: operation("Update a research source", "Research", {
          parameters: [pathId("sourceId", "rsource_example")],
        }),
        delete: operation("Delete a research source", "Research", {
          parameters: [pathId("sourceId", "rsource_example")],
        }),
      },
      "/api/research/sources/{sourceId}/content": {
        get: operation("Read research source content", "Research", {
          parameters: [pathId("sourceId", "rsource_example")],
        }),
      },
      "/api/research/notebooks/{notebookId}/outputs": {
        get: operation("List research outputs", "Research", {
          parameters: [pathId("notebookId", "rnotebook_example")],
        }),
        post: operation("Create a research output", "Research", {
          parameters: [pathId("notebookId", "rnotebook_example")],
        }),
      },
      "/api/research/outputs/{outputId}": {
        patch: operation("Update a research output", "Research", {
          parameters: [pathId("outputId", "routput_example")],
        }),
        delete: operation("Delete a research output", "Research", {
          parameters: [pathId("outputId", "routput_example")],
        }),
      },
      "/api/research/outputs/{outputId}/promote": {
        post: operation(
          "Promote research output into canonical Documents",
          "Research",
          { parameters: [pathId("outputId", "routput_example")] },
        ),
      },
      "/api/research/ask": {
        post: operation("Ask against ranked notebook context", "Research"),
      },
      "/api/research/chat": {
        post: operation("Chat against ranked notebook context", "Research"),
      },
      "/api/research/graph/query": {
        post: operation("Query notebook relationship graph", "Research"),
      },
      "/api/brain/entities": {
        get: operation("List entity facts or read an entity profile", "Brain"),
      },
      "/api/brain/context": {
        post: operation("Query GBrain context", "Brain", {
          description: "Uses native GBrain query defaults unless limit, expand or detail is supplied. The configured native search mode controls the default retrieval budget.",
        }),
      },
      "/api/brain/recall": {
        post: operation("Recall GBrain memories", "Brain", {
          description: "scopeRef is required; query is optional. Omit query for native hot-fact/entity/session reads. Supports entity, sessionId, since, supersessions, includeExpired, includePending, grep, limit and budgetTokens. Native facts/results and search_degraded metadata are preserved; no client-side reranking or truncation.",
        }),
      },
      "/api/brain/extract-facts": {
        post: operation("Extract facts into GBrain", "Brain", {
          description:
            "Write is permitted only for same-origin browser requests, a valid GBrain bearer token, or the dedicated server extraction bearer.",
        }),
      },
      "/api/bindings": {
        get: operation("List cross-application bindings", "Bindings"),
        post: operation("Create a cross-application binding", "Bindings"),
      },
      "/api/bindings/{bindingId}": {
        delete: operation("Delete a cross-application binding", "Bindings", {
          parameters: [pathId("bindingId", "kbinding_example")],
        }),
      },
      "/api/{ownerType}/{ownerId}/knowledge/documents": {
        get: operation("List Work-owned document bindings", "Bindings"),
        post: operation("Create a Work-owned document binding", "Bindings"),
      },
      "/api/{ownerType}/{ownerId}/knowledge/documents/{documentId}": {
        delete: operation("Delete a Work-owned document binding", "Bindings"),
      },
      "/api/{ownerType}/{ownerId}/knowledge/collections": {
        get: operation("List Work-owned collection bindings", "Bindings"),
        post: operation("Create a Work-owned collection binding", "Bindings"),
      },
      "/api/{ownerType}/{ownerId}/knowledge/collections/{collectionId}": {
        delete: operation("Delete a Work-owned collection binding", "Bindings"),
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        researchBrowserCookie: { type: "apiKey", in: "cookie", name: "knowledge_research_session", description: "Opt-in single-operator session only; HttpOnly, host-only and SameSite=Strict." },
        researchBrowserCsrf: { type: "apiKey", in: "header", name: "X-CSRF-Token", description: "Synchronizer token returned by the same-origin session status. Required with cookie-authenticated writes." },
      },
    },
    "x-doppelganger": {
      application: "knowledge",
      surfaces: { standalone: "/", embed: "/embed" },
      communicationTemplates: {
        search: {
          method: "GET",
          path: "/api/companies/{companyId}/knowledge/search?q={query}&limit=50",
        },
        groundedAsk: {
          method: "POST",
          path: "/api/research/ask",
          body: { notebookId: "{notebookId}", prompt: "{question}" },
        },
        brainRecall: {
          method: "POST",
          path: "/api/brain/recall",
          body: {
            scopeRef: "{scopeRef}",
            purpose: "general",
            query: "{query}",
          },
        },
        ingestRepository: {
          method: "POST",
          path: "/api/companies/{companyId}/knowledge/ingest-runs",
          body: { collectionId: "{collectionId}" },
        },
      },
      authorization: {
        generalDomainBearerRequired: false,
        brainExtractFacts: "same-origin browser, configured GBrain bearer, or dedicated server extraction bearer",
        credentialExposedToBrowser: false,
      },
    },
  };
  for (const [route, methods] of Object.entries(document.paths) as Array<[string, Record<string, Operation>]>) {
    if (!route.includes("/engine")) continue;
    for (const [method, details] of Object.entries(methods)) {
      const mutates = method !== "get" && method !== "head";
      methods[method] = { ...details, security: [{ bearerAuth: [] }, mutates ? { researchBrowserCookie: [], researchBrowserCsrf: [] } : { researchBrowserCookie: [] }],
        description: `${details.description ?? ""} Optional browser mode accepts its server-owned session cookie only when Authorization is entirely absent. Browser requests require exact configured Host and same-origin checks; writes also require Origin and X-CSRF-Token. Capability, mapping, owner and optional Rules policy are unchanged.`.trim() };
    }
  }
  return document;
}
