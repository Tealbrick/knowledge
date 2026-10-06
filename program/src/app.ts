import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import { createMemoryEngine, type MemoryEngine } from "./memory-engine.js";
import { nativeOperationAuthorized } from "./brain-native-policy.js";
import { BrainProjections } from "./brain-projections.js";
import { BrainExtractions } from "./brain-extractions.js";
import { registerNativeMemoryRoutes } from "./brain-native-routes.js";
import { nativeMemoryCapabilities } from "./brain-native-policy.js";
import { registerModelSettingsRoutes } from "./model-settings-routes.js";
import { readModelSettings } from "./model-settings.js";
import { ResearchModelSync, resolveResearchChatModelId } from "./research-model-sync.js";
import { createKnowledgePrincipalResolver, type KnowledgeServicePrincipal } from "./knowledge-principal.js";
import { KnowledgeAuthorizationAudit } from "./authorization-audit.js";
import {
  authorizeKnowledgePartition,
  bearerToken,
  normalizeKnowledgePartitionKey,
  partitionGrantSummaries,
} from "./partition-authority.js";
import { OpenNotebookAdapter } from "./open-notebook.js";
import { registerOpenNotebookRoutes } from "./open-notebook-routes.js";
import { ResearchWriteLedger } from "./research-write-ledger.js";
import { ResearchChatLedger } from "./research-chat-ledger.js";
import { OpenNotebookChatAdapter } from "./open-notebook-chat.js";
import {
  browserSessionErrorStatus,
  RESEARCH_BROWSER_SESSION_COOKIE,
  ResearchBrowserSessionAuthority,
  ResearchBrowserSessionError,
} from "./research-browser-session.js";
import {
  buildKnowledgeOpenApi,
  KNOWLEDGE_FRONTEND_VERSION,
} from "./frontend-contract.js";
import { loadConfig } from "./config.js";
import { classifyKnowledgeOperation } from "./policy.js";
import { KnowledgeRulesClient } from "./rules-client.js";
import { SqliteKnowledgePersistence } from "./persistence.js";
import {
  KnowledgeSourceAdapters,
  KnowledgeSourceSyncError,
  isRepoBackedSourceConfig,
  normalizeSourcePath,
  normalizeStoredSourcePath,
} from "./source-adapters.js";
import { KnowledgeStore } from "./store.js";
import type {
  BuildKnowledgeAppOptions,
  KnowledgeConfig,
  KnowledgeOwnerType,
} from "./types.js";

const BindingInputSchema = z.object({
  ownerPlugin: z.string().min(1),
  ownerType: z.string().min(1),
  ownerId: z.string().min(1),
  artifactType: z.string().min(1),
  artifactId: z.string().min(1),
  relationshipType: z.string().min(1),
  summary: z.string().optional().nullable(),
  createdBy: z.string().optional(),
  rulesDecisionRef: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  partitionKey: z.string().trim().min(1).optional().nullable(),
});

const NativeSourceConfigSchema = z.object({
  provider: z.literal("native"),
});

const RepoSourceBaseSchema = z.object({
  owner: z.string().trim().min(1),
  repo: z.string().trim().min(1),
  branch: z.string().trim().min(1).default("main"),
  rootPath: z.string().trim().default(""),
  tokenEnvVar: z.string().trim().min(1).optional(),
  secretName: z.string().trim().min(1).optional(),
});

const GithubSourceConfigSchema = RepoSourceBaseSchema.extend({
  provider: z.literal("github_repo"),
});

const ForgejoSourceConfigSchema = RepoSourceBaseSchema.extend({
  provider: z.literal("forgejo_repo"),
  apiBaseUrl: z.string().trim().url(),
});

const CollectionInputSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional().nullable(),
  sourceConfig: z
    .discriminatedUnion("provider", [
      NativeSourceConfigSchema,
      GithubSourceConfigSchema,
      ForgejoSourceConfigSchema,
    ])
    .optional()
    .nullable(),
});

const KnowledgeIngestRunInputSchema = z.object({
  collectionId: z.string().trim().min(1).optional().nullable(),
});

const KnowledgeActorSchema = z.object({
  kind: z.enum(["agent", "app", "import", "operator"]).default("operator"),
  id: z.string().trim().min(1),
});

const DocumentCreateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  summary: z.string().optional().nullable(),
  body: z.string().optional().nullable(),
  collectionId: z.string().optional().nullable(),
  documentId: z.string().optional(),
  parentDocumentId: z.string().optional().nullable(),
  bindingType: z.string().optional().nullable(),
  bodyFormat: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  companyId: z.string().optional().nullable(),
  sourcePath: z.string().optional().nullable(),
  actor: KnowledgeActorSchema.optional(),
});

const DocumentUpdateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  summary: z.string().optional().nullable(),
  body: z.string().optional(),
  parentDocumentId: z.string().optional().nullable(),
  bodyFormat: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  actor: KnowledgeActorSchema.optional(),
});

type DocumentCreateInput = z.infer<typeof DocumentCreateSchema>;
type DocumentUpdateInput = z.infer<typeof DocumentUpdateSchema>;

function actorProvenance(
  actor: z.infer<typeof KnowledgeActorSchema> | undefined,
  principal?: KnowledgeServicePrincipal,
) {
  if (principal) return { createdByAgentId: principal.principalId, createdByUserId: null };
  if (!actor || actor.kind === "operator") {
    return { createdByAgentId: null, createdByUserId: actor?.id ?? "operator" };
  }
  if (actor.kind === "agent") {
    return { createdByAgentId: actor.id, createdByUserId: null };
  }
  return {
    createdByAgentId: null,
    createdByUserId: `${actor.kind}:${actor.id}`,
  };
}

const CommentInputSchema = z.object({
  body: z.string().min(1),
  parentCommentId: z.string().optional().nullable(),
});

const LinkInputSchema = z.object({
  targetDocumentId: z.string().trim().min(1),
  linkType: z.string().optional().nullable(),
});

const AccessPolicyInputSchema = z.object({
  accessMode: z.string().optional(),
  inheritFromParent: z.boolean().optional(),
  grants: z
    .array(
      z.object({
        principalType: z.string().min(1),
        principalId: z.string().min(1),
        role: z.string().min(1),
      }),
    )
    .optional(),
});

const BrainContextInputSchema = z.object({
  scopeRef: z.string().min(1),
  purpose: z.enum(["task", "thread", "entity", "general"]).default("general"),
  query: z.string().min(1),
  sourceIds: z.array(z.string()).optional(),
  partitionKey: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  expand: z.boolean().optional(),
  detail: z.enum(["low", "medium", "high"]).optional(),
  grep: z.string().max(2000).optional(),
  entity: z.string().max(512).optional(),
  sessionId: z.string().max(512).optional(),
  includeExpired: z.boolean().optional(),
  budgetTokens: z.number().int().min(256).max(32000).optional(),
});

// Native recall may retrieve hot facts without a semantic query. Do not force
// entity/session/temporal reads to spend on the hybrid-search arm.
const BrainRecallInputSchema = BrainContextInputSchema.extend({
  query: z.string().min(1).optional(),
  since: z.string().trim().min(1).max(128).optional(),
  supersessions: z.boolean().optional(),
  includePending: z.boolean().optional(),
});

const BrainEntitiesQuerySchema = z.object({
  slug: z.string().trim().min(1).optional(),
  kind: z.enum(["entities", "pages", "all"]).default("entities"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  depth: z.coerce.number().int().min(1).max(4).default(2),
  direction: z.enum(["in", "out", "both"]).optional(),
  linkType: z.string().trim().min(1).optional(),
  partitionKey: z.string().trim().min(1).optional(),
});

const BrainExtractFactsInputSchema = z.object({
  text: z.string().trim().min(1),
  sessionId: z.string().optional().nullable(),
  entityHints: z.array(z.string().trim().min(1)).optional(),
  partitionKey: z.string().trim().min(1).optional(),
  sourceSlug: z.string().trim().min(1).max(512).optional(),
  validFrom: z.iso.datetime().optional(),
});

interface BrainQueryRow {
  readonly chunk_source?: unknown;
  readonly chunk_text?: unknown;
  readonly page_id?: unknown;
  readonly score?: unknown;
  readonly slug?: unknown;
  readonly source_id?: unknown;
  readonly title?: unknown;
  readonly type?: unknown;
}

type PartitionRequestShape = {
  readonly method: string;
  readonly url: string;
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
};

function requestPath(url: string): string {
  return url.split("?")[0] ?? url;
}

function partitionProtectedPath(pathname: string): boolean {
  if (pathname === "/api/knowledge/partitions") return true;
  if (pathname === "/api/research/browser-session") return false;
  return pathname.startsWith("/api/knowledge/")
    || pathname.startsWith("/api/research/")
    || pathname.startsWith("/api/brain/")
    || pathname.startsWith("/api/companies/") && (pathname.includes("/knowledge/") || pathname.includes("/research/"))
    || pathname.startsWith("/api/projects/") && pathname.includes("/knowledge/")
    || pathname.startsWith("/api/goals/") && pathname.includes("/knowledge/")
    || pathname.startsWith("/api/issues/") && pathname.includes("/knowledge/")
    || pathname === "/api/bindings" || pathname.startsWith("/api/bindings/");
}

function partitionCapabilityForRequest(method: string, pathname: string): string {
  if (pathname.startsWith("/api/brain/native/")) return nativeMemoryCapabilities(pathname.split("/").at(-1) ?? "")[0]!;
  if (pathname.startsWith("/api/brain/")) {
    return pathname.startsWith("/api/brain/extract-facts") ? "brain:write" : "brain:read";
  }
  if (pathname.startsWith("/api/research/") || /^\/api\/companies\/[^/]+\/research\//u.test(pathname)) {
    return method.toUpperCase() === "GET" || pathname.includes("/ask") || pathname.includes("/graph")
      ? "research:read"
      : "research:write";
  }
  switch (method.toUpperCase()) {
    case "GET": case "HEAD": return "knowledge:read";
    case "POST": return "knowledge:create";
    case "PATCH": case "PUT": return "knowledge:update";
    case "DELETE": return "knowledge:delete";
    default: return "knowledge:unsupported";
  }
}

function storePartitionForRequest(request: PartitionRequestShape, store: KnowledgeStore, policyPathname = requestPath(request.url)): string | null {
  const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
  const body = request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)
    ? request.body as Record<string, unknown>
    : {};
  const directValues = [params.companyId, query.companyId, query.partitionKey, body.partitionKey, body.companyId,
    ...(policyPathname.startsWith("/api/brain/") ? [body.scopeRef, query.scopeRef] : [])];
  const directPartitions: string[] = [];
  for (const value of directValues) {
    if (typeof value !== "string" || !value.trim()) continue;
    const partition = normalizeKnowledgePartitionKey(value);
    if (!partition) return null;
    directPartitions.push(partition);
  }
  const uniqueDirectPartitions = [...new Set(directPartitions)];
  if (uniqueDirectPartitions.length > 1) return null;
  const directPartition = uniqueDirectPartitions[0] ?? null;

  const scope = body.scope && typeof body.scope === "object" && !Array.isArray(body.scope)
    ? body.scope as Record<string, unknown>
    : {};
  const selectedId = (...values: unknown[]): { value: string | null; conflict: boolean } => {
    const ids = [...new Set(values.flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : []))];
    return { value: ids.length > 1 ? null : ids[0] ?? null, conflict: ids.length > 1 };
  };
  const selectors = [
    selectedId(params.documentId, query.documentId, body.documentId),
    selectedId(params.collectionId, query.collectionId, body.collectionId),
    selectedId(params.attachmentId, query.attachmentId, body.attachmentId),
    selectedId(params.linkId, query.linkId, body.linkId),
    selectedId(params.notebookId, query.notebookId, body.notebookId, scope.notebookId),
    selectedId(params.sourceId, query.sourceId, body.sourceId),
    selectedId(params.entryId, query.entryId, body.entryId),
    selectedId(params.outputId, query.outputId, body.outputId),
    selectedId(params.bindingId, query.bindingId, body.bindingId),
  ];
  if (selectors.some(({ conflict }) => conflict)) return null;
  const [documentId, collectionId, attachmentId, linkId, notebookId, sourceId, entryId, outputId, bindingId] = selectors.map(({ value }) => value);

  const companyForDocument = (documentId: unknown): string | null => {
    if (typeof documentId !== "string") return null;
    return store.getKnowledgeDocument(documentId)?.companyId ?? null;
  };
  const companyForNotebook = (notebookId: unknown): string | null => {
    if (typeof notebookId !== "string") return null;
    return store.getResearchNotebook(notebookId)?.companyId ?? null;
  };
  const companyForSource = (sourceId: unknown): string | null => {
    if (typeof sourceId !== "string") return null;
    return store.getResearchSource(sourceId)?.companyId ?? null;
  };
  const targetCompanyIds: Array<string | null> = [];
  const addTargetCompany = (reference: unknown, resolve: (value: string) => string | null) => {
    if (typeof reference !== "string" || !reference.trim()) return;
    targetCompanyIds.push(resolve(reference));
  };
  addTargetCompany(documentId, companyForDocument);
  addTargetCompany(body.parentDocumentId, companyForDocument);
  addTargetCompany(body.targetDocumentId, companyForDocument);
  addTargetCompany(collectionId, (id) => store.getKnowledgeCollection(id)?.companyId ?? null);
  addTargetCompany(attachmentId, (id) => companyForDocument(store.getKnowledgeAttachment(id)?.documentId));
  addTargetCompany(linkId, (id) => store.getKnowledgeLink(id)?.companyId ?? null);
  addTargetCompany(notebookId, companyForNotebook);
  addTargetCompany(sourceId, companyForSource);
  addTargetCompany(entryId, (id) => companyForNotebook(store.getResearchEntry(id)?.notebookId));
  addTargetCompany(outputId, (id) => store.getResearchOutput(id)?.companyId ?? null);
  addTargetCompany(bindingId, (id) => store.getBinding(id)?.partitionKey ?? null);
  const targetPartitions: string[] = [];
  for (const companyId of targetCompanyIds) {
    const partition = companyId ? normalizeKnowledgePartitionKey(companyId) : null;
    if (!partition) return null;
    targetPartitions.push(partition);
  }
  const uniquePartitions = [...new Set(targetPartitions)];
  if (directPartition && uniquePartitions.some((partition) => partition !== directPartition)) return null;
  if (uniquePartitions.length > 1) return null;
  return directPartition ?? uniquePartitions[0] ?? null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildBrainQueryCitations(data: unknown) {
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const row = candidate as BrainQueryRow;
    const slug = optionalString(row.slug);
    if (!slug) {
      return [];
    }
    const pageId =
      typeof row.page_id === "number" || typeof row.page_id === "string"
        ? row.page_id
        : null;
    return [
      {
        sourceId: optionalString(row.source_id),
        pageId,
        slug,
        title: optionalString(row.title) ?? brainLabelFromSlug(slug),
        kind: optionalString(row.type) ?? "gbrain_page",
        citation: `[${slug}]`,
        excerpt: optionalString(row.chunk_text),
        chunkSource: optionalString(row.chunk_source),
        score: optionalNumber(row.score),
      },
    ];
  });
}

function headerValue(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = candidate?.trim() ?? "";
  return normalized || null;
}

function isResearchSameOriginPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname === "/api/research/browser-session" ||
    pathname === "/api/research/engine/notebooks" ||
    /^\/api\/research\/notebooks\/[^/]+\/engine(?:\/|$)/u.test(pathname);
}

function isSameOriginRequest(
  origin: string | null,
  host: string | null,
): boolean {
  // No Origin is a server-to-server request, not evidence of a hostile browser.
  if (!origin) {
    return true;
  }
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function hasBearerToken(
  authorization: string | null,
  expectedToken: string | null,
): boolean {
  if (!authorization || !expectedToken) {
    return false;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  if (!match?.[1]) {
    return false;
  }
  const received = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

function brainLabelFromSlug(slug: string): string {
  const leaf = slug.split("/").filter(Boolean).at(-1) ?? slug;
  const label = leaf.replace(/[-_]+/gu, " ").trim();
  return label ? `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}` : slug;
}

const BRAIN_ENTITY_PAGE_TYPES = new Set([
  "person",
  "company",
  "organization",
  "entity",
]);

type BrainEntityKind = "entities" | "pages" | "all";

interface BrainPageRow {
  readonly slug: string;
  readonly sourceId: string | null;
  readonly title: string;
  readonly type: string | null;
  readonly updatedAt: string | null;
}

function normalizeBrainPageRow(value: unknown): BrainPageRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const slug = optionalString(row.slug);
  if (!slug) {
    return null;
  }
  return {
    slug,
    sourceId: optionalString(row.source_id) ?? optionalString(row.sourceId),
    title: optionalString(row.title) ?? brainLabelFromSlug(slug),
    type: optionalString(row.type),
    updatedAt: optionalString(row.updated_at) ?? optionalString(row.updatedAt),
  };
}

function normalizeBrainEntityCard(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  const card = envelope.card;
  return card && typeof card === "object" && !Array.isArray(card)
    ? card as Record<string, unknown>
    : null;
}

function brainCapabilityGap(
  operation: string,
  result: Awaited<ReturnType<MemoryEngine["listEntities"]>>,
) {
  return {
    code: "native_operation_unavailable",
    operation,
    detail: result.error ?? `${operation} did not return a usable result`,
  };
}

function observedBrainCapabilities(
  readiness: ReturnType<MemoryEngine["nativeCapabilityReadiness"]>,
  observed: Record<string, boolean>,
) {
  return Object.fromEntries(
    Object.entries(readiness.capabilities).map(([name, capability]) => [
      name,
      {
        ...capability,
        ...(name in observed
          ? { status: observed[name] ? "ready" : "unavailable" }
          : {}),
      },
    ]),
  ) as typeof readiness.capabilities;
}

function buildBrainPageEnumerationResponse(input: {
  readonly result: Awaited<ReturnType<MemoryEngine["listPages"]>>;
  readonly kind: BrainEntityKind;
  readonly limit: number;
  readonly offset: number;
  readonly readiness: ReturnType<MemoryEngine["nativeCapabilityReadiness"]>;
  readonly factsVisibility?: "partition_private" | "world_only";
}) {
  const { result, kind, limit, offset, readiness } = input;
  const rawRows = result.ok && Array.isArray(result.data) ? result.data : [];
  const pages = rawRows
    .map(normalizeBrainPageRow)
    .filter((row): row is BrainPageRow => row !== null);
  const hasNativeOverflow = pages.length > limit;
  const visiblePages = pages.slice(0, limit);
  const entities = visiblePages.filter((row) =>
    BRAIN_ENTITY_PAGE_TYPES.has(row.type ?? ""),
  );
  const selected = kind === "entities" ? entities : visiblePages;
  // GBrain's remote cap is 100. Requests below that cap include one sentinel
  // row; a full 100-row response is therefore indeterminate rather than
  // evidence that the visible register ended. This only describes the
  // world-visible native page window, never private pages or a whole graph.
  const sourcePageComplete =
    result.ok && pages.length < Math.min(limit + 1, 100);
  const hasMore = !result.ok
    ? null
    : hasNativeOverflow
      ? true
      : sourcePageComplete
        ? false
        : null;
  const capabilityGaps = [
    ...readiness.capabilityGaps,
    ...(result.ok ? [] : [brainCapabilityGap("list_pages", result)]),
  ];
  return {
    ok: result.ok,
    source: "gbrain-adapter",
    status: result.status,
    degradedReason: result.error ?? null,
    kind,
    entities: kind === "pages" ? [] : entities,
    pages: kind === "entities" ? [] : visiblePages,
    // The `all` mode keeps the two projections separate instead of pretending
    // every native page is an entity. `entities` is filtered from this bounded
    // page window; it never claims a whole-brain entity count.
    selected,
    pagination: {
      limit,
      offset,
      returned: selected.length,
      scanned: visiblePages.length,
      complete: sourcePageComplete,
      hasMore,
    },
    nextOffset: hasMore === true ? offset + visiblePages.length : null,
    capabilities: {
      ...observedBrainCapabilities(readiness, { pageEnumeration: result.ok }),
      facts: {
        status: input.factsVisibility === "partition_private" ? "ready" : "limited",
        visibility: input.factsVisibility ?? "world_only",
        detail:
          input.factsVisibility === "partition_private" ? "Private facts are available only within the authorized Knowledge partition." : "Remote GBrain recall is intentionally limited to world-visible facts; private facts are not exposed by this route.",
      },
    },
    capabilityGaps,
  };
}

const NotebookInputSchema = z.object({
  title: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  focusPrompt: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
});

const SourceInputSchema = z
  .object({
    notebookId: z.string().optional().nullable(),
    kind: z.string().optional().nullable(),
    title: z.string().optional().nullable(),
    sourceType: z.string().optional().nullable(),
    url: z.string().optional().nullable(),
    author: z.string().optional().nullable(),
    publisher: z.string().optional().nullable(),
    publishedAt: z.string().optional().nullable(),
    summary: z.string().optional().nullable(),
    content: z.string().optional().nullable(),
    text: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    citation: z.string().optional().nullable(),
    apiConfig: z.record(z.string(), z.unknown()).optional().nullable(),
    apiSnapshot: z.record(z.string(), z.unknown()).optional().nullable(),
    status: z.string().optional().nullable(),
  })
  .passthrough();

const ResearchEntryInputSchema = z.object({
  entryKind: z.string().optional().nullable(),
  sourceId: z.string().optional().nullable(),
  documentId: z.string().optional().nullable(),
  documentRevisionId: z.string().optional().nullable(),
  role: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const ResearchOutputInputSchema = z.object({
  outputKind: z.string().optional().nullable(),
  kind: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  body: z.string().optional().nullable(),
  bodyFormat: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  promotionState: z.string().optional().nullable(),
  promotedDocumentId: z.string().optional().nullable(),
  promotedRevisionId: z.string().optional().nullable(),
});

const ResearchPromoteInputSchema = z.object({
  documentId: z.string().optional().nullable(),
  collectionId: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  mode: z.enum(["append", "replace", "new_document"]).optional().nullable(),
});

const ResearchAskInputSchema = z.object({
  notebookId: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  sourceIds: z.array(z.string()).optional(),
  documentIds: z.array(z.string()).optional(),
  noteIds: z.array(z.string()).optional(),
  chatSessionId: z.string().optional().nullable(),
});

const ResearchChatInputSchema = z.object({
  notebookId: z.string().trim().min(1),
  message: z.string().trim().min(1),
  sourceIds: z.array(z.string()).optional(),
  documentIds: z.array(z.string()).optional(),
  chatSessionId: z.string().optional().nullable(),
});

const ResearchGraphInputSchema = z.object({
  companyId: z.string().optional(),
  query: z.string().trim().min(1),
  scope: z
    .object({
      notebookId: z.string().optional().nullable(),
      sourceIds: z.array(z.string()).optional(),
      documentIds: z.array(z.string()).optional(),
      projectId: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function attachmentDisposition(filename?: string | null): string {
  return filename ? `attachment; filename="${encodeURIComponent(filename)}"` : "attachment";
}

function parseMultipartContentDisposition(value: string) {
  const output: Record<string, string> = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    const rawValue = rawValueParts.join("=").trim();
    if (key && rawValue) {
      output[key] = rawValue.replace(/^"|"$/gu, "");
    }
  }
  return output;
}

function parseMultipartFormData(
  raw: Buffer,
  contentTypeHeader: string | string[] | undefined,
): {
  fields: Record<string, string>;
  files: Array<{
    name: string;
    filename: string;
    contentType: string;
    content: Buffer;
  }>;
} {
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader[0]
    : contentTypeHeader;
  const match =
    typeof contentType === "string"
      ? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/iu)
      : null;
  const boundaryValue = match?.[1] ?? match?.[2];
  if (!boundaryValue) {
    return { fields: {}, files: [] };
  }
  const boundary = Buffer.from(`--${boundaryValue}`);
  const fields: Record<string, string> = {};
  const files: Array<{
    name: string;
    filename: string;
    contentType: string;
    content: Buffer;
  }> = [];

  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf(boundary, cursor);
    if (start < 0) {
      break;
    }
    cursor = start + boundary.length;
    if (raw.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) {
      break;
    }
    if (raw[cursor] === 13 && raw[cursor + 1] === 10) {
      cursor += 2;
    }
    const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd < 0) {
      break;
    }
    const nextBoundary = raw.indexOf(boundary, headerEnd + 4);
    if (nextBoundary < 0) {
      break;
    }
    const headerText = raw.subarray(cursor, headerEnd).toString("utf8");
    let body = raw.subarray(headerEnd + 4, nextBoundary);
    if (
      body.length >= 2 &&
      body[body.length - 2] === 13 &&
      body[body.length - 1] === 10
    ) {
      body = body.subarray(0, body.length - 2);
    }
    cursor = nextBoundary;

    const headers = new Map<string, string>();
    for (const line of headerText.split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator >= 0) {
        headers.set(
          line.slice(0, separator).trim().toLowerCase(),
          line.slice(separator + 1).trim(),
        );
      }
    }
    const disposition = headers.get("content-disposition");
    if (!disposition) {
      continue;
    }
    const parsed = parseMultipartContentDisposition(disposition);
    const fieldName = parsed.name;
    if (!fieldName) {
      continue;
    }
    if (parsed.filename) {
      files.push({
        name: fieldName,
        filename: parsed.filename,
        contentType: headers.get("content-type") ?? "application/octet-stream",
        content: body,
      });
    } else {
      fields[fieldName] = body.toString("utf8");
    }
  }

  return { fields, files };
}

function normalizeResearchScopeIds(value: readonly string[] | undefined) {
  return [
    ...new Set((value ?? []).map((entry) => entry.trim()).filter(Boolean)),
  ];
}

function toKnowledgeAttachmentResponse(
  attachment: NonNullable<ReturnType<KnowledgeStore["getKnowledgeAttachment"]>>,
) {
  const { storagePath: _storagePath, ...rest } = attachment;
  return rest;
}

function mapResearchSource(
  store: KnowledgeStore,
  source: NonNullable<ReturnType<KnowledgeStore["getResearchSource"]>>,
) {
  const notebook = store.getResearchNotebook(source.notebookId);
  return {
    id: source.id,
    companyId: source.companyId,
    notebookId: source.notebookId,
    notebookTitle: notebook?.title ?? "Unknown notebook",
    title: source.title,
    sourceType: source.sourceType,
    url: source.url,
    storagePath: null,
    originalFilename: source.originalFilename,
    contentType: source.contentType,
    size: source.size,
    author: source.author,
    publisher: source.publisher,
    publishedAt: source.publishedAt,
    summary: source.summary,
    citation: source.citation,
    apiConfig: source.apiConfig,
    apiSnapshot: source.apiSnapshot,
    status: source.status,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function extractImportedFileText(file: {
  readonly content: Buffer;
  readonly contentType: string;
}) {
  if (
    file.contentType.startsWith("text/") ||
    file.contentType.includes("json")
  ) {
    return file.content.toString("utf8");
  }
  return `[binary ${file.contentType || "application/octet-stream"}; ${file.content.length} bytes]`;
}

const KNOWLEDGE_INGEST_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".jsonl",
  ".markdown",
  ".md",
  ".mdx",
  ".txt",
  ".tsv",
  ".yaml",
  ".yml",
]);

type KnowledgeIngestAction =
  | "created"
  | "failed"
  | "skipped"
  | "unchanged"
  | "updated";

interface KnowledgeIngestDocumentResult {
  readonly action: KnowledgeIngestAction;
  readonly documentId?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly sourcePath: string;
  readonly title?: string;
}

interface KnowledgeIngestSummary {
  created: number;
  failed: number;
  skipped: number;
  unchanged: number;
  updated: number;
}

function emptyIngestSummary(): KnowledgeIngestSummary {
  return {
    created: 0,
    failed: 0,
    skipped: 0,
    unchanged: 0,
    updated: 0,
  };
}

function countIngestAction(
  summary: KnowledgeIngestSummary,
  action: KnowledgeIngestAction,
) {
  summary[action] += 1;
}

function isKnowledgeIngestiblePath(sourcePath: string) {
  return KNOWLEDGE_INGEST_EXTENSIONS.has(
    path.extname(sourcePath).toLowerCase(),
  );
}

function titleFromSourcePath(sourcePath: string, body: string) {
  const heading = body.match(/^\s*#\s+(.+?)\s*$/mu)?.[1]?.trim();
  if (heading) {
    return heading;
  }
  const parsed = path.parse(sourcePath);
  const base = parsed.name || parsed.base || "Document";
  return base
    .replace(/[-_]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\b\w/gu, (value) => value.toUpperCase());
}

function summaryFromBody(body: string) {
  return (
    body
      .split(/\r?\n/u)
      .map((line) => line.replace(/^#+\s*/u, "").trim())
      .find(Boolean)
      ?.slice(0, 280) ?? null
  );
}

function bodyFormatFromSourcePath(sourcePath: string, contentType?: string) {
  const extension = path.extname(sourcePath).toLowerCase();
  if (
    extension === ".json" ||
    extension === ".jsonl" ||
    contentType?.includes("json")
  ) {
    return "json";
  }
  if (extension === ".csv") {
    return "csv";
  }
  if (extension === ".tsv") {
    return "tsv";
  }
  if (extension === ".yaml" || extension === ".yml") {
    return "yaml";
  }
  return "markdown";
}

function buildStatus(
  config: KnowledgeConfig,
  store: KnowledgeStore,
  brain: MemoryEngine,
) {
  const brainStatus = brain.status();
  const gbrainConfigured =
    brainStatus.status === "online" ||
    config.gbrainBaseUrl !== null ||
    config.gbrainAutoStart;
  const knowledgeDbConfigured =
    config.knowledgeDatabasePath !== null ||
    config.knowledgeDatabaseUrl !== null;
  return {
    ok: true,
    microappId: "knowledge",
    name: "Knowledge",
    status: knowledgeDbConfigured ? "online" : "degraded",
    subapps: {
      documents: { status: "online", canonical: true },
      research: {
        status: "degraded", canonical: true, runtime: "open_notebook",
        integration: "scoped-read-and-text-write-bridge",
        configured: Boolean(config.openNotebookBaseUrl && config.openNotebookToken),
        runtimeVerified: false,
        detail: "Mapped engine reads, durable text-source writes and scoped chat are available when configured and authorized. Browser Research requires its separate operator session. Legacy ask remains a local no-model fallback; uncertain writes require reconciliation.",
      },
      brain: {
        status: brainStatus.status === "online" ? "online" : "degraded",
        runtime: "gbrain",
        firstGradeSurface: true,
        detail: brainStatus.detail,
      },
      orchestrator: { status: "online" },
    },
    sidecars: {
      gbrain: {
        required: true,
        status: brainStatus.status,
        baseUrl: brainStatus.baseUrl,
        home: brainStatus.home,
        repoPath: brainStatus.repoPath,
        schemaPack: brainStatus.schemaPack,
        tokenConfigured: brainStatus.tokenConfigured,
        configured: gbrainConfigured,
        detail: brainStatus.detail,
      },
      knowledgeDb: {
        required: true,
        status: knowledgeDbConfigured ? "configured" : "missing-config",
        kind: config.knowledgeDatabasePath ? "sqlite" : "external",
        path: config.knowledgeDatabasePath,
      },
      objectStore: {
        required: true,
        status: "configured",
        dataDir: config.dataDir,
      },
    },
    counts: store.snapshot().counts,
  };
}

function renderObserverUi(
  config: KnowledgeConfig,
  store: KnowledgeStore,
  brain: MemoryEngine,
) {
  const status = buildStatus(config, store, brain);
  const rows = [
    [
      "Documents",
      status.subapps.documents.status,
      "Canonical docs and source-backed pages",
    ],
    [
      "Research",
      status.subapps.research.status,
      "Notebooks, sources, outputs, promotion",
    ],
    [
      "GBrain",
      status.subapps.brain.status,
      "Recall, facts, graph, query, think",
    ],
    [
      "Orchestrator",
      status.subapps.orchestrator.status,
      "Rules, bindings, sync, provenance",
    ],
  ];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Knowledge Micro-app</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; background: #f5f7f8; color: #1f2528; }
      main { max-width: 980px; margin: 0 auto; padding: 32px; }
      header { display: flex; justify-content: space-between; align-items: start; gap: 24px; }
      h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
      p { color: #5e6a70; line-height: 1.5; }
      .pill { border: 1px solid #cfd8dc; border-radius: 999px; padding: 6px 10px; font-size: 12px; background: #fff; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-top: 24px; }
      .unit { background: #fff; border: 1px solid #dce3e6; border-radius: 8px; padding: 16px; }
      .unit h2 { margin: 0 0 6px; font-size: 15px; }
      .status { font-size: 12px; color: #2f6f62; text-transform: uppercase; }
      pre { overflow: auto; background: #101820; color: #dbeafe; border-radius: 8px; padding: 16px; }
      @media (prefers-color-scheme: dark) {
        body { background: #101416; color: #eef3f4; }
        p { color: #aab7bd; }
        .pill, .unit { background: #151b1e; border-color: #2a3439; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Knowledge Micro-app</h1>
          <p>Documents, Research, GBrain, and Orchestrator running as one installable Product unit.</p>
        </div>
        <div class="pill">${status.microappId} · ${status.status}</div>
      </header>
      <section class="grid">
        ${rows
          .map(
            ([name, state, description]) => `<article class="unit">
              <div class="status">${state}</div>
              <h2>${name}</h2>
              <p>${description}</p>
            </article>`,
          )
          .join("")}
      </section>
      <h2>Runtime</h2>
      <pre>${JSON.stringify(status, null, 2)}</pre>
    </main>
  </body>
</html>`;
}

const programRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const webDistRoot = path.join(programRoot, "web-dist");

function webContentType(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".webmanifest":
      return "application/manifest+json";
    case ".ttf":
      return "font/ttf";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function readWebAsset(relativePath: string) {
  const resolved = path.resolve(webDistRoot, relativePath);
  if (!resolved.startsWith(`${webDistRoot}${path.sep}`)) {
    return null;
  }
  return fs.readFile(resolved).catch(() => null);
}

export async function buildKnowledgeApp(
  options: BuildKnowledgeAppOptions = {},
): Promise<FastifyInstance> {
  const config = loadConfig(options);
  if (config.brainExtractionToken !== null) {
    if (!/^[\x21-\x7e]{32,1024}$/u.test(config.brainExtractionToken)) {
      throw new Error("Invalid Knowledge brain extraction token configuration");
    }
    if (config.brainExtractionToken === config.gbrainToken) {
      throw new Error("Invalid Knowledge brain extraction token configuration");
    }
  }
  const researchPrincipals = createKnowledgePrincipalResolver(config.knowledgeServicePrincipals);
  if (config.knowledgeServicePrincipals.length > 0 && !researchPrincipals.configured) {
    throw new Error("Invalid Knowledge service principal configuration");
  }
  const portalPrincipals = options.portalPrincipals ?? null;
  if (config.partitionAuthorizationRequired && !researchPrincipals.configured && !portalPrincipals) {
    throw new Error("Knowledge partition authorization requires configured service principals");
  }
  const browserSessionConfigured = [config.browserOperatorSecret, config.browserPrincipalId, config.browserOrigin].some((value) => value !== null);
  let browserSession: ResearchBrowserSessionAuthority | null = null;
  if (browserSessionConfigured) {
    if (
      typeof config.browserOperatorSecret !== "string" ||
      typeof config.browserPrincipalId !== "string" ||
      typeof config.browserOrigin !== "string"
    ) {
      throw new Error("Invalid Knowledge browser session configuration");
    }
    const configuredCredentials = [
      config.gbrainToken,
      config.brainExtractionToken,
      config.openNotebookToken,
      config.rulesAuthToken,
      ...(Array.isArray(config.knowledgeServicePrincipals)
        ? config.knowledgeServicePrincipals.map((binding) =>
            binding && typeof binding === "object" && typeof binding.token === "string" ? binding.token : null,
          )
        : []),
    ];
    if (configuredCredentials.some((credential) => credential !== null && credential === config.browserOperatorSecret)) {
      throw new Error("Invalid Knowledge browser session configuration");
    }
    try {
      browserSession = new ResearchBrowserSessionAuthority({
        operatorSecret: config.browserOperatorSecret,
        principalId: config.browserPrincipalId,
        origin: config.browserOrigin,
        principals: researchPrincipals,
      });
    } catch {
      throw new Error("Invalid Knowledge browser session configuration");
    }
  }
  const openNotebook = config.openNotebookBaseUrl && config.openNotebookToken
    ? new OpenNotebookAdapter({ baseUrl: config.openNotebookBaseUrl, token: config.openNotebookToken,
      timeoutMs: 30_000, maxResponseBytes: 4 * 1024 * 1024 })
    : null;
  const persistence = config.knowledgeDatabasePath
    ? new SqliteKnowledgePersistence(config.knowledgeDatabasePath)
    : null;
  const store = new KnowledgeStore(persistence, {
    defaultKnowledgeCollectionSourceConfig: config.defaultDocsSourceConfig,
  });
  // One memory engine per deployment (KNOWLEDGE_MEMORY_ENGINE; GBrain when unset).
  const brain = createMemoryEngine(config);
  const extractions = new BrainExtractions(config.knowledgeDatabasePath ? path.join(config.dataDir, "brain-extractions.sqlite") : ":memory:");
  const extractCanonical = async (item: ReturnType<KnowledgeStore["brainProjectionInputs"]>[number]) => {
    const text = item.kind === "document" ? [item.value.title, item.value.summary, item.value.body].filter(Boolean).join("\n\n") : [item.value.title, item.value.summary, item.value.content].filter(Boolean).join("\n\n");
    const input = { text, partitionKey: item.value.companyId, sessionId: `${item.kind}:${item.value.id}` };
    // Keep the ledger fingerprint stable across additive provenance upgrades.
    return extractions.run(`projection:${item.value.companyId}`, undefined, input, async () => brain.extractFacts({ ...input, sourceSlug: `${item.kind === "document" ? "knowledge-docs" : "knowledge-research/sources"}/${item.value.id}` }));
  };
  const projections = new BrainProjections(config.knowledgeDatabasePath ? path.join(config.dataDir, "brain-projections.sqlite") : ":memory:", brain, () => store.brainProjectionInputs(), process.env.KNOWLEDGE_AUTO_EXTRACT === "false" ? undefined : extractCanonical);
  const sourceAdapters = new KnowledgeSourceAdapters();
  const rulesBindingRequested = Boolean(config.rulesBaseUrl || config.rulesAuthToken);
  const rulesClient =
    config.rulesBaseUrl && config.rulesAuthToken
      ? new KnowledgeRulesClient({
          baseUrl: config.rulesBaseUrl,
          authToken: config.rulesAuthToken,
          workspaceSlug: config.rulesWorkspaceSlug,
          timeoutMs: config.rulesTimeoutMs,
        })
      : null;
  let researchWriteLedger: ResearchWriteLedger | null = null;
  let researchChatLedger: ResearchChatLedger | null = null;
  // The chat model id is resolved per request (env override, else the model
  // Settings -> Models configured in Research), so the adapter exists whenever
  // Open Notebook is configured.
  const openNotebookChat = openNotebook
    ? new OpenNotebookChatAdapter({ baseUrl: config.openNotebookBaseUrl!, token: config.openNotebookToken!, timeoutMs: 30_000, maxResponseBytes: 4 * 1024 * 1024 }) : null;
  // Writers are static service principals or a trusted host provider (e.g.
  // Portal attachments admitted by the container edge).
  const researchWritersPossible = Boolean(options.researchPrincipalProvider) ||
    config.knowledgeServicePrincipals.some((principal) => principal.capabilities.includes("research:write"));
  try {
    researchWriteLedger = openNotebook && config.researchWriteLedgerPath && researchWritersPossible
      ? new ResearchWriteLedger(config.researchWriteLedgerPath) : null;
    researchChatLedger = openNotebookChat && config.researchChatLedgerPath && researchWritersPossible
      ? new ResearchChatLedger(config.researchChatLedgerPath) : null;
    await brain.start();
  } catch (error) {
    researchWriteLedger?.close();
    researchChatLedger?.close();
    persistence?.close();
    await brain.close();
    throw error;
  }
  const app = Fastify({ logger: config.environment === "test" ? false : {
    redact: ["req.headers", "req.body", "res.headers", "err.message", "err.stack"],
    serializers: {
      req: (request: FastifyRequest) => ({ method: request.method, route: request.routeOptions?.url ?? null }),
      err: () => ({ type: "Error", message: "[redacted]", stack: "[redacted]" }),
    },
  } });
  const authorizationAudit = new KnowledgeAuthorizationAudit(
    config.environment === "test" && !config.knowledgeDatabasePath ? ":memory:" : path.join(config.dataDir, "authorization-audit.sqlite"),
  );
  const authorizationAuditIds = new WeakMap<object, string>();
  // Internal host seam only; never an HTTP endpoint and never creates a partition.
  app.decorate("knowledgeHasPartition", (companyId: string) =>
    store.listKnowledgeCollections(companyId, false).length > 0 || store.listResearchNotebooks(companyId).length > 0);
  // Internal host seam: the edge maps a native operation to its Portal capability (read/write).
  app.decorate("knowledgeNativeOperationPolicy", (operation: string) => brain.nativeOperationPolicy(operation));
  const recordAuthorization = (request: FastifyRequest, decision: "admitted" | "denied", capability: string | null, partitionKey: string | null) => {
    authorizationAuditIds.set(request, authorizationAudit.record({
      principalId: request.knowledgePrincipal?.principalId ?? null, partitionKey,
      method: request.method, route: request.routeOptions.url ?? "unmatched", capability, decision,
    }));
  };
  const events: Array<Record<string, unknown>> = [];

  const recordEvent = (event: Record<string, unknown>) => {
    events.unshift({
      id: `kevt_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      ...event,
    });
    events.splice(100);
  };

  const projectDocumentToBrain = async (
    document: NonNullable<ReturnType<KnowledgeStore["getKnowledgeDocument"]>>,
  ) => {
    const result = await projections.project({ kind: "document", value: document });
    recordEvent({
      type: "brain.projection.document",
      artifactId: document.id,
      ok: result.ok,
      status: result.status,
      error: result.error ?? null,
    });
  };

  const projectResearchSourceToBrain = async (
    source: NonNullable<ReturnType<KnowledgeStore["getResearchSource"]>>,
  ) => {
    const projection = await projections.project({ kind: "research", value: source });
    const facts =
      source.sourceType === "message" || source.sourceType === "social"
        ? await extractCanonical({ kind: "research", value: source })
        : null;
    recordEvent({
      type: "brain.projection.research_source",
      artifactId: source.id,
      ok: projection.ok,
      status: projection.status,
      error: projection.error ?? null,
      facts: facts
        ? {
            ok: facts.ok,
            status: facts.status,
            error: facts.error ?? null,
          }
        : null,
    });
  };

  const readCanonicalDocument = async (documentId: string) => {
    const document = store.getKnowledgeDocument(documentId);
    if (!document) {
      return null;
    }
    const collection = store.getKnowledgeCollection(document.collectionId);
    if (
      !isRepoBackedSourceConfig(collection?.sourceConfig) ||
      !document.source?.path
    ) {
      return document;
    }
    const sourcePath = normalizeStoredSourcePath(
      collection.sourceConfig,
      document.source.path,
    );
    const remote = await sourceAdapters.readDocument(
      collection.sourceConfig,
      sourcePath,
    );
    return {
      ...document,
      body: remote.body,
      source: {
        ...remote.source,
        path: normalizeStoredSourcePath(
          collection.sourceConfig,
          remote.source.path,
        ),
      },
    };
  };

  const createCanonicalDocument = async (
    collectionId: string,
    input: DocumentCreateInput & { readonly title: string },
  ) => {
    const collection = store.getKnowledgeCollection(collectionId);
    if (!collection) {
      return null;
    }
    if (!isRepoBackedSourceConfig(collection.sourceConfig)) {
      return store.createKnowledgeDocument(collectionId, input);
    }
    const sourcePath = normalizeStoredSourcePath(
      collection.sourceConfig,
      normalizeSourcePath(input.title, input.sourcePath),
    );
    const remote = await sourceAdapters.writeDocument(collection.sourceConfig, {
      sourcePath,
      body: input.body ?? "",
      title: input.title,
      operation: "create",
    });
    return store.createKnowledgeDocument(collectionId, {
      ...input,
      sourcePath,
      source: {
        ...remote.source,
        path: normalizeStoredSourcePath(
          collection.sourceConfig,
          remote.source.path,
        ),
      },
    });
  };

  const updateCanonicalDocument = async (
    documentId: string,
    input: DocumentUpdateInput,
  ) => {
    const document = store.getKnowledgeDocument(documentId);
    if (!document) {
      return null;
    }
    const collection = store.getKnowledgeCollection(document.collectionId);
    if (
      !isRepoBackedSourceConfig(collection?.sourceConfig) ||
      !document.source?.path
    ) {
      return store.updateKnowledgeDocument(documentId, input);
    }
    const sourcePath = normalizeStoredSourcePath(
      collection.sourceConfig,
      document.source.path,
    );
    const title = input.title?.trim() || document.title;
    const body = typeof input.body === "string" ? input.body : document.body;
    const remote = await sourceAdapters.writeDocument(collection.sourceConfig, {
      sourcePath,
      body,
      sha: document.source.sha,
      title,
      operation: "update",
    });
    return store.updateKnowledgeDocument(documentId, {
      ...input,
      body,
      source: {
        ...remote.source,
        path: normalizeStoredSourcePath(
          collection.sourceConfig,
          remote.source.path,
        ),
      },
    });
  };

  const deleteCanonicalDocument = async (documentId: string) => {
    const document = store.getKnowledgeDocument(documentId);
    if (!document) {
      return null;
    }
    const collection = store.getKnowledgeCollection(document.collectionId);
    if (
      isRepoBackedSourceConfig(collection?.sourceConfig) &&
      document.source?.path
    ) {
      const sourcePath = normalizeStoredSourcePath(
        collection.sourceConfig,
        document.source.path,
      );
      await sourceAdapters.deleteDocument(collection.sourceConfig, {
        sourcePath,
        sha: document.source.sha,
        title: document.title,
      });
    }
    return store.deleteKnowledgeDocument(documentId);
  };

  const ingestRepoBackedCollection = async (
    collection: NonNullable<
      ReturnType<KnowledgeStore["getKnowledgeCollection"]>
    >,
  ) => {
    const summary = emptyIngestSummary();
    const documents: KnowledgeIngestDocumentResult[] = [];
    if (!isRepoBackedSourceConfig(collection.sourceConfig)) {
      countIngestAction(summary, "skipped");
      documents.push({
        action: "skipped",
        reason: "collection_is_not_source_backed",
        sourcePath: collection.id,
        title: collection.name,
      });
      return { documents, summary };
    }

    const sourceDocuments = await sourceAdapters.listDocuments(
      collection.sourceConfig,
    );
    for (const sourceDocument of sourceDocuments) {
      const sourcePath = normalizeStoredSourcePath(
        collection.sourceConfig,
        sourceDocument.path,
      );
      if (!isKnowledgeIngestiblePath(sourcePath)) {
        countIngestAction(summary, "skipped");
        documents.push({
          action: "skipped",
          reason: "unsupported_file_type",
          sourcePath,
        });
        continue;
      }
      try {
        const remote = await sourceAdapters.readDocument(
          collection.sourceConfig,
          sourcePath,
        );
        const storedSource = {
          ...remote.source,
          path: normalizeStoredSourcePath(
            collection.sourceConfig,
            remote.source.path,
          ),
        };
        const existing = store.getKnowledgeDocumentBySourcePath(
          collection.id,
          sourcePath,
        );
        const title = titleFromSourcePath(sourcePath, remote.body);
        const summaryText = summaryFromBody(remote.body);
        const bodyFormat = bodyFormatFromSourcePath(sourcePath);
        if (existing) {
          if (
            existing.body === remote.body &&
            existing.source?.sha === storedSource.sha
          ) {
            countIngestAction(summary, "unchanged");
            documents.push({
              action: "unchanged",
              documentId: existing.id,
              sourcePath,
              title: existing.title,
            });
            continue;
          }
          const updated = store.updateKnowledgeDocument(existing.id, {
            body: remote.body,
            bodyFormat,
            source: storedSource,
            status: "published",
            summary: summaryText,
            title,
          });
          if (!updated) {
            throw new Error(
              "Knowledge document disappeared during ingest update.",
            );
          }
          await projectDocumentToBrain(updated);
          countIngestAction(summary, "updated");
          documents.push({
            action: "updated",
            documentId: updated.id,
            sourcePath,
            title: updated.title,
          });
          continue;
        }
        const created = store.createKnowledgeDocument(collection.id, {
          body: remote.body,
          bodyFormat,
          source: storedSource,
          sourcePath,
          status: "published",
          summary: summaryText,
          title,
        });
        if (!created) {
          throw new Error(
            "Knowledge collection disappeared during ingest create.",
          );
        }
        await projectDocumentToBrain(created);
        countIngestAction(summary, "created");
        documents.push({
          action: "created",
          documentId: created.id,
          sourcePath,
          title: created.title,
        });
      } catch (error) {
        countIngestAction(summary, "failed");
        documents.push({
          action: "failed",
          error: error instanceof Error ? error.message : String(error),
          sourcePath,
        });
      }
    }
    return { documents, summary };
  };

  const mergeIngestSummary = (
    target: KnowledgeIngestSummary,
    source: KnowledgeIngestSummary,
  ) => {
    target.created += source.created;
    target.failed += source.failed;
    target.skipped += source.skipped;
    target.unchanged += source.unchanged;
    target.updated += source.updated;
  };

  const ingestResponse = (input: {
    readonly collectionId?: string | null;
    readonly companyId: string;
    readonly documents: readonly KnowledgeIngestDocumentResult[];
    readonly source: "files" | "repo";
    readonly summary: KnowledgeIngestSummary;
  }) => ({
    ok: input.summary.failed === 0,
    collectionId: input.collectionId ?? null,
    companyId: input.companyId,
    documents: input.documents,
    runId: `king_${randomUUID()}`,
    source: input.source,
    status: input.summary.failed > 0 ? "partial" : "completed",
    summary: input.summary,
  });

  let projectionTimer: NodeJS.Timeout | undefined;
  if (config.environment !== "test") {
    app.addHook("onReady", async () => {
      const tick = () => { void projections.reconcile().catch(() => recordEvent({ type: "brain.indexing.failed" })); };
      tick();
      projectionTimer = setInterval(tick, 30_000);
      projectionTimer.unref();
    });
  }
  app.addHook("onClose", async () => {
    clearInterval(projectionTimer);
    await projections.close();
    extractions.close();
    authorizationAudit.close();
    researchWriteLedger?.close();
    researchChatLedger?.close();
    await brain.close();
    persistence?.close();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (isResearchSameOriginPath(request.url)) {
      reply.header("cache-control", "no-store");
      return;
    }
    reply.header("access-control-allow-origin", "*");
    reply.header(
      "access-control-allow-methods",
      "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    );
    reply.header(
      "access-control-allow-headers",
      "authorization,content-type,accept,idempotency-key",
    );
  });

  app.addHook("preHandler", async (request, reply) => {
    const pathname = requestPath(request.url);
    // Use the route Fastify actually matched for authorization policy. A raw
    // URL can encode static path bytes and still dispatch to this same route.
    const policyPathname = request.routeOptions.url ?? pathname;
    const suppliedBearer = bearerToken(request);
    const nativeRoute = policyPathname.startsWith("/api/brain/native/");
    const requestPrincipal = request.knowledgePrincipal ?? researchPrincipals.resolve(suppliedBearer) ??
      (portalPrincipals ? await portalPrincipals.resolve(suppliedBearer) : null) ??
      // Edge-minted, per-request bearers for Portal attachments with knowledge:brain:* grants.
      (nativeRoute && options.brainPrincipalProvider ? await options.brainPrincipalProvider(request, "brain:native") : null);
    if (requestPrincipal) request.knowledgePrincipal = requestPrincipal;
    const partitionProtected = partitionProtectedPath(policyPathname);
    // Engine routes own their existing bearer/browser/provider and mapping checks.
    const mappedResearch = isResearchSameOriginPath(policyPathname);
    const suppliedGenericBearer = request.headers.authorization !== undefined &&
      !policyPathname.startsWith("/api/brain/") && !policyPathname.startsWith("/api/research/");
    if (!mappedResearch && partitionProtected && (config.partitionAuthorizationRequired || requestPrincipal || suppliedGenericBearer || policyPathname.startsWith("/api/brain/native/"))) {
      if (!requestPrincipal) {
        recordAuthorization(request, "denied", null, null);
        reply.code(401).send({ ok: false, error: "authentication_required" });
        return;
      }
      if (policyPathname !== "/api/knowledge/partitions" && policyPathname !== "/api/research/engine/notebooks") {
        const partitionKey = storePartitionForRequest(request, store, policyPathname);
        if (!partitionKey) {
          recordAuthorization(request, "denied", null, null);
          reply.code(400).send({ ok: false, error: "partition_key_required" });
          return;
        }
        // Native operations authorize against the selected engine's per-operation policy.
        const nativePolicy = policyPathname === "/api/brain/native/:operation"
          ? brain.nativeOperationPolicy(String((request.params as Record<string, unknown> | undefined)?.operation ?? ""))
          // Discovery is a native read: brain:read or an attachment's brain:native:read.
          : policyPathname === "/api/brain/native/tools" ? { scope: "read" as const, capabilities: ["brain:read"] } : null;
        const capability = nativePolicy ? nativePolicy.capabilities[0]! : partitionCapabilityForRequest(request.method, policyPathname);
        const authorization = authorizeKnowledgePartition(requestPrincipal, partitionKey, capability);
        const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
        const additionalCapabilities = policyPathname.startsWith("/api/brain/native/") ? [] : policyPathname.includes("/ingest-") ? ["knowledge:update"]
          : policyPathname === "/api/research/chat" ? ["research:read"]
          : /^\/api\/research\/(?:notebooks|sources|entries|outputs)\/[^/]+$/u.test(policyPathname) && ["PATCH", "DELETE"].includes(request.method) ? ["research:read"]
          : /^\/api\/research\/notebooks\/[^/]+\/entries$/u.test(policyPathname) && request.method === "POST"
            ? [
                ...(typeof body.sourceId === "string" && body.sourceId.trim() ? ["research:read"] : []),
                ...(typeof body.documentId === "string" && body.documentId.trim() ? ["knowledge:read"] : []),
              ]
          : /^\/api\/research\/outputs\/[^/]+\/promote$/u.test(policyPathname)
            ? ["research:read", body.documentId ? "knowledge:update" : "knowledge:create"] : [];
        const admitted = nativePolicy ? nativeOperationAuthorized(requestPrincipal, partitionKey, nativePolicy)
          : authorization.allowed && !additionalCapabilities.some(required => !authorizeKnowledgePartition(requestPrincipal, partitionKey, required).allowed);
        if (!admitted) {
          recordAuthorization(request, "denied", capability, partitionKey);
          reply.code(403).send({ ok: false, error: "partition_scope_denied" });
          return;
        }
        request.knowledgePartitionKey = authorization.partitionKey;
        if (request.method === "POST" && /^\/api\/companies\/[^/]+\/knowledge\/collections$/u.test(policyPathname)) {
          const source = body.sourceConfig as Record<string, unknown> | null | undefined;
          if (source && source.provider !== "native") {
            recordAuthorization(request, "denied", capability, partitionKey);
            reply.code(403).send({ ok: false, error: "runtime_source_configuration_denied" });
            return;
          }
          // Agent-created collections never inherit operator repository credentials.
          request.body = { ...body, sourceConfig: { provider: "native" } };
        }
        recordAuthorization(request, "admitted", capability, authorization.partitionKey);
      }
    }

    const operation = classifyKnowledgeOperation({
      method: request.method,
      pathname: policyPathname,
      params: request.params as Record<string, string | undefined>,
      query: request.query as Record<string, unknown>,
      body: request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)
        ? request.body as Record<string, unknown>
        : undefined,
    });
    if (!operation || !rulesBindingRequested) {
      return;
    }
    if (!rulesClient) {
      reply.code(503).send({
        ok: false,
        error: "rules_unavailable",
        message: "Rules Approvals is unavailable.",
        operation: operation.operation,
      });
      return;
    }
    const effectivePartition = request.knowledgePartitionKey
      ?? (requestPrincipal ? normalizeKnowledgePartitionKey(requestPrincipal.companyId) : null)
      ?? operation.companyId;
    const decision = await rulesClient.evaluate({
      ...operation,
      companyId: effectivePartition,
      payload: {
        ...operation.payload,
        ...(effectivePartition ? { partitionKey: effectivePartition } : {}),
      },
      actor: {
        id: requestPrincipal?.principalId ?? config.rulesActorId,
        roles: ["service"],
        source: "knowledge-program",
        companyId: requestPrincipal?.companyId ?? null,
      },
    });
    if (decision.effect === "allow") {
      return;
    }
    if (decision.effect === "review") {
      reply.code(409).send({
        ok: false,
        error: "rules_review_required",
        message: "Rules Approvals requires review before this Knowledge operation can continue.",
        operation: operation.operation,
      });
      return;
    }
    if (decision.effect === "deny") {
      reply.code(403).send({
        ok: false,
        error: "rules_denied",
        message: "Rules Approvals denied this Knowledge operation.",
        operation: operation.operation,
      });
      return;
    }
    reply.code(503).send({
      ok: false,
      error: "rules_unavailable",
      message: "Rules Approvals is unavailable.",
      operation: operation.operation,
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!partitionProtectedPath(requestPath(request.url))) return;
    try {
      if (!authorizationAuditIds.has(request) && (request.knowledgePrincipal || request.headers.authorization !== undefined)) {
        recordAuthorization(request, reply.statusCode < 400 ? "admitted" : "denied",
          partitionCapabilityForRequest(request.method, requestPath(request.url)), request.knowledgePartitionKey ?? null);
      }
      const id = authorizationAuditIds.get(request);
      if (id) authorizationAudit.complete(id, reply.statusCode);
    } catch {
      // A completion-record failure cannot undo a dispatched operation. No content/error dump.
      app.log.error({ event: "authorization_audit_completion_failed" });
    }
  });

  app.addContentTypeParser(
    /^multipart\/form-data/u,
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        ok: false,
        error: "invalid_request",
        details: error.issues,
      });
      return;
    }
    if (error instanceof KnowledgeSourceSyncError) {
      reply.code(error.statusCode).send({
        ok: false,
        error: error.code,
        message: error.message,
        details: error.details ?? null,
      });
      return;
    }
    reply.send(error);
  });

  app.get("/healthz", async () => ({
    ok: true,
    service: "knowledge",
  }));

  app.options("/*", async (_request, reply) => {
    reply.code(204).send();
  });

  app.get("/api/status", async () => buildStatus(config, store, brain));

  const redactedStatus = () => {
    const status = buildStatus(config, store, brain);
    return {
      ok: status.ok,
      program: {
        id: "knowledge",
        name: status.name,
        version: KNOWLEDGE_FRONTEND_VERSION,
        environment: config.environment,
        status: status.status,
      },
      subapps: status.subapps,
      dependencies: {
        gbrain: {
          required: status.sidecars.gbrain.required,
          status: status.sidecars.gbrain.status,
          configured: status.sidecars.gbrain.configured,
          tokenConfigured: status.sidecars.gbrain.tokenConfigured,
          detail: status.sidecars.gbrain.detail,
        },
        knowledgeDb: {
          required: status.sidecars.knowledgeDb.required,
          status: status.sidecars.knowledgeDb.status,
          kind: status.sidecars.knowledgeDb.kind,
        },
        objectStore: {
          required: status.sidecars.objectStore.required,
          status: status.sidecars.objectStore.status,
        },
        rules: {
          requiredForGovernedOperations: rulesBindingRequested,
          status: rulesBindingRequested
            ? rulesClient
              ? "configured"
              : "unavailable"
            : "local",
          detail: rulesBindingRequested
            ? rulesClient
              ? "Configured governed Knowledge operations call the Rules gateway before route handlers."
              : "A central Rules binding is incomplete; governed Knowledge operations fail closed."
            : "No central Rules binding is configured; standalone Knowledge-owned operations use local app authority.",
        },
        workEthic: {
          requiredForOwnerBindings: false,
          status: "contract-only",
          detail:
            "Owner and generic binding contracts are available; remote Work Ethic reachability is not exposed.",
        },
      },
      counts: status.counts,
      authorization: {
        generalDomainBearerRequired: config.partitionAuthorizationRequired,
        partitionAuthorizationRequired: config.partitionAuthorizationRequired,
        partitionModel: "server-attested-grants-over-hierarchical-keys",
        openNotebookEngineReads: "service-bearer-and-company-notebook-mapping",
        openNotebookEngineWrites: "research:write-and-company-notebook-mapping-and-durable-idempotency-key",
        brainExtractFacts: "same-origin-or-gbrain-or-dedicated-extraction-bearer",
        credentialExposedToBrowser: false,
      },
    };
  };

  const sendWebShell = async (reply: FastifyReply) => {
    const html = await readWebAsset("index.html");
    reply.header("cache-control", "no-store");
    reply.header(
      "content-security-policy",
      `default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${browserSession ? "'self'" : "*"}`,
    );
    reply
      .type("text/html; charset=utf-8")
      .send(
        html ?? Buffer.from(renderObserverUi(config, store, brain), "utf8"),
      );
  };

  app.get("/", async (_request, reply) => sendWebShell(reply));
  app.get("/embed", async (_request, reply) => sendWebShell(reply));
  app.get("/assets/*", async (request, reply) => {
    const relativePath = `assets/${(request.params as { "*": string })["*"]}`;
    const asset = await readWebAsset(relativePath);
    if (!asset) {
      reply
        .code(404)
        .send({ ok: false, error: "knowledge_web_asset_not_found" });
      return;
    }
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.type(webContentType(relativePath)).send(asset);
  });

  app.get("/status", async () => redactedStatus());
  const disabledBrowserSession = {
    enabled: false,
    authenticated: false,
    principal: null,
    csrfToken: null,
    expiresAt: null,
  } as const;
  const browserSessionError = (reply: FastifyReply, error: unknown) => {
    const status = browserSessionErrorStatus(error);
    const code = error instanceof ResearchBrowserSessionError ? error.code : "browser_session_authority_unavailable";
    reply.code(status).send({ error: code });
  };
  app.get("/api/research/browser-session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!browserSession) return disabledBrowserSession;
    try {
      return browserSession.status(request.headers);
    } catch (error) {
      browserSessionError(reply, error);
      return undefined;
    }
  });
  app.post("/api/research/browser-session", { bodyLimit: 4096 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!browserSession) {
      reply.code(404).send({ error: "browser_session_disabled" });
      return;
    }
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, "secret")) {
      reply.code(400).send({ error: "invalid_browser_session_request" });
      return;
    }
    const secret = (body as Record<string, unknown>).secret;
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") > 4096) {
      reply.code(400).send({ error: "invalid_browser_session_request" });
      return;
    }
    try {
      const result = browserSession.login(secret, request.headers);
      reply.header("set-cookie", result.setCookie).send(result.status);
    } catch (error) {
      browserSessionError(reply, error);
    }
  });
  app.delete("/api/research/browser-session", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!browserSession) {
      reply.code(404).send({ error: "browser_session_disabled" });
      return;
    }
    try {
      const status = browserSession.logout(request.headers);
      const secure = browserSession.secure ? "; Secure" : "";
      reply.header("set-cookie", `${RESEARCH_BROWSER_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/research; Max-Age=0${secure}`).send(status);
    } catch (error) {
      browserSessionError(reply, error);
    }
  });
  app.get("/bootstrap.json", async (request) => ({
    ...redactedStatus(),
    surfaces: {
      standalone: "/",
      embed: "/embed",
      status: "/status",
      openapi: "/openapi.json",
      swagger: "/swagger.json",
    },
    scope: {
      // A Portal deployment is bound to one workspace; standalone installs keep "default".
      defaultCompanyId: process.env.KNOWLEDGE_COMPANY_ID?.trim() || "default",
      // Display-only name forwarded by the instance edge from the Portal browser grant.
      workspaceLabel: workspaceLabel(request.headers["x-knowledge-workspace-label"]),
    },
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
  }));
  app.get("/openapi.json", async () => buildKnowledgeOpenApi());
  app.get("/swagger.json", async (_request, reply) => {
    reply.header(
      "content-disposition",
      'attachment; filename="knowledge-swagger.json"',
    );
    return buildKnowledgeOpenApi();
  });

  app.get("/api/events", async () => ({
    ok: true,
    events,
  }));

  app.get(
    "/api/companies/:companyId/knowledge/collections",
    async (request) => {
      const { companyId } = request.params as { companyId: string };
      return store.listKnowledgeCollections(companyId, !request.knowledgePrincipal);
    },
  );

  app.post(
    "/api/companies/:companyId/knowledge/collections",
    async (request, reply) => {
      const { companyId } = request.params as { companyId: string };
      const input = CollectionInputSchema.parse(request.body);
      reply.code(201).send(
        store.createKnowledgeCollection(companyId, {
          name: input.name,
          description: input.description,
          sourceConfig: input.sourceConfig,
        }),
      );
    },
  );

  app.post(
    "/api/companies/:companyId/knowledge/ingest-runs",
    async (request, reply) => {
      const { companyId } = request.params as { companyId: string };
      const input = KnowledgeIngestRunInputSchema.parse(request.body ?? {});
      const summary = emptyIngestSummary();
      const documents: KnowledgeIngestDocumentResult[] = [];
      const collections = input.collectionId
        ? [store.getKnowledgeCollection(input.collectionId)].filter(
            (
              collection,
            ): collection is NonNullable<
              ReturnType<KnowledgeStore["getKnowledgeCollection"]>
            > => Boolean(collection && collection.companyId === companyId),
          )
        : store
            .listKnowledgeCollections(companyId)
            .filter((collection) =>
              isRepoBackedSourceConfig(collection.sourceConfig),
            );
      if (input.collectionId && collections.length === 0) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_collection_not_found" });
        return;
      }
      for (const collection of collections) {
        const result = await ingestRepoBackedCollection(collection);
        mergeIngestSummary(summary, result.summary);
        documents.push(...result.documents);
      }
      const response = ingestResponse({
        collectionId: input.collectionId ?? null,
        companyId,
        documents,
        source: "repo",
        summary,
      });
      recordEvent({
        type: "knowledge.ingest.run",
        collectionId: input.collectionId ?? null,
        ok: response.ok,
        source: "repo",
        status: response.status,
        summary,
      });
      reply.code(201).send(response);
    },
  );

  app.post(
    "/api/companies/:companyId/knowledge/ingest-files",
    async (request, reply) => {
      const { companyId } = request.params as { companyId: string };
      const raw = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from("");
      const parsed = parseMultipartFormData(
        raw,
        request.headers["content-type"],
      );
      if (parsed.files.length === 0) {
        reply
          .code(400)
          .send({ ok: false, error: "knowledge_ingest_file_required" });
        return;
      }
      const requestedCollectionId = nonEmptyString(parsed.fields.collectionId);
      const collection = requestedCollectionId
        ? store.getKnowledgeCollection(requestedCollectionId)
        : store.listKnowledgeCollections(companyId)[0];
      if (!collection || collection.companyId !== companyId) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_collection_not_found" });
        return;
      }

      const summary = emptyIngestSummary();
      const documents: KnowledgeIngestDocumentResult[] = [];
      for (const file of parsed.files) {
        const sourcePath = file.filename.trim();
        if (!sourcePath || !isKnowledgeIngestiblePath(sourcePath)) {
          countIngestAction(summary, "skipped");
          documents.push({
            action: "skipped",
            reason: sourcePath ? "unsupported_file_type" : "missing_filename",
            sourcePath: sourcePath || file.name,
          });
          continue;
        }
        try {
          const body = extractImportedFileText(file);
          const title =
            parsed.files.length === 1
              ? (nonEmptyString(parsed.fields.title) ??
                titleFromSourcePath(sourcePath, body))
              : titleFromSourcePath(sourcePath, body);
          const bodyFormat = bodyFormatFromSourcePath(
            sourcePath,
            file.contentType,
          );
          const existing = isRepoBackedSourceConfig(collection.sourceConfig)
            ? store.getKnowledgeDocumentBySourcePath(collection.id, sourcePath)
            : null;
          const document = existing
            ? await updateCanonicalDocument(existing.id, {
                body,
                bodyFormat,
                status: "published",
                summary: summaryFromBody(body),
                title,
              })
            : await createCanonicalDocument(collection.id, {
                body,
                bodyFormat,
                sourcePath,
                status: "published",
                summary: summaryFromBody(body),
                title,
              });
          if (!document) {
            throw new Error("Knowledge document import failed.");
          }
          await projectDocumentToBrain(document);
          const action: KnowledgeIngestAction = existing
            ? "updated"
            : "created";
          countIngestAction(summary, action);
          documents.push({
            action,
            documentId: document.id,
            sourcePath,
            title: document.title,
          });
        } catch (error) {
          countIngestAction(summary, "failed");
          documents.push({
            action: "failed",
            error: error instanceof Error ? error.message : String(error),
            sourcePath,
          });
        }
      }

      const response = ingestResponse({
        collectionId: collection.id,
        companyId,
        documents,
        source: "files",
        summary,
      });
      recordEvent({
        type: "knowledge.ingest.run",
        collectionId: collection.id,
        ok: response.ok,
        source: "files",
        status: response.status,
        summary,
      });
      reply.code(201).send(response);
    },
  );

  app.get("/api/companies/:companyId/knowledge/search", async (request) => {
    const { companyId } = request.params as { companyId: string };
    const query = request.query as {
      q?: string;
      collectionId?: string;
      excludeDocumentId?: string;
      limit?: string;
    };
    return store.searchKnowledgeDocuments(companyId, {
      q: query.q ?? "",
      collectionId: query.collectionId ?? null,
      excludeDocumentId: query.excludeDocumentId ?? null,
      limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
    });
  });

  /**
   * Fleet/Portal discovery surface. This exposes only the caller's
   * server-attested grants; it never accepts a partition list from the
   * browser and never returns service credentials.
   */
  app.get("/api/knowledge/partitions", async (request, reply) => {
    const principal = request.knowledgePrincipal;
    if (!principal) {
      reply.code(401).send({ ok: false, error: "authentication_required" });
      return;
    }
    reply.send({
      ok: true,
      principalId: principal.principalId,
      partitions: partitionGrantSummaries(principal),
    });
  });

  app.get("/api/knowledge/collections", async (request) => {
    const query = request.query as { partitionKey?: string; companyId?: string };
    return store.listKnowledgeCollections(query.partitionKey ?? query.companyId ?? "default", !request.knowledgePrincipal);
  });

  app.delete(
    "/api/knowledge/collections/:collectionId",
    async (request, reply) => {
      const { collectionId } = request.params as { collectionId: string };
      const collection = store.deleteKnowledgeCollection(collectionId);
      if (!collection) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_collection_not_found" });
        return;
      }
      reply.send(request.knowledgePrincipal && !authorizeKnowledgePartition(request.knowledgePrincipal, collection.companyId, "knowledge:read").allowed
        ? { id: collection.id, deleted: true } : collection);
    },
  );

  app.get(
    "/api/knowledge/collections/:collectionId/tree",
    async (request, reply) => {
      const { collectionId } = request.params as { collectionId: string };
      const tree = store.getKnowledgeCollectionTree(collectionId);
      if (!tree) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_collection_not_found" });
        return;
      }
      reply.send(tree);
    },
  );

  app.post(
    "/api/knowledge/collections/:collectionId/documents",
    async (request, reply) => {
      const { collectionId } = request.params as { collectionId: string };
      const input = DocumentCreateSchema.parse(request.body);
      const title = input.title?.trim();
      if (!title) {
        reply
          .code(400)
          .send({ ok: false, error: "knowledge_document_title_required" });
        return;
      }
      const document = await createCanonicalDocument(collectionId, {
        ...input,
        ...actorProvenance(input.actor, request.knowledgePrincipal),
        title,
      });
      if (!document) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_collection_not_found" });
        return;
      }
      await projectDocumentToBrain(document);
      reply.code(201).send(document);
    },
  );

  app.get("/api/knowledge/documents/:documentId", async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const document = await readCanonicalDocument(documentId);
    if (!document) {
      reply
        .code(404)
        .send({ ok: false, error: "knowledge_document_not_found" });
      return;
    }
    await projectDocumentToBrain(document);
    reply.send(document);
  });

  app.delete("/api/knowledge/documents/:documentId", async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const document = await deleteCanonicalDocument(documentId);
    if (!document) {
      reply
        .code(404)
        .send({ ok: false, error: "knowledge_document_not_found" });
      return;
    }
    reply.send(request.knowledgePrincipal && !authorizeKnowledgePartition(request.knowledgePrincipal, document.companyId, "knowledge:read").allowed
      ? { id: document.id, deleted: true } : document);
  });

  app.patch("/api/knowledge/documents/:documentId", async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const input = DocumentUpdateSchema.parse(request.body);
    const document = await updateCanonicalDocument(documentId, {
      ...input,
      ...actorProvenance(input.actor, request.knowledgePrincipal),
    });
    if (!document) {
      reply
        .code(404)
        .send({ ok: false, error: "knowledge_document_not_found" });
      return;
    }
    await projectDocumentToBrain(document);
    reply.send(request.knowledgePrincipal && !authorizeKnowledgePartition(request.knowledgePrincipal, document.companyId, "knowledge:read").allowed
      ? { id: document.id, updated: true } : document);
  });

  app.get(
    "/api/knowledge/documents/:documentId/revisions",
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      if (!store.getKnowledgeDocument(documentId)) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_document_not_found" });
        return;
      }
      reply.send(store.listKnowledgeDocumentRevisions(documentId));
    },
  );

  app.get(
    "/api/knowledge/documents/:documentId/comments",
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      if (!store.getKnowledgeDocument(documentId)) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_document_not_found" });
        return;
      }
      reply.send(store.listKnowledgeDocumentComments(documentId));
    },
  );

  app.post(
    "/api/knowledge/documents/:documentId/comments",
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      const input = CommentInputSchema.parse(request.body);
      const comment = store.addKnowledgeDocumentComment(documentId, input);
      if (!comment) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_document_not_found" });
        return;
      }
      reply.code(201).send(comment);
    },
  );

  app.get(
    "/api/knowledge/documents/:documentId/access",
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      const policy = store.getKnowledgeAccessPolicy(documentId);
      if (!policy) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_document_not_found" });
        return;
      }
      reply.send(policy);
    },
  );

  app.put(
    "/api/knowledge/documents/:documentId/access",
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      const input = AccessPolicyInputSchema.parse(request.body);
      const policy = store.updateKnowledgeAccessPolicy(documentId, input);
      if (!policy) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_document_not_found" });
        return;
      }
      reply.send(request.knowledgePrincipal && !authorizeKnowledgePartition(request.knowledgePrincipal, policy.companyId, "knowledge:read").allowed
        ? { documentId, updated: true } : policy);
    },
  );

  app.get(
    "/api/knowledge/documents/:documentId/attachments",
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      const attachments = store.listKnowledgeAttachments(documentId);
      if (!attachments) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_document_not_found" });
        return;
      }
      reply.send(
        attachments.map((attachment) =>
          toKnowledgeAttachmentResponse(attachment),
        ),
      );
    },
  );

  app.post(
    "/api/companies/:companyId/knowledge/documents/:documentId/attachments",
    async (request, reply) => {
      const { companyId, documentId } = request.params as {
        companyId: string;
        documentId: string;
      };
      const document = store.getKnowledgeDocument(documentId);
      if (!document || document.companyId !== companyId) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_document_not_found" });
        return;
      }
      const raw = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from("");
      const parsed = parseMultipartFormData(
        raw,
        request.headers["content-type"],
      );
      const file =
        parsed.files.find((entry) => entry.name === "file") ?? parsed.files[0];
      if (!file) {
        reply.code(400).send({ ok: false, error: "file_required" });
        return;
      }
      const uploadsDir = path.join(
        config.dataDir,
        "knowledge-attachments",
        documentId,
      );
      await fs.mkdir(uploadsDir, { recursive: true });
      const objectKey = randomUUID();
      const ext = path.extname(file.filename).slice(0, 24);
      const safeExt = ext ? `.${ext.replace(/^\.+/u, "")}` : "";
      const storagePath = path.join(uploadsDir, `${objectKey}${safeExt}`);
      await fs.writeFile(storagePath, file.content);
      const attachmentId = `katt_${randomUUID()}`;
      const attachment = store.createKnowledgeAttachment({
        id: attachmentId,
        companyId,
        documentId,
        assetId: `asset_${randomUUID()}`,
        label: parsed.fields.label?.trim() || null,
        provider: "local",
        objectKey,
        contentType: file.contentType || "application/octet-stream",
        byteSize: file.content.length,
        sha256: createHash("sha256").update(file.content).digest("hex"),
        originalFilename: file.filename,
        createdByAgentId: null,
        createdByUserId: "operator",
        createdAt: new Date().toISOString(),
        contentPath: `/api/knowledge/attachments/${attachmentId}/content`,
        storagePath,
      });
      if (!attachment) {
        await fs.rm(storagePath, { force: true }).catch(() => undefined);
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_document_not_found" });
        return;
      }
      reply.code(201).send(toKnowledgeAttachmentResponse(attachment));
    },
  );

  app.get(
    "/api/knowledge/attachments/:attachmentId",
    async (request, reply) => {
      const { attachmentId } = request.params as { attachmentId: string };
      const attachment = store.getKnowledgeAttachment(attachmentId);
      if (!attachment) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_attachment_not_found" });
        return;
      }
      reply.send(toKnowledgeAttachmentResponse(attachment));
    },
  );

  app.get(
    "/api/knowledge/attachments/:attachmentId/content",
    async (request, reply) => {
      const { attachmentId } = request.params as { attachmentId: string };
      const attachment = store.getKnowledgeAttachment(attachmentId);
      if (!attachment?.storagePath) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_attachment_not_found" });
        return;
      }
      try {
        const content = await fs.readFile(attachment.storagePath);
        reply.header("content-type", "application/octet-stream");
        reply.header("content-disposition", attachmentDisposition(attachment.originalFilename));
        reply.header("x-content-type-options", "nosniff");
        reply.header("cache-control", "private, max-age=60");
        reply.send(content);
      } catch {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_attachment_content_missing" });
      }
    },
  );

  app.delete(
    "/api/knowledge/attachments/:attachmentId",
    async (request, reply) => {
      const { attachmentId } = request.params as { attachmentId: string };
      const attachment = store.deleteKnowledgeAttachment(attachmentId);
      if (!attachment) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_attachment_not_found" });
        return;
      }
      if (attachment.storagePath) {
        await fs
          .rm(attachment.storagePath, { force: true })
          .catch(() => undefined);
      }
      reply.send({ ok: true });
    },
  );

  app.get(
    "/api/knowledge/documents/:documentId/links",
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      const links = store.listKnowledgeLinks(documentId);
      if (!links) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_document_not_found" });
        return;
      }
      reply.send(links);
    },
  );

  app.post(
    "/api/knowledge/documents/:documentId/links",
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      const input = LinkInputSchema.parse(request.body);
      const created = store.createKnowledgeLink(documentId, input);
      if (!created) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_link_target_not_found" });
        return;
      }
      reply.code(201).send(created);
    },
  );

  app.get("/api/knowledge/links/:linkId", async (request, reply) => {
    const { linkId } = request.params as { linkId: string };
    const link = store.getKnowledgeLink(linkId);
    if (!link) {
      reply.code(404).send({ ok: false, error: "knowledge_link_not_found" });
      return;
    }
    reply.send(link);
  });

  app.delete("/api/knowledge/links/:linkId", async (request, reply) => {
    const { linkId } = request.params as { linkId: string };
    const link = store.deleteKnowledgeLink(linkId);
    if (!link) {
      reply.code(404).send({ ok: false, error: "knowledge_link_not_found" });
      return;
    }
    reply.send({ ok: true });
  });

  const registerOwnerRoutes = (ownerType: KnowledgeOwnerType) => {
    const ownerPath = `/api/${ownerType}s/:ownerId`;
    app.get(`${ownerPath}/knowledge/documents`, async (request) => {
      const { ownerId } = request.params as { ownerId: string };
      return store.listKnowledgeOwnerBindings(ownerType, ownerId, "documents", request.knowledgePartitionKey);
    });
    app.post(`${ownerPath}/knowledge/documents`, async (request, reply) => {
      const { ownerId } = request.params as { ownerId: string };
      const input = DocumentCreateSchema.parse(request.body);
      const scopedInput = request.knowledgePartitionKey
        ? { ...input, companyId: request.knowledgePartitionKey }
        : input;
      let targetCollection = scopedInput.collectionId?.trim()
        ? store.getKnowledgeCollection(scopedInput.collectionId)
        : null;
      if (!targetCollection && !scopedInput.collectionId?.trim() && !scopedInput.documentId?.trim()) {
        const companyId = scopedInput.companyId ?? "default";
        const collections = store.listKnowledgeCollections(companyId, !request.knowledgePrincipal);
        targetCollection = request.knowledgePrincipal
          ? collections.find((collection) => collection.sourceConfig.provider === "native") ?? null
          : collections[0] ?? null;
        targetCollection ??= store.createKnowledgeCollection(companyId, {
          name: "Default",
          description: "Default knowledge collection",
          ...(request.knowledgePrincipal ? { sourceConfig: { provider: "native" } } : {}),
        });
      }
      const targetCollectionId = targetCollection?.id ?? null;
      const shouldCreateRepoDocument =
        !scopedInput.documentId?.trim() && targetCollectionId !== null;
      const binding = shouldCreateRepoDocument
        ? await (async () => {
            const title = scopedInput.title?.trim() || "Untitled document";
            const document = await createCanonicalDocument(
              targetCollectionId,
              {
                ...scopedInput,
                ...actorProvenance(scopedInput.actor, request.knowledgePrincipal),
                title,
              },
            );
            return document
              ? store.createKnowledgeOwnerBinding(
                  ownerType,
                  ownerId,
                  "documents",
                  {
                    documentId: document.id,
                    bindingType: input.bindingType,
                  },
                )
              : null;
          })()
        : store.createKnowledgeOwnerBinding(
            ownerType,
            ownerId,
            "documents",
            scopedInput,
          );
      if (!binding) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_document_not_found" });
        return;
      }
      reply.code(201).send(request.knowledgePrincipal && !authorizeKnowledgePartition(request.knowledgePrincipal, request.knowledgePartitionKey ?? "", "knowledge:read").allowed
        ? { id: binding.id, documentId: (binding.document as { id: string }).id, bound: true } : binding);
    });
    app.delete(
      `${ownerPath}/knowledge/documents/:documentId`,
      async (request, reply) => {
        const { ownerId, documentId } = request.params as {
          ownerId: string;
          documentId: string;
        };
        const ok = store.deleteKnowledgeOwnerBinding(
          ownerType,
          ownerId,
          "documents",
          documentId,
        );
        if (!ok) {
          reply
            .code(404)
            .send({ ok: false, error: "knowledge_binding_not_found" });
          return;
        }
        reply.send({ ok: true, documentId });
      },
    );
    app.get(`${ownerPath}/knowledge/collections`, async (request) => {
      const { ownerId } = request.params as { ownerId: string };
      return store.listKnowledgeOwnerBindings(
        ownerType,
        ownerId,
        "collections",
        request.knowledgePartitionKey,
      );
    });
    app.post(`${ownerPath}/knowledge/collections`, async (request, reply) => {
      const { ownerId } = request.params as { ownerId: string };
      const input = z
        .object({
          collectionId: z.string().trim().min(1),
          bindingType: z.string().optional().nullable(),
        })
        .parse(request.body);
      const binding = store.createKnowledgeOwnerBinding(
        ownerType,
        ownerId,
        "collections",
        input,
      );
      if (!binding) {
        reply
          .code(404)
          .send({ ok: false, error: "knowledge_collection_not_found" });
        return;
      }
      reply.code(201).send(request.knowledgePrincipal && !authorizeKnowledgePartition(request.knowledgePrincipal, request.knowledgePartitionKey ?? "", "knowledge:read").allowed
        ? { id: binding.id, collectionId: input.collectionId, bound: true } : binding);
    });
    app.delete(
      `${ownerPath}/knowledge/collections/:collectionId`,
      async (request, reply) => {
        const { ownerId, collectionId } = request.params as {
          ownerId: string;
          collectionId: string;
        };
        const ok = store.deleteKnowledgeOwnerBinding(
          ownerType,
          ownerId,
          "collections",
          collectionId,
        );
        if (!ok) {
          reply
            .code(404)
            .send({ ok: false, error: "knowledge_binding_not_found" });
          return;
        }
        reply.send({ ok: true, collectionId });
      },
    );
  };
  registerOwnerRoutes("project");
  registerOwnerRoutes("goal");
  registerOwnerRoutes("issue");

  const deploymentCompanyId = options.researchModelSync?.companyId !== undefined
    ? options.researchModelSync.companyId
    : process.env.KNOWLEDGE_COMPANY_ID?.trim() || null;
  const researchSync = new ResearchModelSync({
    baseUrl: config.openNotebookBaseUrl,
    token: config.openNotebookToken,
    dataDir: config.dataDir,
    fetchImpl: options.researchModelSync?.fetchImpl,
    companyId: deploymentCompanyId,
    envBindings: config.openNotebookBindings,
    notebooks: {
      create: (companyId) => store.createResearchNotebook({
        companyId,
        title: "Research",
        summary: "Research notebook connected to this Knowledge installation.",
      }).id,
      ownerOf: (id) => store.getResearchNotebook(id)?.companyId ?? null,
    },
  });
  await researchSync.load();
  // Startup (and post-upgrade) reconciliation: idempotent, never blocks boot,
  // retried on the next start when it fails.
  if (options.researchModelSync?.syncOnStart ?? config.environment !== "test") {
    app.addHook("onReady", async () => {
      if (!researchSync.installed) return;
      void readModelSettings(config.dataDir)
        .then((settings) => settings ? researchSync.sync(settings, { onlyIfStale: true }) : undefined)
        .then((result) => { if (result) recordEvent({ type: "research.models.sync", status: result.status }); })
        .catch(() => recordEvent({ type: "research.models.sync", status: "failed" }));
    });
  }

  registerOpenNotebookRoutes(app, {
    researchPrincipalProvider: options.researchPrincipalProvider,
    adapter: openNotebook,
    ledger: researchWriteLedger,
    chatAdapter: openNotebookChat, chatLedger: researchChatLedger,
    chatModelId: () => resolveResearchChatModelId(config.openNotebookChatModelId, researchSync),
    browserSession,
    principals: researchPrincipals,
    bindings: () => researchSync.bindings(),
    resolveNotebookCompany: (id) => store.getResearchNotebook(id)?.companyId ?? null,
    resolveNotebookSummary: (id) => {
      const notebook = store.getResearchNotebook(id);
      return notebook
        ? { id: notebook.id, name: notebook.title, description: notebook.summary ?? "" }
        : null;
    },
  });

  app.get("/api/research/summary", async (request, reply) => {
    const companyId = nonEmptyString(
      (request.query as { companyId?: string }).companyId,
    );
    if (!companyId) {
      reply.code(400).send({ error: "companyId is required" });
      return;
    }
    const notebooks = store.listResearchNotebooks(companyId);
    const sources = store.listResearchSources(companyId);
    reply.send({
      companyId,
      notebooks,
      counts: {
        notebooks: notebooks.length,
        sources: sources.length,
      },
      activeNotebookId: notebooks[0]?.id ?? null,
      recentChats: [],
      posture: {
        search: {
          available: true,
          mode: "standalone_db",
          degraded: false,
          reason: "local research store",
        },
        graph: {
          available: true,
          mode: "standalone_db",
          degraded: false,
          reason: "local research store",
        },
        ask: {
          available: true,
          mode: "grounded_fallback",
          degraded: true,
          reason: "ranked notebook context",
        },
        chat: {
          available: true,
          mode: "grounded_fallback",
          degraded: true,
          reason: "ranked notebook context",
        },
      },
    });
  });

  app.get("/api/companies/:companyId/research/notebooks", async (request) => {
    const { companyId } = request.params as { companyId: string };
    return store.listResearchNotebooks(companyId);
  });

  app.post(
    "/api/companies/:companyId/research/notebooks",
    async (request, reply) => {
      const { companyId } = request.params as { companyId: string };
      const input = NotebookInputSchema.parse(request.body);
      const notebook = store.createResearchNotebook({
        companyId,
        title: nonEmptyString(input.title) ?? "Untitled notebook",
        summary: input.summary ?? null,
        focusPrompt: input.focusPrompt ?? null,
        status: input.status ?? null,
      });
      reply.code(201).send(notebook);
    },
  );

  app.get("/api/research/notebooks/:notebookId", async (request, reply) => {
    const { notebookId } = request.params as { notebookId: string };
    const notebook = store.getResearchNotebook(notebookId);
    if (!notebook) {
      reply.code(404).send({ error: "Notebook not found" });
      return;
    }
    reply.send({
      ...notebook,
      sourceCount: store.listResearchSources(notebook.companyId, notebook.id)
        .length,
    });
  });

  app.patch("/api/research/notebooks/:notebookId", async (request, reply) => {
    const { notebookId } = request.params as { notebookId: string };
    const input = NotebookInputSchema.parse(request.body);
    const notebook = store.updateResearchNotebook(notebookId, {
      ...(input.title !== undefined ? { title: input.title ?? undefined } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.focusPrompt !== undefined
        ? { focusPrompt: input.focusPrompt }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });
    if (!notebook) {
      reply.code(404).send({ error: "Notebook not found" });
      return;
    }
    reply.send(notebook);
  });

  app.delete("/api/research/notebooks/:notebookId", async (request, reply) => {
    const { notebookId } = request.params as { notebookId: string };
    const notebook = store.deleteResearchNotebook(notebookId);
    if (!notebook) {
      reply.code(404).send({ error: "Notebook not found" });
      return;
    }
    reply.send(notebook);
  });

  app.get("/api/research/notebook", async (request, reply) => {
    const notebookId = nonEmptyString(
      (request.query as { notebookId?: string }).notebookId,
    );
    if (!notebookId) {
      reply.code(400).send({ error: "notebookId is required" });
      return;
    }
    const workspace = store.buildResearchNotebookWorkspace(notebookId);
    if (!workspace) {
      reply.code(404).send({ error: "Notebook not found" });
      return;
    }
    reply.send({
      ...workspace,
      sources: workspace.sources.map((source) => ({
        ...mapResearchSource(store, source),
        content: source.content,
      })),
    });
  });

  app.get(
    "/api/research/notebooks/:notebookId/entries",
    async (request, reply) => {
      const { notebookId } = request.params as { notebookId: string };
      if (!store.getResearchNotebook(notebookId)) {
        reply.code(404).send({ error: "Notebook not found" });
        return;
      }
      reply.send(store.listResearchEntries(notebookId));
    },
  );

  app.post(
    "/api/research/notebooks/:notebookId/entries",
    async (request, reply) => {
      const { notebookId } = request.params as { notebookId: string };
      const notebook = store.getResearchNotebook(notebookId);
      if (!notebook) {
        reply.code(404).send({ error: "Notebook not found" });
        return;
      }
      const input = ResearchEntryInputSchema.parse(request.body);
      const source = input.sourceId
        ? store.getResearchSource(input.sourceId)
        : null;
      const document = input.documentId
        ? store.getKnowledgeDocument(input.documentId)
        : null;
      const entry = store.createResearchEntry({
        companyId: notebook.companyId,
        notebookId,
        entryKind: nonEmptyString(input.entryKind) ?? "source",
        sourceId: source?.id ?? null,
        documentId: document?.id ?? null,
        documentRevisionId: nonEmptyString(input.documentRevisionId),
        role: nonEmptyString(input.role) ?? "reference",
        notes: input.notes ?? null,
        title: source?.title ?? document?.title ?? "Linked entry",
        summary: source?.summary ?? document?.summary ?? null,
        body: source?.content ?? document?.body ?? null,
        bodyFormat: document?.bodyFormat ?? "markdown",
        citation: source?.citation ?? null,
        url: source?.url ?? null,
        version: null,
      });
      reply.code(201).send(entry);
    },
  );

  app.delete("/api/research/entries/:entryId", async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const entry = store.deleteResearchEntry(entryId);
    if (!entry) {
      reply.code(404).send({ error: "Entry not found" });
      return;
    }
    reply.send(entry);
  });

  app.get("/api/companies/:companyId/research/sources", async (request) => {
    const { companyId } = request.params as { companyId: string };
    const notebookId = nonEmptyString(
      (request.query as { notebookId?: string }).notebookId,
    );
    return store
      .listResearchSources(companyId, notebookId)
      .map((source) => mapResearchSource(store, source));
  });

  app.post("/api/research/sources", async (request, reply) => {
    const input = SourceInputSchema.parse(request.body);
    const notebookId = nonEmptyString(input.notebookId);
    if (!notebookId) {
      reply.code(400).send({ error: "notebookId is required" });
      return;
    }
    const notebook = store.getResearchNotebook(notebookId);
    if (!notebook) {
      reply.code(404).send({ error: "Notebook not found" });
      return;
    }
    const source = store.createResearchSource({
      companyId: notebook.companyId,
      notebookId,
      title: nonEmptyString(input.title) ?? "Untitled source",
      sourceType:
        nonEmptyString(input.sourceType) ?? nonEmptyString(input.kind),
      url: input.url ?? null,
      author: input.author ?? null,
      publisher: input.publisher ?? null,
      publishedAt: input.publishedAt ?? null,
      summary: input.summary ?? null,
      citation: input.citation ?? null,
      apiConfig: input.apiConfig ?? null,
      apiSnapshot: input.apiSnapshot ?? null,
      status: input.status ?? null,
      content: input.content ?? input.text ?? "",
      notes: input.notes ?? null,
    });
    if (!source) {
      reply.code(404).send({ error: "Notebook not found" });
      return;
    }
    await projectResearchSourceToBrain(source);
    reply.code(201).send({
      source: mapResearchSource(store, source),
      ingest: {
        mode: "standalone_ingest",
        chunking: "none",
        searchIndex: "local",
        graphLinks: [],
      },
    });
  });

  app.post(
    "/api/research/notebooks/:notebookId/imports",
    async (request, reply) => {
      const { notebookId } = request.params as { notebookId: string };
      const notebook = store.getResearchNotebook(notebookId);
      if (!notebook) {
        reply.code(404).send({ error: "Notebook not found" });
        return;
      }
      const raw = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from("");
      const parsed = parseMultipartFormData(
        raw,
        request.headers["content-type"],
      );
      const file =
        parsed.files.find((entry) => entry.name === "file") ?? parsed.files[0];
      if (!file) {
        reply.code(400).send({ error: "file is required" });
        return;
      }
      const source = store.createResearchSource({
        companyId: notebook.companyId,
        notebookId,
        title: parsed.fields.title?.trim() || file.filename,
        sourceType: "file",
        originalFilename: file.filename,
        contentType: file.contentType,
        size: file.content.length,
        author: parsed.fields.author ?? null,
        publisher: parsed.fields.publisher ?? null,
        publishedAt: parsed.fields.publishedAt ?? null,
        summary: parsed.fields.summary ?? null,
        citation: parsed.fields.citation ?? null,
        status: parsed.fields.status ?? "ready",
        content: extractImportedFileText(file),
        notes: parsed.fields.notes ?? null,
      });
      if (!source) {
        reply.code(404).send({ error: "Notebook not found" });
        return;
      }
      await projectResearchSourceToBrain(source);
      reply.code(201).send({
        source: {
          ...mapResearchSource(store, source),
          url: `/api/research/sources/${source.id}/content`,
        },
        ingest: {
          mode: "file_import",
          chunking: "none",
          searchIndex: "local",
          graphLinks: [],
        },
      });
    },
  );

  app.get("/api/research/sources/:sourceId", async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    const source = store.getResearchSource(sourceId);
    if (!source) {
      reply.code(404).send({ error: "Source not found" });
      return;
    }
    await projectResearchSourceToBrain(source);
    reply.send({
      ...mapResearchSource(store, source),
      content: source.content,
      notes: source.notes,
    });
  });

  app.get("/api/research/sources/:sourceId/content", async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    const source = store.getResearchSource(sourceId);
    if (!source) {
      reply.code(404).send({ error: "Source not found" });
      return;
    }
    reply
      .type("application/octet-stream")
      .header("content-disposition", attachmentDisposition(source.originalFilename))
      .header("x-content-type-options", "nosniff")
      .send(source.content);
  });

  app.patch("/api/research/sources/:sourceId", async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    const input = SourceInputSchema.parse(request.body);
    const source = store.updateResearchSource(sourceId, {
      ...(input.notebookId !== undefined
        ? { notebookId: nonEmptyString(input.notebookId) }
        : {}),
      ...(input.title !== undefined ? { title: input.title ?? "" } : {}),
      ...(input.sourceType !== undefined || input.kind !== undefined
        ? {
            sourceType:
              nonEmptyString(input.sourceType) ?? nonEmptyString(input.kind),
          }
        : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.author !== undefined ? { author: input.author } : {}),
      ...(input.publisher !== undefined ? { publisher: input.publisher } : {}),
      ...(input.publishedAt !== undefined
        ? { publishedAt: input.publishedAt }
        : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.citation !== undefined ? { citation: input.citation } : {}),
      ...(input.apiConfig !== undefined ? { apiConfig: input.apiConfig } : {}),
      ...(input.apiSnapshot !== undefined
        ? { apiSnapshot: input.apiSnapshot }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.content !== undefined || input.text !== undefined
        ? { content: input.content ?? input.text ?? null }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    if (!source) {
      reply.code(404).send({ error: "Source not found" });
      return;
    }
    reply.send({
      ...mapResearchSource(store, source),
      content: source.content,
      notes: source.notes,
    });
  });

  app.delete("/api/research/sources/:sourceId", async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    const source = store.deleteResearchSource(sourceId);
    if (!source) {
      reply.code(404).send({ error: "Source not found" });
      return;
    }
    reply.send(mapResearchSource(store, source));
  });

  app.get(
    "/api/research/notebooks/:notebookId/outputs",
    async (request, reply) => {
      const { notebookId } = request.params as { notebookId: string };
      if (!store.getResearchNotebook(notebookId)) {
        reply.code(404).send({ error: "Notebook not found" });
        return;
      }
      reply.send(store.listResearchOutputs(notebookId));
    },
  );

  app.post(
    "/api/research/notebooks/:notebookId/outputs",
    async (request, reply) => {
      const { notebookId } = request.params as { notebookId: string };
      const notebook = store.getResearchNotebook(notebookId);
      if (!notebook) {
        reply.code(404).send({ error: "Notebook not found" });
        return;
      }
      const input = ResearchOutputInputSchema.parse(request.body);
      const output = store.createResearchOutput({
        companyId: notebook.companyId,
        notebookId,
        outputKind:
          nonEmptyString(input.outputKind) ?? nonEmptyString(input.kind),
        title: nonEmptyString(input.title) ?? "Research output",
        summary: input.summary ?? null,
        body: input.body ?? "",
        bodyFormat: input.bodyFormat ?? null,
        status: input.status ?? null,
      });
      if (!output) {
        reply.code(404).send({ error: "Notebook not found" });
        return;
      }
      reply.code(201).send(output);
    },
  );

  app.patch("/api/research/outputs/:outputId", async (request, reply) => {
    const { outputId } = request.params as { outputId: string };
    const input = ResearchOutputInputSchema.parse(request.body);
    const output = store.updateResearchOutput(outputId, {
      ...(input.outputKind !== undefined || input.kind !== undefined
        ? {
            outputKind:
              nonEmptyString(input.outputKind) ?? nonEmptyString(input.kind),
          }
        : {}),
      ...(input.title !== undefined ? { title: input.title ?? "" } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.bodyFormat !== undefined
        ? { bodyFormat: input.bodyFormat }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.promotionState !== undefined
        ? { promotionState: input.promotionState ?? "idle" }
        : {}),
      ...(input.promotedDocumentId !== undefined
        ? { promotedDocumentId: input.promotedDocumentId }
        : {}),
      ...(input.promotedRevisionId !== undefined
        ? { promotedRevisionId: input.promotedRevisionId }
        : {}),
    });
    if (!output) {
      reply.code(404).send({ error: "Output not found" });
      return;
    }
    reply.send(output);
  });

  app.delete("/api/research/outputs/:outputId", async (request, reply) => {
    const { outputId } = request.params as { outputId: string };
    const output = store.deleteResearchOutput(outputId);
    if (!output) {
      reply.code(404).send({ error: "Output not found" });
      return;
    }
    reply.send(output);
  });

  app.post(
    "/api/research/outputs/:outputId/promote",
    async (request, reply) => {
      const { outputId } = request.params as { outputId: string };
      const output = store.getResearchOutput(outputId);
      if (!output) {
        reply.code(404).send({ error: "Output not found" });
        return;
      }
      const notebook = store.getResearchNotebook(output.notebookId);
      if (!notebook) {
        reply.code(404).send({ error: "Notebook not found" });
        return;
      }
      const input = ResearchPromoteInputSchema.parse(request.body);
      const mode = input.mode ?? "new_document";
      let promotedDocumentId = nonEmptyString(input.documentId);
      let promotedRevisionId: string | null = null;
      if (promotedDocumentId) {
        const existingDocument =
          await readCanonicalDocument(promotedDocumentId);
        if (!existingDocument) {
          reply.code(404).send({ error: "Document not found" });
          return;
        }
        const mergedBody =
          mode === "append"
            ? `${existingDocument.body}\n\n${output.body}`.trim()
            : output.body;
        const updated = await updateCanonicalDocument(promotedDocumentId, {
          title: nonEmptyString(input.title) ?? output.title,
          summary: input.summary ?? output.summary,
          body: mergedBody,
          bodyFormat: output.bodyFormat,
          status: "published",
        });
        if (updated) {
          await projectDocumentToBrain(updated);
        }
        promotedDocumentId = updated?.id ?? promotedDocumentId;
        promotedRevisionId =
          store.listKnowledgeDocumentRevisions(promotedDocumentId)[0]?.id ??
          null;
      } else {
        const collections = store.listKnowledgeCollections(notebook.companyId);
        const collectionId =
          nonEmptyString(input.collectionId) ?? collections[0]?.id ?? null;
        if (!collectionId) {
          reply.code(400).send({ error: "collectionId is required" });
          return;
        }
        const created = await createCanonicalDocument(collectionId, {
          title: nonEmptyString(input.title) ?? output.title,
          summary: input.summary ?? output.summary,
          body: output.body,
          parentDocumentId: null,
          bodyFormat: output.bodyFormat,
          status: "published",
        });
        if (!created) {
          reply.code(404).send({ error: "Collection not found" });
          return;
        }
        await projectDocumentToBrain(created);
        promotedDocumentId = created.id;
        promotedRevisionId =
          store.listKnowledgeDocumentRevisions(promotedDocumentId)[0]?.id ??
          null;
      }
      const next = store.updateResearchOutput(output.id, {
        promotionState: "promoted",
        promotedDocumentId,
        promotedRevisionId,
        status: "published",
      });
      reply.send(next ?? output);
    },
  );

  app.post("/api/research/ask", async (request, reply) => {
    const input = ResearchAskInputSchema.parse(request.body);
    const workspace = store.buildResearchNotebookWorkspace(input.notebookId);
    if (!workspace) {
      reply.code(404).send({ error: "Notebook not found" });
      return;
    }
    const ranked = store.rankResearchWorkspaceItems(input.prompt, workspace, {
      sourceIds: normalizeResearchScopeIds(input.sourceIds),
      documentIds: normalizeResearchScopeIds(input.documentIds),
    });
    reply.send({
      mode: "ask",
      notebookId: input.notebookId,
      chatSessionId: null,
      sessionKey: `research:${input.notebookId}:ask`,
      answer:
        ranked.length > 0
          ? `Prompt: ${input.prompt}\n\nRelevant notebook context:\n${ranked
              .map(
                (item, index) =>
                  `${index + 1}. ${item.title}: ${item.excerpt.slice(0, 180)}`,
              )
              .join("\n")}`
          : `Prompt: ${input.prompt}\n\nNo strongly matching source was found in the current notebook workspace.`,
      citations: ranked.map((item) => ({
        sourceId: item.kind === "source" ? item.id : null,
        documentId: item.kind === "document" ? item.id : null,
        documentRevisionId: null,
        kind: item.kind,
        title: item.title,
        citation: null,
        url: item.url,
        excerpt: item.excerpt.slice(0, 240),
        score: item.score,
      })),
      sourceIds: ranked
        .filter((item) => item.kind === "source")
        .map((item) => item.id),
      documentIds: ranked
        .filter((item) => item.kind === "document")
        .map((item) => item.id),
      noteIds: [],
      degraded: false,
      degradedReason: "",
      strategy: {
        retrievalMode: "ranked_fallback",
        candidateCount: ranked.length,
        citationCount: ranked.length,
      },
    });
  });

  app.post("/api/research/chat", async (request, reply) => {
    const input = ResearchChatInputSchema.parse(request.body);
    const workspace = store.buildResearchNotebookWorkspace(input.notebookId);
    if (!workspace) {
      reply.code(404).send({ error: "Notebook not found" });
      return;
    }
    const ranked = store.rankResearchWorkspaceItems(input.message, workspace, {
      sourceIds: normalizeResearchScopeIds(input.sourceIds),
      documentIds: normalizeResearchScopeIds(input.documentIds),
    });
    reply.send({
      mode: "chat",
      notebookId: input.notebookId,
      chatSessionId:
        nonEmptyString(input.chatSessionId) ?? `rchat_${randomUUID()}`,
      sessionKey: `research:${input.notebookId}:chat`,
      reply:
        ranked.length > 0
          ? `Notebook context for "${input.message}":\n${ranked
              .map(
                (item, index) =>
                  `${index + 1}. ${item.title}: ${item.excerpt.slice(0, 160)}`,
              )
              .join("\n")}`
          : `No strongly matching source was found for "${input.message}".`,
      citations: ranked.map((item) => ({
        sourceId: item.kind === "source" ? item.id : null,
        documentId: item.kind === "document" ? item.id : null,
        documentRevisionId: null,
        kind: item.kind,
        title: item.title,
        citation: null,
        url: item.url,
        excerpt: item.excerpt.slice(0, 240),
        score: item.score,
      })),
      sourceIds: ranked
        .filter((item) => item.kind === "source")
        .map((item) => item.id),
      documentIds: ranked
        .filter((item) => item.kind === "document")
        .map((item) => item.id),
      degraded: false,
      degradedReason: "",
      strategy: {
        retrievalMode: "ranked_fallback",
        candidateCount: ranked.length,
        citationCount: ranked.length,
      },
    });
  });

  app.post("/api/research/graph/query", async (request, reply) => {
    const input = ResearchGraphInputSchema.parse(request.body);
    const notebookId = nonEmptyString(input.scope?.notebookId);
    if (!notebookId) {
      reply
        .code(400)
        .send({ error: "query and scope.notebookId are required" });
      return;
    }
    const workspace = store.buildResearchNotebookWorkspace(notebookId);
    if (!workspace) {
      reply.code(404).send({ error: "Notebook not found" });
      return;
    }
    const terms = input.query
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length > 2);
    const matches = (value: string) =>
      terms.length === 0 ||
      terms.some((term) => value.toLowerCase().includes(term));
    const scopedSourceIds = new Set(
      normalizeResearchScopeIds(input.scope?.sourceIds),
    );
    const scopedDocumentIds = new Set(
      normalizeResearchScopeIds(input.scope?.documentIds),
    );
    const nodes: Array<Record<string, unknown>> = [
      {
        id: workspace.notebook.id,
        kind: "notebook",
        label: workspace.notebook.title,
        summary: workspace.notebook.summary,
      },
    ];
    const edges: Array<Record<string, unknown>> = [];
    for (const source of workspace.sources) {
      if (scopedSourceIds.size > 0 && !scopedSourceIds.has(source.id)) {
        continue;
      }
      if (
        !matches(
          `${source.title}\n${source.summary ?? ""}\n${source.citation ?? ""}`,
        )
      ) {
        continue;
      }
      nodes.push({
        id: source.id,
        kind: "source",
        label: source.title,
        summary: source.summary,
        status: source.status,
      });
      edges.push({
        id: `${workspace.notebook.id}:${source.id}`,
        fromId: workspace.notebook.id,
        toId: source.id,
        type: "contains_source",
        reason: "Notebook contains source",
      });
    }
    for (const document of workspace.linkedDocuments) {
      if (scopedDocumentIds.size > 0 && !scopedDocumentIds.has(document.id)) {
        continue;
      }
      if (!matches(`${document.title}\n${document.summary ?? ""}`)) {
        continue;
      }
      nodes.push({
        id: document.id,
        kind: "document",
        label: document.title,
        summary: document.summary,
      });
      edges.push({
        id: `${workspace.notebook.id}:${document.id}`,
        fromId: workspace.notebook.id,
        toId: document.id,
        type: "references_document",
        reason: "Notebook references document",
      });
    }
    for (const output of workspace.outputs) {
      if (
        !matches(`${output.title}\n${output.summary ?? ""}\n${output.body}`)
      ) {
        continue;
      }
      nodes.push({
        id: output.id,
        kind: "output",
        label: output.title,
        summary: output.summary,
        status: output.status,
      });
      edges.push({
        id: `${workspace.notebook.id}:${output.id}`,
        fromId: workspace.notebook.id,
        toId: output.id,
        type: "contains_output",
        reason: "Notebook stores prior synthesis output",
      });
    }
    reply.send({
      query: input.query,
      scope: input.scope ?? null,
      nodes,
      edges,
      citations: nodes
        .filter((node) => node.kind === "source" || node.kind === "document")
        .map((node) => ({
          sourceId: node.kind === "source" ? String(node.id) : null,
          title: String(node.label),
          kind: node.kind,
        })),
      degraded: false,
      degradedReason: "",
      unresolvedScope: {
        projectId: input.scope?.projectId ?? null,
        documentIds: [],
      },
    });
  });

  app.get("/api/brain/entities", async (request) => {
    const query = BrainEntitiesQuerySchema.parse(request.query);
    const partitionKey = request.knowledgePartitionKey ?? query.partitionKey;
    const slug = query.slug;
    if (!slug) {
      const result = await brain.listPages({
        // Fetch one sentinel row when possible. GBrain's remote 100-row cap
        // means a full 100-row window remains intentionally indeterminate.
        limit: Math.min(query.limit + 1, 100),
        offset: query.offset,
        partitionKey,
      });
      return buildBrainPageEnumerationResponse({
        result,
        kind: query.kind,
        limit: query.limit,
        offset: query.offset,
        readiness: brain.nativeCapabilityReadiness(),
        factsVisibility: brain.status().factsVisibility,
      });
    }

    const direction = query.direction ?? null;
    const linkType = query.linkType ?? null;
    const [profile, entityCard, links, graph, timeline, recall] = await Promise.all([
      brain.getPage({ slug, partitionKey }),
      brain.getEntityCard({ name: slug, partitionKey }),
      brain.getLinks({ slug, partitionKey }),
      brain.traverseGraph({ slug, depth: query.depth, direction, linkType, partitionKey }),
      brain.getTimeline({ slug, limit: 100, partitionKey }),
      // Entity-scoped recall keeps the facts arm on the requested canonical
      // slug. A query/grep would run broad page search and could return
      // unrelated hot-memory facts.
      brain.recall({ entity: slug, limit: 20, includePending: true, partitionKey }),
    ]);
    const coreResults = [profile, entityCard, links, graph, timeline];
    const firstFailure = coreResults.find((result) => !result.ok);
    const capabilityGaps = [
      ...brain.nativeCapabilityReadiness().capabilityGaps,
      ...(profile.ok ? [] : [brainCapabilityGap("get_page", profile)]),
      ...(
        entityCard.ok
          ? []
          : [brainCapabilityGap("entity", entityCard)]
      ),
      ...(timeline.ok ? [] : [brainCapabilityGap("get_timeline", timeline)]),
      ...(links.ok ? [] : [brainCapabilityGap("get_links", links)]),
      ...(graph.ok ? [] : [brainCapabilityGap("traverse_graph", graph)]),
      ...(recall.ok ? [] : [brainCapabilityGap("recall", recall)]),
    ];
    const readiness = brain.nativeCapabilityReadiness();
    const capabilities = observedBrainCapabilities(readiness, {
      entityCard: entityCard.ok,
      timeline: timeline.ok,
      typedRelationships: links.ok && graph.ok,
    });
    return {
      degradedReason: firstFailure?.error ?? null,
      graph: graph.ok ? graph.data : null,
      links: links.ok ? links.data : null,
      // The native `entity` operation wraps the card in
      // `{ found, card }`; expose the card itself so the frontend consumes
      // the actual native entity/aka/edge/timeline shape without learning
      // transport-envelope details.
      entityCard: entityCard.ok ? normalizeBrainEntityCard(entityCard.data) : null,
      timeline: timeline.ok ? timeline.data : null,
      factsVisibility: brain.status().factsVisibility,
      capabilities: {
        ...capabilities,
        facts: {
          status: brain.status().factsVisibility === "partition_private" ? "ready" : "limited",
          visibility: brain.status().factsVisibility,
          detail:
            brain.status().factsVisibility === "partition_private" ? "Private facts are available only within the authorized Knowledge partition." : "Remote GBrain recall is intentionally limited to world-visible facts; private facts are not exposed by this route.",
        },
      },
      capabilityGaps,
      ok: coreResults.every((result) => result.ok),
      profile: profile.ok ? profile.data : null,
      recall: recall.ok ? recall.data : null,
      slug,
      source: "gbrain-adapter",
      status: firstFailure ? firstFailure.status : "ready",
    };
  });

  app.post("/api/bindings", async (request, reply) => {
    const input = BindingInputSchema.parse(request.body);
    const binding = store.createBinding({
      ownerPlugin: input.ownerPlugin,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      artifactType: input.artifactType,
      artifactId: input.artifactId,
      relationshipType: input.relationshipType,
      summary: input.summary ?? null,
      createdBy: input.createdBy ?? "operator",
      rulesDecisionRef: input.rulesDecisionRef ?? null,
      metadata: input.metadata ?? {},
      partitionKey: input.partitionKey ?? request.knowledgePartitionKey ?? null,
    });
    reply.code(201).send(binding);
  });

  app.get("/api/bindings", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (request.knowledgePartitionKey && query.partitionKey &&
      normalizeKnowledgePartitionKey(query.partitionKey) !== request.knowledgePartitionKey) {
      return reply.code(403).send({ ok: false, error: "partition_scope_denied" });
    }
    const bindings = store.listBindings({
      ownerPlugin: query.ownerPlugin,
      ownerType: query.ownerType,
      ownerId: query.ownerId,
      artifactType: query.artifactType,
      artifactId: query.artifactId,
      partitionKey: request.knowledgePartitionKey ? undefined : query.partitionKey,
    });
    return request.knowledgePartitionKey
      ? bindings.filter((binding) => normalizeKnowledgePartitionKey(binding.partitionKey) === request.knowledgePartitionKey)
      : bindings;
  });

  app.delete("/api/bindings/:bindingId", async (request, reply) => {
    const { bindingId } = request.params as { bindingId: string };
    const deleted = store.deleteBinding(bindingId);
    if (deleted === null) {
      reply.code(404).send({ ok: false, error: "knowledge_binding_not_found" });
      return;
    }
    reply.send(deleted);
  });

  registerModelSettingsRoutes(app, { dataDir: config.dataDir, gbrainHome: config.gbrainHome, brain, authority: process.env.KNOWLEDGE_SETTINGS_TOKEN, research: researchSync });
  registerNativeMemoryRoutes(app, {brain,dataDir:config.dataDir,persistent:Boolean(config.knowledgeDatabasePath)});

  app.get("/api/brain/indexing", async (request, reply) => {
    const query = request.query as { partitionKey?: string };
    const partitionKey = request.knowledgePartitionKey ?? normalizeKnowledgePartitionKey(query.partitionKey);
    if (!partitionKey) return reply.code(400).send({ ok: false, error: "partition_key_required" });
    return { ok: true, ...projections.status(partitionKey) };
  });

  app.post("/api/brain/context", async (request) => {
    const input = BrainContextInputSchema.parse(request.body);
    const partitionKey = request.knowledgePartitionKey ?? input.partitionKey;
    const result = await brain.query({ query: input.query, limit: input.limit, partitionKey, expand: input.expand, detail: input.detail });
    return {
      ok: result.ok,
      source: "gbrain-adapter",
      mode: "context",
      status: result.status,
      retrieval: result.retrieval ?? null,
      scopeRef: input.scopeRef,
      purpose: input.purpose,
      query: input.query,
      answer: result.ok ? result.data : null,
      citations: result.ok ? buildBrainQueryCitations(result.data) : [],
      sourceIds: input.sourceIds ?? [],
      degradedReason: result.error ?? null,
    };
  });

  app.post("/api/brain/recall", async (request) => {
    const input = BrainRecallInputSchema.parse(request.body);
    const partitionKey = request.knowledgePartitionKey ?? input.partitionKey;
    const result = await brain.recall({ query: input.query, limit: input.limit, partitionKey, grep: input.grep, entity: input.entity, sessionId: input.sessionId, includeExpired: input.includeExpired, budgetTokens: input.budgetTokens, since: input.since, supersessions: input.supersessions, includePending: input.includePending });
    return {
      ok: result.ok,
      source: "gbrain-adapter",
      mode: "recall",
      status: result.status,
      retrieval: result.retrieval ?? null,
      scopeRef: input.scopeRef,
      query: input.query,
      memories: result.ok ? result.data : [],
      citations: [],
      degradedReason: result.error ?? null,
    };
  });

  app.post("/api/brain/extract-facts", async (request, reply) => {
    const origin = headerValue(request.headers.origin);
    const host = headerValue(request.headers.host);
    const authorization = headerValue(request.headers.authorization);
    if (
      !request.knowledgePrincipal &&
      !isSameOriginRequest(origin, host) &&
      !hasBearerToken(authorization, config.gbrainToken) &&
      !hasBearerToken(authorization, config.brainExtractionToken)
    ) {
      reply.code(403).send({
        ok: false,
        error: "brain_write_forbidden",
      });
      return;
    }
    const input = BrainExtractFactsInputSchema.parse(request.body);
    const partitionKey = request.knowledgePartitionKey ?? input.partitionKey;
    return extractions.run(JSON.stringify([partitionKey, request.knowledgePrincipal?.principalId ?? "operator"]), headerValue(request.headers["idempotency-key"]) ?? undefined, input, async () => {
      const result = await brain.extractFacts({ text: input.text, sessionId: input.sessionId ?? null, entityHints: input.entityHints, partitionKey, sourceSlug: input.sourceSlug, validFrom: input.validFrom });
      return { ok: result.ok, source: "gbrain-adapter", mode: "extract_facts", status: result.status, result: result.ok ? result.data : null, degradedReason: result.error ?? null };
    });
  });

  return app;
}

function workspaceLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 400) return null;
  try {
    const label = decodeURIComponent(value).replace(/[\u0000-\u001f\u007f]/gu, "").trim();
    return label ? label.slice(0, 80) : null;
  } catch { return null; }
}
