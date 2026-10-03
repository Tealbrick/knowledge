import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, EmptyState, Feedback } from "@doppelganger/ui";
import { BookOpen } from "lucide-react";
import { ResearchRequestError } from "./research-chat-api";
import { listResearchNotebooks, RESEARCH_NOTEBOOK_PAGE_LIMIT, RESEARCH_NOTEBOOK_MAX_MAPPINGS, type ResearchNotebookPage } from "./research-notebooks-api";

export function ResearchNotebookPicker({ canRead, expired, renderWorkspace }: {
  canRead: boolean; expired: () => void; renderWorkspace: (notebookId: string) => ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<ResearchNotebookPage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const authFailure = useRef(expired);
  authFailure.current = expired;
  useEffect(() => {
    if (!canRead) { setPage(null); setLoading(false); return; }
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError(null); setPage(null);
    void listResearchNotebooks(offset, controller.signal).then(result => {
      if (!active) return;
      setPage(result);
      setSelectedId(current => result.notebooks.some(item => item.id === current) ? current : result.notebooks[0]?.id ?? null);
    }).catch(failure => {
      if (!active) return;
      setError(failure instanceof ResearchRequestError && failure.status === 403
        ? "This session does not have access to Research notebook discovery."
        : "The authorized notebook list could not be verified. No local or public list will be substituted.");
      if (failure instanceof ResearchRequestError && failure.status === 401) authFailure.current();
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [canRead, offset, refresh]);
  if (!canRead) return <Feedback state="forbidden" title="Research read access required">This session cannot discover Research notebooks. Ask the deployment operator to review its grants.</Feedback>;
  const selected = !loading && !error ? page?.notebooks.find(item => item.id === selectedId) : undefined;
  const navigate = (next: number) => { setPage(null); setLoading(true); setOffset(next); };
  const reload = () => { setPage(null); setLoading(true); setRefresh(value => value + 1); };
  return <div className="research-engine-discovery">
    <div className="research-chat-session"><p className="research-chat-help">Configured Open Notebook mappings · not a live health check. Access comes from your Research session, not the app workspace selector.</p>
      <Button size="small" disabled={loading} onClick={reload}>Refresh notebooks</Button></div>
    <p className="research-chat-help">Switching or refreshing notebooks clears unsent drafts. References for submitted requests remain saved in this tab.</p>
    {loading && <p role="status">Loading authorized notebooks…</p>}
    {error && <Feedback state="error" title="Notebook discovery unavailable" action={<Button size="small" onClick={reload}>Retry notebook discovery</Button>}>{error}</Feedback>}
    {!loading && !error && !page?.notebooks.length && <EmptyState title={offset ? "No notebooks on this page" : "No mapped Research notebooks"}>
      {offset ? "Return to the previous page or refresh the list." : "Sign-in succeeded. The deployment operator must map a Knowledge notebook owned by your authorized workspace to Open Notebook. Local records are not substituted."}
    </EmptyState>}
    <div className="research-engine-notebooks" aria-label="Authorized Research notebooks">
      {!loading && !error && page?.notebooks.map(notebook => <Button key={notebook.id}
        tone={notebook.id === selectedId ? "primary" : undefined} aria-pressed={notebook.id === selectedId}
        onClick={() => setSelectedId(notebook.id)}><BookOpen size={15} />{notebook.name || notebook.id}</Button>)}
    </div>
    <div className="research-chat-actions" aria-label="Research notebook pages">
      <Button size="small" disabled={loading || offset === 0} onClick={() => navigate(Math.max(0, offset - RESEARCH_NOTEBOOK_PAGE_LIMIT))}>Previous notebooks</Button>
      <span>Page {Math.floor(offset / RESEARCH_NOTEBOOK_PAGE_LIMIT) + 1}</span>
      <Button size="small" disabled={loading || !!error || !page?.pagination.hasMore || offset + RESEARCH_NOTEBOOK_PAGE_LIMIT >= RESEARCH_NOTEBOOK_MAX_MAPPINGS}
        onClick={() => navigate(offset + RESEARCH_NOTEBOOK_PAGE_LIMIT)}>Next notebooks</Button>
    </div>
    {selected && <section aria-label="Selected Research notebook">
      <header className="research-engine-notebook-heading"><h2>{selected.name || selected.id}</h2><p>{selected.description || "No research focus has been recorded."}</p></header>
      {renderWorkspace(selected.id)}
    </section>}
  </div>;
}
