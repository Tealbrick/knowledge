import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { AlertTriangle, Archive, ChevronRight, FileClock, FileText, FolderPlus, Link2, MessageSquareText, Paperclip, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Button, EmptyState, Tag } from "@doppelganger/ui";
import { addComment, ApiError, getAccess, getAttachments, getCollections, getComments, getDocument, getLinks, getRevisions, searchDocuments } from "./api";
import type { KnowledgeDocument, KnowledgeSearchResult } from "./types";
import { CollectionDialog, DeleteCollectionDialog, DocumentDialog, IngestDialog } from "./LibraryDialogs";
import { errorTitle } from "./errors";

function date(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}

function bytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function ErrorNotice({ error, retry }: { error: Error; retry?: () => void }) {
  const status = error instanceof ApiError ? error.status : 0;
  const title = errorTitle(status);
  return (
    <div className="notice" role="alert">
      <AlertTriangle size={17} />
      <div>
        <strong>{title}</strong>
        <p>{error.message}</p>
      </div>
      {retry && (
        <Button size="small" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="loading-state">
      <RefreshCw className="spin" size={18} />
      <span>{label}</span>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  children: string;
  actions?: ReactNode;
}) {
  return (
    <header className="section-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

function DocumentIndex({
  documents,
  selectedId,
  onSelect,
  loading,
  emptyHint,
}: {
  documents: KnowledgeSearchResult[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  emptyHint: string;
}) {
  if (loading) return <Loading label="Searching the library…" />;
  if (!documents.length)
    return (
      <div className="index-empty">
        <Archive size={22} />
        <strong>No documents found</strong>
        <span>{emptyHint}</span>
      </div>
    );
  return (
    <div className="document-list" aria-label="Knowledge documents">
      {documents.map((document) => (
        <button
          key={document.id}
          className="document-row"
          aria-current={document.id === selectedId}
          onClick={() => onSelect(document.id)}
        >
          <span className="document-row__icon">
            <FileText size={15} />
          </span>
          <span className="document-row__body">
            <span>
              <strong>{document.title}</strong>
              <time>{date(document.updatedAt).split(",")[0]}</time>
            </span>
            <small>
              {document.collectionName} · {document.status}
            </small>
            <p>
              {document.summary || document.excerpt || "No summary recorded."}
            </p>
          </span>
          <ChevronRight size={14} />
        </button>
      ))}
    </div>
  );
}

function DocumentWorkspace({
  document,
  allDocuments,
  onEdit,
  onIngest,
}: {
  document: KnowledgeDocument;
  allDocuments: KnowledgeSearchResult[];
  onEdit: () => void;
  onIngest: () => void;
}) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const revisions = useQuery({
    queryKey: ["knowledge-revisions", document.id],
    queryFn: () => getRevisions(document.id),
    retry: false,
  });
  const comments = useQuery({
    queryKey: ["knowledge-comments", document.id],
    queryFn: () => getComments(document.id),
    retry: false,
  });
  const access = useQuery({
    queryKey: ["knowledge-access", document.id],
    queryFn: () => getAccess(document.id),
    retry: false,
  });
  const attachments = useQuery({
    queryKey: ["knowledge-attachments", document.id],
    queryFn: () => getAttachments(document.id),
    retry: false,
  });
  const links = useQuery({
    queryKey: ["knowledge-links", document.id],
    queryFn: () => getLinks(document.id),
    retry: false,
  });
  const postComment = useMutation({
    mutationFn: () => addComment(document.id, comment.trim()),
    onSuccess: async () => {
      setComment("");
      await queryClient.invalidateQueries({
        queryKey: ["knowledge-comments", document.id],
      });
    },
  });
  const linked = (id: string) =>
    allDocuments.find((entry) => entry.id === id)?.title ?? id;

  return (
    <article className="document-workspace">
      <header className="document-title">
        <div>
          <p className="eyebrow">Document · {document.bodyFormat}</p>
          <h2>{document.title}</h2>
          <div className="tag-row">
            <Tag
              tone={
                document.status === "published" || document.status === "active"
                  ? "success"
                  : "default"
              }
            >
              {document.status}
            </Tag>
            <Tag>{document.source?.provider ?? "native"}</Tag>
            {document.source?.path && <Tag>{document.source.path}</Tag>}
          </div>
        </div>
        <div className="document-actions">
          <Button size="small" onClick={onEdit}>
            <FileText size={14} />
            Edit
          </Button>
          <Button size="small" onClick={onIngest}>
            <Upload size={14} />
            Ingest
          </Button>
        </div>
      </header>
      {document.summary && (
        <p className="document-summary">{document.summary}</p>
      )}
      <div className="document-grid">
        <main className="document-body">
          <div className="folio">
                <span>
                  {document.bodyFormat === "markdown"
                    ? "Markdown source · plain view"
                    : "Document body · plain view"}
                </span>
            <code>{document.id}</code>
          </div>
          <pre>{document.body || "This document has no body."}</pre>
        </main>
        <aside className="document-meta">
          <section>
            <h3>Record</h3>
            <dl>
              <dt>Collection</dt>
              <dd>
                {allDocuments.find(
                  (entry) => entry.collectionId === document.collectionId,
                )?.collectionName ?? document.collectionId}
              </dd>
              <dt>Updated</dt>
              <dd>{date(document.updatedAt)}</dd>
              <dt>Created by</dt>
              <dd>
                {document.createdByAgentId ||
                  document.createdByUserId ||
                  "Unspecified"}
              </dd>
              <dt>Slug</dt>
              <dd className="mono">{document.slug}</dd>
            </dl>
          </section>
          <section>
            <h3>Source</h3>
            {document.source ? (
              <dl>
                <dt>Provider</dt>
                <dd>{document.source.provider}</dd>
                <dt>Path</dt>
                <dd className="mono">{document.source.path}</dd>
                <dt>Synced</dt>
                <dd>{date(document.source.syncedAt)}</dd>
              </dl>
            ) : (
              <p>Created in Knowledge.</p>
            )}
          </section>
        </aside>
      </div>
      <Tabs.Root className="record-tabs" defaultValue="revisions">
        <Tabs.List aria-label="Document record sections">
          <Tabs.Trigger value="revisions">
            <FileClock size={14} />
            Revisions <span>{revisions.data?.length ?? 0}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="discussion">
            <MessageSquareText size={14} />
            Discussion <span>{comments.data?.length ?? 0}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="links">
            <Link2 size={14} />
            Links <span>{links.data?.length ?? 0}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="attachments">
            <Paperclip size={14} />
            Attachments <span>{attachments.data?.length ?? 0}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="access">
            <ShieldCheck size={14} />
            Access
          </Tabs.Trigger>
        </Tabs.List>
        <div className="record-panel">
          <Tabs.Content value="revisions">
            {revisions.error ? (
              <ErrorNotice
                error={revisions.error}
                retry={() => revisions.refetch()}
              />
            ) : revisions.isLoading ? (
              <Loading label="Loading revision history…" />
            ) : revisions.data?.length ? (
              <div className="timeline">
                {revisions.data.map((revision) => (
                  <article key={revision.id}>
                    <span>v{revision.version}</span>
                    <div>
                      <strong>{revision.title}</strong>
                      <p>{revision.summary || "No revision note."}</p>
                      <time>{date(revision.createdAt)}</time>
                    </div>
                    <code>{revision.id}</code>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted-row">
                No earlier versions have been recorded yet.
              </p>
            )}
          </Tabs.Content>
          <Tabs.Content value="discussion">
            <form
              className="comment-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (comment.trim()) postComment.mutate();
              }}
            >
              <textarea
                aria-label="Add a document comment"
                placeholder="Add context for your team and agents…"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
              <Button
                tone="primary"
                disabled={!comment.trim() || postComment.isPending}
              >
                Add comment
              </Button>
            </form>
            {postComment.error && <ErrorNotice error={postComment.error} />}
            {comments.data?.length ? (
              <div className="comment-list">
                {comments.data.map((entry) => (
                  <article key={entry.id}>
                    <div>
                      <strong>
                        {entry.createdByAgentId ||
                          entry.createdByUserId ||
                          "Unknown author"}
                      </strong>
                      <time>{date(entry.createdAt)}</time>
                    </div>
                    <p>{entry.body}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted-row">No comments have been added.</p>
            )}
          </Tabs.Content>
          <Tabs.Content value="links">
            {links.data?.length ? (
              <div className="simple-list">
                {links.data.map((link) => (
                  <article key={link.id}>
                    <Link2 size={15} />
                    <div>
                      <strong>{linked(link.targetDocumentId)}</strong>
                      <span>{link.linkType}</span>
                    </div>
                    <code>{link.id}</code>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted-row">No document relationships recorded.</p>
            )}
          </Tabs.Content>
          <Tabs.Content value="attachments">
            {attachments.data?.length ? (
              <div className="simple-list">
                {attachments.data.map((attachment) => (
                  <article key={attachment.id}>
                    <Paperclip size={15} />
                    <div>
                      <strong>
                        {attachment.label || attachment.originalFilename}
                      </strong>
                      <span>
                        {attachment.contentType} · {bytes(attachment.byteSize)}
                      </span>
                    </div>
                    <a href={attachment.contentPath}>Open</a>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted-row">No files attached to this document.</p>
            )}
          </Tabs.Content>
          <Tabs.Content value="access">
            {access.error ? (
              <ErrorNotice
                error={access.error}
                retry={() => access.refetch()}
              />
            ) : access.data ? (
              <div className="access-panel">
                <div>
                  <p className="eyebrow">Access mode</p>
                  <strong>{access.data.accessMode}</strong>
                  <span>
                    {access.data.inheritFromParent
                      ? "Inherits from parent"
                      : "Document-specific policy"}
                  </span>
                </div>
                {access.data.grants.length ? (
                  <div className="grant-list">
                    {access.data.grants.map((grant) => (
                      <article key={grant.id}>
                        <ShieldCheck size={15} />
                        <strong>
                          {grant.principalType}:{grant.principalId}
                        </strong>
                        <Tag>{grant.role}</Tag>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted-row">No explicit grants.</p>
                )}
              </div>
            ) : (
              <Loading label="Loading access policy…" />
            )}
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </article>
  );
}

export function LibraryView({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingExisting, setEditingExisting] = useState(false);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [deleteCollectionOpen, setDeleteCollectionOpen] = useState(false);
  const collections = useQuery({
    queryKey: ["knowledge-collections", companyId],
    queryFn: () => getCollections(companyId),
  });
  const documents = useQuery({
    queryKey: ["knowledge-search", companyId, search, collectionId],
    queryFn: () => searchDocuments(companyId, search, collectionId),
  });
  useEffect(() => {
    const rows = documents.data ?? [];
    if (!selectedId || !rows.some((row) => row.id === selectedId))
      setSelectedId(rows[0]?.id ?? null);
  }, [documents.data, selectedId]);
  const detail = useQuery({
    queryKey: ["knowledge-document", selectedId],
    queryFn: () => getDocument(selectedId!),
    enabled: Boolean(selectedId),
  });
  const refreshLibrary = async (nextId?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["knowledge-collections", companyId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["knowledge-search", companyId],
      }),
      queryClient.invalidateQueries({ queryKey: ["knowledge-bootstrap"] }),
    ]);
    if (nextId) setSelectedId(nextId);
    else setSelectedId(null);
  };

  const hasCollections = Boolean(collections.data?.length);
  // A new installation may have no collections (agent-scoped access) or only
  // an empty automatic "Default" collection (owner browser). Both are first run.
  const noCollections = collections.isSuccess && !hasCollections;
  const firstRun = collections.isSuccess &&
    (collections.data ?? []).reduce((total, entry) => total + (entry.documentCount ?? 0), 0) === 0;
  const activeCollection = collections.data?.find((entry) => entry.id === collectionId) ?? null;
  const searching = Boolean(search.trim());
  const emptyHint = searching
    ? "Try a broader search or select another collection."
    : activeCollection
      ? "This collection has no documents yet. Use New to write one or Ingest to import files."
      : "Use New to write a document or Ingest to import files.";
  const newCollectionButton = (
    <Button size="small" tone={noCollections ? "primary" : "default"} onClick={() => setCollectionOpen(true)}>
      <FolderPlus size={14} />
      New collection
    </Button>
  );

  return (
    <section className="library-layout">
      <aside className="library-index">
        <div className="index-heading">
          <div>
            <p className="eyebrow">Documents</p>
            <h2>Library</h2>
          </div>
          <div className="header-actions">
            {hasCollections && (
              <Button
                size="small"
                onClick={() => {
                  setEditingExisting(false);
                  setEditorOpen(true);
                }}
              >
                <Plus size={14} />
                New
              </Button>
            )}
            {newCollectionButton}
          </div>
        </div>
        <label className="search-box">
          <Search size={15} />
          <input
            aria-label="Search Knowledge"
            placeholder="Search documents"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="collection-strip" aria-label="Collections">
          <button
            className={!collectionId ? "is-active" : ""}
            onClick={() => setCollectionId(null)}
          >
            All <span>{documents.data?.length ?? 0}</span>
          </button>
          {collections.data?.map((collection) => (
            <button
              key={collection.id}
              className={collectionId === collection.id ? "is-active" : ""}
              onClick={() => setCollectionId(collection.id)}
            >
              {collection.name}
              <span>{collection.documentCount ?? 0}</span>
            </button>
          ))}
        </div>
        {activeCollection && (
          <div className="collection-actions">
            <span>{activeCollection.description || "No description"}</span>
            <Button size="small" tone="ghost" onClick={() => setDeleteCollectionOpen(true)}>
              <Trash2 size={13} />
              Delete collection
            </Button>
          </div>
        )}
        {collections.error && (
          <ErrorNotice error={collections.error} retry={() => collections.refetch()} />
        )}
        {noCollections ? (
          <div className="index-empty">
            <FolderPlus size={22} />
            <strong>Start with a collection</strong>
            <span>Create a collection, then write or import documents into it.</span>
          </div>
        ) : documents.error ? (
          <ErrorNotice
            error={documents.error}
            retry={() => documents.refetch()}
          />
        ) : (
          <DocumentIndex
            documents={documents.data ?? []}
            selectedId={selectedId}
            onSelect={setSelectedId}
            loading={documents.isLoading}
            emptyHint={emptyHint}
          />
        )}
      </aside>
      <section className="primary-workspace">
        {detail.error ? (
          <div className="workspace-state">
            <ErrorNotice error={detail.error} retry={() => detail.refetch()} />
          </div>
        ) : detail.isLoading ? (
          <Loading label="Opening document…" />
        ) : detail.data ? (
          <DocumentWorkspace
            document={detail.data}
            allDocuments={documents.data ?? []}
            onEdit={() => {
              setEditingExisting(true);
              setEditorOpen(true);
            }}
            onIngest={() => setIngestOpen(true)}
          />
        ) : firstRun && !searching ? (
          <div className="workspace-state">
            <EmptyState
              title="Your library is empty"
              action={
                <div className="header-actions">
                  {hasCollections && (
                    <Button
                      size="small"
                      tone="primary"
                      onClick={() => {
                        setEditingExisting(false);
                        setEditorOpen(true);
                      }}
                    >
                      <Plus size={14} />
                      Write a document
                    </Button>
                  )}
                  {hasCollections && (
                    <Button size="small" onClick={() => setIngestOpen(true)}>
                      <Upload size={14} />
                      Import files
                    </Button>
                  )}
                  {newCollectionButton}
                </div>
              }
            >
              Knowledge keeps your team's documents in collections, ready for
              you and your agents to search. Write or import a document, or
              create a collection to organise them.
            </EmptyState>
          </div>
        ) : (
          <div className="workspace-state">
            <EmptyState title="Select a document">
              Its content, history, discussion, links, attachments, and access
              will appear here.
            </EmptyState>
          </div>
        )}
      </section>
      <DocumentDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        document={editingExisting ? (detail.data ?? null) : null}
        collections={collections.data ?? []}
        defaultCollectionId={collectionId}
        onSaved={refreshLibrary}
      />
      <CollectionDialog
        open={collectionOpen}
        onOpenChange={setCollectionOpen}
        companyId={companyId}
        onCreated={async (collection) => {
          await refreshLibrary();
          setCollectionId(collection.id);
        }}
      />
      <DeleteCollectionDialog
        open={deleteCollectionOpen}
        onOpenChange={setDeleteCollectionOpen}
        collection={activeCollection}
        onDeleted={async () => {
          setCollectionId(null);
          await refreshLibrary();
        }}
      />
      <IngestDialog
        open={ingestOpen}
        onOpenChange={setIngestOpen}
        companyId={companyId}
        collections={collections.data ?? []}
        defaultCollectionId={detail.data?.collectionId ?? collectionId}
        onCompleted={() => refreshLibrary(selectedId ?? undefined)}
      />
    </section>
  );
}
