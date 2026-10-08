import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EMBEDDING_CANARY_INPUTS, gradeEmbeddingReadiness } from "./embedding-readiness.js";
import { CHAT_PROVIDERS, EMBEDDING_PROVIDERS, FIXED_ENDPOINTS, GBRAIN_PROVIDER_ENV, GOOGLE_MODEL_ID, REASONING_EFFORT_PROVIDERS, RERANKER_PROVIDERS, fixedEndpointOrigin } from "./model-providers.js";

const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && !["169.254.169.254", "metadata.google.internal", "[::]", "0.0.0.0"].includes(url.hostname);
}, "Use an explicit trusted HTTP(S) model endpoint without embedded credentials");
const reasoningEffort = z.enum(["none", "minimal", "low", "medium", "high"]);

/**
 * Checks shared by the stored and the update shape. Anthropic and Google use
 * their official host only; Google model ids become part of a URL path; a
 * reasoning effort is only passed on for providers the memory engine supports it for.
 */
function refineConnection(component: "chat" | "embedding" | "reranker") {
  return (entry: { provider?: string; baseUrl?: string; model: string; reasoningEffort?: string }, ctx: z.RefinementCtx) => {
    const provider = entry.provider ?? "";
    if (FIXED_ENDPOINTS[provider]) {
      if (entry.baseUrl !== undefined && !fixedEndpointOrigin(provider, entry.baseUrl)) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "model_endpoint_fixed" });
    } else if (entry.baseUrl === undefined) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Required" });
    if (provider === "google" && !GOOGLE_MODEL_ID.test(entry.model)) ctx.addIssue({ code: "custom", path: ["model"], message: "model_id_invalid" });
    if (component === "chat" && entry.reasoningEffort !== undefined && !REASONING_EFFORT_PROVIDERS.has(provider)) ctx.addIssue({ code: "custom", path: ["reasoningEffort"], message: "reasoning_effort_unsupported" });
  };
}

const connection = z.object({ baseUrl: endpoint, model: z.string().trim().min(1).max(180), apiKey: z.string().trim().min(1).max(4096) }).strict();
export const ModelSettingsSchema = z.object({
  chat: connection.extend({ provider: z.enum(CHAT_PROVIDERS), reasoningEffort: reasoningEffort.optional() }).superRefine(refineConnection("chat")),
  embedding: connection.extend({ provider: z.enum(EMBEDDING_PROVIDERS), dimensions: z.number().int().min(64).max(8192) }).superRefine(refineConnection("embedding")),
  reranker: connection.extend({ provider: z.enum(RERANKER_PROVIDERS).optional() }).superRefine(refineConnection("reranker")).optional(),
}).strict();
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

/**
 * Owner update shape: identical to ModelSettingsSchema except that an API key
 * may be omitted (or blank) to keep the key already saved for the same
 * provider and endpoint. Keys are never returned to the browser, so this is
 * how an owner edits model names without re-entering secrets. Anthropic and
 * Google may omit the endpoint (their official host is used). Anthropic is
 * accepted as an embedding provider here only to answer it with a clear error:
 * Anthropic has no embeddings API.
 */
const optionalKey = z.string().trim().max(4096).optional().transform(value => value ? value : undefined);
const updateConnection = z.object({ baseUrl: endpoint.optional(), model: z.string().trim().min(1).max(180), apiKey: optionalKey }).strict();
export const ModelSettingsUpdateSchema = z.object({
  chat: updateConnection.extend({ provider: z.enum(CHAT_PROVIDERS), reasoningEffort: reasoningEffort.optional() }).superRefine(refineConnection("chat")),
  embedding: updateConnection.extend({ provider: z.enum([...EMBEDDING_PROVIDERS, "anthropic"]), dimensions: z.number().int().min(64).max(8192) }).superRefine(refineConnection("embedding")),
  reranker: updateConnection.extend({ provider: z.enum(RERANKER_PROVIDERS).optional() }).superRefine(refineConnection("reranker")).optional(),
}).strict();
export type ModelSettingsUpdate = z.infer<typeof ModelSettingsUpdateSchema>;

export class ModelSettingsUpdateError extends Error {
  constructor(readonly code: "model_api_key_required" | "model_provider_conflict" | "embedding_provider_required", readonly component: string) {
    super(code);
  }
}

/**
 * Fill omitted keys from saved settings. A saved key is reused only for the
 * same provider and exactly the same endpoint, so changing where a key is
 * sent always requires entering it again.
 */
export function resolveModelSettingsUpdate(update: ModelSettingsUpdate, saved: ModelSettings | null): ModelSettings {
  // Anthropic offers no embeddings API: the owner must pick a separate embedding provider.
  if (update.embedding.provider === "anthropic") throw new ModelSettingsUpdateError("embedding_provider_required", "embedding");
  const savedConnections = saved ? [saved.chat, saved.embedding, ...(saved.reranker ? [{ ...saved.reranker, provider: saved.reranker.provider ?? "llama-server-reranker" }] : [])] : [];
  // Fixed-endpoint providers always use their official origin, so a saved key matches however the URL was typed.
  const withEndpoint = <T extends { baseUrl?: string }>(entry: T, provider: string): T & { baseUrl?: string } =>
    FIXED_ENDPOINTS[provider] ? { ...entry, baseUrl: FIXED_ENDPOINTS[provider] } : entry;
  const keyFor = (component: string, entry: { provider?: string; baseUrl?: string; apiKey?: string }, provider: string) => {
    if (entry.apiKey) return entry.apiKey;
    const match = savedConnections.find(candidate => candidate.provider === provider && candidate.baseUrl === entry.baseUrl);
    if (!match) throw new ModelSettingsUpdateError("model_api_key_required", component);
    return match.apiKey;
  };
  const chat = withEndpoint(update.chat, update.chat.provider);
  const embedding = withEndpoint(update.embedding, update.embedding.provider);
  const reranker = update.reranker ? withEndpoint(update.reranker, update.reranker.provider ?? "llama-server-reranker") : undefined;
  const resolved = {
    chat: { ...chat, apiKey: keyFor("chat", chat, chat.provider) },
    embedding: { ...embedding, apiKey: keyFor("embedding", embedding, embedding.provider) },
    ...(reranker ? { reranker: { ...reranker, apiKey: keyFor("reranker", reranker, reranker.provider ?? "llama-server-reranker") } } : {}),
  };
  const settings = ModelSettingsSchema.parse(resolved);
  try { modelSettingsEnvironment(settings); }
  catch { throw new ModelSettingsUpdateError("model_provider_conflict", "settings"); }
  return settings;
}

export async function readModelSettings(dataDir: string): Promise<ModelSettings | null> {
  try { return ModelSettingsSchema.parse(JSON.parse(await fs.readFile(path.join(dataDir, "model-settings.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Knowledge model settings are invalid; restore the server configuration"); }
}
export function modelSettingsEnvironment(settings: ModelSettings | null): NodeJS.ProcessEnv {
  if (!settings) return {};
  const env: NodeJS.ProcessEnv = {
    GBRAIN_CHAT_MODEL: `${settings.chat.provider}:${settings.chat.model}`,
    GBRAIN_MODEL: `${settings.chat.provider}:${settings.chat.model}`,
    GBRAIN_EXPANSION_MODEL: `${settings.chat.provider}:${settings.chat.model}`,
    GBRAIN_EMBEDDING_MODEL: `${settings.embedding.provider}:${settings.embedding.model}`,
    GBRAIN_EMBEDDING_DIMENSIONS: String(settings.embedding.dimensions),
    KNOWLEDGE_GBRAIN_RERANKER_MODEL: settings.reranker ? `${settings.reranker.provider ?? "llama-server-reranker"}:${settings.reranker.model}` : "disabled",
    ...(settings.chat.reasoningEffort ? { KNOWLEDGE_GBRAIN_CHAT_REASONING_EFFORT: settings.chat.reasoningEffort } : {}),
  };
  for (const entry of [settings.chat, settings.embedding, ...(settings.reranker ? [{...settings.reranker, provider: settings.reranker.provider ?? "llama-server-reranker"}] : [])]) {
    const names = GBRAIN_PROVIDER_ENV[entry.provider]!;
    if (env[names.key] && (env[names.key] !== entry.apiKey || (names.base && env[names.base] !== entry.baseUrl))) throw new Error("Use the same endpoint and key for models sharing one provider");
    env[names.key] = entry.apiKey;
    // Anthropic and Google use their official host: hand the memory engine the origin, not a typed path.
    if (names.base) env[names.base] = fixedEndpointOrigin(entry.provider, entry.baseUrl) ?? entry.baseUrl;
  }
  return env;
}
export async function saveModelSettings(dataDir: string, gbrainHome: string, input: unknown) {
  const settings = ModelSettingsSchema.parse(input);
  modelSettingsEnvironment(settings);
  // A vector dimension change on an existing brain is a migration, not a
  // settings toggle. Never silently rebuild or discard an existing corpus.
  let existing;
  try { existing = JSON.parse(await fs.readFile(path.join(gbrainHome, ".gbrain/config.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && (existing.embedding_dimensions ?? 1536) !== settings.embedding.dimensions) throw new Error("embedding_migration_required: existing memory uses a different vector size; settings were not changed");
  if (existing?.embedding_model && existing.embedding_model !== `${settings.embedding.provider}:${settings.embedding.model}`) throw new Error("embedding_migration_required: existing memory uses a different embedding model; settings were not changed");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "model-settings.json");
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(settings), { mode: 0o600 });
  await fs.rename(temporary, file);
  return settings;
}
export function modelSettingsSummary(settings: ModelSettings | null) {
  if (!settings) return { configured: false, source: "environment-or-not-configured" };
  const publicConnection = ({ apiKey: _key, ...rest }: ModelSettings["chat"] | ModelSettings["embedding"] | NonNullable<ModelSettings["reranker"]>) => ({ ...rest, keyConfigured: true });
  return { configured: true, source: "knowledge-settings", chat: publicConnection(settings.chat), embedding: publicConnection(settings.embedding), reranker: settings.reranker ? publicConnection(settings.reranker) : null };
}

/**
 * OpenAI rejects `max_tokens` on reasoning models and `reasoning_effort` on
 * non-reasoning models, so send `max_completion_tokens` (accepted by every
 * OpenAI chat model) and only the reasoning effort the owner chose.
 */
export function chatReadinessPayload(chat: ModelSettings["chat"]) {
  return {
    model: chat.model,
    messages: [{ role: "user", content: "Reply with READY." }],
    ...(chat.provider === "openai" ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }),
    ...(chat.reasoningEffort ? { reasoning_effort: chat.reasoningEffort } : {}),
  };
}

type Component = "embedding" | "chat" | "reranker";
interface Probe { readonly url: string; readonly headers: Record<string, string>; readonly payload: unknown }

/**
 * The request that proves one configured model works. OpenAI-compatible
 * providers share one shape; Anthropic (Messages API) and Google (Gemini
 * generateContent / batchEmbedContents) are probed on their native APIs at
 * their official host, so a check proves what the memory engine will call.
 */
export function readinessProbe(component: Component, entry: ModelSettings["chat"] | ModelSettings["embedding"] | NonNullable<ModelSettings["reranker"]>, settings: ModelSettings): Probe {
  const provider = entry.provider ?? "llama-server-reranker";
  if (provider === "anthropic") {
    return {
      url: `${FIXED_ENDPOINTS.anthropic}/v1/messages`,
      headers: { "x-api-key": entry.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      payload: { model: entry.model, max_tokens: 1024, messages: [{ role: "user", content: "Reply with READY." }] },
    };
  }
  if (provider === "google") {
    const headers = { "x-goog-api-key": entry.apiKey, "content-type": "application/json" };
    const model = encodeURIComponent(entry.model);
    if (component === "embedding") {
      return {
        url: `${FIXED_ENDPOINTS.google}/v1beta/models/${model}:batchEmbedContents`,
        headers,
        payload: { requests: EMBEDDING_CANARY_INPUTS.map(text => ({ model: `models/${entry.model}`, content: { parts: [{ text }] }, outputDimensionality: settings.embedding.dimensions })) },
      };
    }
    return {
      url: `${FIXED_ENDPOINTS.google}/v1beta/models/${model}:generateContent`,
      headers,
      payload: { contents: [{ role: "user", parts: [{ text: "Reply with READY." }] }], generationConfig: { maxOutputTokens: 4096 } },
    };
  }
  const base = entry.baseUrl.replace(/\/+$/u, "");
  const route = component === "embedding" ? "/embeddings" : component === "chat" ? "/chat/completions" : "/rerank";
  const payload = component === "embedding" ? { model: entry.model, input: EMBEDDING_CANARY_INPUTS }
    : component === "chat" ? chatReadinessPayload(settings.chat)
    : { model: entry.model, query: "Knowledge", documents: ["Knowledge connection check"] };
  return { url: `${base.endsWith("/v1") ? base : `${base}/v1`}${route}`, headers: { authorization: `Bearer ${entry.apiKey}`, "content-type": "application/json" }, payload };
}

/** Google returns `{embeddings:[{values}]}`; grade it in the OpenAI shape the shared canary understands. */
function googleEmbeddingsAsOpenAi(data: unknown) {
  const rows = (data as { embeddings?: unknown })?.embeddings;
  return { data: Array.isArray(rows) ? rows.map((row, index) => ({ index, embedding: (row as { values?: unknown })?.values })) : null };
}

/** Whether a chat answer is a usable, complete reply (not empty, not cut off by the token limit). */
function chatAnswered(provider: string, data: any): boolean {
  if (provider === "anthropic") return Array.isArray(data?.content) && data.content.some((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) && data.stop_reason !== "max_tokens";
  if (provider === "google") {
    const candidate = data?.candidates?.[0];
    const text = Array.isArray(candidate?.content?.parts) ? candidate.content.parts.map((part: any) => typeof part?.text === "string" ? part.text : "").join("") : "";
    return text.trim().length > 0 && candidate?.finishReason !== "MAX_TOKENS";
  }
  return typeof data?.choices?.[0]?.message?.content === "string" && data.choices[0].message.content.trim().length > 0 && data.choices[0].finish_reason !== "length";
}

/** Synthetic readiness probes. User explicitly authorizes these endpoints by saving/testing. */
export async function testModelSettings(settings: ModelSettings) {
  const checks: { component: string; ok: boolean; error?: string }[] = [];
  for (const [component, entry] of [
    ["embedding", settings.embedding],
    ["chat", settings.chat],
    ...(settings.reranker ? [["reranker", settings.reranker]] : []),
  ] as readonly (readonly [Component, ModelSettings["chat"] | ModelSettings["embedding"] | NonNullable<ModelSettings["reranker"]>])[]) {
    try {
      const probe = readinessProbe(component, entry, settings);
      const response = await fetch(probe.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000), headers: probe.headers, body: JSON.stringify(probe.payload) });
      if (!response.ok) { await response.body?.cancel(); checks.push({ component, ok: false, error: `provider_http_${response.status}` }); continue; }
      if (!response.body) throw new Error("empty_response");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "", bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new Error("oversized_response");
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => undefined); }
      const data = JSON.parse(text);
      const provider = entry.provider ?? "llama-server-reranker";
      const semantic = component === "embedding" ? gradeEmbeddingReadiness(provider === "google" ? googleEmbeddingsAsOpenAi(data) : data, settings.embedding.dimensions) : null;
      const ok = component === "embedding" ? semantic?.ok === true
        : component === "chat" ? chatAnswered(provider, data)
        : Array.isArray(data.results) && data.results.length > 0;
      checks.push({ component, ok, ...(!ok ? { error: semantic?.error ?? "invalid_model_response" } : {}) });
    } catch { checks.push({ component, ok: false, error: "model_connection_failed" }); }
  }
  return { ok: checks.every(check => check.ok), checks };
}
