/**
 * Model providers Knowledge can configure (Settings -> Models, the settings
 * contract and provider-env). One table keeps the GBrain environment mapping,
 * the fixed endpoints and the defaults in a single place.
 */

export const CHAT_PROVIDERS = ["openai", "ollama", "openrouter", "anthropic", "google"] as const;
export const EMBEDDING_PROVIDERS = ["openai", "llama-server", "openrouter", "google"] as const;
export const RERANKER_PROVIDERS = ["llama-server-reranker", "openrouter"] as const;

export type ChatProvider = (typeof CHAT_PROVIDERS)[number];
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/**
 * Providers that expose a native (non OpenAI-compatible) API on one official
 * host. The owner cannot point these at another host: the key is only ever
 * sent to the official origin.
 */
export const FIXED_ENDPOINTS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
});

/** Providers whose chat models accept an explicit reasoning effort through the memory engine. */
export const REASONING_EFFORT_PROVIDERS: ReadonlySet<string> = new Set(["openai", "ollama", "openrouter"]);

/** GBrain provider environment names (the recipes read these). `base` is absent when GBrain has no base URL setting. */
export const GBRAIN_PROVIDER_ENV: Readonly<Record<string, { readonly key: string; readonly base?: string }>> = Object.freeze({
  openai: { key: "OPENAI_API_KEY", base: "OPENAI_BASE_URL" },
  openrouter: { key: "OPENROUTER_API_KEY", base: "OPENROUTER_BASE_URL" },
  ollama: { key: "OLLAMA_API_KEY", base: "OLLAMA_BASE_URL" },
  "llama-server": { key: "LLAMA_SERVER_API_KEY", base: "LLAMA_SERVER_BASE_URL" },
  "llama-server-reranker": { key: "LLAMA_SERVER_RERANKER_API_KEY", base: "LLAMA_SERVER_RERANKER_BASE_URL" },
  anthropic: { key: "ANTHROPIC_API_KEY", base: "ANTHROPIC_BASE_URL" },
  google: { key: "GOOGLE_GENERATIVE_AI_API_KEY" },
});

/**
 * Defaults offered for each hosted provider (chat, embedding, vector size).
 * `chatReasoningEffort` is the default reasoning effort for that provider's chat
 * model. Only providers in REASONING_EFFORT_PROVIDERS may have one: Anthropic and
 * Google have none, so they never send it.
 */
export const PROVIDER_DEFAULTS = Object.freeze({
  openai: { baseUrl: "https://api.openai.com/v1", chatModel: "gpt-6-luna", chatReasoningEffort: "low", embeddingModel: "text-embedding-3-small", dimensions: 1536 },
  // The memory engine's current Google embedding model; 768 is its default vector size.
  google: { baseUrl: FIXED_ENDPOINTS.google!, chatModel: "gemini-2.5-flash", embeddingModel: "gemini-embedding-2", dimensions: 768 },
  anthropic: { baseUrl: FIXED_ENDPOINTS.anthropic!, chatModel: "claude-sonnet-5" },
});

/** Google model ids go into a URL path: letters, digits, dot, dash and underscore only. */
export const GOOGLE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/u;

/** Normalised official origin of a fixed-endpoint provider, or null when the URL is not that provider's official host. */
export function fixedEndpointOrigin(provider: string, baseUrl: string): string | null {
  const official = FIXED_ENDPOINTS[provider];
  if (!official) return null;
  let url: URL;
  try { url = new URL(baseUrl); } catch { return null; }
  const suffix = url.pathname.replace(/\/+$/u, "");
  if (url.origin !== official || !["", "/v1", "/v1beta"].includes(suffix)) return null;
  return official;
}
