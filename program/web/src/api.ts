import type {
  BrainEntityDetail,
  BrainEntities,
  BrainResult,
  FrontendBootstrap,
  IngestResult,
  KnowledgeAccessPolicy,
  KnowledgeAttachment,
  KnowledgeBinding,
  KnowledgeCollection,
  KnowledgeComment,
  KnowledgeDocument,
  KnowledgeLink,
  KnowledgeRevision,
  KnowledgeSearchResult,
  ProgramEvent,
  ResearchAnswer,
  ResearchNotebook,
  ResearchOutput,
  ResearchSource,
  ResearchSummary,
  ResearchWorkspace,
} from "./types";
import { describeErrorCode, isErrorCode } from "./errors";

export class ApiError extends Error {
  /** Machine code from the response body (for example `invalid_model_settings`), if any. */
  readonly code: string | null;
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    const code = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
    this.code = typeof code === "string" ? code : null;
  }
}

/**
 * Error codes the instance edge returns when the Portal browser session is
 * missing, expired or revoked. Research sign-in and agent authorization use
 * different codes and must not trigger a Portal relaunch prompt.
 */
const SESSION_ENDED_CODES = new Set([
  "browser_session_required",
  "instance_auth_required",
  "request_denied",
]);

let sessionEnded = false;
const sessionListeners = new Set<() => void>();

export function isSessionEndedResponse(status: number, body: unknown) {
  if (status !== 401 || !body || typeof body !== "object") return false;
  const code = (body as Record<string, unknown>).error;
  return typeof code === "string" && SESSION_ENDED_CODES.has(code);
}
export function markSessionEnded() {
  if (sessionEnded) return;
  sessionEnded = true;
  for (const listener of sessionListeners) listener();
}
export const getSessionEnded = () => sessionEnded;
export function subscribeSessionEnded(listener: () => void) {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}
/** Test hook: a new page load starts with a live session. */
export function resetSessionEndedForTests() {
  sessionEnded = false;
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(!isForm && init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body =
    response.status === 204
      ? null
      : contentType.includes("json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => null);
  if (!response.ok) {
    if (isSessionEndedResponse(response.status, body)) markSessionEnded();
    const record =
      body && typeof body === "object"
        ? (body as Record<string, unknown>)
        : null;
    // Prefer a human sentence from the server; never show a bare machine code.
    const message =
      typeof record?.message === "string" && !isErrorCode(record.message)
        ? record.message
        : typeof record?.error === "string" && !isErrorCode(record.error)
          ? record.error
          : describeErrorCode(
              typeof record?.error === "string" ? record.error : typeof record?.message === "string" ? record.message : null,
              response.status,
            );
    throw new ApiError(response.status, message, body);
  }
  return body as T;
}

export async function getBootstrap(): Promise<FrontendBootstrap> {
  try {
    return await api<FrontendBootstrap>("/bootstrap.json");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const legacy = await api<Record<string, any>>("/api/status");
    return {
      ok: true,
      program: {
        id: "knowledge",
        name: "Knowledge",
        version: "legacy-runtime",
        environment: "unknown",
        status: String(legacy.status ?? "degraded"),
      },
      subapps: legacy.subapps ?? {},
      dependencies: {
        gbrain: {
          status: String(legacy.sidecars?.gbrain?.status ?? "unavailable"),
          configured: Boolean(legacy.sidecars?.gbrain?.configured),
          tokenConfigured: Boolean(legacy.sidecars?.gbrain?.tokenConfigured),
          detail: legacy.sidecars?.gbrain?.detail ?? null,
        },
        knowledgeDb: {
          status: String(legacy.sidecars?.knowledgeDb?.status ?? "unavailable"),
          required: true,
        },
        objectStore: {
          status: String(legacy.sidecars?.objectStore?.status ?? "unavailable"),
          required: true,
        },
        rules: {
          status: "not-attested-by-program",
          detail:
            "This runtime exposes no Rules connection inspection contract.",
        },
        workEthic: {
          status: "contract-only",
          detail:
            "Binding contracts are available; remote reachability is not exposed.",
        },
      },
      counts: legacy.counts ?? {},
      authorization: {
        generalDomainBearerRequired: false,
        brainExtractFacts: "same-origin-or-gbrain-or-dedicated-extraction-bearer",
        credentialExposedToBrowser: false,
      },
      surfaces: {
        standalone: "/",
        embed: "/embed",
        status: "/status",
        openapi: "/openapi.json",
        swagger: "/swagger.json",
      },
      scope: { defaultCompanyId: "default" },
      capabilities: {
        documents: true,
        research: true,
        brain: true,
        bindings: true,
        fileIngest: true,
        repositoryIngest: true,
        revisionRestore: false,
        browserManagedConnections: false,
        versionControl: false,
      },
    };
  }
}
export const getOpenApi = () => api<Record<string, unknown>>("/openapi.json");
export const getCollections = (companyId: string) =>
  api<KnowledgeCollection[]>(
    `/api/companies/${encodeURIComponent(companyId)}/knowledge/collections`,
  );
export const createCollection = (
  companyId: string,
  input: {
    name: string;
    description: string | null;
    sourceConfig: Record<string, unknown>;
  },
) =>
  api<KnowledgeCollection>(
    `/api/companies/${encodeURIComponent(companyId)}/knowledge/collections`,
    { method: "POST", body: JSON.stringify(input) },
  );
export const deleteCollection = (collectionId: string) =>
  api<KnowledgeCollection>(
    `/api/knowledge/collections/${encodeURIComponent(collectionId)}`,
    { method: "DELETE" },
  );
export const searchDocuments = (
  companyId: string,
  q: string,
  collectionId?: string | null,
) => {
  const params = new URLSearchParams({ q, limit: "200" });
  if (collectionId) params.set("collectionId", collectionId);
  return api<KnowledgeSearchResult[]>(
    `/api/companies/${encodeURIComponent(companyId)}/knowledge/search?${params}`,
  );
};
export const getDocument = (documentId: string) =>
  api<KnowledgeDocument>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}`,
  );
export const createDocument = (
  collectionId: string,
  input: Partial<KnowledgeDocument>,
) =>
  api<KnowledgeDocument>(
    `/api/knowledge/collections/${encodeURIComponent(collectionId)}/documents`,
    {
      method: "POST",
      body: JSON.stringify({
        ...input,
        actor: { kind: "operator", id: "operator" },
      }),
    },
  );
export const updateDocument = (
  documentId: string,
  input: Partial<KnowledgeDocument>,
) =>
  api<KnowledgeDocument>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        ...input,
        actor: { kind: "operator", id: "operator" },
      }),
    },
  );
export const deleteDocument = (documentId: string) =>
  api<KnowledgeDocument>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}`,
    { method: "DELETE" },
  );
export const getRevisions = (documentId: string) =>
  api<KnowledgeRevision[]>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}/revisions`,
  );
export const getComments = (documentId: string) =>
  api<KnowledgeComment[]>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}/comments`,
  );
export const addComment = (documentId: string, body: string) =>
  api<KnowledgeComment>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
export const getAccess = (documentId: string) =>
  api<KnowledgeAccessPolicy>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}/access`,
  );
export const updateAccess = (
  documentId: string,
  input: Pick<
    KnowledgeAccessPolicy,
    "accessMode" | "inheritFromParent" | "grants"
  >,
) =>
  api<KnowledgeAccessPolicy>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}/access`,
    {
      method: "PUT",
      body: JSON.stringify({
        ...input,
        grants: input.grants.map(({ principalType, principalId, role }) => ({
          principalType,
          principalId,
          role,
        })),
      }),
    },
  );
export const getAttachments = (documentId: string) =>
  api<KnowledgeAttachment[]>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}/attachments`,
  );
export const uploadAttachment = (
  companyId: string,
  documentId: string,
  file: File,
  label: string,
) => {
  const form = new FormData();
  form.set("file", file);
  if (label) form.set("label", label);
  return api<KnowledgeAttachment>(
    `/api/companies/${encodeURIComponent(companyId)}/knowledge/documents/${encodeURIComponent(documentId)}/attachments`,
    { method: "POST", body: form },
  );
};
export const deleteAttachment = (attachmentId: string) =>
  api<{ ok: true }>(
    `/api/knowledge/attachments/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE" },
  );
export const getLinks = (documentId: string) =>
  api<KnowledgeLink[]>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}/links`,
  );
export const createLink = (
  documentId: string,
  targetDocumentId: string,
  linkType: string,
) =>
  api<KnowledgeLink>(
    `/api/knowledge/documents/${encodeURIComponent(documentId)}/links`,
    { method: "POST", body: JSON.stringify({ targetDocumentId, linkType }) },
  );
export const deleteLink = (linkId: string) =>
  api<{ ok: true }>(`/api/knowledge/links/${encodeURIComponent(linkId)}`, {
    method: "DELETE",
  });
export const runRepoIngest = (companyId: string, collectionId: string | null) =>
  api<IngestResult>(
    `/api/companies/${encodeURIComponent(companyId)}/knowledge/ingest-runs`,
    {
      method: "POST",
      body: JSON.stringify(collectionId ? { collectionId } : {}),
    },
  );
export const ingestFiles = (
  companyId: string,
  collectionId: string,
  files: File[],
) => {
  const form = new FormData();
  form.set("collectionId", collectionId);
  for (const file of files) form.append("file", file);
  return api<IngestResult>(
    `/api/companies/${encodeURIComponent(companyId)}/knowledge/ingest-files`,
    { method: "POST", body: form },
  );
};

export const getResearchSummary = (companyId: string) =>
  api<ResearchSummary>(
    `/api/research/summary?companyId=${encodeURIComponent(companyId)}`,
  );
export const getNotebooks = (companyId: string) =>
  api<ResearchNotebook[]>(
    `/api/companies/${encodeURIComponent(companyId)}/research/notebooks`,
  );
export const createNotebook = (
  companyId: string,
  input: Partial<ResearchNotebook>,
) =>
  api<ResearchNotebook>(
    `/api/companies/${encodeURIComponent(companyId)}/research/notebooks`,
    { method: "POST", body: JSON.stringify(input) },
  );
export const updateNotebook = (
  notebookId: string,
  input: Partial<ResearchNotebook>,
) =>
  api<ResearchNotebook>(
    `/api/research/notebooks/${encodeURIComponent(notebookId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
export const deleteNotebook = (notebookId: string) =>
  api<ResearchNotebook>(
    `/api/research/notebooks/${encodeURIComponent(notebookId)}`,
    { method: "DELETE" },
  );
export const getResearchWorkspace = (notebookId: string) =>
  api<ResearchWorkspace>(
    `/api/research/notebook?notebookId=${encodeURIComponent(notebookId)}`,
  );
export const getResearchSources = (companyId: string, notebookId?: string) =>
  api<ResearchSource[]>(
    `/api/companies/${encodeURIComponent(companyId)}/research/sources${notebookId ? `?notebookId=${encodeURIComponent(notebookId)}` : ""}`,
  );
export const createResearchSource = (input: Record<string, unknown>) =>
  api<{ source: ResearchSource }>("/api/research/sources", {
    method: "POST",
    body: JSON.stringify(input),
  });
export const importResearchFile = (notebookId: string, file: File) => {
  const form = new FormData();
  form.set("file", file);
  return api<{ source: ResearchSource }>(
    `/api/research/notebooks/${encodeURIComponent(notebookId)}/imports`,
    { method: "POST", body: form },
  );
};
export const getResearchOutputs = (notebookId: string) =>
  api<ResearchOutput[]>(
    `/api/research/notebooks/${encodeURIComponent(notebookId)}/outputs`,
  );
export const createResearchOutput = (
  notebookId: string,
  input: Partial<ResearchOutput>,
) =>
  api<ResearchOutput>(
    `/api/research/notebooks/${encodeURIComponent(notebookId)}/outputs`,
    { method: "POST", body: JSON.stringify(input) },
  );
export const promoteResearchOutput = (
  outputId: string,
  input: { collectionId?: string; documentId?: string; mode: string },
) =>
  api<ResearchOutput>(
    `/api/research/outputs/${encodeURIComponent(outputId)}/promote`,
    { method: "POST", body: JSON.stringify(input) },
  );
export const askResearch = (notebookId: string, prompt: string) =>
  api<ResearchAnswer>("/api/research/ask", {
    method: "POST",
    body: JSON.stringify({ notebookId, prompt }),
  });
export const queryResearchGraph = (notebookId: string, query: string) =>
  api<Record<string, unknown>>("/api/research/graph/query", {
    method: "POST",
    body: JSON.stringify({ query, scope: { notebookId } }),
  });

export interface BrainEntityListOptions {
  signal?: AbortSignal;
  limit?: number;
  offset?: number;
  kind?: "entities" | "pages" | "all";
}

export interface BrainEntityDetailOptions {
  signal?: AbortSignal;
  depth?: number;
  direction?: "in" | "out" | "both";
  linkType?: string;
}

export const getBrainEntities = (options: BrainEntityListOptions = {}) => {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  if (options.kind) params.set("kind", options.kind);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return api<BrainEntities>(`/api/brain/entities${suffix}`, {
    signal: options.signal,
  });
};

export const getBrainEntity = (
  slug: string,
  options: BrainEntityDetailOptions = {},
) => {
  const params = new URLSearchParams({ slug });
  if (options.depth !== undefined) params.set("depth", String(options.depth));
  if (options.direction) params.set("direction", options.direction);
  if (options.linkType) params.set("linkType", options.linkType);
  return api<BrainEntityDetail>(`/api/brain/entities?${params.toString()}`, {
    signal: options.signal,
  });
};
export const brainRecall = (query: string) =>
  api<BrainResult>("/api/brain/recall", {
    method: "POST",
    body: JSON.stringify({
      scopeRef: "knowledge-web",
      purpose: "general",
      query,
    }),
  });
export const brainContext = (query: string) =>
  api<BrainResult>("/api/brain/context", {
    method: "POST",
    body: JSON.stringify({
      scopeRef: "knowledge-web",
      purpose: "general",
      query,
    }),
  });
export const extractBrainFacts = (text: string) =>
  api<Record<string, unknown>>("/api/brain/extract-facts", {
    method: "POST",
    body: JSON.stringify({ text, sessionId: "knowledge-web" }),
  });

export const getBindings = () => api<KnowledgeBinding[]>("/api/bindings");
export const createBinding = (input: Record<string, unknown>) =>
  api<KnowledgeBinding>("/api/bindings", {
    method: "POST",
    body: JSON.stringify(input),
  });
export const deleteBinding = (bindingId: string) =>
  api<KnowledgeBinding>(`/api/bindings/${encodeURIComponent(bindingId)}`, {
    method: "DELETE",
  });
export const getEvents = () =>
  api<{ ok: boolean; events: ProgramEvent[] }>("/api/events");
