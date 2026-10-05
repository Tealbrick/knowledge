import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelSettings } from "./model-settings.js";
import type { OpenNotebookNotebookBinding } from "./open-notebook-routes.js";

/**
 * Knowledge -> Settings -> Models is the single source of truth for model
 * providers. This module mirrors the saved chat and embedding models into the
 * deployment's private Open Notebook (Research) through its v1.14.0 API:
 * one DB-stored credential per provider, one language and one embedding model
 * linked to it, and the Open Notebook default model slots.
 *
 * The provider key is sent only to Open Notebook (which stores it encrypted)
 * and is never written to research-settings.json, returned, or logged.
 */

export type ResearchSyncStatus =
  | "configured"
  | "not-installed"
  | "provider_unsupported"
  | "embedding_migration_required"
  | "encryption_not_configured"
  | "model_conflict"
  | "failed";

export interface ResearchSyncResult {
  readonly status: ResearchSyncStatus;
  readonly error?: string;
  /** Short owner-facing explanation (no secrets), e.g. for model_conflict. */
  readonly hint?: string;
}

export interface ResearchSettingsFile {
  readonly version: 1;
  /** Open Notebook credential id per Open Notebook provider. */
  readonly credentialIds: Readonly<Record<string, string>>;
  /** Credential used by the chat model (kept for operators reading the file). */
  readonly credentialId: string | null;
  readonly chatModelId: string | null;
  readonly embeddingModelId: string | null;
  readonly bindings: readonly OpenNotebookNotebookBinding[];
  /** A local notebook created for a binding whose upstream notebook is not yet confirmed. */
  readonly pendingNotebook: { readonly knowledgeNotebookId: string; readonly companyId: string } | null;
  readonly appliedFingerprint: string | null;
  readonly appliedAt: string | null;
  readonly lastResult: (ResearchSyncResult & { readonly at: string }) | null;
}

export interface ResearchNotebookStore {
  /** Create a local Knowledge research notebook owned by companyId; returns its id. */
  create(companyId: string): string;
  /** Current owner of a local notebook, or null when it no longer exists. */
  ownerOf(knowledgeNotebookId: string): string | null;
}

export interface ResearchSyncDeps {
  readonly baseUrl: string | null;
  readonly token: string | null;
  readonly dataDir: string;
  readonly fetchImpl?: typeof fetch;
  /** Per-request bound. */
  readonly timeoutMs?: number;
  /** Bound on one complete sync. */
  readonly totalTimeoutMs?: number;
  /** Deployment workspace (KNOWLEDGE_COMPANY_ID). Enables automatic notebook binding. */
  readonly companyId?: string | null;
  readonly envBindings?: readonly OpenNotebookNotebookBinding[];
  readonly notebooks?: ResearchNotebookStore | null;
  readonly now?: () => Date;
}

const FILE_NAME = "research-settings.json";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;

/** Knowledge provider -> Open Notebook SupportedProvider (api/models.py, v1.14.0). */
const PROVIDER_MAP: Readonly<Record<string, string>> = Object.freeze({
  openai: "openai",
  openrouter: "openrouter",
  ollama: "ollama",
  // llama-server speaks the OpenAI-compatible API.
  "llama-server": "openai_compatible",
});
/** Base URLs Open Notebook (Esperanto) uses when a credential has none. */
const PROVIDER_DEFAULT_BASE: Readonly<Record<string, string>> = Object.freeze({
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
});

const researchProviderNames = new Set(Object.values(PROVIDER_MAP));

export const EMPTY_RESEARCH_SETTINGS: ResearchSettingsFile = Object.freeze({
  version: 1,
  credentialIds: Object.freeze({}),
  credentialId: null,
  chatModelId: null,
  embeddingModelId: null,
  bindings: Object.freeze([]),
  pendingNotebook: null,
  appliedFingerprint: null,
  appliedAt: null,
  lastResult: null,
}) as ResearchSettingsFile;

export class ResearchSyncError extends Error {
  constructor(readonly code: string) { super(code); }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const safeId = (value: unknown): string | null => typeof value === "string" && ID_PATTERN.test(value) ? value : null;

export function researchProvider(knowledgeProvider: string): string | null {
  return Object.prototype.hasOwnProperty.call(PROVIDER_MAP, knowledgeProvider) ? PROVIDER_MAP[knowledgeProvider]! : null;
}

export function researchCredentialName(provider: string) {
  return `tealbrick-knowledge-${provider}`;
}

/** Normalised base URL to store on the credential, or null for the provider default. */
export function researchBaseUrl(provider: string, baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  if (provider === "ollama") return trimmed.replace(/\/v1$/u, ""); // Esperanto uses Ollama's native API.
  const withV1 = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  const fallback = PROVIDER_DEFAULT_BASE[provider];
  if (fallback && (withV1 === fallback || trimmed === fallback)) return null;
  return withV1;
}

/** Key-free fingerprint of what Research should be configured with. */
export function researchFingerprint(settings: ModelSettings): string {
  return sha256(JSON.stringify({
    chat: { provider: settings.chat.provider, baseUrl: settings.chat.baseUrl, model: settings.chat.model, key: sha256(settings.chat.apiKey) },
    embedding: { provider: settings.embedding.provider, baseUrl: settings.embedding.baseUrl, model: settings.embedding.model, dimensions: settings.embedding.dimensions, key: sha256(settings.embedding.apiKey) },
  }));
}

function validBinding(value: unknown): value is OpenNotebookNotebookBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && Boolean(safeId(record.knowledgeNotebookId) && safeId(record.companyId) && safeId(record.externalNotebookId));
}

export async function readResearchSettings(dataDir: string): Promise<ResearchSettingsFile> {
  let raw: string;
  try { raw = await fs.readFile(path.join(dataDir, FILE_NAME), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_RESEARCH_SETTINGS; throw error; }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; }
  catch { return EMPTY_RESEARCH_SETTINGS; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_RESEARCH_SETTINGS;
  const credentialIds: Record<string, string> = {};
  if (parsed.credentialIds && typeof parsed.credentialIds === "object") {
    for (const [provider, id] of Object.entries(parsed.credentialIds as Record<string, unknown>)) {
      if (researchProviderNames.has(provider) && safeId(id)) credentialIds[provider] = id as string;
    }
  }
  const pending = parsed.pendingNotebook as Record<string, unknown> | null | undefined;
  const lastResult = parsed.lastResult as Record<string, unknown> | null | undefined;
  return {
    version: 1,
    credentialIds,
    credentialId: safeId(parsed.credentialId),
    chatModelId: safeId(parsed.chatModelId),
    embeddingModelId: safeId(parsed.embeddingModelId),
    bindings: Array.isArray(parsed.bindings) ? parsed.bindings.filter(validBinding).map((binding) => ({
      knowledgeNotebookId: binding.knowledgeNotebookId, companyId: binding.companyId, externalNotebookId: binding.externalNotebookId,
    })) : [],
    pendingNotebook: pending && safeId(pending.knowledgeNotebookId) && safeId(pending.companyId)
      ? { knowledgeNotebookId: pending.knowledgeNotebookId as string, companyId: pending.companyId as string } : null,
    appliedFingerprint: typeof parsed.appliedFingerprint === "string" && /^[a-f0-9]{64}$/u.test(parsed.appliedFingerprint) ? parsed.appliedFingerprint : null,
    appliedAt: typeof parsed.appliedAt === "string" ? parsed.appliedAt : null,
    lastResult: lastResult && typeof lastResult.status === "string" && typeof lastResult.at === "string"
      ? { status: lastResult.status as ResearchSyncStatus, ...(typeof lastResult.error === "string" ? { error: lastResult.error } : {}), ...(typeof lastResult.hint === "string" ? { hint: lastResult.hint } : {}), at: lastResult.at } : null,
  };
}
export async function writeResearchSettings(dataDir: string, state: ResearchSettingsFile) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, FILE_NAME);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(temporary, file);
}

/**
 * Effective notebook bindings: configured env bindings plus bindings created
 * by the sync. Exact duplicates collapse; any other overlap is left in place
 * so the route mapping index fails closed on the conflicting union.
 */
export function effectiveResearchBindings(
  envBindings: readonly OpenNotebookNotebookBinding[],
  persisted: readonly OpenNotebookNotebookBinding[],
): readonly OpenNotebookNotebookBinding[] {
  if (!Array.isArray(envBindings)) return envBindings; // invalid env config stays invalid (fail closed)
  const seen = new Set<string>();
  const union: OpenNotebookNotebookBinding[] = [];
  for (const binding of [...envBindings, ...persisted]) {
    const key = binding && typeof binding === "object"
      ? JSON.stringify([binding.knowledgeNotebookId, binding.companyId, binding.externalNotebookId]) : String(binding);
    if (seen.has(key) && validBinding(binding)) continue;
    seen.add(key);
    union.push(binding);
  }
  return union;
}

/** Bounded Open Notebook JSON client. Never includes the token, body or upstream text in errors. */
class ResearchEngineClient {
  private readonly base: URL;
  constructor(baseUrl: string, private readonly token: string, private readonly fetchImpl: typeof fetch, private readonly timeoutMs: number, private readonly deadline: number) {
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new ResearchSyncError("invalid_research_config"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new ResearchSyncError("invalid_research_config");
    this.base = parsed;
  }

  async call(step: string, method: string, pathname: string, body?: unknown, okStatuses: readonly number[] = [200, 201]): Promise<unknown> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new ResearchSyncError(`research_timeout:${step}`);
    const url = new URL(pathname, this.base);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, remaining)),
        headers: { accept: "application/json", authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ResearchSyncError(error instanceof Error && error.name === "TimeoutError" ? `research_timeout:${step}` : `research_unavailable:${step}`);
    }
    if (!okStatuses.includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResearchSyncError(`research_http_${response.status}:${step}`);
    }
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new ResearchSyncError(`research_response_too_large:${step}`);
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ResearchSyncError) throw error;
      throw new ResearchSyncError(`research_unavailable:${step}`);
    } finally { await reader.cancel().catch(() => undefined); }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new ResearchSyncError(`research_malformed_response:${step}`); }
  }
}

interface EngineModel { id: string; name: string; provider: string; type: string; credential: string | null }
interface EngineDefaults { default_chat_model?: string | null; default_embedding_model?: string | null }

function asArray(value: unknown, step: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new ResearchSyncError(`research_malformed_response:${step}`);
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}
function idOf(value: unknown, step: string): string {
  const id = value && typeof value === "object" ? safeId((value as Record<string, unknown>).id) : null;
  if (!id) throw new ResearchSyncError(`research_malformed_response:${step}`);
  return id;
}
function parseModels(value: unknown, step: string): EngineModel[] {
  return asArray(value, step).flatMap((entry) => {
    const id = safeId(entry.id);
    if (!id || typeof entry.name !== "string" || typeof entry.provider !== "string") return [];
    return [{ id, name: entry.name, provider: entry.provider, type: typeof entry.type === "string" ? entry.type : "", credential: typeof entry.credential === "string" ? entry.credential : null }];
  });
}
const sameModel = (model: EngineModel, provider: string, name: string) =>
  model.provider.toLowerCase() === provider.toLowerCase() && model.name.toLowerCase() === name.toLowerCase();

interface ModelConflict { readonly conflict: string }

/** Owner-facing hint; names only the model the owner chose (customer copy avoids vendor names). */
export function modelConflictHint(modelName: string) {
  const name = modelName.length > 80 ? `${modelName.slice(0, 77)}...` : modelName;
  return `Research already has a ${name} model on another key; remove it there or pick a different model.`;
}

/** Env KNOWLEDGE_OPEN_NOTEBOOK_CHAT_MODEL_ID wins (back-compat override); else the synced model. */
export function resolveResearchChatModelId(envOverride: string | null | undefined, sync: Pick<ResearchModelSync, "chatModelId"> | null): string | null {
  const configured = envOverride?.trim();
  if (configured) return configured;
  return sync?.chatModelId() ?? null;
}

/**
 * Serialises syncs and keeps the latest persisted research settings in memory
 * so request-time readers (chat model id, notebook bindings) see changes
 * without a restart.
 */
export class ResearchModelSync {
  private state: ResearchSettingsFile = EMPTY_RESEARCH_SETTINGS;
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(private readonly deps: ResearchSyncDeps) {}

  get installed() { return Boolean(this.deps.baseUrl && this.deps.token); }

  async load() {
    try { this.state = await readResearchSettings(this.deps.dataDir); } catch { this.state = EMPTY_RESEARCH_SETTINGS; }
    this.loaded = true;
    return this.state;
  }

  current(): ResearchSettingsFile { return this.state; }

  chatModelId(): string | null { return this.state.chatModelId; }

  private bindingsCache: { source: readonly OpenNotebookNotebookBinding[]; value: readonly OpenNotebookNotebookBinding[] } | null = null;

  /** Env bindings plus persisted bindings; stable identity until the persisted set changes. */
  bindings(): readonly OpenNotebookNotebookBinding[] {
    if (this.bindingsCache?.source !== this.state.bindings) {
      this.bindingsCache = { source: this.state.bindings, value: effectiveResearchBindings(this.deps.envBindings ?? [], this.state.bindings) };
    }
    return this.bindingsCache.value;
  }

  /** Key-free summary for the owner settings page. */
  summary() {
    if (!this.installed) return { status: "not-installed" as const };
    const last = this.state.lastResult;
    return {
      status: last?.status ?? ("pending" as const),
      ...(last?.error ? { error: last.error } : {}),
      ...(last?.hint ? { hint: last.hint } : {}),
      appliedAt: this.state.appliedAt,
      chatModelConfigured: Boolean(this.state.chatModelId),
      embeddingModelConfigured: Boolean(this.state.embeddingModelId),
      notebookBound: this.deps.companyId ? this.bindings().some((binding) => binding.companyId === this.deps.companyId) : null,
    };
  }

  /**
   * Apply settings to Open Notebook. With onlyIfStale, an unchanged fingerprint
   * only triggers cheap verification reads; writes happen when Open Notebook
   * reports the credential or default models missing.
   */
  sync(settings: ModelSettings, options: { readonly onlyIfStale?: boolean } = {}): Promise<ResearchSyncResult> {
    const run = this.queue.then(() => this.runSync(settings, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runSync(settings: ModelSettings, options: { readonly onlyIfStale?: boolean }): Promise<ResearchSyncResult> {
    if (!this.loaded) await this.load();
    if (!this.deps.baseUrl || !this.deps.token) return { status: "not-installed" };
    const chatProvider = researchProvider(settings.chat.provider);
    const embeddingProvider = researchProvider(settings.embedding.provider);
    if (!chatProvider || !embeddingProvider) return this.record({ status: "provider_unsupported" }, {});
    const fingerprint = researchFingerprint(settings);
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let client: ResearchEngineClient;
    try {
      client = new ResearchEngineClient(this.deps.baseUrl, this.deps.token, this.deps.fetchImpl ?? fetch, timeoutMs, Date.now() + (this.deps.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS));
    } catch (error) {
      return this.record({ status: "failed", error: error instanceof ResearchSyncError ? error.code : "research_sync_failed" }, {});
    }
    try {
      if (options.onlyIfStale && this.state.appliedFingerprint === fingerprint && await this.verify(client)) {
        return { status: "configured" };
      }
      return await this.apply(client, settings, chatProvider, embeddingProvider, fingerprint);
    } catch (error) {
      return this.record({ status: "failed", error: error instanceof ResearchSyncError ? error.code : "research_sync_failed" }, {});
    }
  }

  /** True when the applied configuration is still present upstream and bound. */
  private async verify(client: ResearchEngineClient): Promise<boolean> {
    const { chatModelId, embeddingModelId, credentialIds } = this.state;
    if (!chatModelId || !embeddingModelId || Object.keys(credentialIds).length === 0) return false;
    if (this.needsBinding()) return false;
    try {
      const defaults = await client.call("defaults", "GET", "/api/models/defaults") as EngineDefaults | null;
      if (defaults?.default_chat_model !== chatModelId || defaults?.default_embedding_model !== embeddingModelId) return false;
      for (const id of Object.values(credentialIds)) {
        await client.call("credential", "GET", `/api/credentials/${encodeURIComponent(id)}`);
      }
      return true;
    } catch { return false; }
  }

  private needsBinding(): boolean {
    const companyId = this.deps.companyId;
    if (!companyId || !this.deps.notebooks || !safeId(companyId)) return false;
    return !this.bindings().some((binding) => binding.companyId === companyId && this.deps.notebooks!.ownerOf(binding.knowledgeNotebookId) === companyId);
  }

  private async apply(client: ResearchEngineClient, settings: ModelSettings, chatProvider: string, embeddingProvider: string, fingerprint: string): Promise<ResearchSyncResult> {
    const status = await client.call("credentials_status", "GET", "/api/credentials/status") as { encryption_configured?: unknown } | null;
    if (status?.encryption_configured !== true) return this.record({ status: "encryption_not_configured" }, {});

    // 1. One credential per Open Notebook provider, matched by our fixed name.
    const wanted = new Map<string, { apiKey: string; baseUrl: string | null; modalities: Set<string> }>();
    for (const [provider, entry, modality] of [[chatProvider, settings.chat, "language"], [embeddingProvider, settings.embedding, "embedding"]] as const) {
      const existing = wanted.get(provider);
      if (existing) { existing.modalities.add(modality); continue; }
      wanted.set(provider, { apiKey: entry.apiKey, baseUrl: researchBaseUrl(provider, entry.baseUrl), modalities: new Set([modality]) });
    }
    const credentialIds: Record<string, string> = {};
    for (const [provider, entry] of wanted) {
      const name = researchCredentialName(provider);
      const listed = asArray(await client.call("credentials", "GET", `/api/credentials/by-provider/${encodeURIComponent(provider)}`), "credentials");
      const match = listed.find((credential) => credential.name === name && safeId(credential.id));
      const modalities = [...entry.modalities].sort();
      if (match) {
        const id = match.id as string;
        await client.call("credential_update", "PUT", `/api/credentials/${encodeURIComponent(id)}`, { api_key: entry.apiKey, base_url: entry.baseUrl, modalities });
        credentialIds[provider] = id;
      } else {
        const created = await client.call("credential_create", "POST", "/api/credentials", {
          name, provider, modalities, api_key: entry.apiKey, ...(entry.baseUrl ? { base_url: entry.baseUrl } : {}),
        });
        credentialIds[provider] = idOf(created, "credential_create");
      }
    }

    // 2. Language and embedding models linked to those credentials. Only
    // models Knowledge created (linked to one of its fixed-name credentials, or
    // recorded in research-settings.json) may be replaced; anything else is a
    // conflict the owner resolves, never a silent delete.
    const ownCredentials = new Set([...Object.values(this.state.credentialIds), ...Object.values(credentialIds)]);
    const ownModels = new Set([this.state.chatModelId, this.state.embeddingModelId].filter((id): id is string => Boolean(id)));
    const upsertModel = async (type: "language" | "embedding", provider: string, name: string, credential: string, models: EngineModel[]): Promise<string | ModelConflict> => {
      const match = models.find((model) => sameModel(model, provider, name));
      if (match?.credential === credential) return match.id;
      if (match) {
        const ours = ownModels.has(match.id) || (match.credential !== null && ownCredentials.has(match.credential));
        if (!ours) return { conflict: match.name };
        // Open Notebook has no model update endpoint and rejects duplicates.
        await client.call(`model_relink_${type}`, "DELETE", `/api/models/${encodeURIComponent(match.id)}`);
      }
      return idOf(await client.call(`model_create_${type}`, "POST", "/api/models", { name, provider, type, credential }), `model_create_${type}`);
    };
    const conflict = async (found: ModelConflict) => {
      await this.persist({ ...this.state, credentialIds, credentialId: credentialIds[chatProvider] ?? null });
      return this.record({ status: "model_conflict", error: "research_model_conflict", hint: modelConflictHint(found.conflict) }, {});
    };
    const languageModels = parseModels(await client.call("models_language", "GET", "/api/models?type=language"), "models_language");
    const chatModelId = await upsertModel("language", chatProvider, settings.chat.model, credentialIds[chatProvider]!, languageModels);
    if (typeof chatModelId !== "string") return conflict(chatModelId);
    const embeddingModels = parseModels(await client.call("models_embedding", "GET", "/api/models?type=embedding"), "models_embedding");
    const embeddingModelId = await upsertModel("embedding", embeddingProvider, settings.embedding.model, credentialIds[embeddingProvider]!, embeddingModels);
    if (typeof embeddingModelId !== "string") return conflict(embeddingModelId);

    // 3. Defaults. Never silently switch the embedding model under existing vectors.
    const defaults = await client.call("defaults", "GET", "/api/models/defaults") as EngineDefaults | null;
    const currentEmbedding = typeof defaults?.default_embedding_model === "string" && defaults.default_embedding_model ? defaults.default_embedding_model : null;
    let embeddingAllowed = true;
    if (currentEmbedding && currentEmbedding !== embeddingModelId) {
      const current = embeddingModels.find((model) => model.id === currentEmbedding);
      const compatible = current ? sameModel(current, embeddingProvider, settings.embedding.model) : false;
      if (!compatible) embeddingAllowed = !(await this.hasContent(client));
    }
    await client.call("defaults_update", "PUT", "/api/models/defaults", {
      default_chat_model: chatModelId,
      default_transformation_model: chatModelId,
      default_tools_model: chatModelId,
      large_context_model: chatModelId,
      ...(embeddingAllowed ? { default_embedding_model: embeddingModelId } : {}),
    });
    const ids = { credentialIds, credentialId: credentialIds[chatProvider] ?? null, chatModelId, embeddingModelId };
    await this.persist({ ...this.state, ...ids });

    // 4. Bind the deployment workspace to a Research notebook when none is configured.
    await this.ensureBinding(client);
    if (!embeddingAllowed) return this.record({ status: "embedding_migration_required" }, ids);
    return this.record({ status: "configured" }, ids, fingerprint);
  }

  /** Existing sources or notes would keep vectors from the old model. Unknown counts as yes. */
  private async hasContent(client: ResearchEngineClient): Promise<boolean> {
    try {
      const sources = await client.call("sources_probe", "GET", "/api/sources?limit=1&offset=0");
      if (!Array.isArray(sources) || sources.length > 0) return true;
      const notes = await client.call("notes_probe", "GET", "/api/notes");
      return !Array.isArray(notes) || notes.length > 0;
    } catch { return true; }
  }

  private async ensureBinding(client: ResearchEngineClient) {
    const companyId = this.deps.companyId;
    const notebooks = this.deps.notebooks;
    if (!companyId || !notebooks || !safeId(companyId) || !this.needsBinding()) return;
    // Drop persisted bindings whose local notebook disappeared or changed owner.
    const bindings = this.state.bindings.filter((binding) => binding.companyId !== companyId || notebooks.ownerOf(binding.knowledgeNotebookId) === companyId);
    let pending = this.state.pendingNotebook;
    if (!pending || pending.companyId !== companyId || notebooks.ownerOf(pending.knowledgeNotebookId) !== companyId) {
      let knowledgeNotebookId: string;
      try { knowledgeNotebookId = notebooks.create(companyId); }
      catch { throw new ResearchSyncError("research_notebook_create_failed"); }
      if (!safeId(knowledgeNotebookId)) throw new ResearchSyncError("research_notebook_create_failed");
      pending = { knowledgeNotebookId, companyId };
      await this.persist({ ...this.state, bindings, pendingNotebook: pending });
    }
    const created = await client.call("notebook_create", "POST", "/api/notebooks", { name: "Knowledge research", description: "Research notebook managed by Tealbrick Knowledge." });
    const binding = { knowledgeNotebookId: pending.knowledgeNotebookId, companyId, externalNotebookId: idOf(created, "notebook_create") };
    await this.persist({ ...this.state, bindings: [...bindings, binding], pendingNotebook: null });
  }

  private async persist(next: ResearchSettingsFile) {
    await writeResearchSettings(this.deps.dataDir, next);
    this.state = next;
  }

  private async record(result: ResearchSyncResult, ids: Partial<Pick<ResearchSettingsFile, "credentialIds" | "credentialId" | "chatModelId" | "embeddingModelId">>, fingerprint?: string): Promise<ResearchSyncResult> {
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const next: ResearchSettingsFile = {
      ...this.state,
      ...ids,
      ...(fingerprint ? { appliedFingerprint: fingerprint, appliedAt: at } : result.status === "configured" ? {} : { appliedFingerprint: null }),
      lastResult: { ...result, at },
    };
    try { await this.persist(next); }
    catch { this.state = next; return { status: "failed", error: "research_settings_write_failed" }; }
    return result;
  }
}
