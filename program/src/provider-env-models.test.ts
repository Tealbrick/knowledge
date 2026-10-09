import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelSettingsSchema, modelSettingsEnvironment, modelSettingsSummary, saveModelSettings } from "./model-settings.js";
import { registerModelSettingsRoutes } from "./model-settings-routes.js";
import { PROVIDER_DEFAULTS, REASONING_EFFORT_PROVIDERS } from "./model-providers.js";
import { providerEnvModelSettings, readPinnedEmbedding, resolveEffectiveModelSettings } from "./provider-env-models.js";
import type { GBrainRuntime } from "./gbrain.js";

const OPENAI = "fake-openai-env-key";
const ANTHROPIC = "fake-anthropic-env-key";
const GOOGLE = "fake-google-env-key";
const authority = "disposable-settings-owner-secret-for-tests";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-provider-env-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("model configuration from the account's provider keys", () => {
  it("configures OpenAI chat and embeddings from OPENAI_API_KEY alone", () => {
    const { settings } = providerEnvModelSettings({ OPENAI_API_KEY: OPENAI });
    expect(settings).toMatchObject({
      chat: { provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", baseUrl: "https://api.openai.com/v1" },
      embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    });
    expect(modelSettingsEnvironment(settings)).toMatchObject({ GBRAIN_CHAT_MODEL: "openai:gpt-6-luna", KNOWLEDGE_GBRAIN_CHAT_REASONING_EFFORT: "low", GBRAIN_EMBEDDING_MODEL: "openai:text-embedding-3-small", OPENAI_API_KEY: OPENAI });
  });

  it("uses the shared default constants: gpt-6-luna with low reasoning effort for OpenAI", () => {
    expect(PROVIDER_DEFAULTS.openai).toMatchObject({ chatModel: "gpt-6-luna", chatReasoningEffort: "low" });
    expect(REASONING_EFFORT_PROVIDERS.has("openai")).toBe(true);
  });

  it("sends no reasoning effort for Anthropic or Google chat, even with an OpenAI key for embeddings", () => {
    for (const env of [
      { ANTHROPIC_API_KEY: ANTHROPIC, OPENAI_API_KEY: OPENAI },
      { GOOGLE_GENERATIVE_AI_API_KEY: GOOGLE },
      { ANTHROPIC_API_KEY: ANTHROPIC, GOOGLE_GENERATIVE_AI_API_KEY: GOOGLE },
    ]) {
      const { settings } = providerEnvModelSettings(env);
      expect(settings?.chat).not.toHaveProperty("reasoningEffort");
      expect(modelSettingsEnvironment(settings)).not.toHaveProperty("KNOWLEDGE_GBRAIN_CHAT_REASONING_EFFORT");
    }
  });

  it("keeps a saved OpenAI chat model and effort over the new defaults", async () => {
    const env = { OPENAI_API_KEY: OPENAI };
    const owner = (reasoningEffort?: "high") => ModelSettingsSchema.parse({
      chat: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey: "owner-saved-key", ...(reasoningEffort ? { reasoningEffort } : {}) },
      embedding: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", apiKey: "owner-saved-key", dimensions: 1536 },
    });
    // Saved without an effort: the default effort is not added to the owner's choice.
    await saveModelSettings(root, root, owner());
    const withoutEffort = await resolveEffectiveModelSettings(root, root, env);
    expect(withoutEffort.source).toBe("knowledge-settings");
    expect(withoutEffort.settings?.chat).toMatchObject({ model: "gpt-4.1-mini" });
    expect(withoutEffort.settings?.chat).not.toHaveProperty("reasoningEffort");
    expect(modelSettingsEnvironment(withoutEffort.settings)).not.toHaveProperty("KNOWLEDGE_GBRAIN_CHAT_REASONING_EFFORT");
    // Saved with an effort: that effort wins.
    await saveModelSettings(root, root, owner("high"));
    const withEffort = await resolveEffectiveModelSettings(root, root, env);
    expect(withEffort.settings?.chat).toMatchObject({ model: "gpt-4.1-mini", reasoningEffort: "high" });
    expect(modelSettingsEnvironment(withEffort.settings)).toMatchObject({ GBRAIN_CHAT_MODEL: "openai:gpt-4.1-mini", KNOWLEDGE_GBRAIN_CHAT_REASONING_EFFORT: "high" });
  });

  it("configures Google chat and embeddings from GOOGLE_GENERATIVE_AI_API_KEY alone", () => {
    const { settings } = providerEnvModelSettings({ GOOGLE_GENERATIVE_AI_API_KEY: GOOGLE });
    expect(settings).toMatchObject({ chat: { provider: "google", model: "gemini-2.5-flash" }, embedding: { provider: "google", model: "gemini-embedding-2", dimensions: 768 } });
    expect(modelSettingsEnvironment(settings)).toMatchObject({ GBRAIN_EMBEDDING_MODEL: "google:gemini-embedding-2", GOOGLE_GENERATIVE_AI_API_KEY: GOOGLE });
  });

  it("uses Anthropic for chat and another provider's key for embeddings", () => {
    expect(providerEnvModelSettings({ ANTHROPIC_API_KEY: ANTHROPIC, OPENAI_API_KEY: OPENAI }).settings).toMatchObject({ chat: { provider: "anthropic", model: "claude-sonnet-5" }, embedding: { provider: "openai" } });
    expect(providerEnvModelSettings({ ANTHROPIC_API_KEY: ANTHROPIC, GOOGLE_GENERATIVE_AI_API_KEY: GOOGLE }).settings).toMatchObject({ chat: { provider: "anthropic" }, embedding: { provider: "google", dimensions: 768 } });
    // OpenAI embeddings win when both are present.
    expect(providerEnvModelSettings({ ANTHROPIC_API_KEY: ANTHROPIC, OPENAI_API_KEY: OPENAI, GOOGLE_GENERATIVE_AI_API_KEY: GOOGLE }).settings?.embedding.provider).toBe("openai");
  });

  it("is not configured, with a clear reason, when only Anthropic is connected", () => {
    expect(providerEnvModelSettings({ ANTHROPIC_API_KEY: ANTHROPIC })).toEqual({ settings: null, issue: "embedding_provider_required" });
    expect(providerEnvModelSettings({})).toEqual({ settings: null });
    expect(providerEnvModelSettings({ OPENAI_API_KEY: "  ", ANTHROPIC_API_KEY: "" })).toEqual({ settings: null });
  });

  it("keeps the embedding model an existing brain already uses", async () => {
    await fs.mkdir(path.join(root, ".gbrain"), { recursive: true });
    await fs.writeFile(path.join(root, ".gbrain/config.json"), JSON.stringify({ embedding_model: "google:gemini-embedding-001", embedding_dimensions: 1536 }));
    const pinned = await readPinnedEmbedding(root);
    expect(pinned).toEqual({ provider: "google", model: "gemini-embedding-001", dimensions: 1536 });
    const both = { OPENAI_API_KEY: OPENAI, GOOGLE_GENERATIVE_AI_API_KEY: GOOGLE };
    expect(providerEnvModelSettings(both, pinned).settings?.embedding).toMatchObject({ provider: "google", model: "gemini-embedding-001", dimensions: 1536 });
    // Without that provider's key the brain cannot be embedded: say so rather than switch vector spaces.
    expect(providerEnvModelSettings({ OPENAI_API_KEY: OPENAI }, pinned)).toEqual({ settings: null, issue: "embedding_key_missing" });
    expect(await readPinnedEmbedding(path.join(root, "missing"))).toBeNull();
  });

  it("applies the precedence saved Settings -> Models, then provider environment, then not configured", async () => {
    const env = { OPENAI_API_KEY: OPENAI };
    expect(await resolveEffectiveModelSettings(root, root, {})).toEqual({ settings: null, source: null });
    expect(await resolveEffectiveModelSettings(root, root, { ANTHROPIC_API_KEY: ANTHROPIC })).toEqual({ settings: null, source: null, issue: "embedding_provider_required" });
    const fromEnv = await resolveEffectiveModelSettings(root, root, env);
    expect(fromEnv.source).toBe("provider-env");
    expect(fromEnv.settings?.chat.apiKey).toBe(OPENAI);
    const owner = ModelSettingsSchema.parse({
      chat: { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini", apiKey: "owner-saved-key" },
      embedding: { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/text-embedding-3-small", apiKey: "owner-saved-key", dimensions: 1536 },
    });
    await saveModelSettings(root, root, owner);
    const saved = await resolveEffectiveModelSettings(root, root, env);
    expect(saved.source).toBe("knowledge-settings");
    expect(saved.settings?.chat.provider).toBe("openrouter");
    // Nothing from the environment was written to disk.
    expect(await fs.readFile(path.join(root, "model-settings.json"), "utf8")).not.toContain(OPENAI);
  });

  it("never puts a key in the summary", () => {
    const { settings } = providerEnvModelSettings({ ANTHROPIC_API_KEY: ANTHROPIC, OPENAI_API_KEY: OPENAI });
    const summary = modelSettingsSummary(settings, "provider-env");
    expect(summary).toMatchObject({ configured: true, source: "provider-env", chat: { provider: "anthropic", keyConfigured: true, keySource: "provider-env" } });
    expect(JSON.stringify(summary)).not.toMatch(/fake-.*-env-key/u);
  });
});

describe("GET /api/settings/models source", () => {
  const brain = { status: () => ({ status: "disabled" }) } as unknown as GBrainRuntime;
  const headers = { "x-knowledge-settings-token": authority };

  it("reports provider-env, knowledge-settings and not-configured, without values", async () => {
    const app = Fastify();
    // The route reads this object on every request, as it does process.env.
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: OPENAI };
    const setEnv = (next: Record<string, string>) => { for (const key of Object.keys(env)) delete env[key]; Object.assign(env, next); };
    registerModelSettingsRoutes(app, { dataDir: root, gbrainHome: root, authority, brain, providerEnv: env });
    try {
      const fromEnv = (await app.inject({ method: "GET", url: "/api/settings/models", headers })).json();
      expect(fromEnv).toMatchObject({ configured: true, source: "provider-env", chat: { provider: "openai", keySource: "provider-env" } });
      expect(JSON.stringify(fromEnv)).not.toContain(OPENAI);

      setEnv({ ANTHROPIC_API_KEY: ANTHROPIC });
      const incomplete = (await app.inject({ method: "GET", url: "/api/settings/models", headers })).json();
      expect(incomplete).toMatchObject({ configured: false, source: "not-configured", issue: "embedding_provider_required" });
      expect(JSON.stringify(incomplete)).not.toContain(ANTHROPIC);

      setEnv({});
      expect((await app.inject({ method: "GET", url: "/api/settings/models", headers })).json()).toMatchObject({ configured: false, source: "not-configured" });

      setEnv({ OPENAI_API_KEY: OPENAI });
      await saveModelSettings(root, root, ModelSettingsSchema.parse({
        chat: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "saved-chat", apiKey: "owner-saved-key" },
        embedding: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", apiKey: "owner-saved-key", dimensions: 1536 },
      }));
      const owner = (await app.inject({ method: "GET", url: "/api/settings/models", headers })).json();
      expect(owner).toMatchObject({ configured: true, source: "knowledge-settings", chat: { model: "saved-chat" } });
      expect(owner.chat).not.toHaveProperty("keySource");
    } finally { await app.close(); }
  });

  it("does not copy a provider-env key into the saved settings when a save leaves the key blank", async () => {
    const app = Fastify();
    registerModelSettingsRoutes(app, { dataDir: root, gbrainHome: root, authority, brain, providerEnv: { OPENAI_API_KEY: OPENAI } });
    try {
      const connection = { baseUrl: "https://api.openai.com/v1", apiKey: "" };
      const response = await app.inject({ method: "PUT", url: "/api/settings/models", headers, payload: { chat: { ...connection, provider: "openai", model: "m" }, embedding: { ...connection, provider: "openai", model: "e", dimensions: 1536 } } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: "model_api_key_required", component: "chat" });
      await expect(fs.stat(path.join(root, "model-settings.json"))).rejects.toThrow();
    } finally { await app.close(); }
  });
});
