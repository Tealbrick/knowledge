import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EMBEDDING_CANARY_INPUTS, gradeEmbeddingReadiness } from "./embedding-readiness.js";

const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && !["169.254.169.254", "metadata.google.internal", "[::]", "0.0.0.0"].includes(url.hostname);
}, "Use an explicit trusted HTTP(S) model endpoint without embedded credentials");
const connection = z.object({ baseUrl: endpoint, model: z.string().trim().min(1).max(180), apiKey: z.string().trim().min(1).max(4096) }).strict();
export const ModelSettingsSchema = z.object({
  chat: connection.extend({ provider: z.enum(["openai", "ollama", "openrouter"]), reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high"]).optional() }),
  embedding: connection.extend({ provider: z.enum(["openai", "llama-server", "openrouter"]), dimensions: z.number().int().min(64).max(8192) }),
  reranker: connection.extend({ provider: z.enum(["llama-server-reranker", "openrouter"]).optional() }).optional(),
}).strict();
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

/**
 * Owner update shape: identical to ModelSettingsSchema except that an API key
 * may be omitted (or blank) to keep the key already saved for the same
 * provider and endpoint. Keys are never returned to the browser, so this is
 * how an owner edits model names without re-entering secrets.
 */
const optionalKey = z.string().trim().max(4096).optional().transform(value => value ? value : undefined);
const updateConnection = z.object({ baseUrl: endpoint, model: z.string().trim().min(1).max(180), apiKey: optionalKey }).strict();
export const ModelSettingsUpdateSchema = z.object({
  chat: updateConnection.extend({ provider: z.enum(["openai", "ollama", "openrouter"]), reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high"]).optional() }),
  embedding: updateConnection.extend({ provider: z.enum(["openai", "llama-server", "openrouter"]), dimensions: z.number().int().min(64).max(8192) }),
  reranker: updateConnection.extend({ provider: z.enum(["llama-server-reranker", "openrouter"]).optional() }).optional(),
}).strict();
export type ModelSettingsUpdate = z.infer<typeof ModelSettingsUpdateSchema>;

export class ModelSettingsUpdateError extends Error {
  constructor(readonly code: "model_api_key_required" | "model_provider_conflict", readonly component: string) {
    super(code);
  }
}

/**
 * Fill omitted keys from saved settings. A saved key is reused only for the
 * same provider and exactly the same endpoint, so changing where a key is
 * sent always requires entering it again.
 */
export function resolveModelSettingsUpdate(update: ModelSettingsUpdate, saved: ModelSettings | null): ModelSettings {
  const savedConnections = saved ? [saved.chat, saved.embedding, ...(saved.reranker ? [{ ...saved.reranker, provider: saved.reranker.provider ?? "llama-server-reranker" }] : [])] : [];
  const keyFor = (component: string, entry: { provider?: string; baseUrl: string; apiKey?: string }, provider: string) => {
    if (entry.apiKey) return entry.apiKey;
    const match = savedConnections.find(candidate => candidate.provider === provider && candidate.baseUrl === entry.baseUrl);
    if (!match) throw new ModelSettingsUpdateError("model_api_key_required", component);
    return match.apiKey;
  };
  const resolved = {
    chat: { ...update.chat, apiKey: keyFor("chat", update.chat, update.chat.provider) },
    embedding: { ...update.embedding, apiKey: keyFor("embedding", update.embedding, update.embedding.provider) },
    ...(update.reranker ? { reranker: { ...update.reranker, apiKey: keyFor("reranker", update.reranker, update.reranker.provider ?? "llama-server-reranker") } } : {}),
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
    const prefix = entry.provider === "openrouter" ? "OPENROUTER" : entry.provider === "openai" ? "OPENAI" : entry.provider === "ollama" ? "OLLAMA" : entry.provider === "llama-server-reranker" ? "LLAMA_SERVER_RERANKER" : "LLAMA_SERVER";
    if (env[`${prefix}_API_KEY`] && (env[`${prefix}_API_KEY`] !== entry.apiKey || env[`${prefix}_BASE_URL`] !== entry.baseUrl)) throw new Error("Use the same endpoint and key for models sharing one provider");
    env[`${prefix}_API_KEY`] = entry.apiKey;
    env[`${prefix}_BASE_URL`] = entry.baseUrl;
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

/** Synthetic readiness probes. User explicitly authorizes these endpoints by saving/testing. */
export async function testModelSettings(settings: ModelSettings) {
  const checks: { component: string; ok: boolean; error?: string }[] = [];
  for (const [component, entry, route, payload] of [
    ["embedding", settings.embedding, "/embeddings", { model: settings.embedding.model, input: EMBEDDING_CANARY_INPUTS }],
    ["chat", settings.chat, "/chat/completions", { model: settings.chat.model, messages: [{ role: "user", content: "Reply with READY." }], max_tokens: 4096, reasoning_effort: "low" }],
    ...(settings.reranker ? [["reranker", settings.reranker, "/rerank", { model: settings.reranker.model, query: "Knowledge", documents: ["Knowledge connection check"] }]] : []),
  ] as const) {
    try {
      const base = (entry as ModelSettings["chat"]).baseUrl.replace(/\/+$/u, "");
      const response = await fetch(`${base.endsWith("/v1") ? base : `${base}/v1`}${route}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000), headers: { authorization: `Bearer ${(entry as ModelSettings["chat"]).apiKey}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) { await response.body?.cancel(); checks.push({ component: String(component), ok: false, error: `provider_http_${response.status}` }); continue; }
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
      const semantic = component === "embedding" ? gradeEmbeddingReadiness(data, settings.embedding.dimensions) : null;
      const ok = component === "embedding" ? semantic?.ok === true
        : component === "chat" ? typeof data.choices?.[0]?.message?.content === "string" && data.choices[0].message.content.trim().length > 0 && data.choices[0].finish_reason !== "length"
        : Array.isArray(data.results) && data.results.length > 0;
      checks.push({ component: String(component), ok, ...(!ok ? { error: semantic?.error ?? "invalid_model_response" } : {}) });
    } catch { checks.push({ component: String(component), ok: false, error: "model_connection_failed" }); }
  }
  return { ok: checks.every(check => check.ok), checks };
}
