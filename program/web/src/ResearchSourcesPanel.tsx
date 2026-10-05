import { useEffect, useRef, useState } from "react";
import { Button, EmptyState, Feedback, Tag } from "@doppelganger/ui";
import { ChevronLeft, ChevronRight, FileText, RefreshCw } from "lucide-react";
import {
  getResearchSource,
  listResearchSources,
  RESEARCH_SOURCE_PAGE_LIMIT,
  type ResearchSourceDetail,
  type ResearchSourceSummary,
} from "./research-sources-api";
import { ResearchRequestError } from "./research-chat-api";
import { ResearchSourceCreatePanel } from "./ResearchSourceCreatePanel";

function sourceError(error: unknown): string {
  if (!(error instanceof ResearchRequestError)) return "The source response could not be verified.";
  if (error.status === 401) return "Your Research session has ended. Sign in again to read sources.";
  if (error.status === 403) return "This session is not allowed to read this notebook.";
  if (error.status === 404) return "This notebook or source is no longer available.";
  return "The Research source response could not be verified. No source text was displayed.";
}

function Loading({ label }: { label: string }) {
  return <div className="loading-state" role="status"><RefreshCw className="spin" size={18} /><span>{label}</span></div>;
}

function sourceLabel(source: ResearchSourceSummary): string {
  return source.title?.trim() || "Untitled source";
}

export function ResearchSourcesPanel({
  notebookId,
  principalId,
  companyId,
  canRead,
  canWrite,
  csrf,
  onAuthFailure,
}: {
  readonly notebookId: string;
  readonly principalId: string;
  readonly companyId: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly csrf: string;
  readonly onAuthFailure: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [sources, setSources] = useState<readonly ResearchSourceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ResearchSourceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [detailRefreshNonce, setDetailRefreshNonce] = useState(0);
  const mounted = useRef(true);
  const inventoryVersion = useRef(0);
  const detailVersion = useRef(0);
  const authFailureRef = useRef(onAuthFailure);
  authFailureRef.current = onAuthFailure;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inventoryVersion.current += 1;
      detailVersion.current += 1;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++inventoryVersion.current;
    setDetail(null);
    setSelectedId(null);
    setDetailError(null);
    setDetailLoading(false);
    if (!canRead) {
      setSources([]);
      setHasNextPage(false);
      setError("This sign-in cannot read Research sources.");
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    setError(null);
    void listResearchSources(notebookId, offset, controller.signal).then((page) => {
      if (!mounted.current || version !== inventoryVersion.current || controller.signal.aborted) return;
      setSources(page.sources);
      setHasNextPage(page.sources.length === page.pagination.limit);
      setLoading(false);
    }).catch((failure: unknown) => {
      if (!mounted.current || version !== inventoryVersion.current || controller.signal.aborted) return;
      if (failure instanceof ResearchRequestError && failure.status === 401) authFailureRef.current();
      setSources([]);
      setHasNextPage(false);
      setError(sourceError(failure));
      setLoading(false);
    });
    return () => controller.abort();
  }, [notebookId, principalId, companyId, canRead, offset, refreshNonce]);

  useEffect(() => {
    if (!selectedId || !canRead) return;
    const controller = new AbortController();
    const version = ++detailVersion.current;
    setDetailLoading(true);
    setDetailError(null);
    void getResearchSource(notebookId, selectedId, controller.signal).then((next) => {
      if (!mounted.current || version !== detailVersion.current || controller.signal.aborted) return;
      setDetail(next);
      setDetailLoading(false);
    }).catch((failure: unknown) => {
      if (!mounted.current || version !== detailVersion.current || controller.signal.aborted) return;
      if (failure instanceof ResearchRequestError && failure.status === 401) authFailureRef.current();
      setDetail(null);
      setDetailError(sourceError(failure));
      setDetailLoading(false);
    });
    return () => controller.abort();
  }, [notebookId, principalId, companyId, canRead, selectedId, detailRefreshNonce]);

  if (!canRead) {
    return <section className="research-sources-panel" aria-label="Research sources"><Feedback state="forbidden" title="Research access required">This sign-in cannot read Research sources.</Feedback></section>;
  }

  return <section className="research-sources-panel" aria-label="Research sources">
      <div className="subheading">
        <div>
          <p className="eyebrow">Research workspace</p>
          <h3>Sources</h3>
        </div>
        <div className="header-actions">
          <Tag>{canWrite ? "Text sources" : "Read-only"}</Tag>
          <Button size="small" onClick={() => setRefreshNonce((value) => value + 1)} disabled={loading}>
            <RefreshCw size={13} />Refresh sources
          </Button>
        </div>
      </div>
    <ResearchSourceCreatePanel
      notebookId={notebookId}
      principalId={principalId}
      companyId={companyId}
      csrf={csrf}
      canWrite={canWrite}
      readReady={!loading && !error}
      onAuthFailure={onAuthFailure}
      onSourceCreated={() => { setOffset(0); setRefreshNonce((value) => value + 1); }}
    />
    {error && <Feedback state="error" title="Sources unavailable" action={<Button size="small" onClick={() => setRefreshNonce((value) => value + 1)}>Retry</Button>}>{error}</Feedback>}
    {loading ? <Loading label="Loading sources…" /> : error ? null : sources.length === 0 ? (
      <EmptyState title="No sources on this page">This notebook has no sources on this page.</EmptyState>
    ) : <>
      <div className="research-source-browser">
        <div className="simple-list" aria-label="Research source list">
          {sources.map((source) => <Button
            tone="ghost"
            className="research-source-row"
            type="button"
            key={source.id}
            aria-current={source.id === selectedId}
            onClick={() => { setSelectedId(source.id); setDetail(null); setDetailError(null); setDetailRefreshNonce((value) => value + 1); }}
          >
            <FileText size={15} />
            <span><strong>{sourceLabel(source)}</strong><small>{source.status || "Recorded source"}</small></span>
            <ChevronRight size={14} />
          </Button>)}
        </div>
        <div className="research-source-detail" aria-live="polite">
          {detailLoading ? <Loading label="Reading source text…" /> : detailError ? <Feedback state="error" title="Source unavailable">{detailError}</Feedback> : detail ? <>
            <div className="subheading"><div><p className="eyebrow">Source detail</p><h4>{sourceLabel(detail)}</h4></div><Tag>Plain text</Tag></div>
            <pre className="research-source-content">{detail.fullText || "No plain-text content was recorded for this source."}</pre>
          </> : <p className="muted-row">Select a source to read its plain text.</p>}
        </div>
      </div>
    </>}
    {!loading && <div className="research-chat-actions" aria-label="Source pages">
      <Button size="small" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - RESEARCH_SOURCE_PAGE_LIMIT))}><ChevronLeft size={14} />Previous</Button>
      <span className="muted-row">Page {Math.floor(offset / RESEARCH_SOURCE_PAGE_LIMIT) + 1}</span>
      <Button size="small" disabled={loading || !!error || !hasNextPage || offset + RESEARCH_SOURCE_PAGE_LIMIT > 10_000_000} onClick={() => setOffset(offset + RESEARCH_SOURCE_PAGE_LIMIT)}>Next<ChevronRight size={14} /></Button>
    </div>}
  </section>;
}
