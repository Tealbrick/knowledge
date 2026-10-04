import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, BookOpen, Bot, ChevronRight, FileText, Plus, RefreshCw, Search, Sparkles, Upload } from "lucide-react";
import { Button, EmptyState, Tag } from "@doppelganger/ui";
import { ApiError, askResearch, getNotebooks, getResearchSummary, getResearchWorkspace } from "./api";
import type { ResearchAnswer } from "./types";
import { ResearchChatPanel } from "./ResearchChatPanel";
import { errorTitle } from "./errors";

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

export function ResearchView({ companyId }: { companyId: string }) {
  const [showLocal, setShowLocal] = useState(false);
  return <section className="section-scroll">
    <SectionHeader eyebrow="Research" title="Research">
      Collect sources and ask grounded questions in your Research workspace. Your Research sign-in decides which notebooks you can open.
    </SectionHeader>
    <ResearchChatPanel />
    <details className="research-local-fallback" onToggle={event => setShowLocal(event.currentTarget.open)}>
      <summary>Older local research records</summary>
      <p className="research-chat-help">These records were saved locally before the Research workspace was connected. They follow the workspace selected in Settings, not your Research sign-in.</p>
      {showLocal && <LocalResearchView key={companyId} companyId={companyId} />}
    </details>
  </section>;
}

function LocalResearchView({ companyId }: { companyId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState<ResearchAnswer | null>(null);
  const summary = useQuery({
    queryKey: ["research-summary", companyId],
    queryFn: () => getResearchSummary(companyId),
  });
  const notebooks = useQuery({
    queryKey: ["research-notebooks", companyId],
    queryFn: () => getNotebooks(companyId),
  });
  useEffect(() => {
    if (
      !selectedId ||
      !notebooks.data?.some((entry) => entry.id === selectedId)
    )
      setSelectedId(notebooks.data?.[0]?.id ?? null);
  }, [notebooks.data, selectedId]);
  const workspace = useQuery({
    queryKey: ["research-workspace", selectedId],
    queryFn: () => getResearchWorkspace(selectedId!),
    enabled: Boolean(selectedId),
    retry: false,
  });
  const ask = useMutation({
    mutationFn: () => askResearch(selectedId!, prompt.trim()),
    onSuccess: (result) => setAnswer(result),
  });
  const selected = notebooks.data?.find((entry) => entry.id === selectedId);

  return (
    <section aria-label="Local research records">
      {summary.error ? (
        <ErrorNotice error={summary.error} retry={() => summary.refetch()} />
      ) : (
        <div className="posture-row" aria-label="Local fallback capabilities">
          {Object.entries(summary.data?.posture ?? {}).map(([id, posture]) => (
            <div key={id}>
              <span
                className={`status-light ${posture.degraded ? "is-warning" : ""}`}
              />
              <div>
                <strong>Local {id}</strong>
                <small>
                  {posture.mode} · {posture.reason}
                </small>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="research-layout">
        <aside className="notebook-list">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Notebooks</p>
              <h2>{notebooks.data?.length ?? 0} {notebooks.data?.length === 1 ? "workspace" : "workspaces"}</h2>
            </div>
          </div>
          {notebooks.isLoading ? (
            <Loading label="Loading notebooks…" />
          ) : notebooks.data?.length ? (
            notebooks.data.map((notebook) => (
              <button
                key={notebook.id}
                aria-current={notebook.id === selectedId}
                onClick={() => {
                  setSelectedId(notebook.id);
                  setAnswer(null);
                }}
              >
                <Sparkles size={15} />
                <span>
                  <strong>{notebook.title}</strong>
                  <small>
                    {notebook.summary ||
                      notebook.focusPrompt ||
                      "No focus recorded"}
                  </small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))
          ) : (
            <div className="index-empty">
              <BookOpen size={22} />
              <strong>No research notebooks</strong>
              <span>
                Create one to collect sources, ask grounded questions, and
                publish outputs.
              </span>
            </div>
          )}
        </aside>
        <main className="research-workspace">
          {workspace.isLoading ? (
            <Loading label="Opening research workspace…" />
          ) : selected && workspace.data ? (
            <>
              <header>
                <p className="eyebrow">Research notebook</p>
                <h2>{selected.title}</h2>
                <p>
                  {selected.summary ||
                    selected.focusPrompt ||
                    "No research focus has been recorded."}
                </p>
                <div className="tag-row">
                  <Tag>{selected.status}</Tag>
                  <Tag>Local records</Tag>
                </div>
              </header>
              <div className="research-counts">
                <div>
                  <strong>{workspace.data.sources.length}</strong>
                  <span>Local sources</span>
                </div>
                <div>
                  <strong>{workspace.data.entries.length}</strong>
                  <span>Entries</span>
                </div>
                <div>
                  <strong>{workspace.data.outputs.length}</strong>
                  <span>Outputs</span>
                </div>
                <div>
                  <strong>{workspace.data.linkedDocuments.length}</strong>
                  <span>Documents</span>
                </div>
              </div>
              <details className="research-local-fallback">
                <summary>Local evidence fallback · no model</summary>
              <section className="ask-panel">
                <div>
                  <Bot size={18} />
                  <span>
                    <strong>Search recorded notebook context</strong>
                    <small>
                      Responses are ranked from the recorded notebook context.
                    </small>
                  </span>
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (prompt.trim()) ask.mutate();
                  }}
                >
                  <textarea
                    aria-label="Research question"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="What does the recorded evidence say?"
                  />
                  <Button
                    tone="primary"
                    disabled={!prompt.trim() || ask.isPending}
                  >
                    Ask
                  </Button>
                </form>
                {ask.error && <ErrorNotice error={ask.error} />}
                {answer && (
                  <article className="research-answer">
                    <p>{answer.answer || answer.reply}</p>
                    <div>
                      {answer.citations.map((citation, index) => (
                        <span key={`${citation.title}-${index}`}>
                          <strong>{citation.title}</strong>
                          {citation.excerpt}
                        </span>
                      ))}
                    </div>
                  </article>
                )}
              </section>
              </details>
              <div className="research-columns">
                <section>
                  <div className="subheading">
                    <h3>Local sources</h3>
                    <Button size="small" disabled title="Add new sources in the Research workspace above.">
                      <Upload size={13} />
                      Import
                    </Button>
                  </div>
                  {workspace.data.sources.length ? (
                    <div className="simple-list">
                      {workspace.data.sources.map((source) => (
                        <article key={source.id}>
                          <FileText size={15} />
                          <div>
                            <strong>{source.title}</strong>
                            <span>
                              {source.sourceType} · {source.status}
                            </span>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted-row">No local sources. Add new sources in the Research workspace above.</p>
                  )}
                </section>
                <section>
                  <div className="subheading">
                    <h3>Outputs</h3>
                    <Button size="small" disabled title="Output drafting is not yet available in this view.">
                      <Plus size={13} />
                      Draft
                    </Button>
                  </div>
                  {workspace.data.outputs.length ? (
                    <div className="simple-list">
                      {workspace.data.outputs.map((output) => (
                        <article key={output.id}>
                          <Sparkles size={15} />
                          <div>
                            <strong>{output.title}</strong>
                            <span>
                              {output.outputKind} · {output.promotionState}
                            </span>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted-row">No synthesis outputs yet.</p>
                  )}
                </section>
              </div>
            </>
          ) : (
            <EmptyState title="Research starts empty">
              Create a notebook to establish a scoped research workspace.
            </EmptyState>
          )}
        </main>
      </div>
    </section>
  );
}
