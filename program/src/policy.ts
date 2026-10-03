export interface KnowledgePolicyOperation {
  readonly operation: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly companyId: string | null;
  readonly payload: Record<string, unknown>;
}

interface ClassifyInput {
  readonly method: string;
  readonly pathname: string;
  readonly params?: Record<string, string | undefined>;
  readonly query?: Record<string, unknown>;
  readonly body?: Record<string, unknown>;
}

function targetId(
  params: Record<string, string | undefined> | undefined,
  query: Record<string, unknown> | undefined,
  body: Record<string, unknown> | undefined,
): string | null {
  for (const key of ["documentId", "collectionId", "notebookId", "sourceId", "entryId", "outputId", "attachmentId", "linkId", "bindingId", "ownerId"]) {
    const value = params?.[key];
    if (value) return value;
    const queryValue = query?.[key];
    if (typeof queryValue === "string" && queryValue) return queryValue;
    const bodyValue = body?.[key];
    if (typeof bodyValue === "string" && bodyValue) return bodyValue;
  }
  return null;
}

export function classifyKnowledgeOperation(input: ClassifyInput): KnowledgePolicyOperation | null {
  const pathname = input.pathname.split("?")[0] ?? input.pathname;
  if (!pathname.startsWith("/api/")) return null;
  // Browser session exchange/logout is authentication lifecycle, not a
  // Research domain operation. It must not invoke Rules before a principal
  // exists; the engine routes remain governed below.
  if (pathname === "/api/research/browser-session") return null;
  if (pathname.startsWith("/api/brain/native/")) {
    const operation = pathname.slice("/api/brain/native/".length);
    const partition = input.body?.partitionKey ?? input.query?.partitionKey;
    return {
      operation: `knowledge.brain.native.${operation}`,
      targetKind: "knowledge_brain_native",
      targetId: null,
      companyId: typeof partition === "string" ? partition : null,
      payload: { method: input.method.toUpperCase(), pathname },
    };
  }
  const governed =
    pathname.startsWith("/api/knowledge/collections") ||
    pathname.startsWith("/api/knowledge/documents") ||
    pathname.startsWith("/api/knowledge/attachments") ||
    pathname.startsWith("/api/knowledge/links") ||
    pathname.startsWith("/api/research/") ||
    pathname.startsWith("/api/brain/") ||
    pathname.startsWith("/api/bindings") ||
    pathname.startsWith("/api/projects/") && pathname.includes("/knowledge/") ||
    pathname.startsWith("/api/goals/") && pathname.includes("/knowledge/") ||
    pathname.startsWith("/api/issues/") && pathname.includes("/knowledge/") ||
    pathname.startsWith("/api/companies/") &&
      (pathname.includes("/knowledge/") || pathname.includes("/research/"));
  if (!governed) return null;
  const method = input.method.toUpperCase();
  const verb = method === "GET" ? "read" : method === "POST" ? "create" : method === "DELETE" ? "delete" : "update";
  const domain = pathname.includes("/research/") ? "research" : "knowledge";
  const noun = pathname.includes("/ingest-") ? "ingest" : pathname.includes("/sources") ? "source" : pathname.includes("/documents") ? "document" : pathname.includes("/collections") ? "collection" : pathname.includes("/outputs") ? "output" : pathname.includes("/bindings") ? "binding" : "research";
  return {
    operation: `knowledge.${domain}.${noun}.${verb}`,
    targetKind: `knowledge_${noun}`,
    targetId: targetId(input.params, input.query, input.body),
    companyId:
      input.params?.companyId ??
      (typeof input.query?.companyId === "string" ? input.query.companyId : null) ??
      (typeof input.query?.partitionKey === "string" ? input.query.partitionKey : null) ??
      (typeof input.body?.partitionKey === "string" ? input.body.partitionKey : null) ??
      (typeof input.body?.companyId === "string" ? input.body.companyId : null),
    payload: {
      method,
      pathname,
      ...(typeof input.body?.partitionKey === "string" ? { partitionKey: input.body.partitionKey } : {}),
      ...(typeof input.body?.companyId === "string" ? { companyId: input.body.companyId } : {}),
    },
  };
}
