import { useEffect, useRef, useState } from "react";
import { Button, Feedback, Tag, TextareaField, TextField } from "@doppelganger/ui";
import { Bot, LockKeyhole } from "lucide-react";
import { loadChatResume, type Pending, type Resume } from "./research-chat-resume";
import {
  ResearchRequestError, researchBrowserStatus, researchBrowserLogin, researchBrowserLogout,
  researchChatCreate, researchChatSend, researchChatReceipt, researchChatHistory,
  type BrowserResearchSession, type ChatMessage, type ChatReceipt,
} from "./research-chat-api";
import { ResearchSourcesPanel } from "./ResearchSourcesPanel";
import { ResearchNotebookPicker } from "./ResearchNotebookPicker";
import { ResearchNotesPanel } from "./ResearchNotesPanel";

function errorText(error: unknown): string {
  if (!(error instanceof ResearchRequestError)) return "The request could not be verified. Check the connection before continuing.";
  if (error.status === 401) return "Your Research session has ended. Sign in again to continue.";
  if (error.status === 403) return "This session is not allowed to use this notebook or operation.";
  if (error.status === 404) return "No accessible record was found. An absent receipt does not prove the request never ran.";
  if (error.status === 429) return "Too many sign-in attempts. Wait before trying again.";
  if (error.code === "chat_session_busy") return "This chat has an unresolved turn. Check its original receipt before sending anything else.";
  return "The result could not be confirmed. If a request was submitted, its original key has been retained.";
}

export function ResearchChatPanel() {
  const [session, setSession] = useState<BrowserResearchSession | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const authBusy = useRef(false);
  const authVersion = useRef(0);
  const refresh = async () => {
    const version = ++authVersion.current;
    try { const next = await researchBrowserStatus(); if (active.current && version === authVersion.current) { setSession(next); setError(null); } }
    catch (failure) { if (active.current && version === authVersion.current) { setSession(null); setError(errorText(failure)); } }
  };
  useEffect(() => {
    active.current = true; void refresh();
    const focus = () => { if (!authBusy.current) void refresh(); };
    window.addEventListener("focus", focus);
    return () => { active.current = false; ++authVersion.current; window.removeEventListener("focus", focus); };
  }, []);
  useEffect(() => {
    if (!session?.authenticated || !session.expiresAt) return;
    const timer = window.setTimeout(() => { setSession(null); void refresh(); }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [session?.expiresAt, session?.authenticated]);
  const login = async () => {
    if (authBusy.current) return;
    authBusy.current = true; setBusy(true); setError(null);
    const version = ++authVersion.current;
    const supplied = secret; setSecret("");
    try { const next = await researchBrowserLogin(supplied); if (active.current && version === authVersion.current) setSession(next); }
    catch (failure) { if (active.current) setError(errorText(failure)); }
    finally { authBusy.current = false; if (active.current) setBusy(false); }
  };
  const logout = async () => {
    if (authBusy.current || !session?.csrfToken) return;
    authBusy.current = true; setBusy(true); setError(null);
    ++authVersion.current;
    const csrf = session.csrfToken; setSession(null);
    try { await researchBrowserLogout(csrf); await refresh(); }
    catch { if (active.current) setError("Sign-out was not confirmed. Close this tab and retry the session check; do not assume the server cookie was revoked."); }
    finally { authBusy.current = false; if (active.current) setBusy(false); }
  };
  const authenticated = session?.authenticated && session.principal && session.csrfToken;
  return <section className="research-chat-panel" aria-label="Research chat">
    <header className="research-chat-heading"><div><Bot size={20} /><span><h3>Research workspace</h3><p>Read the evidence, then research from its full source context.</p></span></div>
      <Tag>{authenticated ? "Signed in" : session?.enabled === false ? "Not configured" : "Protected"}</Tag>
    </header>
    {error && <Feedback state="error" title="Research session" action={<Button size="small" onClick={() => void refresh()} disabled={busy}>Check session</Button>}>{error}</Feedback>}
    {!session && !error && <p role="status">Checking Research session…</p>}
    {session?.enabled === false && <p className="research-chat-help">Research sign-in is not enabled for this installation yet. The local records below do not use a model.</p>}
    {session?.enabled && !authenticated && <form className="research-login" onSubmit={event => { event.preventDefault(); void login(); }}>
      <TextField label="Research sign-in code" type="password" autoComplete="off" value={secret} maxLength={1024}
        onChange={event => setSecret(event.target.value)} description="Use the Research sign-in code from your Knowledge administrator — not a model or service API key." />
      <Button tone="primary" disabled={busy || !secret.trim()}><LockKeyhole size={14} />{busy ? "Signing in…" : "Sign in to Research"}</Button>
    </form>}
    {authenticated && session.principal && <>
      <div className="research-chat-session"><small>Authorized workspace: {session.principal.companyId}</small><Button size="small" onClick={() => void logout()} disabled={busy}>Sign out of Research</Button></div>
      <ResearchNotebookPicker key={JSON.stringify([session.principal.principalId, session.principal.companyId, session.principal.capabilities])}
        canRead={session.principal.capabilities.includes("research:read")}
        expired={() => { setSession(null); void refresh(); }}
        renderWorkspace={notebookId => <AuthenticatedChat key={JSON.stringify([session.principal!.principalId, session.principal!.companyId, notebookId])}
          notebookId={notebookId} principalId={session.principal!.principalId} companyId={session.principal!.companyId}
          csrf={session.csrfToken!} canRead={session.principal!.capabilities.includes("research:read")}
          canWrite={session.principal!.capabilities.includes("research:read") && session.principal!.capabilities.includes("research:write")}
          expired={() => { setSession(null); void refresh(); }} />} />
    </>}
  </section>;
}

function AuthenticatedChat({ notebookId, principalId, companyId, csrf, canRead, canWrite, expired }: {
  notebookId: string; principalId: string; companyId: string; csrf: string; canRead: boolean; canWrite: boolean; expired: () => void;
}) {
  const storageKey = `knowledge.research.chat.v1:${JSON.stringify([principalId, companyId, notebookId])}`;
  const [resume, setResume] = useState<Resume>({ sessionId: null, pending: null });
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ChatReceipt | null>(null);
  const running = useRef(false);
  const historyVersion = useRef(0);
  const mounted = useRef(true);
  const fail = (failure: unknown) => { if (!mounted.current) return; setError(errorText(failure)); if (failure instanceof ResearchRequestError && failure.status === 401) expired(); };
  const persist = (next: Resume) => {
    // Save BEFORE dispatch. If browser storage is blocked, no write is sent.
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { if (mounted.current) setStorageError(true); throw new Error("resume_storage_unavailable"); }
    if (mounted.current) setResume(next);
  };
  const history = async (sessionId: string) => {
    const version = ++historyVersion.current;
    const result = await researchChatHistory(notebookId, sessionId);
    if (mounted.current && historyVersion.current === version) setMessages(result.messages);
  };
  const settle = async (result: ChatReceipt, old: Resume) => {
    if (mounted.current) setReceipt(result);
    if (result.state === "succeeded") {
      const sessionId = result.sessionId!;
      persist({ sessionId, pending: null });
      if (mounted.current) { setPrompt(""); setError(null); }
      await history(sessionId);
    } else if (result.state === "rejected") {
      persist({ ...old, pending: null });
      if (mounted.current) setError("The server recorded this request as rejected. Nothing will be resent automatically.");
    }
  };
  useEffect(() => {
    mounted.current = true;
    try {
      const restored = loadChatResume(sessionStorage, storageKey); setResume(restored); setReady(true);
      if (restored.sessionId) void history(restored.sessionId).catch(fail);
    } catch { setStorageError(true); setReady(true); }
    return () => { mounted.current = false; };
  }, [storageKey]);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try { await action(); } catch (failure) { fail(failure); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const write = () => run(async () => {
    if (!ready || storageError || resume.pending || !canWrite) return;
    if (resume.sessionId && !prompt.trim()) return;
    if (new TextEncoder().encode(prompt.trim()).byteLength > 32768) return;
    const key = crypto.randomUUID();
    const pending: Pending = resume.sessionId ? { key, operation: "message", sessionId: resume.sessionId } : { key, operation: "session" };
    const next = { ...resume, pending }; persist(next); setReceipt(null);
    const result = resume.sessionId
      ? await researchChatSend(notebookId, resume.sessionId, prompt.trim(), csrf, key)
      : await researchChatCreate(notebookId, csrf, key);
    await settle(result, next);
  });
  const check = () => run(async () => {
    if (!resume.pending) return;
    const p = resume.pending;
    await settle(await researchChatReceipt(notebookId, p.key, p.operation, p.sessionId), resume);
  });
  const tooLong = new TextEncoder().encode(prompt.trim()).byteLength > 32768;
  return <div className="research-chat-body">
    <ResearchSourcesPanel notebookId={notebookId} principalId={principalId} companyId={companyId} canRead={canRead} canWrite={canWrite} csrf={csrf} onAuthFailure={expired} />
    <ResearchNotesPanel notebookId={notebookId} principalId={principalId} companyId={companyId} canRead={canRead} onAuthFailure={expired} />
    <h3 className="research-chat-title">Chat with this notebook</h3>
    {storageError && <Feedback state="unavailable" title="Safe resume is unavailable">This tab cannot retain request references, or its saved reference is invalid. Chat writes are disabled. No service credentials or message text are stored here.</Feedback>}
    {!canWrite && <Feedback state="forbidden" title="Research chat is read-only">This sign-in can read Research but cannot start or send a chat. Ask your Knowledge administrator for write access.</Feedback>}
    {error && <Feedback state="error" title="Research request">{error}</Feedback>}
    {resume.pending && <Feedback state="pending" title="Request awaiting confirmation"
      action={<Button size="small" onClick={() => void check()} disabled={busy}>Check receipt</Button>}>
      <p>{receipt?.state === "uncertain" ? "The upstream outcome is uncertain. Operator reconciliation is required." : "A submitted request has not yet been confirmed. Do not submit it again with a new key."}</p>
      <code className="research-receipt-key">{resume.pending.key}</code>
      <p>Checking a receipt only reads its saved state; it never resends a question.</p>
    </Feedback>}
    {receipt?.state === "succeeded" && <p className="research-chat-help" role="status">Confirmed by durable receipt · {receipt.operation === "session" ? "Chat started" : "Answer saved"}</p>}
    {!!messages.length && <ol className="research-chat-history" aria-label="Research chat history">{messages.map((entry, i) =>
      <li key={`${entry.id}-${i}`} data-author={entry.type}><strong>{entry.type === "ai" ? "Assistant" : entry.type === "human" ? "You" : "Context"}</strong><p>{entry.content}</p></li>)}</ol>}
    {resume.sessionId && <div className="research-chat-actions"><Button size="small" disabled={busy} onClick={() => void run(() => history(resume.sessionId!))}>Refresh chat history</Button></div>}
    {!resume.sessionId ? <Button tone="primary" disabled={!ready || busy || !!resume.pending || storageError || !canWrite} onClick={() => void write()}>{busy ? "Starting chat…" : "Start Research chat"}</Button> :
      <form className="research-chat-compose" onSubmit={event => { event.preventDefault(); void write(); }}>
        <TextareaField label="Ask a research question" value={prompt} onChange={event => setPrompt(event.target.value)}
          disabled={busy || !!resume.pending} maxLength={32768} rows={3} placeholder="What can we conclude from these sources?"
          description="The server selects this notebook’s source context and model. Source text is untrusted evidence, not instructions."
          error={tooLong ? "Keep the question within 32 KiB." : undefined} />
        <Button tone="primary" disabled={!ready || busy || !!resume.pending || !prompt.trim() || tooLong || storageError || !canWrite}>{busy ? "Working…" : "Send question"}</Button>
      </form>}
    <p className="research-chat-help">Answers are model-generated; check them against your sources. This sign-in protects Research only, not the rest of Knowledge.</p>
  </div>;
}
