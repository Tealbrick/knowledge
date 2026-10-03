export type Section = "library" | "research" | "brain" | "activity";

export interface FrontendBootstrap {
  ok: boolean;
  program: {
    id: string;
    name: string;
    version: string;
    environment: string;
    status: string;
  };
  subapps: Record<string, { status: string; [key: string]: unknown }>;
  dependencies: Record<
    string,
    {
      status: string;
      required?: boolean;
      configured?: boolean;
      tokenConfigured?: boolean;
      detail?: string | null;
      [key: string]: unknown;
    }
  >;
  counts: Record<string, number>;
  authorization: {
    generalDomainBearerRequired: boolean;
    brainExtractFacts: string;
    credentialExposedToBrowser: false;
  };
  surfaces: {
    standalone: string;
    embed: string;
    status: string;
    openapi: string;
    swagger: string;
  };
  scope: { defaultCompanyId: string };
  capabilities: Record<string, boolean>;
}

export type CollectionSource =
  | { provider: "native" }
  | {
      provider: "github_repo";
      owner: string;
      repo: string;
      branch: string;
      rootPath: string;
      secretName?: string;
      tokenEnvVar?: string;
    }
  | {
      provider: "forgejo_repo";
      apiBaseUrl: string;
      owner: string;
      repo: string;
      branch: string;
      rootPath: string;
      secretName?: string;
      tokenEnvVar?: string;
    };

export interface KnowledgeCollection {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  sourceConfig: CollectionSource;
  documentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSearchResult {
  id: string;
  companyId: string;
  collectionId: string;
  collectionName: string;
  title: string;
  summary: string | null;
  excerpt: string;
  status: string;
  parentDocumentId: string | null;
  source: {
    provider: string;
    path: string;
    htmlUrl?: string | null;
    syncedAt?: string | null;
  } | null;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  companyId: string;
  collectionId: string;
  parentDocumentId: string | null;
  title: string;
  slug: string;
  summary: string | null;
  body: string;
  bodyFormat: string;
  status: string;
  source: {
    provider: string;
    path: string;
    sha?: string | null;
    htmlUrl?: string | null;
    syncedAt?: string | null;
  } | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRevision {
  id: string;
  documentId: string;
  version: number;
  title: string;
  summary: string | null;
  body: string;
  bodyFormat: string;
  createdAt: string;
}

export interface KnowledgeComment {
  id: string;
  documentId: string;
  parentCommentId: string | null;
  body: string;
  bodyFormat: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeAccessPolicy {
  documentId: string;
  companyId: string;
  accessMode: string;
  inheritFromParent: boolean;
  grants: Array<{
    id: string;
    principalType: string;
    principalId: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface KnowledgeAttachment {
  id: string;
  documentId: string;
  label: string | null;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string;
  createdAt: string;
  contentPath: string;
}

export interface KnowledgeLink {
  id: string;
  sourceDocumentId: string;
  targetDocumentId: string;
  linkType: string;
  createdAt: string;
}

export interface IngestResult {
  ok: boolean;
  runId: string;
  status: string;
  source: "files" | "repo";
  summary: {
    created: number;
    failed: number;
    skipped: number;
    unchanged: number;
    updated: number;
  };
  documents: Array<{
    action: string;
    documentId?: string;
    sourcePath: string;
    title?: string;
    error?: string;
    reason?: string;
  }>;
}

export interface ResearchSummary {
  companyId: string;
  notebooks: ResearchNotebook[];
  counts: { notebooks: number; sources: number };
  activeNotebookId: string | null;
  posture: Record<
    string,
    { available: boolean; mode: string; degraded: boolean; reason: string }
  >;
}

export interface ResearchNotebook {
  id: string;
  companyId: string;
  title: string;
  slug: string | null;
  summary: string | null;
  focusPrompt: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchSource {
  id: string;
  companyId: string;
  notebookId: string;
  notebookTitle: string;
  title: string;
  sourceType: string;
  url: string | null;
  originalFilename: string | null;
  contentType: string | null;
  size: number | null;
  author: string | null;
  publisher: string | null;
  publishedAt: string | null;
  summary: string | null;
  citation: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  content?: string;
  notes?: string | null;
}

export interface ResearchOutput {
  id: string;
  companyId: string;
  notebookId: string;
  outputKind: string;
  title: string;
  summary: string | null;
  body: string;
  bodyFormat: string;
  status: string;
  promotionState: string;
  promotedDocumentId: string | null;
  promotedRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchWorkspace extends ResearchNotebook {
  sources: ResearchSource[];
  entries: unknown[];
  outputs: ResearchOutput[];
  linkedDocuments: KnowledgeDocument[];
}

export interface ResearchAnswer {
  mode: string;
  notebookId: string;
  answer?: string;
  reply?: string;
  citations: Array<{
    kind: string;
    title: string;
    excerpt: string;
    score: number;
    sourceId?: string | null;
    documentId?: string | null;
  }>;
  degraded: boolean;
  degradedReason: string;
  strategy: {
    retrievalMode: string;
    candidateCount: number;
    citationCount: number;
  };
}

export type BrainSurfaceStatus = "ready" | "degraded" | "unavailable" | string;

export interface BrainCapabilityStatus {
  operation: string;
  status: "ready" | "unavailable" | string;
  detail?: string | null;
}

export interface BrainReadiness {
  status: "ready" | "degraded" | "unavailable" | string;
  capabilities?: Partial<
    Record<
      "pageEnumeration" | "entityCard" | "timeline" | "typedRelationships",
      BrainCapabilityStatus
    >
  >;
  capabilityGaps?: Array<{ code: string; detail?: string | null }>;
}

export interface BrainEntity {
  id?: string;
  slug: string;
  label?: string;
  title?: string | null;
  type?: string | null;
  aliases?: string[];
  factCount?: number;
  updatedAt?: string | null;
  facts?: BrainFact[];
}

export interface BrainEntityCard {
  slug: string;
  title: string;
  type: string | null;
  aliases: string[];
  summary: string | null;
  updatedAt: string | null;
  lastRetrievedAt?: string | null;
  lastTimelineDate?: string | null;
  openThreads: string[];
  backlinkCount: number;
  activeFactCount: number;
}

/** Native `entity` result kept as an adapter input; the UI projects it into BrainEntityCard. */
export interface BrainNativeEntityCard {
  entity: { slug: string; title: string; type: string | null };
  aka: string[];
  summary: string | null;
  last_touched: {
    updated_at: string | null;
    last_retrieved_at: string | null;
    last_timeline_date: string | null;
  };
  open_threads: Array<string | Record<string, unknown>>;
  edges: Array<{
    type: string;
    direction: string;
    slug: string;
    context: string | null;
  }>;
  backlink_count: number;
  active_fact_count: number;
}

export interface BrainNativeEntityCardEnvelope {
  protocol_version?: number;
  found: boolean;
  card?: BrainNativeEntityCard | null;
}

export type BrainNativeEntityCardResponse = BrainNativeEntityCard | BrainNativeEntityCardEnvelope;

export interface BrainNativeLink {
  id?: string | number | null;
  from_slug?: string | null;
  to_slug?: string | null;
  link_type?: string | null;
  type?: string | null;
  direction?: string | null;
  slug?: string | null;
  targetSlug?: string | null;
  target_slug?: string | null;
  toSlug?: string | null;
  targetLabel?: string | null;
  context?: string | null;
}

export interface BrainRelationship {
  id?: string | null;
  type: string;
  direction: "in" | "out" | "both" | string;
  targetSlug: string;
  targetLabel?: string | null;
  context?: string | null;
  source?: string | null;
}

export interface BrainTimelineEvent {
  id?: string | null;
  date: string | null;
  summary: string;
  type?: string | null;
  source?: string | null;
}

export interface BrainProvenance {
  source: string;
  sourceId?: string | null;
  sourceSession?: string | null;
  observedAt?: string | null;
  createdAt?: string | null;
}

export interface BrainEntities {
  ok: boolean;
  status: BrainSurfaceStatus;
  source?: string;
  degradedReason: string | null;
  readiness?: BrainReadiness;
  kind?: "entities" | "pages" | "all" | string;
  entities: BrainEntity[];
  pages?: BrainEntity[];
  selected?: BrainEntity[];
  facts?: BrainFact[];
  pendingConsolidationCount?: number;
  total?: number;
  nextOffset?: number | null;
  pagination?: {
    limit: number;
    offset: number;
    returned: number;
    scanned: number;
    complete: boolean;
    hasMore: boolean | null;
    nextOffset?: number | null;
  };
  capabilities?: Record<string, BrainCapabilityStatus & { visibility?: string }>;
  capabilityGaps?: Array<{ code: string; operation?: string; detail?: string | null }>;
}

export interface BrainEntityDetail {
  ok: boolean;
  status: BrainSurfaceStatus;
  source?: string;
  degradedReason: string | null;
  readiness?: BrainReadiness;
  slug: string;
  card?: BrainEntityCard | null;
  /** Canonical projected fields are optional while the backend adapter exposes native results. */
  entityCard?: BrainNativeEntityCardResponse | null;
  facts?: BrainFact[];
  relationships?: BrainRelationship[];
  timeline?: BrainTimelineEvent[] | null;
  provenance?: BrainProvenance[];
  links?: BrainNativeLink[] | Record<string, unknown> | null;
  graph?: unknown;
  recall?: unknown;
  factsVisibility?: string;
  trajectory?: unknown;
  capabilities?: Record<string, BrainCapabilityStatus & { visibility?: string }>;
  capabilityGaps?: Array<{ code: string; operation?: string; detail?: string | null }>;
}

export interface BrainFact {
  id: string | number;
  fact: string;
  kind: string | null;
  entitySlug: string | null;
  confidence: number | null;
  source: string | null;
  sourceSession?: string | null;
  createdAt: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface BrainResult {
  ok: boolean;
  status: string;
  mode: string;
  query: string;
  answer?: unknown;
  memories?: unknown;
  citations: unknown[];
  degradedReason: string | null;
}

export interface KnowledgeBinding {
  bindingId: string;
  ownerPlugin: string;
  ownerType: string;
  ownerId: string;
  artifactType: string;
  artifactId: string;
  relationshipType: string;
  summary: string | null;
  createdBy: string;
  createdAt: string;
  rulesDecisionRef: string | null;
}

export interface ProgramEvent {
  id: string;
  type: string;
  createdAt: string;
  [key: string]: unknown;
}
