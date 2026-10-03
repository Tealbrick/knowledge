import { useEffect, useRef, useState } from "react";
import { Button, Feedback, Tag, TextareaField, TextField } from "@doppelganger/ui";
import { CheckCircle2, LockKeyhole, RefreshCw } from "lucide-react";
import {
  createResearchSource,
  getResearchSourceWriteReceipt,
  RESEARCH_SOURCE_CONTENT_MAX_BYTES,
  RESEARCH_SOURCE_TITLE_MAX_BYTES,
  type ResearchSourceWriteReceipt,
} from "./research-source-write-api";
import { ResearchRequestError } from "./research-chat-api";
import { clearSourceWriteResume, loadSourceWriteResume, saveSourceWriteResume, type SourceWriteResume } from "./source-write-resume";

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const storagePrefix = "knowledge.research.source-write.v1:";

function writeError(error: unknown): string {
  if (!(error instanceof ResearchRequestError)) return "The source write could not be verified. Its original key is retained.";
  if (error.status === 401) return "Your Research session ended. Sign in again, then check the original receipt; do not submit a new key.";
  if (error.status === 403) return "This session is not allowed to create sources. The original key is retained.";
  if (error.status === 404) return "No receipt was found for this key. It remains retained and was not resubmitted.";
  if (error.status === 409) return "The server has not confirmed this source write. Check the original receipt; do not submit a new key.";
  return "The source write could not be confirmed. Check the original receipt; do not submit it again with a new key.";
}

function receiptMessage(receipt: ResearchSourceWriteReceipt): string {
  if (receipt.state === "pending" || receipt.state === "uncertain") return "The server has not confirmed this source write. Check its receipt; no retry is sent.";
  if (receipt.state === "rejected") return "The server recorded this source write as rejected. Nothing was resent.";
  return receipt.sourceId ? `Source created: ${receipt.sourceId}` : "Source created and confirmed.";
}

export function ResearchSourceCreatePanel({
  notebookId,
  principalId,
  companyId,
  csrf,
  canWrite,
  readReady,
  onAuthFailure,
  onSourceCreated,
}: {
  readonly notebookId: string;
  readonly principalId: string;
  readonly companyId: string;
  readonly csrf: string;
  readonly canWrite: boolean;
  readonly readReady: boolean;
  readonly onAuthFailure: () => void;
  readonly onSourceCreated: () => void;
}) {
  const storageKey = `${storagePrefix}${JSON.stringify([principalId, companyId, notebookId])}`;
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [resume, setResume] = useState<SourceWriteResume>({ pendingKey: null });
  const [receipt, setReceipt] = useState<ResearchSourceWriteReceipt | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const settledKey = useRef<string | null>(null);
  const authFailureRef = useRef(onAuthFailure);
  authFailureRef.current = onAuthFailure;

  useEffect(() => {
    mounted.current = true;
    try {
      setResume(loadSourceWriteResume(window.sessionStorage, storageKey));
      setStorageReady(true);
    } catch {
      setStorageError(true);
      setStorageReady(true);
    }
    return () => { mounted.current = false; };
  }, [storageKey]);

  const clearPending = (key: string): boolean => {
    try {
      clearSourceWriteResume(window.sessionStorage, storageKey);
      if (mounted.current) setResume({ pendingKey: null });
      return true;
    } catch {
      if (mounted.current) {
        setStorageError(true);
        setError("The confirmed outcome could not clear its saved key. Keep this session open and do not submit a new source.");
      }
      return false;
    }
  };

  const settle = (result: ResearchSourceWriteReceipt, key: string) => {
    if (!mounted.current) return;
    setReceipt(result);
    if (result.state !== "succeeded" && result.state !== "rejected") {
      setError(receiptMessage(result));
      return;
    }
    if (!clearPending(key)) return;
    if (result.state === "succeeded" && settledKey.current !== key) {
      settledKey.current = key;
      setTitle("");
      setContent("");
      setError(null);
      onSourceCreated();
    } else if (result.state === "rejected") {
      settledKey.current = key;
      setError(receiptMessage(result));
    }
  };

  const run = async (action: () => Promise<void>) => {
    if (running.current || !mounted.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try { await action(); } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ResearchRequestError && (failure.status === 401 || failure.status === 403)) authFailureRef.current();
      setError(writeError(failure));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const write = () => run(async () => {
    if (!canWrite || !readReady || !storageReady || storageError || resume.pendingKey) return;
    if (!title.trim() || !content.trim() || byteLength(title) > RESEARCH_SOURCE_TITLE_MAX_BYTES || byteLength(content) > RESEARCH_SOURCE_CONTENT_MAX_BYTES) {
      setError("Enter a title and text within the stated UTF-8 limits.");
      return;
    }
    const key = crypto.randomUUID();
    try {
      saveSourceWriteResume(window.sessionStorage, storageKey, key);
    } catch {
      setStorageError(true);
      setError("This tab cannot retain the original request key, so no source write was sent.");
      return;
    }
    setResume({ pendingKey: key });
    try {
      const result = await createResearchSource(notebookId, title, content, csrf, key);
      settle(result.receipt, key);
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ResearchRequestError && (failure.status === 401 || failure.status === 403)) authFailureRef.current();
      if (mounted.current) setError(writeError(failure));
    }
  });

  const check = () => run(async () => {
    const key = resume.pendingKey;
    if (!key) return;
    try {
      const next = await getResearchSourceWriteReceipt(notebookId, key);
      settle(next, key);
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ResearchRequestError && (failure.status === 401 || failure.status === 403)) authFailureRef.current();
      if (mounted.current) setError(writeError(failure));
    }
  });

  const titleTooLong = byteLength(title) > RESEARCH_SOURCE_TITLE_MAX_BYTES;
  const contentTooLong = byteLength(content) > RESEARCH_SOURCE_CONTENT_MAX_BYTES;

  if (!canWrite) return <p className="muted-row">Creating text sources requires Research write capability.</p>;
  if (!storageReady) return <p className="loading-state" role="status"><RefreshCw className="spin" size={16} />Checking safe source-write state…</p>;
  if (storageError && !resume.pendingKey) return <Feedback state="unavailable" title="Source writes are disabled">This tab cannot retain a scoped request key. No source write will be sent.</Feedback>;

  return <section className="research-source-create" aria-label="Create Open Notebook text source">
    <div className="subheading"><div><p className="eyebrow">Text source</p><h4>Add evidence</h4></div><Tag>Read + write</Tag></div>
    {storageError && <Feedback state="unavailable" title="Source writes are disabled">This tab cannot clear its saved request key. Keep checking the original receipt; no new source write is enabled.</Feedback>}
    {resume.pendingKey && <Feedback state="pending" title="Request awaiting confirmation"
      action={<Button size="small" onClick={() => void check()} disabled={busy}>Check source receipt</Button>}>
      <p>{error ?? (receipt ? receiptMessage(receipt) : "The original key is retained until a definitive receipt is read.")}</p>
      <code className="research-source-pending">{resume.pendingKey}</code>
      <p>Checking a receipt only reads its saved state; it never resends the source.</p>
    </Feedback>}
    {!resume.pendingKey && !storageError && error && <Feedback state="error" title="Source write">{error}</Feedback>}
    {!resume.pendingKey && !storageError && <form onSubmit={(event) => { event.preventDefault(); void write(); }}>
      {!readReady && <p className="research-chat-help" role="status">Source submission is paused until this notebook’s mapped source inventory is available. Refresh sources or check the notebook configuration.</p>}
      <TextField label="Source title" value={title} maxLength={RESEARCH_SOURCE_TITLE_MAX_BYTES} onChange={(event) => setTitle(event.target.value)} description="Text-only source; no URL, file, embedding, or transformation options." error={titleTooLong ? "Title exceeds the UTF-8 byte limit." : undefined} />
      <TextareaField label="Source text" value={content} maxLength={RESEARCH_SOURCE_CONTENT_MAX_BYTES} rows={8} onChange={(event) => setContent(event.target.value)} description={`UTF-8 limits: title ${RESEARCH_SOURCE_TITLE_MAX_BYTES} bytes, text ${RESEARCH_SOURCE_CONTENT_MAX_BYTES} bytes.`} error={contentTooLong ? "Text exceeds the UTF-8 byte limit." : undefined} />
      <Button tone="primary" type="submit" disabled={!readReady || busy || !title.trim() || !content.trim() || titleTooLong || contentTooLong} pending={busy}><LockKeyhole size={14} />{busy ? "Creating source…" : "Create text source"}</Button>
    </form>}
    {receipt?.state === "succeeded" && !resume.pendingKey && <p className="research-chat-help" role="status"><CheckCircle2 size={14} /> Confirmed by durable receipt.</p>}
  </section>;
}
