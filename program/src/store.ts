import type {
  KnowledgeAccessPolicy,
  KnowledgeBinding,
  KnowledgeCollection,
  KnowledgeCollectionSourceConfig,
  KnowledgeDocument,
  KnowledgeDocumentAttachment,
  KnowledgeDocumentComment,
  KnowledgeDocumentLink,
  KnowledgeDocumentRevision,
  KnowledgeDocumentSourceState,
  KnowledgeOwnerBinding,
  KnowledgeOwnerType,
  ResearchEntry,
  ResearchNotebook,
  ResearchOutput,
  ResearchSource,
} from "./types.js";
import { EDGE_PARTITION_KEY, normalizeKnowledgePartitionKey } from "./partition-authority.js";

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string, value: number) {
  return `${prefix}_${value.toString(36).padStart(4, "0")}`;
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "document"
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function trimSlashes(value: string) {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function normalizeSourcePath(title: string, sourcePath?: string | null) {
  const normalized = trimSlashes(sourcePath ?? "");
  if (normalized) {
    return normalized;
  }
  return `${slugify(title)}.md`;
}

function normalizeStoredSourcePath(
  sourceConfig: Exclude<KnowledgeCollectionSourceConfig, { provider: "native" }>,
  sourcePath: string,
) {
  const normalized = trimSlashes(sourcePath);
  const rootPath = trimSlashes(sourceConfig.rootPath);
  if (!rootPath || normalized === rootPath) {
    return normalized;
  }
  return normalized.startsWith(`${rootPath}/`) ? normalized.slice(rootPath.length + 1) : normalized;
}

export interface KnowledgeStoreSnapshot {
  readonly version: 1;
  readonly counters: {
    readonly bindingCounter: number;
    readonly collectionCounter: number;
    readonly documentCounter: number;
    readonly revisionCounter: number;
    readonly commentCounter: number;
    readonly grantCounter: number;
    readonly attachmentCounter: number;
    readonly linkCounter: number;
    readonly ownerBindingCounter: number;
    readonly notebookCounter: number;
    readonly sourceCounter: number;
    readonly entryCounter: number;
    readonly outputCounter: number;
  };
  readonly bindings: readonly KnowledgeBinding[];
  readonly collections: readonly KnowledgeCollection[];
  readonly documents: readonly KnowledgeDocument[];
  readonly revisions: readonly KnowledgeDocumentRevision[];
  readonly comments: readonly KnowledgeDocumentComment[];
  readonly accessPolicies: readonly KnowledgeAccessPolicy[];
  readonly attachments: readonly KnowledgeDocumentAttachment[];
  readonly links: readonly KnowledgeDocumentLink[];
  readonly ownerBindings: readonly KnowledgeOwnerBinding[];
  readonly notebooks: readonly ResearchNotebook[];
  readonly sources: readonly ResearchSource[];
  readonly entries: readonly ResearchEntry[];
  readonly outputs: readonly ResearchOutput[];
}

export interface KnowledgeStorePersistence {
  load(): KnowledgeStoreSnapshot | null;
  save(snapshot: KnowledgeStoreSnapshot): void;
  describe?(): Record<string, unknown>;
}

export interface KnowledgeStoreOptions {
  readonly defaultKnowledgeCollectionSourceConfig?: KnowledgeCollectionSourceConfig | null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneSnapshotArray<T>(value: readonly T[] | undefined): T[] {
  return cloneJson(Array.isArray(value) ? value : []);
}

function restoreCounter(value: unknown, ids: readonly string[], prefix: string): number {
  const explicit =
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  const fromIds = ids.reduce((max, id) => {
    if (!id.startsWith(`${prefix}_`)) {
      return max;
    }
    const parsed = Number.parseInt(id.slice(prefix.length + 1), 36);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
  return Math.max(explicit, fromIds);
}

export class KnowledgeStore {
  private bindingCounter = 0;
  private collectionCounter = 0;
  private documentCounter = 0;
  private revisionCounter = 0;
  private commentCounter = 0;
  private grantCounter = 0;
  private attachmentCounter = 0;
  private linkCounter = 0;
  private ownerBindingCounter = 0;
  private notebookCounter = 0;
  private sourceCounter = 0;
  private entryCounter = 0;
  private outputCounter = 0;
  private readonly bindings: KnowledgeBinding[] = [];
  private readonly collections: KnowledgeCollection[] = [];
  private readonly documents: KnowledgeDocument[] = [];
  private readonly revisions: KnowledgeDocumentRevision[] = [];
  private readonly comments: KnowledgeDocumentComment[] = [];
  private readonly accessPolicies: KnowledgeAccessPolicy[] = [];
  private readonly attachments: KnowledgeDocumentAttachment[] = [];
  private readonly links: KnowledgeDocumentLink[] = [];
  private readonly ownerBindings: KnowledgeOwnerBinding[] = [];
  private readonly notebooks: ResearchNotebook[] = [];
  private readonly sources: ResearchSource[] = [];
  private readonly entries: ResearchEntry[] = [];
  private readonly outputs: ResearchOutput[] = [];

  constructor(
    private readonly persistence: KnowledgeStorePersistence | null = null,
    private readonly options: KnowledgeStoreOptions = {},
  ) {
    const snapshot = this.persistence?.load();
    if (snapshot) {
      this.restore(snapshot);
    }
  }

  private persist() {
    this.persistence?.save(this.exportSnapshot());
  }

  private commit<T>(value: T): T {
    this.persist();
    return value;
  }

  private exportSnapshot(): KnowledgeStoreSnapshot {
    return {
      version: 1,
      counters: {
        bindingCounter: this.bindingCounter,
        collectionCounter: this.collectionCounter,
        documentCounter: this.documentCounter,
        revisionCounter: this.revisionCounter,
        commentCounter: this.commentCounter,
        grantCounter: this.grantCounter,
        attachmentCounter: this.attachmentCounter,
        linkCounter: this.linkCounter,
        ownerBindingCounter: this.ownerBindingCounter,
        notebookCounter: this.notebookCounter,
        sourceCounter: this.sourceCounter,
        entryCounter: this.entryCounter,
        outputCounter: this.outputCounter,
      },
      bindings: cloneJson(this.bindings),
      collections: cloneJson(this.collections),
      documents: cloneJson(this.documents),
      revisions: cloneJson(this.revisions),
      comments: cloneJson(this.comments),
      accessPolicies: cloneJson(this.accessPolicies),
      attachments: cloneJson(this.attachments),
      links: cloneJson(this.links),
      ownerBindings: cloneJson(this.ownerBindings),
      notebooks: cloneJson(this.notebooks),
      sources: cloneJson(this.sources),
      entries: cloneJson(this.entries),
      outputs: cloneJson(this.outputs),
    };
  }

  private restore(snapshot: KnowledgeStoreSnapshot) {
    const bindings = cloneSnapshotArray(snapshot.bindings).map((binding) => ({
      ...binding,
      partitionKey: binding.partitionKey ?? null,
    }));
    const collections = cloneSnapshotArray(snapshot.collections);
    const documents = cloneSnapshotArray(snapshot.documents).map((document) => ({
      ...document,
      createdByAgentId: document.createdByAgentId ?? null,
      createdByUserId: document.createdByUserId ?? "operator",
    }));
    const revisions = cloneSnapshotArray(snapshot.revisions);
    const comments = cloneSnapshotArray(snapshot.comments);
    const accessPolicies = cloneSnapshotArray(snapshot.accessPolicies);
    const attachments = cloneSnapshotArray(snapshot.attachments);
    const links = cloneSnapshotArray(snapshot.links);
    const ownerBindings = cloneSnapshotArray(snapshot.ownerBindings);
    const notebooks = cloneSnapshotArray(snapshot.notebooks);
    const sources = cloneSnapshotArray(snapshot.sources);
    const entries = cloneSnapshotArray(snapshot.entries);
    const outputs = cloneSnapshotArray(snapshot.outputs);
    const counters = snapshot.counters as Partial<KnowledgeStoreSnapshot["counters"]>;

    this.bindingCounter = restoreCounter(
      counters.bindingCounter,
      bindings.map((binding) => binding.bindingId),
      "binding",
    );
    this.collectionCounter = restoreCounter(
      counters.collectionCounter,
      collections.map((collection) => collection.id),
      "kcol",
    );
    this.documentCounter = restoreCounter(
      counters.documentCounter,
      documents.map((document) => document.id),
      "kdoc",
    );
    this.revisionCounter = restoreCounter(
      counters.revisionCounter,
      revisions.map((revision) => revision.id),
      "krev",
    );
    this.commentCounter = restoreCounter(
      counters.commentCounter,
      comments.map((comment) => comment.id),
      "kcom",
    );
    this.grantCounter = restoreCounter(
      counters.grantCounter,
      accessPolicies.flatMap((policy) => policy.grants.map((grant) => grant.id)),
      "kgrant",
    );
    this.attachmentCounter = restoreCounter(
      counters.attachmentCounter,
      attachments.map((attachment) => attachment.id),
      "katt",
    );
    this.linkCounter = restoreCounter(
      counters.linkCounter,
      links.map((link) => link.id),
      "klink",
    );
    this.ownerBindingCounter = restoreCounter(
      counters.ownerBindingCounter,
      ownerBindings.map((binding) => binding.id),
      "kbind",
    );
    this.notebookCounter = restoreCounter(
      counters.notebookCounter,
      notebooks.map((notebook) => notebook.id),
      "notebook",
    );
    this.sourceCounter = restoreCounter(
      counters.sourceCounter,
      sources.map((source) => source.id),
      "source",
    );
    this.entryCounter = restoreCounter(
      counters.entryCounter,
      entries.map((entry) => entry.id),
      "entry",
    );
    this.outputCounter = restoreCounter(
      counters.outputCounter,
      outputs.map((output) => output.id),
      "output",
    );
    this.bindings.splice(0, this.bindings.length, ...bindings);
    this.collections.splice(0, this.collections.length, ...collections);
    this.documents.splice(0, this.documents.length, ...documents);
    this.revisions.splice(0, this.revisions.length, ...revisions);
    this.comments.splice(0, this.comments.length, ...comments);
    this.accessPolicies.splice(0, this.accessPolicies.length, ...accessPolicies);
    this.attachments.splice(0, this.attachments.length, ...attachments);
    this.links.splice(0, this.links.length, ...links);
    this.ownerBindings.splice(0, this.ownerBindings.length, ...ownerBindings);
    this.notebooks.splice(0, this.notebooks.length, ...notebooks);
    this.sources.splice(0, this.sources.length, ...sources);
    this.entries.splice(0, this.entries.length, ...entries);
    this.outputs.splice(0, this.outputs.length, ...outputs);
  }

  private ensureKnowledgeDefaultCollection(companyId: string) {
    const existing = this.collections.find((collection) => collection.companyId === companyId);
    if (existing) {
      return existing;
    }
    const timestamp = nowIso();
    const collection: KnowledgeCollection = {
      id: createId("kcol", ++this.collectionCounter),
      companyId,
      name: "Default",
      description: "Default knowledge collection",
      sourceConfig: this.options.defaultKnowledgeCollectionSourceConfig ?? {
        provider: "native",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.collections.unshift(collection);
    this.persist();
    return collection;
  }

  /**
   * Edge-partition keys holding records directly under a workspace partition
   * (`workspace/key`). Records are partitioned by their hierarchical companyId,
   * so this is a scan, never a separate registry; deeper or foreign keys are ignored.
   */
  listEdgePartitionKeys(companyId: string): string[] {
    const base = normalizeKnowledgePartitionKey(companyId);
    if (!base) return [];
    const keys = new Set<string>();
    for (const record of [...this.collections, ...this.documents, ...this.notebooks, ...this.sources]) {
      const partition = normalizeKnowledgePartitionKey(record.companyId);
      if (!partition?.startsWith(`${base}/`)) continue;
      const key = partition.slice(base.length + 1);
      if (EDGE_PARTITION_KEY.test(key) && key !== "default") keys.add(key);
    }
    return [...keys].sort();
  }

  listKnowledgeCollections(companyId: string, ensureDefault = true) {
    if (ensureDefault) this.ensureKnowledgeDefaultCollection(companyId);
    return this.collections
      .filter((collection) => collection.companyId === companyId)
      .map((collection) => ({
        ...collection,
        documentCount: this.documents.filter((document) => document.collectionId === collection.id)
          .length,
      }));
  }

  getKnowledgeCollection(collectionId: string) {
    return this.collections.find((collection) => collection.id === collectionId) ?? null;
  }

  createKnowledgeCollection(
    companyId: string,
    input: {
      readonly name: string;
      readonly description?: string | null;
      readonly sourceConfig?: KnowledgeCollectionSourceConfig | null;
    },
  ) {
    const timestamp = nowIso();
    const collection: KnowledgeCollection = {
      id: createId("kcol", ++this.collectionCounter),
      companyId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      sourceConfig: input.sourceConfig ?? { provider: "native" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.collections.unshift(collection);
    return this.commit({
      ...collection,
      documentCount: 0,
    });
  }

  deleteKnowledgeCollection(collectionId: string) {
    const collection = this.getKnowledgeCollection(collectionId);
    if (!collection) {
      return null;
    }
    const documentIds = new Set(
      this.documents
        .filter((document) => document.collectionId === collectionId)
        .map((document) => document.id),
    );
    this.collections.splice(this.collections.indexOf(collection), 1);
    this.documents.splice(
      0,
      this.documents.length,
      ...this.documents.filter((document) => document.collectionId !== collectionId),
    );
    this.revisions.splice(
      0,
      this.revisions.length,
      ...this.revisions.filter((revision) => !documentIds.has(revision.documentId)),
    );
    this.comments.splice(
      0,
      this.comments.length,
      ...this.comments.filter((comment) => !documentIds.has(comment.documentId)),
    );
    this.accessPolicies.splice(
      0,
      this.accessPolicies.length,
      ...this.accessPolicies.filter((policy) => !documentIds.has(policy.documentId)),
    );
    this.attachments.splice(
      0,
      this.attachments.length,
      ...this.attachments.filter((attachment) => !documentIds.has(attachment.documentId)),
    );
    this.links.splice(
      0,
      this.links.length,
      ...this.links.filter(
        (link) =>
          !documentIds.has(link.sourceDocumentId) && !documentIds.has(link.targetDocumentId),
      ),
    );
    this.ownerBindings.splice(
      0,
      this.ownerBindings.length,
      ...this.ownerBindings.filter(
        (binding) =>
          binding.collectionId !== collectionId && !documentIds.has(binding.documentId ?? ""),
      ),
    );
    return this.commit(collection);
  }

  getKnowledgeCollectionTree(collectionId: string) {
    const collection = this.getKnowledgeCollection(collectionId);
    if (!collection) {
      return null;
    }
    const documents = this.documents.filter((document) => document.collectionId === collectionId);
    const byParent = new Map<string | null, KnowledgeDocument[]>();
    for (const document of documents) {
      const key = document.parentDocumentId;
      const list = byParent.get(key) ?? [];
      list.push(document);
      byParent.set(key, list);
    }
    const buildTree = (parentDocumentId: string | null): Array<Record<string, unknown>> =>
      (byParent.get(parentDocumentId) ?? []).map((document) => ({
        id: document.id,
        title: document.title,
        summary: document.summary,
        updatedAt: document.updatedAt,
        parentDocumentId: document.parentDocumentId,
        children: buildTree(document.id),
      }));
    return {
      collection: {
        ...collection,
        documentCount: documents.length,
      },
      documents: buildTree(null),
    };
  }

  searchKnowledgeDocuments(
    companyId: string,
    input: {
      readonly q: string;
      readonly collectionId?: string | null;
      readonly excludeDocumentId?: string | null;
      readonly limit?: number;
    },
  ) {
    const query = input.q.trim().toLowerCase();
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const collectionById = new Map(
      this.collections.map((collection) => [collection.id, collection]),
    );
    return this.documents
      .filter((document) => document.companyId === companyId)
      .filter((document) => !input.collectionId || document.collectionId === input.collectionId)
      .filter((document) => !input.excludeDocumentId || document.id !== input.excludeDocumentId)
      .filter((document) => {
        if (!query) {
          return true;
        }
        return (
          document.title.toLowerCase().includes(query) ||
          (document.summary ?? "").toLowerCase().includes(query) ||
          document.body.toLowerCase().includes(query)
        );
      })
      .slice(0, limit)
      .map((document) => ({
        id: document.id,
        companyId: document.companyId,
        collectionId: document.collectionId,
        collectionName: collectionById.get(document.collectionId)?.name ?? "Collection",
        title: document.title,
        summary: document.summary,
        excerpt: document.body.slice(0, 240),
        status: document.status,
        parentDocumentId: document.parentDocumentId,
        source: document.source,
        updatedAt: document.updatedAt,
      }));
  }

  createKnowledgeDocument(
    collectionId: string,
    input: {
      readonly title: string;
      readonly summary?: string | null;
      readonly body?: string | null;
      readonly parentDocumentId?: string | null;
      readonly bodyFormat?: string | null;
      readonly status?: string | null;
      readonly sourcePath?: string | null;
      readonly source?: KnowledgeDocumentSourceState | null;
      readonly createdByAgentId?: string | null;
      readonly createdByUserId?: string | null;
    },
  ) {
    const collection = this.getKnowledgeCollection(collectionId);
    if (!collection) {
      return null;
    }
    const timestamp = nowIso();
    const source =
      collection.sourceConfig.provider === "native"
        ? (input.source ?? null)
        : {
            provider: collection.sourceConfig.provider,
            path: normalizeStoredSourcePath(
              collection.sourceConfig,
              normalizeSourcePath(input.title, input.sourcePath ?? input.source?.path),
            ),
            sha: input.source?.sha ?? null,
            htmlUrl: input.source?.htmlUrl ?? null,
            syncedAt: input.source?.syncedAt ?? timestamp,
          };
    const document: KnowledgeDocument = {
      id: createId("kdoc", ++this.documentCounter),
      companyId: collection.companyId,
      collectionId,
      parentDocumentId: input.parentDocumentId?.trim() || null,
      title: input.title.trim(),
      slug: slugify(input.title),
      summary: input.summary?.trim() || null,
      body: input.body ?? "",
      bodyFormat: input.bodyFormat?.trim() || "markdown",
      status: input.status?.trim() || "draft",
      source,
      createdByAgentId: input.createdByAgentId?.trim() || null,
      // Agent-created records must not acquire an operator identity merely
      // because the user-side provenance field is intentionally null.
      createdByUserId: input.createdByUserId?.trim() ||
        (input.createdByAgentId?.trim() ? null : "operator"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.documents.unshift(document);
    this.createRevision(document, 1, timestamp);
    this.accessPolicies.unshift({
      documentId: document.id,
      companyId: document.companyId,
      accessMode: "company",
      inheritFromParent: true,
      grants: [],
    });
    const collectionIndex = this.collections.indexOf(collection);
    this.collections[collectionIndex] = { ...collection, updatedAt: timestamp };
    return this.commit(document);
  }

  getKnowledgeDocument(documentId: string) {
    return this.documents.find((document) => document.id === documentId) ?? null;
  }

  getKnowledgeDocumentBySourcePath(collectionId: string, sourcePath: string) {
    const collection = this.getKnowledgeCollection(collectionId);
    const normalized =
      collection && collection.sourceConfig.provider !== "native"
        ? normalizeStoredSourcePath(collection.sourceConfig, sourcePath)
        : trimSlashes(sourcePath);
    return (
      this.documents.find(
        (document) =>
          document.collectionId === collectionId && document.source?.path === normalized,
      ) ?? null
    );
  }

  updateKnowledgeDocument(
    documentId: string,
    input: {
      readonly title?: string;
      readonly summary?: string | null;
      readonly body?: string;
      readonly bodyFormat?: string | null;
      readonly parentDocumentId?: string | null;
      readonly status?: string | null;
      readonly source?: KnowledgeDocumentSourceState | null;
      readonly createdByAgentId?: string | null;
      readonly createdByUserId?: string | null;
    },
  ) {
    const index = this.documents.findIndex((document) => document.id === documentId);
    if (index === -1) {
      return null;
    }
    const current = this.documents[index];
    if (!current) {
      return null;
    }
    const updated: KnowledgeDocument = {
      ...current,
      title:
        typeof input.title === "string" && input.title.trim() ? input.title.trim() : current.title,
      slug:
        typeof input.title === "string" && input.title.trim() ? slugify(input.title) : current.slug,
      summary: input.summary !== undefined ? input.summary?.trim() || null : current.summary,
      body: typeof input.body === "string" ? input.body : current.body,
      bodyFormat:
        typeof input.bodyFormat === "string" && input.bodyFormat.trim()
          ? input.bodyFormat.trim()
          : current.bodyFormat,
      parentDocumentId:
        input.parentDocumentId !== undefined
          ? input.parentDocumentId?.trim() || null
          : current.parentDocumentId,
      status:
        typeof input.status === "string" && input.status.trim()
          ? input.status.trim()
          : current.status,
      source: input.source !== undefined ? input.source : current.source,
      updatedAt: nowIso(),
    };
    this.documents[index] = updated;
    const nextVersion =
      this.revisions
        .filter((revision) => revision.documentId === updated.id)
        .reduce((max, revision) => Math.max(max, revision.version), 0) + 1;
    this.createRevision(updated, nextVersion, updated.updatedAt, input);
    const collection = this.getKnowledgeCollection(updated.collectionId);
    if (collection) {
      this.collections[this.collections.indexOf(collection)] = {
        ...collection,
        updatedAt: updated.updatedAt,
      };
    }
    return this.commit(updated);
  }

  deleteKnowledgeDocument(documentId: string) {
    const document = this.getKnowledgeDocument(documentId);
    if (!document) {
      return null;
    }
    this.documents.splice(this.documents.indexOf(document), 1);
    this.revisions.splice(
      0,
      this.revisions.length,
      ...this.revisions.filter((revision) => revision.documentId !== documentId),
    );
    this.comments.splice(
      0,
      this.comments.length,
      ...this.comments.filter((comment) => comment.documentId !== documentId),
    );
    this.accessPolicies.splice(
      0,
      this.accessPolicies.length,
      ...this.accessPolicies.filter((policy) => policy.documentId !== documentId),
    );
    this.attachments.splice(
      0,
      this.attachments.length,
      ...this.attachments.filter((attachment) => attachment.documentId !== documentId),
    );
    this.links.splice(
      0,
      this.links.length,
      ...this.links.filter(
        (link) => link.sourceDocumentId !== documentId && link.targetDocumentId !== documentId,
      ),
    );
    this.ownerBindings.splice(
      0,
      this.ownerBindings.length,
      ...this.ownerBindings.filter((binding) => binding.documentId !== documentId),
    );
    return this.commit(document);
  }

  listKnowledgeDocumentRevisions(documentId: string) {
    return this.revisions.filter((revision) => revision.documentId === documentId);
  }

  listKnowledgeDocumentComments(documentId: string) {
    return this.comments.filter((comment) => comment.documentId === documentId);
  }

  addKnowledgeDocumentComment(
    documentId: string,
    input: { readonly body: string; readonly parentCommentId?: string | null },
  ) {
    const document = this.getKnowledgeDocument(documentId);
    if (!document) {
      return null;
    }
    const timestamp = nowIso();
    const comment: KnowledgeDocumentComment = {
      id: createId("kcom", ++this.commentCounter),
      companyId: document.companyId,
      documentId,
      parentCommentId: input.parentCommentId?.trim() || null,
      body: input.body,
      bodyFormat: "markdown",
      createdByAgentId: null,
      createdByUserId: "operator",
      resolvedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.comments.unshift(comment);
    return this.commit(comment);
  }

  getKnowledgeAccessPolicy(documentId: string) {
    return this.accessPolicies.find((policy) => policy.documentId === documentId) ?? null;
  }

  updateKnowledgeAccessPolicy(
    documentId: string,
    input: {
      readonly accessMode?: string;
      readonly inheritFromParent?: boolean;
      readonly grants?: readonly {
        readonly principalType: string;
        readonly principalId: string;
        readonly role: string;
      }[];
    },
  ) {
    const existing = this.getKnowledgeAccessPolicy(documentId);
    if (!existing) {
      return null;
    }
    const timestamp = nowIso();
    const grants = (input.grants ?? existing.grants).map((grant) => ({
      id: createId("kgrant", ++this.grantCounter),
      principalType: grant.principalType,
      principalId: grant.principalId,
      role: grant.role,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const updated: KnowledgeAccessPolicy = {
      documentId,
      companyId: existing.companyId,
      accessMode: input.accessMode?.trim() || existing.accessMode,
      inheritFromParent: input.inheritFromParent ?? existing.inheritFromParent,
      grants,
    };
    const index = this.accessPolicies.indexOf(existing);
    this.accessPolicies[index] = updated;
    return this.commit(updated);
  }

  listKnowledgeAttachments(documentId: string) {
    if (!this.getKnowledgeDocument(documentId)) {
      return null;
    }
    return this.attachments.filter((attachment) => attachment.documentId === documentId);
  }

  createKnowledgeAttachment(
    input: Omit<KnowledgeDocumentAttachment, "id"> & { readonly id?: string },
  ) {
    const document = this.getKnowledgeDocument(input.documentId);
    if (!document) {
      return null;
    }
    const attachment: KnowledgeDocumentAttachment = {
      ...input,
      id: input.id ?? createId("katt", ++this.attachmentCounter),
    };
    this.attachments.unshift(attachment);
    const index = this.documents.indexOf(document);
    this.documents[index] = { ...document, updatedAt: attachment.createdAt };
    return this.commit(attachment);
  }

  getKnowledgeAttachment(attachmentId: string) {
    return this.attachments.find((attachment) => attachment.id === attachmentId) ?? null;
  }

  deleteKnowledgeAttachment(attachmentId: string) {
    const attachment = this.getKnowledgeAttachment(attachmentId);
    if (!attachment) {
      return null;
    }
    this.attachments.splice(this.attachments.indexOf(attachment), 1);
    return this.commit(attachment);
  }

  listKnowledgeLinks(documentId: string) {
    if (!this.getKnowledgeDocument(documentId)) {
      return null;
    }
    const mapLinked = (link: KnowledgeDocumentLink, linkedDocumentId: string) => {
      const document = this.getKnowledgeDocument(linkedDocumentId);
      if (!document) {
        return null;
      }
      const collection = this.getKnowledgeCollection(document.collectionId);
      return {
        id: link.id,
        sourceDocumentId: link.sourceDocumentId,
        targetDocumentId: link.targetDocumentId,
        linkType: link.linkType,
        document: {
          id: document.id,
          title: document.title,
          summary: document.summary,
          collectionId: document.collectionId,
          collectionName: collection?.name ?? "Collection",
          updatedAt: document.updatedAt,
        },
      };
    };
    return {
      outbound: this.links
        .filter((link) => link.sourceDocumentId === documentId)
        .map((link) => mapLinked(link, link.targetDocumentId))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
      backlinks: this.links
        .filter((link) => link.targetDocumentId === documentId)
        .map((link) => mapLinked(link, link.sourceDocumentId))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    };
  }

  createKnowledgeLink(
    documentId: string,
    input: {
      readonly targetDocumentId: string;
      readonly linkType?: string | null;
    },
  ) {
    const source = this.getKnowledgeDocument(documentId);
    const target = this.getKnowledgeDocument(input.targetDocumentId);
    const linkType = input.linkType?.trim() || "references";
    if (!source || !target || source.id === target.id) {
      return null;
    }
    const existing = this.links.find(
      (link) =>
        link.sourceDocumentId === source.id &&
        link.targetDocumentId === target.id &&
        link.linkType === linkType,
    );
    if (existing) {
      return { id: existing.id };
    }
    const link: KnowledgeDocumentLink = {
      id: createId("klink", ++this.linkCounter),
      companyId: source.companyId,
      sourceDocumentId: source.id,
      targetDocumentId: target.id,
      linkType,
      createdAt: nowIso(),
    };
    this.links.unshift(link);
    return this.commit({ id: link.id });
  }

  getKnowledgeLink(linkId: string) {
    return this.links.find((link) => link.id === linkId) ?? null;
  }

  deleteKnowledgeLink(linkId: string) {
    const link = this.getKnowledgeLink(linkId);
    if (!link) {
      return null;
    }
    this.links.splice(this.links.indexOf(link), 1);
    return this.commit(link);
  }

  listKnowledgeOwnerBindings(
    ownerType: KnowledgeOwnerType,
    ownerId: string,
    kind: "documents" | "collections",
    partitionKey?: string,
  ): Array<Record<string, unknown>> {
    return this.ownerBindings
      .filter((binding) => {
        if (
          binding.ownerType !== ownerType ||
          binding.ownerId !== ownerId ||
          (kind === "documents" ? !binding.documentId : !binding.collectionId)
        ) {
          return false;
        }
        if (partitionKey === undefined) return true;
        const linkedPartition = binding.partitionKey ?? (
          binding.documentId
            ? this.getKnowledgeDocument(binding.documentId)?.companyId
            : binding.collectionId
              ? this.getKnowledgeCollection(binding.collectionId)?.companyId
              : null
        );
        return typeof linkedPartition === "string"
          && linkedPartition.trim().toLowerCase() === partitionKey.trim().toLowerCase();
      })
      .map((binding) => {
        if (kind === "documents") {
          const document = this.getKnowledgeDocument(binding.documentId ?? "");
          if (!document) {
            return null;
          }
          const collection = this.getKnowledgeCollection(document.collectionId);
          return {
            id: binding.id,
            ownerType: binding.ownerType,
            ownerId: binding.ownerId,
            bindingType: binding.bindingType,
            linkedAt: binding.linkedAt,
            partitionKey: document.companyId,
            document,
            collection: collection
              ? {
                  ...collection,
                  documentCount: this.documents.filter(
                    (entry) => entry.collectionId === collection.id,
                  ).length,
                }
              : null,
          };
        }
        const collection = this.getKnowledgeCollection(binding.collectionId ?? "");
        if (!collection) {
          return null;
        }
        return {
          id: binding.id,
          ownerType: binding.ownerType,
          ownerId: binding.ownerId,
          bindingType: binding.bindingType,
          linkedAt: binding.linkedAt,
          partitionKey: collection.companyId,
          collection: {
            ...collection,
            documentCount: this.documents.filter((entry) => entry.collectionId === collection.id)
              .length,
          },
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  createKnowledgeOwnerBinding(
    ownerType: KnowledgeOwnerType,
    ownerId: string,
    kind: "documents" | "collections",
    input: {
      readonly documentId?: string;
      readonly collectionId?: string | null;
      readonly title?: string;
      readonly summary?: string | null;
      readonly body?: string | null;
      readonly parentDocumentId?: string | null;
      readonly bindingType?: string | null;
      readonly companyId?: string | null;
    },
  ): Record<string, unknown> | null {
    const bindingType = input.bindingType?.trim() || "linked";
    if (kind === "documents" && input.documentId?.trim()) {
      const document = this.getKnowledgeDocument(input.documentId);
      if (!document) {
        return null;
      }
      const existing = this.ownerBindings.find(
        (binding) =>
          binding.ownerType === ownerType &&
          binding.ownerId === ownerId &&
          binding.documentId === document.id,
      );
      if (!existing) {
        this.ownerBindings.unshift({
          id: createId("kbind", ++this.ownerBindingCounter),
          ownerType,
          ownerId,
          bindingType,
          linkedAt: nowIso(),
          partitionKey: document.companyId,
          documentId: document.id,
        });
        this.persist();
      }
      return (
        this.listKnowledgeOwnerBindings(ownerType, ownerId, "documents").find((binding) => {
          const boundDocument = binding.document as { id?: string } | undefined;
          return boundDocument?.id === document.id;
        }) ?? null
      );
    }
    if (kind === "documents") {
      const companyId = input.companyId?.trim() || "default";
      const collection = input.collectionId?.trim()
        ? this.getKnowledgeCollection(input.collectionId)
        : this.ensureKnowledgeDefaultCollection(companyId);
      if (!collection) {
        return null;
      }
      const document = this.createKnowledgeDocument(collection.id, {
        title: input.title?.trim() || "Untitled document",
        summary: input.summary,
        body: input.body,
        parentDocumentId: input.parentDocumentId,
      });
      if (!document) {
        return null;
      }
      return this.createKnowledgeOwnerBinding(ownerType, ownerId, "documents", {
        documentId: document.id,
        bindingType,
      });
    }
    const collectionId = input.collectionId?.trim();
    const collection = collectionId ? this.getKnowledgeCollection(collectionId) : null;
    if (!collection) {
      return null;
    }
    const existing = this.ownerBindings.find(
      (binding) =>
        binding.ownerType === ownerType &&
        binding.ownerId === ownerId &&
        binding.collectionId === collectionId,
    );
    if (!existing) {
      this.ownerBindings.unshift({
        id: createId("kbind", ++this.ownerBindingCounter),
        ownerType,
        ownerId,
        bindingType,
        linkedAt: nowIso(),
        partitionKey: collection.companyId,
        collectionId,
      });
      this.persist();
    }
    return (
      this.listKnowledgeOwnerBindings(ownerType, ownerId, "collections").find((binding) => {
        const boundCollection = binding.collection as { id?: string } | undefined;
        return boundCollection?.id === collectionId;
      }) ?? null
    );
  }

  deleteKnowledgeOwnerBinding(
    ownerType: KnowledgeOwnerType,
    ownerId: string,
    kind: "documents" | "collections",
    targetId: string,
  ) {
    const before = this.ownerBindings.length;
    this.ownerBindings.splice(
      0,
      this.ownerBindings.length,
      ...this.ownerBindings.filter((binding) => {
        if (binding.ownerType !== ownerType || binding.ownerId !== ownerId) {
          return true;
        }
        return kind === "documents"
          ? binding.documentId !== targetId
          : binding.collectionId !== targetId;
      }),
    );
    const changed = before !== this.ownerBindings.length;
    if (changed) {
      this.persist();
    }
    return changed;
  }

  listResearchNotebooks(companyId: string) {
    return this.notebooks
      .filter((notebook) => notebook.companyId === companyId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((notebook) => ({
        ...notebook,
        sourceCount: this.sources.filter((source) => source.notebookId === notebook.id).length,
      }));
  }

  getResearchNotebook(notebookId: string) {
    return this.notebooks.find((notebook) => notebook.id === notebookId) ?? null;
  }

  createResearchNotebook(input: {
    readonly companyId: string;
    readonly title: string;
    readonly slug?: string | null;
    readonly summary?: string | null;
    readonly focusPrompt?: string | null;
    readonly status?: string | null;
  }) {
    const timestamp = nowIso();
    const notebook: ResearchNotebook = {
      id: createId("notebook", ++this.notebookCounter),
      companyId: input.companyId,
      title: input.title.trim() || "Untitled notebook",
      slug: nonEmptyString(input.slug) ?? slugify(input.title),
      summary: input.summary ?? null,
      focusPrompt: input.focusPrompt ?? null,
      status: nonEmptyString(input.status) ?? "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.notebooks.unshift(notebook);
    return this.commit({
      ...notebook,
      sourceCount: 0,
    });
  }

  updateResearchNotebook(
    notebookId: string,
    patch: Partial<{
      readonly title: string;
      readonly summary: string | null;
      readonly focusPrompt: string | null;
      readonly status: string | null;
    }>,
  ) {
    const index = this.notebooks.findIndex((notebook) => notebook.id === notebookId);
    const existing = this.notebooks[index] ?? null;
    if (!existing) {
      return null;
    }
    const updated: ResearchNotebook = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title.trim() || existing.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.focusPrompt !== undefined ? { focusPrompt: patch.focusPrompt } : {}),
      ...(patch.status !== undefined
        ? { status: nonEmptyString(patch.status) ?? existing.status }
        : {}),
      updatedAt: nowIso(),
    };
    this.notebooks[index] = updated;
    return this.commit({
      ...updated,
      sourceCount: this.sources.filter((source) => source.notebookId === updated.id).length,
    });
  }

  deleteResearchNotebook(notebookId: string) {
    const notebook = this.getResearchNotebook(notebookId);
    if (!notebook) {
      return null;
    }
    this.notebooks.splice(this.notebooks.indexOf(notebook), 1);
    const sourceIds = new Set(
      this.sources.filter((source) => source.notebookId === notebookId).map((source) => source.id),
    );
    this.sources.splice(
      0,
      this.sources.length,
      ...this.sources.filter((source) => source.notebookId !== notebookId),
    );
    this.entries.splice(
      0,
      this.entries.length,
      ...this.entries.filter(
        (entry) => entry.notebookId !== notebookId && !sourceIds.has(entry.sourceId ?? ""),
      ),
    );
    this.outputs.splice(
      0,
      this.outputs.length,
      ...this.outputs.filter((output) => output.notebookId !== notebookId),
    );
    return this.commit({
      ...notebook,
      sourceCount: 0,
    });
  }

  listResearchSources(companyId: string, notebookId?: string | null) {
    return this.sources
      .filter((source) => source.companyId === companyId)
      .filter((source) => !notebookId || source.notebookId === notebookId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getResearchSource(sourceId: string) {
    return this.sources.find((source) => source.id === sourceId) ?? null;
  }

  createResearchSource(input: {
    readonly companyId: string;
    readonly notebookId: string;
    readonly title: string;
    readonly sourceType?: string | null;
    readonly url?: string | null;
    readonly storagePath?: string | null;
    readonly originalFilename?: string | null;
    readonly contentType?: string | null;
    readonly size?: number | null;
    readonly author?: string | null;
    readonly publisher?: string | null;
    readonly publishedAt?: string | null;
    readonly summary?: string | null;
    readonly citation?: string | null;
    readonly apiConfig?: Record<string, unknown> | null;
    readonly apiSnapshot?: Record<string, unknown> | null;
    readonly status?: string | null;
    readonly content?: string | null;
    readonly notes?: string | null;
  }) {
    if (!this.getResearchNotebook(input.notebookId)) {
      return null;
    }
    const timestamp = nowIso();
    const source: ResearchSource = {
      id: createId("source", ++this.sourceCounter),
      companyId: input.companyId,
      notebookId: input.notebookId,
      title: input.title.trim() || "Untitled source",
      sourceType: nonEmptyString(input.sourceType) ?? "url",
      url: input.url ?? null,
      storagePath: input.storagePath ?? null,
      originalFilename: input.originalFilename ?? null,
      contentType: input.contentType ?? null,
      size: input.size ?? null,
      author: input.author ?? null,
      publisher: input.publisher ?? null,
      publishedAt: input.publishedAt ?? null,
      summary: input.summary ?? null,
      citation: input.citation ?? null,
      apiConfig: input.apiConfig ?? null,
      apiSnapshot: input.apiSnapshot ?? null,
      status: nonEmptyString(input.status) ?? "ready",
      content: input.content ?? "",
      notes: input.notes ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.sources.unshift(source);
    return this.commit(source);
  }

  updateResearchSource(
    sourceId: string,
    patch: Partial<{
      readonly notebookId: string | null;
      readonly title: string;
      readonly sourceType: string | null;
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
      readonly status: string | null;
      readonly content: string | null;
      readonly notes: string | null;
    }>,
  ) {
    const index = this.sources.findIndex((source) => source.id === sourceId);
    const existing = this.sources[index] ?? null;
    if (!existing) {
      return null;
    }
    const updated: ResearchSource = {
      ...existing,
      ...(patch.notebookId !== undefined
        ? { notebookId: patch.notebookId ?? existing.notebookId }
        : {}),
      ...(patch.title !== undefined ? { title: patch.title.trim() || existing.title } : {}),
      ...(patch.sourceType !== undefined
        ? {
            sourceType: nonEmptyString(patch.sourceType) ?? existing.sourceType,
          }
        : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.storagePath !== undefined ? { storagePath: patch.storagePath } : {}),
      ...(patch.originalFilename !== undefined ? { originalFilename: patch.originalFilename } : {}),
      ...(patch.contentType !== undefined ? { contentType: patch.contentType } : {}),
      ...(patch.size !== undefined ? { size: patch.size } : {}),
      ...(patch.author !== undefined ? { author: patch.author } : {}),
      ...(patch.publisher !== undefined ? { publisher: patch.publisher } : {}),
      ...(patch.publishedAt !== undefined ? { publishedAt: patch.publishedAt } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.citation !== undefined ? { citation: patch.citation } : {}),
      ...(patch.apiConfig !== undefined ? { apiConfig: patch.apiConfig } : {}),
      ...(patch.apiSnapshot !== undefined ? { apiSnapshot: patch.apiSnapshot } : {}),
      ...(patch.status !== undefined
        ? { status: nonEmptyString(patch.status) ?? existing.status }
        : {}),
      ...(patch.content !== undefined ? { content: patch.content ?? "" } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      updatedAt: nowIso(),
    };
    this.sources[index] = updated;
    return this.commit(updated);
  }

  deleteResearchSource(sourceId: string) {
    const source = this.getResearchSource(sourceId);
    if (!source) {
      return null;
    }
    this.sources.splice(this.sources.indexOf(source), 1);
    this.entries.splice(
      0,
      this.entries.length,
      ...this.entries.filter((entry) => entry.sourceId !== sourceId),
    );
    return this.commit(source);
  }

  listResearchEntries(notebookId: string) {
    return this.entries
      .filter((entry) => entry.notebookId === notebookId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getResearchEntry(entryId: string) {
    return this.entries.find((entry) => entry.id === entryId) ?? null;
  }

  createResearchEntry(input: Omit<ResearchEntry, "id" | "createdAt" | "updatedAt">) {
    const timestamp = nowIso();
    const entry: ResearchEntry = {
      ...input,
      id: createId("entry", ++this.entryCounter),
      role: nonEmptyString(input.role) ?? "reference",
      bodyFormat: input.bodyFormat ?? "markdown",
      version: input.version ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.entries.unshift(entry);
    return this.commit(entry);
  }

  deleteResearchEntry(entryId: string) {
    const entry = this.getResearchEntry(entryId);
    if (!entry) {
      return null;
    }
    this.entries.splice(this.entries.indexOf(entry), 1);
    return this.commit(entry);
  }

  listResearchOutputs(notebookId: string) {
    return this.outputs
      .filter((output) => output.notebookId === notebookId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getResearchOutput(outputId: string) {
    return this.outputs.find((output) => output.id === outputId) ?? null;
  }

  createResearchOutput(input: {
    readonly companyId: string;
    readonly notebookId: string;
    readonly outputKind?: string | null;
    readonly title: string;
    readonly summary?: string | null;
    readonly body?: string | null;
    readonly bodyFormat?: string | null;
    readonly status?: string | null;
  }) {
    if (!this.getResearchNotebook(input.notebookId)) {
      return null;
    }
    const timestamp = nowIso();
    const output: ResearchOutput = {
      id: createId("output", ++this.outputCounter),
      companyId: input.companyId,
      notebookId: input.notebookId,
      outputKind: nonEmptyString(input.outputKind) ?? "memo",
      title: input.title.trim() || "Research output",
      summary: input.summary ?? null,
      body: input.body ?? "",
      bodyFormat: nonEmptyString(input.bodyFormat) ?? "markdown",
      status: nonEmptyString(input.status) ?? "draft",
      promotionState: "idle",
      promotedDocumentId: null,
      promotedRevisionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.outputs.unshift(output);
    return this.commit(output);
  }

  updateResearchOutput(
    outputId: string,
    patch: Partial<{
      readonly outputKind: string | null;
      readonly title: string;
      readonly summary: string | null;
      readonly body: string | null;
      readonly bodyFormat: string | null;
      readonly status: string | null;
      readonly promotionState: string;
      readonly promotedDocumentId: string | null;
      readonly promotedRevisionId: string | null;
    }>,
  ) {
    const index = this.outputs.findIndex((output) => output.id === outputId);
    const existing = this.outputs[index] ?? null;
    if (!existing) {
      return null;
    }
    const updated: ResearchOutput = {
      ...existing,
      ...(patch.outputKind !== undefined
        ? {
            outputKind: nonEmptyString(patch.outputKind) ?? existing.outputKind,
          }
        : {}),
      ...(patch.title !== undefined ? { title: patch.title.trim() || existing.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.body !== undefined ? { body: patch.body ?? existing.body } : {}),
      ...(patch.bodyFormat !== undefined
        ? {
            bodyFormat: nonEmptyString(patch.bodyFormat) ?? existing.bodyFormat,
          }
        : {}),
      ...(patch.status !== undefined
        ? { status: nonEmptyString(patch.status) ?? existing.status }
        : {}),
      ...(patch.promotionState !== undefined ? { promotionState: patch.promotionState } : {}),
      ...(patch.promotedDocumentId !== undefined
        ? { promotedDocumentId: patch.promotedDocumentId }
        : {}),
      ...(patch.promotedRevisionId !== undefined
        ? { promotedRevisionId: patch.promotedRevisionId }
        : {}),
      updatedAt: nowIso(),
    };
    this.outputs[index] = updated;
    return this.commit(updated);
  }

  deleteResearchOutput(outputId: string) {
    const output = this.getResearchOutput(outputId);
    if (!output) {
      return null;
    }
    this.outputs.splice(this.outputs.indexOf(output), 1);
    return this.commit(output);
  }

  buildResearchNotebookWorkspace(notebookId: string) {
    const notebook = this.getResearchNotebook(notebookId);
    if (!notebook) {
      return null;
    }
    const sources = this.listResearchSources(notebook.companyId, notebook.id);
    const entries = this.listResearchEntries(notebook.id);
    const outputs = this.listResearchOutputs(notebook.id);
    const linkedDocuments = entries
      .filter((entry) => entry.documentId)
      .map((entry) => {
        const document = this.getKnowledgeDocument(entry.documentId ?? "");
        if (!document) {
          return null;
        }
        return {
          id: document.id,
          entryId: entry.id,
          title: document.title,
          summary: document.summary,
          role: entry.role,
          entryKind: entry.entryKind,
          documentRevisionId: entry.documentRevisionId,
          updatedAt: document.updatedAt,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return {
      companyId: notebook.companyId,
      notebook: {
        ...notebook,
        sourceCount: sources.length,
      },
      sources,
      entries,
      outputs,
      notes: [] as Array<Record<string, never>>,
      recentTurns: [] as Array<Record<string, never>>,
      linkedDocuments,
      linkedProjects: [] as Array<Record<string, never>>,
      degraded: {
        notesMode: "standalone_empty",
        recentTurns: "standalone_empty",
        linkedContext: "documents_only",
      },
    };
  }

  rankResearchWorkspaceItems(
    prompt: string,
    workspace: ReturnType<KnowledgeStore["buildResearchNotebookWorkspace"]>,
    scope?: {
      readonly sourceIds?: readonly string[];
      readonly documentIds?: readonly string[];
    } | null,
  ) {
    if (!workspace) {
      return [];
    }
    const terms = prompt
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length > 2);
    const scopedSourceIds = new Set(scope?.sourceIds ?? []);
    const scopedDocumentIds = new Set(scope?.documentIds ?? []);
    const scoreText = (text: string) =>
      terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
    const candidates = [
      ...workspace.sources
        .filter((source) => scopedSourceIds.size === 0 || scopedSourceIds.has(source.id))
        .map((source) => ({
          kind: "source" as const,
          id: source.id,
          title: source.title,
          excerpt: [source.summary, source.citation, source.content]
            .filter(Boolean)
            .join("\n")
            .slice(0, 1_200),
          url: source.url,
        })),
      ...workspace.linkedDocuments
        .filter((document) => scopedDocumentIds.size === 0 || scopedDocumentIds.has(document.id))
        .map((document) => ({
          kind: "document" as const,
          id: document.id,
          title: document.title,
          excerpt: [document.summary, document.title].filter(Boolean).join("\n").slice(0, 600),
          url: null,
        })),
      ...workspace.outputs.map((output) => ({
        kind: "output" as const,
        id: output.id,
        title: output.title,
        excerpt: [output.summary, output.body].filter(Boolean).join("\n").slice(0, 1_200),
        url: null,
      })),
    ];
    return candidates
      .map((candidate) => {
        const haystack = `${candidate.title}\n${candidate.excerpt}`.toLowerCase();
        return { ...candidate, score: scoreText(haystack) };
      })
      .filter((candidate) => candidate.score > 0 || terms.length === 0)
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, 5);
  }

  private createRevision(
    document: KnowledgeDocument,
    version: number,
    createdAt: string,
    actor: { readonly createdByAgentId?: string | null; readonly createdByUserId?: string | null } = {},
  ) {
    this.revisions.unshift({
      id: createId("krev", ++this.revisionCounter),
      companyId: document.companyId,
      documentId: document.id,
      version,
      title: document.title,
      summary: document.summary,
      body: document.body,
      bodyFormat: document.bodyFormat,
      createdByAgentId:
        actor.createdByAgentId !== undefined
          ? actor.createdByAgentId?.trim() || null
          : document.createdByAgentId ?? null,
      createdByUserId:
        actor.createdByUserId !== undefined
          ? actor.createdByUserId?.trim() || null
          : document.createdByUserId ?? (document.createdByAgentId ? null : "operator"),
      createdAt,
    });
  }

  createBinding(
    input: Omit<KnowledgeBinding, "bindingId" | "createdAt"> & {
      readonly bindingId?: string;
      readonly createdAt?: string;
    },
  ): KnowledgeBinding {
    const binding: KnowledgeBinding = {
      ...input,
      bindingId: input.bindingId ?? `binding_${++this.bindingCounter}`,
      createdAt: input.createdAt ?? new Date().toISOString(),
      partitionKey: input.partitionKey ?? null,
    };
    this.bindings.unshift(binding);
    return this.commit(binding);
  }

  listBindings(
    filter: {
      readonly ownerPlugin?: string;
      readonly ownerType?: string;
      readonly ownerId?: string;
      readonly artifactType?: string;
      readonly artifactId?: string;
      readonly partitionKey?: string;
    } = {},
  ): readonly KnowledgeBinding[] {
    return this.bindings.filter((binding) => {
      if (filter.ownerPlugin !== undefined && binding.ownerPlugin !== filter.ownerPlugin) {
        return false;
      }
      if (filter.ownerType !== undefined && binding.ownerType !== filter.ownerType) {
        return false;
      }
      if (filter.ownerId !== undefined && binding.ownerId !== filter.ownerId) {
        return false;
      }
      if (filter.artifactType !== undefined && binding.artifactType !== filter.artifactType) {
        return false;
      }
      if (filter.artifactId !== undefined && binding.artifactId !== filter.artifactId) {
        return false;
      }
      if (filter.partitionKey !== undefined && binding.partitionKey !== filter.partitionKey) {
        return false;
      }
      return true;
    });
  }

  deleteBinding(bindingId: string): KnowledgeBinding | null {
    const index = this.bindings.findIndex((binding) => binding.bindingId === bindingId);
    if (index === -1) {
      return null;
    }
    const [deleted] = this.bindings.splice(index, 1);
    return deleted ? this.commit(deleted) : null;
  }

  getBinding(bindingId: string): KnowledgeBinding | null {
    return this.bindings.find((binding) => binding.bindingId === bindingId) ?? null;
  }

  /** Internal projection input, never returned as an unscoped HTTP response. */
  brainProjectionInputs() {
    return [
      ...this.documents.map(value => ({ kind: "document" as const, value: cloneJson(value) })),
      ...this.sources.map(value => ({ kind: "research" as const, value: cloneJson(value) })),
    ];
  }

  snapshot() {
    return {
      counts: {
        attachments: this.attachments.length,
        bindings: this.bindings.length,
        collections: this.collections.length,
        documents: this.documents.length,
        researchEntries: this.entries.length,
        researchNotebooks: this.notebooks.length,
        researchOutputs: this.outputs.length,
        researchSources: this.sources.length,
      },
      persistence: this.persistence?.describe?.() ?? null,
    };
  }
}
