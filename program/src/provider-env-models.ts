import fs from "node:fs/promises";
import path from "node:path";
import { FIXED_ENDPOINTS, PROVIDER_DEFAULTS } from "./model-providers.js";
import { ModelSettingsSchema, readModelSettings, type ModelSettings } from "./model-settings.js";

/**
 * Model configuration from the account's provider keys.
 *
 * Portal Connections writes an API key once as a shared variable in the
 * customer's hosting environment (manifest fields with `destination:
 * "provider-env"`). When the owner has saved no Settings -> Models, Knowledge
 * builds its model configuration from those variables:
 *
 *   explicit owner Settings -> Models  >  provider environment  >  not configured
 *
 * Values are read from the process environment and used in memory only. They are
 * never written to disk, logged or returned. A save in Settings -> Models takes
 * precedence from then on, and Portal Connections no longer changes the models.
 */

/** Provider key variables, as declared by the manifest's provider-env fields. */
export const PROVIDER_ENV_KEYS = Object.freeze({
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
} as const);

export type ModelConfigSource = "knowledge-settings" | "provider-env";
export type ModelConfigIssue = "embedding_provider_required" | "embedding_key_missing";

export interface EffectiveModelSettings {
  readonly settings: ModelSettings | null;
  readonly source: ModelConfigSource | null;
  /** Why the provider environment did not make a configuration (never contains a value). */
  readonly issue?: ModelConfigIssue;
}

/** The embedding model an existing brain already uses: vectors must keep matching it. */
export interface PinnedEmbedding { readonly provider: string; readonly model: string; readonly dimensions: number | null }

type Env = Readonly<Record<string, string | undefined>>;
const present = (env: Env, name: string) => env[name]?.trim() || null;

/**
 * Chat prefers Anthropic, then OpenAI, then Google. Embeddings prefer OpenAI,
 * then Google; Anthropic has no embeddings API. An existing brain keeps its
 * embedding model, so adding a key later never changes the vector space.
 */
export function providerEnvModelSettings(env: Env, pinned: PinnedEmbedding | null = null): { settings: ModelSettings | null; issue?: ModelConfigIssue } {
  const keys = {
    openai: present(env, PROVIDER_ENV_KEYS.openai),
    anthropic: present(env, PROVIDER_ENV_KEYS.anthropic),
    google: present(env, PROVIDER_ENV_KEYS.google),
  };
  if (!keys.openai && !keys.anthropic && !keys.google) return { settings: null };

  let embeddingProvider: "openai" | "google" | null = null;
  if (pinned) {
    if ((pinned.provider === "openai" || pinned.provider === "google") && keys[pinned.provider]) embeddingProvider = pinned.provider;
    else return { settings: null, issue: "embedding_key_missing" };
  } else embeddingProvider = keys.openai ? "openai" : keys.google ? "google" : null;
  if (!embeddingProvider) return { settings: null, issue: "embedding_provider_required" };

  const chatProvider = keys.anthropic ? "anthropic" : keys.openai ? "openai" : "google";
  const connection = (provider: "openai" | "anthropic" | "google") => ({
    provider,
    baseUrl: provider === "openai" ? PROVIDER_DEFAULTS.openai.baseUrl : FIXED_ENDPOINTS[provider]!,
    apiKey: keys[provider]!,
  });
  const defaults = PROVIDER_DEFAULTS[embeddingProvider];
  const parsed = ModelSettingsSchema.safeParse({
    chat: { ...connection(chatProvider), model: PROVIDER_DEFAULTS[chatProvider].chatModel },
    embedding: {
      ...connection(embeddingProvider),
      model: pinned?.model ?? defaults.embeddingModel,
      dimensions: pinned?.dimensions ?? defaults.dimensions,
    },
  });
  return parsed.success ? { settings: parsed.data } : { settings: null };
}

/** The pinned embedding model of an existing brain, from its GBrain config file. */
export async function readPinnedEmbedding(gbrainHome: string): Promise<PinnedEmbedding | null> {
  try {
    const config = JSON.parse(await fs.readFile(path.join(gbrainHome, ".gbrain", "config.json"), "utf8")) as { embedding_model?: unknown; embedding_dimensions?: unknown };
    if (typeof config.embedding_model !== "string") return null;
    const split = config.embedding_model.indexOf(":");
    if (split < 1) return null;
    return {
      provider: config.embedding_model.slice(0, split),
      model: config.embedding_model.slice(split + 1),
      dimensions: typeof config.embedding_dimensions === "number" && Number.isInteger(config.embedding_dimensions) ? config.embedding_dimensions : null,
    };
  } catch { return null; }
}

/** Owner-saved settings first, else the provider environment, else nothing. */
export async function resolveEffectiveModelSettings(dataDir: string, gbrainHome: string, env: Env = process.env): Promise<EffectiveModelSettings> {
  const saved = await readModelSettings(dataDir);
  if (saved) return { settings: saved, source: "knowledge-settings" };
  const derived = providerEnvModelSettings(env, await readPinnedEmbedding(gbrainHome));
  if (derived.settings) return { settings: derived.settings, source: "provider-env" };
  return { settings: null, source: null, ...(derived.issue ? { issue: derived.issue } : {}) };
}
