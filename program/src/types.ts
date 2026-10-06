import type { KnowledgeServicePrincipalBinding } from "./knowledge-principal.js";
import type { ResearchPrincipalProvider } from './portal-research-principal.js';

export type KnowledgeEnvironment = "development" | "test" | "production";

export interface KnowledgeOpenNotebookBinding {
  readonly knowledgeNotebookId: string;
  readonly companyId: string;
  readonly externalNotebookId: string;
}

export interface KnowledgeGBrainPartitionToken {
  readonly partitionKey: string;
  readonly token: string;
}

export interface KnowledgeConfig {
  readonly host: string;
  readonly port: number;
  readonly environment: KnowledgeEnvironment;
  readonly dataDir: string;
  readonly defaultDocsSourceConfig: KnowledgeCollectionSourceConfig | null;
  readonly gbrainBaseUrl: string | null;
  readonly gbrainToken: string | null;
  /** Separate upstream GBrain service (`gbrain serve --http`); Knowledge provisions per-source OAuth clients. */
  readonly gbrainServiceUrl: string | null;
  readonly gbrainServiceAdminToken: string | null;
  /** KNOWLEDGE_MEMORY_ENGINE: one engine per deployment; GBrain when unset. */
  readonly memoryEngine: "gbrain" | "hindsight";
  /** Private Hindsight service origin (KNOWLEDGE_HINDSIGHT_URL), e.g. http://hindsight.railway.internal:8888. */
  readonly hindsightUrl: string | null;
  /** Hindsight HINDSIGHT_API_TENANT_API_KEY shared only with Knowledge (KNOWLEDGE_HINDSIGHT_API_KEY). */
  readonly hindsightApiKey: string | null;
  /** Optional server-only source-scoped GBrain credentials by partition. */
  readonly gbrainPartitionTokens: readonly KnowledgeGBrainPartitionToken[];
  /** Optional server-to-server credential for the broker's extract-facts hook. */
  readonly brainExtractionToken: string | null;
  readonly gbrainHome: string;
  readonly gbrainRepoPath: string | null;
  readonly gbrainAutoStart: boolean;
  /** Trusted server configuration; never serialize credentials into status/UI. */
  readonly openNotebookBaseUrl: string | null;
  readonly openNotebookToken: string | null;
  readonly researchWriteLedgerPath: string | null;
  readonly researchChatLedgerPath: string | null;
  readonly openNotebookChatModelId: string | null;
  readonly knowledgeServicePrincipals: readonly KnowledgeServicePrincipalBinding[];
  /** Fail-closed general domain authorization for server-attested partitions. */
  readonly partitionAuthorizationRequired: boolean;
  /** Optional single-operator same-origin Research browser session authority. */
  readonly browserOperatorSecret: string | null;
  readonly browserPrincipalId: string | null;
  readonly browserOrigin: string | null;
  readonly openNotebookBindings: readonly KnowledgeOpenNotebookBinding[];
  /** Optional central Rules binding. No binding keeps the standalone local mode usable. */
  readonly rulesBaseUrl: string | null;
  readonly rulesAuthToken: string | null;
  readonly rulesWorkspaceSlug: string;
  readonly rulesActorId: string;
  readonly rulesTimeoutMs: number;
  readonly knowledgeDatabaseUrl: string | null;
  readonly knowledgeDatabasePath: string | null;
}

export interface BuildKnowledgeAppOptions {
  /** Trusted host injection for Research only; never supplied by an HTTP client. */
  readonly researchPrincipalProvider?: ResearchPrincipalProvider;
  /**
   * Trusted host injection: resolves edge-minted per-request bearers for Portal
   * attachments on the native memory route (knowledge:brain:read/write).
   */
  readonly brainPrincipalProvider?: ResearchPrincipalProvider;
  /** Trusted host injection: Portal-validated runtime principals (never client-supplied). */
  readonly portalPrincipals?: import("./portal-principal.js").PortalPrincipalResolver;
  readonly environment?: KnowledgeEnvironment;
  readonly config?: Partial<KnowledgeConfig>;
  /** Test/host hooks for mirroring Settings -> Models into Research (Open Notebook). */
  readonly researchModelSync?: {
    readonly fetchImpl?: typeof fetch;
    /** Defaults to on outside the test environment. */
    readonly syncOnStart?: boolean;
    /** Defaults to KNOWLEDGE_COMPANY_ID. */
    readonly companyId?: string | null;
  };
}

export interface KnowledgeBinding {
  readonly bindingId: string;
  readonly ownerPlugin: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly artifactType: string;
  readonly artifactId: string;
  readonly relationshipType: string;
  /** Optional partition for cross-miniapp relationships; null is legacy/unscoped. */
  readonly partitionKey?: string | null;
  readonly summary: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly rulesDecisionRef: string | null;
  readonly metadata: Record<string, unknown>;
}

export type KnowledgeCollectionSourceConfig =
  | { readonly provider: "native" }
  | {
      readonly provider: "github_repo";
      readonly owner: string;
      readonly repo: string;
      readonly branch: string;
      readonly rootPath: string;
      readonly tokenEnvVar?: string;
      readonly secretName?: string;
    }
  | {
      readonly provider: "forgejo_repo";
      readonly apiBaseUrl: string;
      readonly owner: string;
      readonly repo: string;
      readonly branch: string;
      readonly rootPath: string;
      readonly tokenEnvVar?: string;
      readonly secretName?: string;
    };

export interface KnowledgeDocumentSourceState {
  readonly provider: "github_repo" | "forgejo_repo";
  readonly path: string;
  readonly sha?: string | null;
  readonly htmlUrl?: string | null;
  readonly syncedAt?: string | null;
}

export interface KnowledgeCollection {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly description: string | null;
  readonly sourceConfig: KnowledgeCollectionSourceConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeDocument {
  readonly id: string;
  readonly companyId: string;
  readonly collectionId: string;
  readonly parentDocumentId: string | null;
  readonly title: string;
  readonly slug: string;
  readonly summary: string | null;
  readonly body: string;
  readonly bodyFormat: string;
  readonly status: string;
  readonly source: KnowledgeDocumentSourceState | null;
  readonly createdByAgentId: string | null;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeDocumentRevision {
  readonly id: string;
  readonly companyId: string;
  readonly documentId: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string | null;
  readonly body: string;
  readonly bodyFormat: string;
  readonly createdByAgentId: string | null;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
}

export interface KnowledgeDocumentComment {
  readonly id: string;
  readonly companyId: string;
  readonly documentId: string;
  readonly parentCommentId: string | null;
  readonly body: string;
  readonly bodyFormat: string;
  readonly createdByAgentId: string | null;
  readonly createdByUserId: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeAccessGrant {
  readonly id: string;
  readonly principalType: string;
  readonly principalId: string;
  readonly role: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeAccessPolicy {
  readonly documentId: string;
  readonly companyId: string;
  readonly accessMode: string;
  readonly inheritFromParent: boolean;
  readonly grants: readonly KnowledgeAccessGrant[];
}

export interface KnowledgeDocumentAttachment {
  readonly id: string;
  readonly companyId: string;
  readonly documentId: string;
  readonly assetId: string;
  readonly label: string | null;
  readonly provider: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly originalFilename: string;
  readonly createdByAgentId: string | null;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
  readonly contentPath: string;
  readonly storagePath: string | null;
}

export interface KnowledgeDocumentLink {
  readonly id: string;
  readonly companyId: string;
  readonly sourceDocumentId: string;
  readonly targetDocumentId: string;
  readonly linkType: string;
  readonly createdAt: string;
}

export type KnowledgeOwnerType = "project" | "goal" | "issue";

export interface KnowledgeOwnerBinding {
  readonly id: string;
  readonly ownerType: KnowledgeOwnerType;
  readonly ownerId: string;
  readonly bindingType: string;
  readonly linkedAt: string;
  /** The document/collection partition, retained for scoped Work lookups. */
  readonly partitionKey?: string | null;
  readonly documentId?: string;
  readonly collectionId?: string;
}

export interface ResearchNotebook {
  readonly id: string;
  readonly companyId: string;
  readonly title: string;
  readonly slug: string | null;
  readonly summary: string | null;
  readonly focusPrompt: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResearchSource {
  readonly id: string;
  readonly companyId: string;
  readonly notebookId: string;
  readonly title: string;
  readonly sourceType: string;
  readonly url: string | null;
  readonly storagePath: string | null;
  readonly originalFilename: string | null;
  readonly contentType: string | null;
  readonly size: number | null;
  readonly author: string | null;
  readonly publisher: string | null;
  readonly publishedAt: string | null;
  readonly summary: string | null;
  readonly citation: string | null;
  readonly apiConfig: Record<string, unknown> | null;
  readonly apiSnapshot: Record<string, unknown> | null;
  readonly status: string;
  readonly content: string;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResearchEntry {
  readonly id: string;
  readonly companyId: string;
  readonly notebookId: string;
  readonly entryKind: string;
  readonly sourceId: string | null;
  readonly documentId: string | null;
  readonly documentRevisionId: string | null;
  readonly role: string;
  readonly notes: string | null;
  readonly title: string;
  readonly summary: string | null;
  readonly body: string | null;
  readonly bodyFormat: string | null;
  readonly citation: string | null;
  readonly url: string | null;
  readonly version: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResearchOutput {
  readonly id: string;
  readonly companyId: string;
  readonly notebookId: string;
  readonly outputKind: string;
  readonly title: string;
  readonly summary: string | null;
  readonly body: string;
  readonly bodyFormat: string;
  readonly status: string;
  readonly promotionState: string;
  readonly promotedDocumentId: string | null;
  readonly promotedRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
