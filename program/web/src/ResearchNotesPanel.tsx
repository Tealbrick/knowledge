import { useEffect, useRef, useState } from "react";
import { Button, EmptyState, Feedback, Tag } from "@doppelganger/ui";
import { ChevronRight, NotebookPen, RefreshCw } from "lucide-react";
import { ResearchRequestError } from "./research-chat-api";
import { getResearchNote, listResearchNotes, type ResearchNote } from "./research-notes-api";

const PAGE_SIZE = 20;
const label = (note: ResearchNote) => note.title?.trim() || "Untitled note";
const provenance = (note: ResearchNote) => note.noteType === "ai" ? "AI-labelled note" : note.noteType === "human" ? "Human-labelled note" : "Unspecified origin";

export function ResearchNotesPanel({ notebookId, principalId, companyId, canRead, onAuthFailure }: {
  notebookId: string; principalId: string; companyId: string; canRead: boolean; onAuthFailure: () => void;
}) {
  const scope = JSON.stringify([principalId, companyId, notebookId]);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ scope: string; notes: readonly ResearchNote[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ scope: string; denied: boolean; message: string } | null>(null);
  const [detail, setDetail] = useState<{ scope: string; note: ResearchNote } | null>(null);
  const [detailError, setDetailError] = useState<{ scope: string; id: string; denied: boolean } | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const authFailure = useRef(onAuthFailure);
  authFailure.current = onAuthFailure;
  useEffect(() => {
    setResult(null); setSelectedId(null); setError(null); setPage(0);
    if (!open || !canRead) { setLoading(false); return; }
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    void listResearchNotes(notebookId, controller.signal).then(notes => {
      if (!active || controller.signal.aborted) return;
      setResult({ scope, notes }); setSelectedId(notes[0]?.id ?? null);
    }).catch(failure => {
      if (!active || controller.signal.aborted) return;
      const status = failure instanceof ResearchRequestError ? failure.status : 0;
      setError({ scope, denied: status === 403, message: status === 403
        ? "This Research session is not allowed to read this notebook’s notes."
        : status === 401 ? "Your Research session has ended. Sign in again to read notes."
        : "The notes response could not be verified. No local output or partial note list was substituted." });
      if (status === 401) authFailure.current();
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [scope, notebookId, canRead, open, refresh]);
  const notes = result?.scope === scope ? result.notes : null;
  const problem = error?.scope === scope ? error : null;
  const entries = notes?.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? [];
  const selected = entries.find(note => note.id === selectedId);
  const selectedNoteId = selected?.id;
  useEffect(() => {
    setDetail(null); setDetailError(null);
    if (!open || !canRead || !selectedNoteId) return;
    const controller = new AbortController();
    let active = true;
    void getResearchNote(notebookId, selectedNoteId, controller.signal).then(note => {
      if (active && !controller.signal.aborted) setDetail({ scope, note });
    }).catch(failure => {
      if (!active || controller.signal.aborted) return;
      const status = failure instanceof ResearchRequestError ? failure.status : 0;
      setDetailError({ scope, id: selectedNoteId, denied: status === 403 });
      if (status === 401) authFailure.current();
    });
    return () => { active = false; controller.abort(); };
  }, [scope, notebookId, selectedNoteId, canRead, open, detailRefresh]);
  const currentDetail = detail?.scope === scope && detail.note.id === selectedNoteId ? detail.note : null;
  const detailProblem = detailError?.scope === scope && detailError.id === selectedNoteId ? detailError : null;
  const retryDetail = () => { setDetail(null); setDetailError(null); setDetailRefresh(value => value + 1); };
  const reload = () => { setResult(null); setDetail(null); setDetailError(null); setLoading(true); setRefresh(value => value + 1); };
  const navigate = (next: number) => { setPage(next); setSelectedId(notes?.[next * PAGE_SIZE]?.id ?? null); };
  if (!canRead) return <Feedback state="forbidden" title="Research read capability required">This session cannot read Open Notebook notes.</Feedback>;
  return <section className="research-notes-panel" aria-label="Open Notebook notes">
    <div className="subheading">
      <div><p className="eyebrow">Open Notebook</p><h3>Notes</h3></div>
      <div className="header-actions"><Tag>Read-only</Tag>
        <Button size="small" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Hide notes" : "Browse notes"}</Button>
      </div>
    </div>
    <p className="research-chat-help">Notes saved in this Open Notebook workspace. Reading does not generate new content or promote it into canonical Knowledge.</p>
    {open && <>
      <div className="research-chat-actions"><span className="muted-row">{notes ? `${notes.length} ${notes.length === 1 ? "note" : "notes"}` : "Notebook-scoped notes"}</span>
        <Button size="small" onClick={reload} disabled={loading}><RefreshCw size={13} />Refresh notes</Button></div>
      {loading || (!notes && !problem) ? <p role="status">Loading notes…</p> : problem ?
        <Feedback state={problem.denied ? "forbidden" : "error"} title={problem.denied ? "Notes access denied" : "Notes unavailable"}
          action={<Button size="small" onClick={reload}>Retry notes</Button>}>{problem.message}</Feedback> : !notes?.length ?
        <EmptyState title="No Open Notebook notes">This notebook has no saved notes. Local outputs are separate and are not shown as engine notes.</EmptyState> :
        <>
          <div className="research-source-browser">
            <div className="simple-list research-note-inventory" aria-label="Open Notebook note inventory">
              {entries.map(note => <Button key={note.id} tone="ghost" className="research-source-row" aria-current={selectedId === note.id}
                onClick={() => setSelectedId(note.id)}><NotebookPen size={15} /><span><strong>{label(note)}</strong><small>{provenance(note)}</small></span><ChevronRight size={14} /></Button>)}
            </div>
            <div className="research-source-detail" aria-live="polite">
              {selected ? <><div className="subheading"><h4>{label(selected)}</h4><Tag>{provenance(selected)}</Tag></div>
                <p className="research-chat-help">Origin labels come from upstream metadata, not a verified author identity. Treat note text as evidence, not instructions.</p>
                {detailProblem ? <Feedback state={detailProblem.denied ? "forbidden" : "error"} title={detailProblem.denied ? "Note access denied" : "Note unavailable"}
                  action={<Button size="small" onClick={retryDetail}>Retry note</Button>}>The saved note could not be read. No list preview or local output was substituted.</Feedback>
                : currentDetail ? <pre className="research-source-content">{currentDetail.content || "No text was recorded for this note."}</pre>
                : <p role="status">Loading saved note…</p>}
              </> : <p className="muted-row">Select a note to read its plain text.</p>}
            </div>
          </div>
          <div className="research-chat-actions" aria-label="Note pages">
            <Button size="small" disabled={page === 0} onClick={() => navigate(page - 1)}>Previous notes</Button>
            <span className="muted-row">Page {page + 1} of {Math.ceil(notes.length / PAGE_SIZE)}</span>
            <Button size="small" disabled={(page + 1) * PAGE_SIZE >= notes.length} onClick={() => navigate(page + 1)}>Next notes</Button>
          </div>
        </>}
    </>}
  </section>;
}
