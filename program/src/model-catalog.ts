import { createHash } from "node:crypto";
import { filterModels, type ModelManifest } from "@tealbrick/contract/models";
import { CHAT_PROVIDERS, EMBEDDING_PROVIDERS, FIXED_ENDPOINTS, GOOGLE_MODEL_ID, PROVIDER_DEFAULTS, REASONING_EFFORT_PROVIDERS, RERANKER_PROVIDERS } from "./model-providers.js";
import type { ModelSettings } from "./model-settings.js";
import { PROVIDER_ENV_KEYS } from "./provider-env-models.js";

/**
 * Which models the owner may pick in Settings -> Models.
 *
 * The Program asks the provider for its live model list with the key it already
 * holds (the saved Settings key for that provider, else the provider-env key) and
 * filters it through the active model manifest. The browser gets model ids only:
 * never a key, never an upstream error body. Without a key, or when the provider
 * cannot be reached, the picker falls back to the manifest's own exact ids.
 */

export const PICKER_ROLES = ["chat", "embedding", "rerank"] as const;
export type PickerRole = (typeof PICKER_ROLES)[number];
export const PICKER_PROVIDERS = [...new Set<string>([...CHAT_PROVIDERS, ...EMBEDDING_PROVIDERS, ...RERANKER_PROVIDERS])] as readonly string[];

/** What the memory engine accepts (model-settings.ts). The manifest enum also has xhigh and max: those clamp to high. */
export const ENGINE_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
export type EngineReasoningEffort = (typeof ENGINE_REASONING_EFFORTS)[number];
export function clampReasoningEffort(value: string | undefined): EngineReasoningEffort | null {
  if (!value) return null;
  if ((ENGINE_REASONING_EFFORTS as readonly string[]).includes(value)) return value as EngineReasoningEffort;
  return value === "xhigh" || value === "max" ? "high" : null;
}

/** Providers whose manifest entry is authoritative: their live list is always filtered. */
const CURATED_PROVIDERS: ReadonlySet<string> = new Set(["openai", "anthropic", "google"]);
const CACHE_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 10_000;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 1000;
const MAX_PAGES = 5;
const MODEL_ID = /^[^\s]{1,180}$/u;

export type ListingError = "provider_unreachable" | "provider_key_invalid";
export class ProviderListingError extends Error {
  constructor(readonly code: ListingError) { super(code); }
}

export interface ProviderCredential {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly source: "knowledge-settings" | "provider-env";
}

/**
 * The key Knowledge already holds for a provider: the saved Settings connection for that
 * provider first (with its saved endpoint), else the provider-env key at the provider's
 * official endpoint. Nothing typed in the browser is ever used here.
 */
export function credentialFor(provider: string, saved: ModelSettings | null, env: Readonly<Record<string, string | undefined>>): ProviderCredential | null {
  const connections = saved ? [saved.chat, saved.embedding, ...(saved.reranker ? [{ ...saved.reranker, provider: saved.reranker.provider ?? "llama-server-reranker" }] : [])] : [];
  const match = connections.find((entry) => entry.provider === provider);
  if (match) return { provider, baseUrl: FIXED_ENDPOINTS[provider] ?? match.baseUrl, apiKey: match.apiKey, source: "knowledge-settings" };
  const envName = (PROVIDER_ENV_KEYS as Record<string, string>)[provider];
  const key = envName ? env[envName]?.trim() : undefined;
  if (!key) return null;
  const baseUrl = provider === "openai" ? PROVIDER_DEFAULTS.openai.baseUrl : FIXED_ENDPOINTS[provider];
  return baseUrl ? { provider, baseUrl, apiKey: key, source: "provider-env" } : null;
}

/** A stable, non-reversible cache key: provider, endpoint and a hash of the key. */
export function credentialFingerprint(credential: ProviderCredential): string {
  return createHash("sha256").update(`${credential.provider}\n${credential.baseUrl}\n${credential.apiKey}`).digest("hex").slice(0, 32);
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ProviderListingError("provider_unreachable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_LIST_BYTES) throw new ProviderListingError("provider_unreachable");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(text); } catch { throw new ProviderListingError("provider_unreachable"); }
}

/** One GET to the provider. Upstream bodies on errors are discarded: they can echo a key. */
async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try { response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) }); }
  catch { throw new ProviderListingError("provider_unreachable"); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderListingError(response.status === 401 || response.status === 403 ? "provider_key_invalid" : "provider_unreachable");
  }
  return readJson(response);
}

function ids(values: unknown[], pick: (row: Record<string, unknown>) => unknown, pattern: RegExp = MODEL_ID): string[] {
  const out: string[] = [];
  for (const row of values) {
    if (!row || typeof row !== "object") continue;
    const id = pick(row as Record<string, unknown>);
    if (typeof id === "string" && pattern.test(id)) out.push(id);
  }
  return out;
}

/** OpenAI-compatible endpoints (OpenAI, OpenRouter, Ollama, llama-server) share `GET {base}/v1/models`. */
function openAiModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  return `${base.endsWith("/v1") ? base : `${base}/v1`}/models`;
}

/** The provider's live model ids. Throws ProviderListingError with a clean code. */
export async function listProviderModels(credential: ProviderCredential, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const { provider, apiKey } = credential;
  const listed: string[] = [];
  if (provider === "anthropic") {
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: string = `limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
      const data = await getJson(fetchImpl, `${FIXED_ENDPOINTS.anthropic}/v1/models?${query}`, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }) as { data?: unknown; has_more?: unknown; last_id?: unknown };
      if (!Array.isArray(data?.data)) throw new ProviderListingError("provider_unreachable");
      listed.push(...ids(data.data, (row) => row.id));
      if (data.has_more !== true || typeof data.last_id !== "string") break;
      after = data.last_id;
    }
  } else if (provider === "google") {
    let token: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: string = `pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
      const data = await getJson(fetchImpl, `${FIXED_ENDPOINTS.google}/v1beta/models?${query}`, { "x-goog-api-key": apiKey }) as { models?: unknown; nextPageToken?: unknown };
      if (!Array.isArray(data?.models)) throw new ProviderListingError("provider_unreachable");
      // Google names models `models/<id>`; the id is what settings and the memory engine use.
      listed.push(...ids(data.models, (row) => typeof row.name === "string" ? row.name.replace(/^models\//u, "") : null, GOOGLE_MODEL_ID));
      if (typeof data.nextPageToken !== "string" || !data.nextPageToken) break;
      token = data.nextPageToken;
    }
  } else {
    const data = await getJson(fetchImpl, openAiModelsUrl(credential.baseUrl), { authorization: `Bearer ${apiKey}` }) as { data?: unknown };
    if (!Array.isArray(data?.data)) throw new ProviderListingError("provider_unreachable");
    listed.push(...ids(data.data, (row) => row.id));
  }
  return [...new Set(listed)].slice(0, MAX_MODELS);
}

/** Ten-minute cache of live lists per provider and key fingerprint. Only successful lists are kept. */
export class ProviderModelCache {
  private readonly entries = new Map<string, { at: number; ids: string[] }>();
  constructor(private readonly now: () => number = Date.now, private readonly fetchImpl: typeof fetch = fetch) {}
  async list(credential: ProviderCredential): Promise<string[]> {
    const key = credentialFingerprint(credential);
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.ids;
    const listed = await listProviderModels(credential, this.fetchImpl);
    if (this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { at: this.now(), ids: listed });
    return listed;
  }
}

type RoleEntry = { recommended: { model: string; reasoningEffort?: string; dimensions?: number }; models: string[]; globs: string[] };
function roleEntry(manifest: ModelManifest, provider: string, role: PickerRole): RoleEntry | null {
  const entry = (manifest.providers as Record<string, { roles: Record<string, RoleEntry | undefined> } | undefined>)[provider]?.roles[role];
  return entry ?? null;
}

export interface AvailableModels {
  readonly provider: string;
  readonly role: PickerRole;
  /** "provider": the live list, filtered; "manifest": the manifest's own ids (no key, or the list failed); "none": free text only. */
  readonly listing: "provider" | "manifest" | "none";
  /** Whether the manifest filtered the ids (false: an uncurated OpenRouter, Ollama or llama-server list, shown as listed). */
  readonly curated: boolean;
  readonly models: readonly string[];
  readonly recommended: string | null;
  /** Vector size the manifest recommends for the recommended embedding model. */
  readonly recommendedDimensions: number | null;
  readonly reasoningEffort: { readonly supported: boolean; readonly options: readonly EngineReasoningEffort[]; readonly recommended: EngineReasoningEffort | null };
  /** No ids to offer: the owner can only type a model name (the advanced path). */
  readonly freeTextOnly: boolean;
  /** Where the key used for the list came from. The key itself is never returned. */
  readonly keySource: "knowledge-settings" | "provider-env" | "none";
  readonly error?: ListingError;
}

/**
 * Role filtering: `allowed = filterModels(listed, provider, role, manifest)`; the recommendation is the
 * manifest's, shown only when allowed. Reasoning effort keeps the engine rule (REASONING_EFFORT_PROVIDERS,
 * chat only) and the manifest's effort is clamped to what the engine accepts.
 */
export function availableModels(input: { provider: string; role: PickerRole; manifest: ModelManifest; listed: readonly string[] | null; keySource: AvailableModels["keySource"]; error?: ListingError }): AvailableModels {
  const { provider, role, manifest } = input;
  const entry = roleEntry(manifest, provider, role);
  const reasoningSupported = role === "chat" && REASONING_EFFORT_PROVIDERS.has(provider);
  let listing: AvailableModels["listing"] = "none";
  let curated = false;
  let models: string[] = [];
  let recommended: string | null = null;
  // OpenRouter's general list holds chat models only, so without a manifest entry it is offered for chat only.
  const uncuratedListUsable = !CURATED_PROVIDERS.has(provider) && (provider !== "openrouter" || role === "chat");
  if (input.listed && (entry || uncuratedListUsable)) {
    listing = "provider";
    if (entry) {
      const filtered = filterModels(input.listed, provider, role, manifest);
      models = filtered.allowed;
      recommended = filtered.recommended ?? null;
      curated = true;
    } else {
      // Ollama or llama-server (any role) and OpenRouter (chat) without a manifest entry: the list as the provider gave it.
      models = [...input.listed];
    }
  } else if (entry) {
    // No key, or the provider could not be reached: offer the manifest's exact ids.
    const filtered = filterModels(entry.models, provider, role, manifest);
    listing = "manifest";
    curated = true;
    models = filtered.allowed;
    recommended = filtered.recommended ?? null;
  }
  if (!models.length) listing = "none";
  const recommendedEntry = recommended && entry?.recommended.model === recommended ? entry.recommended : null;
  return {
    provider,
    role,
    listing,
    curated,
    models,
    recommended,
    recommendedDimensions: role === "embedding" ? recommendedEntry?.dimensions ?? null : null,
    reasoningEffort: {
      supported: reasoningSupported,
      options: reasoningSupported ? ENGINE_REASONING_EFFORTS : [],
      recommended: reasoningSupported ? clampReasoningEffort(recommendedEntry?.reasoningEffort) : null,
    },
    freeTextOnly: models.length === 0,
    keySource: input.keySource,
    ...(input.error ? { error: input.error } : {}),
  };
}
