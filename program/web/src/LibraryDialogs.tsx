import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  Archive,
  RefreshCw,
  Save,
  Upload,
  X,
} from "lucide-react";
import {
  Button,
  Dialog as SharedDialog,
  Feedback,
  IconButton,
  SelectField,
  Tag,
  TextareaField,
  TextField,
} from "@doppelganger/ui";

import {
  createCollection,
  createDocument,
  deleteCollection,
  deleteDocument,
  ingestFiles,
  runRepoIngest,
  updateDocument,
} from "./api";
import type {
  IngestResult,
  KnowledgeCollection,
  KnowledgeDocument,
} from "./types";

function MutationError({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p className="inline-error" role="alert">
      <AlertTriangle size={14} />
      {error.message}
    </p>
  );
}

function Confirmation({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  error: Error | null;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className="confirm-dialog">
          <p className="eyebrow">Please confirm</p>
          <AlertDialog.Title>{title}</AlertDialog.Title>
          <AlertDialog.Description>{description}</AlertDialog.Description>
          <MutationError error={error} />
          <footer>
            <AlertDialog.Cancel asChild>
              <Button disabled={pending}>Cancel</Button>
            </AlertDialog.Cancel>
            <Button tone="danger" disabled={pending} onClick={onConfirm}>
              {pending && <RefreshCw className="spin" size={14} />}
              {confirmLabel}
            </Button>
          </footer>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function DocumentDialog({
  open,
  onOpenChange,
  document,
  collections,
  defaultCollectionId = null,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: KnowledgeDocument | null;
  collections: KnowledgeCollection[];
  defaultCollectionId?: string | null;
  onSaved: (documentId?: string) => void;
}) {
  type DocumentDraft = {
    collectionId: string;
    title: string;
    summary: string;
    body: string;
    status: string;
  };
  const emptyDraft: DocumentDraft = {
    collectionId: "",
    title: "",
    summary: "",
    body: "",
    status: "draft",
  };
  const [collectionId, setCollectionId] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("draft");
  const [baseline, setBaseline] = useState<DocumentDraft>(emptyDraft);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saveFailure, setSaveFailure] = useState<Error | null>(null);
  const [saveFailureDraft, setSaveFailureDraft] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const deleteInFlight = useRef(false);
  useEffect(() => {
    if (!open) return;
    const nextDraft: DocumentDraft = {
      collectionId: document?.collectionId ??
        (collections.some((entry) => entry.id === defaultCollectionId) ? defaultCollectionId! : collections[0]?.id ?? ""),
      title: document?.title ?? "",
      summary: document?.summary ?? "",
      body: document?.body ?? "",
      status: document?.status ?? "draft",
    };
    setCollectionId(nextDraft.collectionId);
    setTitle(nextDraft.title);
    setSummary(nextDraft.summary);
    setBody(nextDraft.body);
    setStatus(nextDraft.status);
    setBaseline(nextDraft);
    setDiscardOpen(false);
    setDeleteOpen(false);
  }, [open, document?.id]);
  const draft: DocumentDraft = { collectionId, title, summary, body, status };
  const dirty = open && JSON.stringify(draft) !== JSON.stringify(baseline);
  const requestClose = (nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }
    if (save.isPending || saveInFlight.current || remove.isPending || deleteInFlight.current) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    setDiscardOpen(false);
    setDeleteOpen(false);
    save.reset();
    remove.reset();
    onOpenChange(false);
  };
  const save = useMutation({
    mutationFn: () =>
      document
        ? updateDocument(document.id, {
            title,
            summary: summary || null,
            body,
            status,
            bodyFormat: document.bodyFormat,
          })
        : createDocument(collectionId, {
            title,
            summary: summary || null,
            body,
            status,
            bodyFormat: "markdown",
          }),
    onError: (error) => {
      setSaveFailure(error instanceof Error ? error : new Error("The document could not be saved."));
      setSaveFailureDraft(JSON.stringify(draft));
    },
    onSuccess: (saved) => {
      setSaveFailure(null);
      setSaveFailureDraft(null);
      onOpenChange(false);
      onSaved(saved.id);
    },
    onSettled: () => {
      saveInFlight.current = false;
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDocument(document!.id),
    onSuccess: () => {
      setDeleteOpen(false);
      onOpenChange(false);
      onSaved();
    },
    onSettled: () => {
      deleteInFlight.current = false;
    },
  });
  useEffect(() => {
    if (!open) {
      setSaveFailure(null);
      setSaveFailureDraft(null);
      save.reset();
      remove.reset();
      return;
    }
    setSaveFailure(null);
    setSaveFailureDraft(null);
    save.reset();
    remove.reset();
  }, [open, document?.id]);
  const selectedCollection = collections.find(
    (collection) => collection.id === collectionId,
  );
  return (
    <>
      <SharedDialog
        open={open}
        onOpenChange={requestClose}
        title={document ? "Edit document" : "Create document"}
        description={
          selectedCollection?.sourceConfig.provider === "native"
            ? "This document is stored in Knowledge."
            : "Changes are written to the connected repository first, then saved in Knowledge."
        }
        footer={
          <div style={{ display: "flex", gap: "var(--dg-space-3)", justifyContent: "space-between", width: "100%", flexWrap: "wrap" }}>
            {document ? (
              <Button
                type="button"
                tone="danger"
                disabled={save.isPending || saveInFlight.current || remove.isPending || deleteInFlight.current}
                onClick={() => {
                  if (save.isPending || saveInFlight.current || remove.isPending || deleteInFlight.current) return;
                  remove.reset();
                  setDeleteOpen(true);
                }}
              >
                <Archive size={14} />
                Delete
              </Button>
            ) : (
              <span aria-hidden="true" />
            )}
            <div className="dialog-actions">
              <Button type="button" disabled={save.isPending || saveInFlight.current || remove.isPending || deleteInFlight.current} onClick={() => requestClose(false)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                type="submit"
                form="document-dialog-form"
                pending={save.isPending || saveInFlight.current}
                disabled={!collectionId || !title.trim() || remove.isPending || deleteInFlight.current}
              >
                {save.isPending || saveInFlight.current ? "Saving…" : <><Save size={14} />{document ? "Save changes" : "Create document"}</>}
              </Button>
            </div>
          </div>
        }
      >
        <form
          id="document-dialog-form"
          style={{ display: "grid", gap: "var(--dg-space-4)" }}
          onSubmit={(event) => {
            event.preventDefault();
            if (save.isPending || saveInFlight.current || remove.isPending || deleteInFlight.current) return;
            saveInFlight.current = true;
            setSaveFailure(null);
            setSaveFailureDraft(null);
            save.reset();
            save.mutate();
          }}
        >
          <SelectField
            label="Collection"
            disabled={Boolean(document) || save.isPending || saveInFlight.current || remove.isPending || deleteInFlight.current}
            value={collectionId}
            onChange={(event) => setCollectionId(event.target.value)}
          >
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name} · {collection.sourceConfig.provider}
              </option>
            ))}
          </SelectField>
          <div style={{ display: "grid", gap: "var(--dg-space-4)", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <TextField
              label="Title"
              required
              maxLength={180}
              disabled={save.isPending || saveInFlight.current || remove.isPending || deleteInFlight.current}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <SelectField
              label="Status"
              disabled={save.isPending || saveInFlight.current || remove.isPending || deleteInFlight.current}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </SelectField>
          </div>
          <TextareaField
            label="Summary"
            rows={2}
            disabled={save.isPending || saveInFlight.current || remove.isPending || deleteInFlight.current}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <TextareaField
            label="Markdown body"
            style={{ fontFamily: "var(--dg-font-mono)" }}
            rows={14}
            disabled={save.isPending || saveInFlight.current || remove.isPending || deleteInFlight.current}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          {saveFailure && saveFailureDraft === JSON.stringify(draft) && <Feedback state="error" title="Document was not saved">{saveFailure.message}</Feedback>}
        </form>
      </SharedDialog>
      <SharedDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        kind="alertdialog"
        title="Discard unsaved changes?"
        description="Your document draft has not been saved. Keep editing or discard the current draft."
        footer={<div className="dialog-actions"><Button autoFocus type="button" onClick={() => setDiscardOpen(false)}>Keep editing</Button><Button tone="danger" type="button" onClick={() => { setDiscardOpen(false); setSaveFailure(null); setSaveFailureDraft(null); save.reset(); remove.reset(); onOpenChange(false); }}>Discard draft</Button></div>}
      />
      <SharedDialog
        open={deleteOpen}
        onOpenChange={(next) => { if (!remove.isPending && !deleteInFlight.current) setDeleteOpen(next); }}
        kind="alertdialog"
        title={`Delete ${document?.title ?? "document"}?`}
        description="This permanently deletes the document. For repository-backed collections, the file is deleted from the repository first. Links from other documents may stop working."
        footer={<div className="dialog-actions"><Button autoFocus type="button" disabled={remove.isPending || deleteInFlight.current} onClick={() => setDeleteOpen(false)}>Cancel</Button><Button tone="danger" type="button" pending={remove.isPending || deleteInFlight.current} onClick={() => { if (remove.isPending || deleteInFlight.current || save.isPending || saveInFlight.current) return; deleteInFlight.current = true; remove.mutate(); }}>Delete document</Button></div>}
      >
        {remove.error && <Feedback state="error" title="Document was not deleted">{remove.error.message}</Feedback>}
      </SharedDialog>
    </>
  );
}

export function IngestDialog({
  open,
  onOpenChange,
  companyId,
  collections,
  defaultCollectionId,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  collections: KnowledgeCollection[];
  defaultCollectionId: string | null;
  onCompleted: () => void;
}) {
  const [collectionId, setCollectionId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [repoConfirm, setRepoConfirm] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);
  useEffect(() => {
    if (!open) return;
    setCollectionId(defaultCollectionId ?? collections[0]?.id ?? "");
    setFiles([]);
    setResult(null);
    setRepoConfirm(false);
  }, [open, defaultCollectionId, collections]);
  const fileMutation = useMutation({
    mutationFn: () => ingestFiles(companyId, collectionId, files),
    onSuccess: (next) => {
      setResult(next);
      setFiles([]);
      onCompleted();
    },
  });
  const repoMutation = useMutation({
    mutationFn: () => runRepoIngest(companyId, collectionId || null),
    onSuccess: (next) => {
      setResult(next);
      setRepoConfirm(false);
      onCompleted();
    },
  });
  const selected = collections.find(
    (collection) => collection.id === collectionId,
  );
  const sourceBacked = selected?.sourceConfig.provider !== "native";
  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!fileMutation.isPending && !repoMutation.isPending)
            onOpenChange(next);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="form-dialog ingest-dialog"
            aria-describedby="ingest-dialog-description"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow">Import</p>
                <Dialog.Title>Ingest documents</Dialog.Title>
                <Dialog.Description id="ingest-dialog-description">
                  Each file becomes a Knowledge document and is added to
                  memory.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <IconButton aria-label="Close ingest">
                  <X size={17} />
                </IconButton>
              </Dialog.Close>
            </header>
            <div className="modal-form">
              <label>
                Target collection
                <select
                  value={collectionId}
                  onChange={(event) => {
                    setCollectionId(event.target.value);
                    setResult(null);
                  }}
                >
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name} · {collection.sourceConfig.provider}
                    </option>
                  ))}
                </select>
              </label>
              <section className="ingest-method">
                <div>
                  <Upload size={18} />
                  <span>
                    <strong>Import local files</strong>
                    <small>
                      Markdown, text, JSON, JSONL, CSV, TSV, and YAML are
                      accepted.
                    </small>
                  </span>
                </div>
                <input
                  aria-label="Knowledge files"
                  type="file"
                  multiple
                  accept=".md,.markdown,.mdx,.txt,.json,.jsonl,.csv,.tsv,.yaml,.yml"
                  onChange={(event) =>
                    setFiles(Array.from(event.target.files ?? []))
                  }
                />
                <Button
                  tone="primary"
                  disabled={
                    !collectionId || !files.length || fileMutation.isPending
                  }
                  onClick={() => fileMutation.mutate()}
                >
                  {fileMutation.isPending ? (
                    <RefreshCw className="spin" size={14} />
                  ) : (
                    <Upload size={14} />
                  )}
                  Ingest {files.length || "files"}
                </Button>
              </section>
              <section
                className={`ingest-method ${sourceBacked ? "" : "is-disabled"}`}
              >
                <div>
                  <RefreshCw size={18} />
                  <span>
                    <strong>Sync repository source</strong>
                    <small>
                      {sourceBacked
                        ? `Read the configured ${selected?.sourceConfig.provider} collection and create, update, or skip documents.`
                        : "Select a Forgejo or GitHub-backed collection to run source sync."}
                    </small>
                  </span>
                </div>
                <Button
                  disabled={!sourceBacked}
                  onClick={() => {
                    repoMutation.reset();
                    setRepoConfirm(true);
                  }}
                >
                  Run source ingest
                </Button>
              </section>
              <MutationError error={fileMutation.error} />
              {result && (
                <div className="ingest-result">
                  <div>
                    <Tag tone={result.ok ? "success" : "warning"}>
                      {result.status}
                    </Tag>
                    <code>{result.runId}</code>
                  </div>
                  <dl>
                    <dt>Created</dt>
                    <dd>{result.summary.created}</dd>
                    <dt>Updated</dt>
                    <dd>{result.summary.updated}</dd>
                    <dt>Unchanged</dt>
                    <dd>{result.summary.unchanged}</dd>
                    <dt>Skipped</dt>
                    <dd>{result.summary.skipped}</dd>
                    <dt>Failed</dt>
                    <dd>{result.summary.failed}</dd>
                  </dl>
                </div>
              )}
              <footer className="modal-footer">
                <span />
                <Dialog.Close asChild>
                  <Button>Done</Button>
                </Dialog.Close>
              </footer>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Confirmation
        open={repoConfirm}
        onOpenChange={(next) => {
          if (!repoMutation.isPending) setRepoConfirm(next);
        }}
        title={`Sync ${selected?.name ?? "repository collection"}?`}
        description="Knowledge will read the connected repository and update matching documents. Unsupported files are skipped; accepted changes are added to memory."
        confirmLabel="Run source ingest"
        pending={repoMutation.isPending}
        error={repoMutation.error}
        onConfirm={() => repoMutation.mutate()}
      />
    </>
  );
}

/** Create a Knowledge-stored (native) collection. Repository sources are configured elsewhere. */
export function CollectionDialog({
  open,
  onOpenChange,
  companyId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  onCreated: (collection: KnowledgeCollection) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () =>
      createCollection(companyId, {
        name: name.trim(),
        description: description.trim() || null,
        sourceConfig: { provider: "native" },
      }),
    onSuccess: (collection) => {
      onOpenChange(false);
      onCreated(collection);
    },
  });
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    create.reset();
  }, [open]);
  const close = (next: boolean) => {
    if (!next && create.isPending) return;
    onOpenChange(next);
  };
  return (
    <SharedDialog
      open={open}
      onOpenChange={close}
      title="New collection"
      description="Collections group related documents, such as a team handbook or a project's notes."
      footer={
        <div className="dialog-actions">
          <Button type="button" disabled={create.isPending} onClick={() => close(false)}>
            Cancel
          </Button>
          <Button tone="primary" type="submit" form="collection-dialog-form" pending={create.isPending} disabled={!name.trim()}>
            {create.isPending ? "Creating…" : "Create collection"}
          </Button>
        </div>
      }
    >
      <form
        id="collection-dialog-form"
        style={{ display: "grid", gap: "var(--dg-space-4)" }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || create.isPending) return;
          create.mutate();
        }}
      >
        <TextField
          label="Name"
          required
          maxLength={120}
          autoFocus
          disabled={create.isPending}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextareaField
          label="Description (optional)"
          rows={3}
          maxLength={500}
          disabled={create.isPending}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        {create.error && <Feedback state="error" title="Collection was not created">{create.error.message}</Feedback>}
      </form>
    </SharedDialog>
  );
}

export function DeleteCollectionDialog({
  open,
  onOpenChange,
  collection,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collection: KnowledgeCollection | null;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => deleteCollection(collection!.id),
    onSuccess: () => {
      onOpenChange(false);
      onDeleted();
    },
  });
  useEffect(() => {
    if (open) remove.reset();
  }, [open]);
  const count = collection?.documentCount ?? 0;
  return (
    <SharedDialog
      open={open}
      onOpenChange={(next) => {
        if (!remove.isPending) onOpenChange(next);
      }}
      kind="alertdialog"
      title={`Delete ${collection?.name ?? "collection"}?`}
      description={
        count
          ? `This permanently deletes the collection and its ${count} ${count === 1 ? "document" : "documents"}, including their history and comments. This cannot be undone.`
          : "This permanently deletes the empty collection. This cannot be undone."
      }
      footer={
        <div className="dialog-actions">
          <Button autoFocus type="button" disabled={remove.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button tone="danger" type="button" pending={remove.isPending} disabled={!collection} onClick={() => remove.mutate()}>
            Delete collection
          </Button>
        </div>
      }
    >
      {remove.error && <Feedback state="error" title="Collection was not deleted">{remove.error.message}</Feedback>}
    </SharedDialog>
  );
}
