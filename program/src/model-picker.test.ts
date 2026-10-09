import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { defaultModelManifest, type ModelManifest } from "@tealbrick/contract/models";
import { afterEach, describe, expect, it } from "vitest";
import { ModelManifestResolver, describeSelection, fetchPortalManifest, portalManifestUrl, readAppLocalManifest } from "./model-manifest.js";
import { ProviderModelCache, availableModels, clampReasoningEffort, credentialFor, listProviderModels } from "./model-catalog.js";
import { registerModelSettingsRoutes } from "./model-settings-routes.js";
import { saveModelSettings } from "./model-settings.js";
import type { MemoryEngine } from "./memory-engine.js";

const secret = "disposable-settings-owner-secret-for-picker-tests";
const providerKey = "sk-disposable-picker-provider-key-0123456789";
const owner = { "x-knowledge-settings-token": secret };
const brain = { status: () => ({ status: "disabled" }), close: async () => undefined, start: async () => undefined } as unknown as MemoryEngine;

/** A manifest derived from the bundled one, with its own version and an OpenAI chat recommendation. */
function manifest(version: number, chatModel = "gpt-6-terra"): ModelManifest {
  const copy = JSON.parse(JSON.stringify(defaultModelManifest)) as ModelManifest;
  copy.version = version;
  copy.providers.openai!.roles.chat = { recommended: { model: chatModel, reasoningEffort: "xhigh" }, models: [chatModel], globs: ["gpt-6*"] };
  return copy;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const roots: string[] = [];
async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-model-picker-"));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("model manifest source selection", () => {
  const portal = (m: unknown) => ({ status: "ok" as const, manifest: m as ModelManifest });
  const none = { status: "not-configured" as const };

  it("uses the bundled manifest when nothing else is available", () => {
    expect(describeSelection(none, none)).toMatchObject({ source: "bundled", version: defaultModelManifest.version, portal: { status: "not-configured" }, appLocal: { status: "not-configured" } });
  });
  it("prefers a newer Portal manifest and ignores an older one", () => {
    expect(describeSelection(portal(manifest(3)), none)).toMatchObject({ source: "portal", version: 3 });
    expect(describeSelection(portal(manifest(3)), { status: "ok", manifest: manifest(2) })).toMatchObject({ source: "portal", version: 3 });
    // A Portal copy older than the app-local one loses; one older than the bundled one never wins.
    expect(describeSelection(portal(manifest(2)), { status: "ok", manifest: manifest(4) })).toMatchObject({ source: "app-local", version: 4 });
    const older = { ...manifest(1), version: 1 };
    expect(describeSelection(portal(older), none, { ...manifest(5), version: 5 })).toMatchObject({ source: "bundled", version: 5 });
  });
  it("lets Portal win a tie, and app-local beat bundled at the same version", () => {
    expect(describeSelection(portal(manifest(2)), { status: "ok", manifest: manifest(2) }).source).toBe("portal");
    expect(describeSelection(none, { status: "ok", manifest: manifest(defaultModelManifest.version) }).source).toBe("app-local");
  });
  it("drops an invalid candidate, whatever its version", () => {
    const invalid = { ...manifest(99), schema: "tealbrick.models/0" };
    expect(describeSelection(portal(invalid), none)).toMatchObject({ source: "bundled", version: defaultModelManifest.version });
  });

  it("reads the Portal copy from /.well-known/tealbrick/models and treats 404, timeouts and invalid bodies as absent", async () => {
    expect(portalManifestUrl("https://portal.example/app/x")).toBe("https://portal.example/.well-known/tealbrick/models");
    expect(portalManifestUrl("https://user:pw@portal.example")).toBeNull();
    expect(portalManifestUrl(undefined)).toBeNull();
    const seen: string[] = [];
    const ok = await fetchPortalManifest("https://portal.example/.well-known/tealbrick/models", (async (url: string, init: RequestInit) => {
      seen.push(url);
      expect(new Headers(init.headers).get("authorization")).toBeNull();
      return json(manifest(3));
    }) as unknown as typeof fetch);
    expect(ok).toMatchObject({ status: "ok", manifest: { version: 3 } });
    expect(seen).toEqual(["https://portal.example/.well-known/tealbrick/models"]);
    expect(await fetchPortalManifest("https://portal.example/m", (async () => json({ error: "not_found" }, 404)) as unknown as typeof fetch)).toEqual({ status: "absent" });
    expect(await fetchPortalManifest("https://portal.example/m", (async () => { throw new Error("timeout"); }) as unknown as typeof fetch)).toEqual({ status: "absent" });
    expect(await fetchPortalManifest("https://portal.example/m", (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)).toEqual({ status: "invalid" });
    expect(await fetchPortalManifest("https://portal.example/m", (async () => json({ ...manifest(4), extra: true })) as unknown as typeof fetch)).toEqual({ status: "invalid" });
    expect(await fetchPortalManifest(null)).toEqual({ status: "not-configured" });
  });

  it("caches the Portal answer for ten minutes and never waits long for a slow Portal", async () => {
    const root = await tempRoot();
    let clock = 0, calls = 0;
    const resolver = new ModelManifestResolver({ dataDir: root, portalUrl: "https://portal.example", now: () => clock, fetch: (async () => { calls += 1; return json(manifest(3)); }) as unknown as typeof fetch });
    expect((await resolver.active()).source).toBe("portal");
    clock += 9 * 60_000;
    expect((await resolver.active()).source).toBe("portal");
    expect(calls).toBe(1);
    clock += 2 * 60_000;
    await resolver.active();
    expect(calls).toBe(2);

    let release: (() => void) | undefined;
    const slow = new ModelManifestResolver({ dataDir: root, portalUrl: "https://portal.example", portalWaitMs: 20, fetch: (() => new Promise<Response>((resolve) => { release = () => resolve(json(manifest(3))); })) as unknown as typeof fetch });
    const started = Date.now();
    expect((await slow.active()).source).toBe("bundled");
    expect(Date.now() - started).toBeLessThan(1_000);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await slow.active()).source).toBe("portal");
  });
});

describe("role filtering through the manifest", () => {
  const listed = ["gpt-4o", "gpt-6-luna", "gpt-6-luna", "gpt-5-mini", "text-embedding-3-small", "text-embedding-3-large", "dall-e-3", "whisper-1"];

  it("keeps only the manifest's chat and embedding families and the recommended model", () => {
    const chat = availableModels({ provider: "openai", role: "chat", manifest: defaultModelManifest, listed, keySource: "knowledge-settings" });
    expect(chat).toMatchObject({ listing: "provider", curated: true, models: ["gpt-6-luna", "gpt-5-mini"], recommended: "gpt-6-luna", freeTextOnly: false });
    expect(chat.reasoningEffort).toEqual({ supported: true, options: ["none", "minimal", "low", "medium", "high"], recommended: "low" });
    const embedding = availableModels({ provider: "openai", role: "embedding", manifest: defaultModelManifest, listed, keySource: "knowledge-settings" });
    expect(embedding).toMatchObject({ models: ["text-embedding-3-small", "text-embedding-3-large"], recommended: "text-embedding-3-small", recommendedDimensions: 1536 });
    expect(embedding.reasoningEffort.supported).toBe(false);
  });
  it("shows no recommendation the provider does not list, and no reasoning effort for Anthropic or Google", () => {
    const chat = availableModels({ provider: "openai", role: "chat", manifest: defaultModelManifest, listed: ["gpt-5-mini"], keySource: "provider-env" });
    expect(chat).toMatchObject({ models: ["gpt-5-mini"], recommended: null });
    const anthropic = availableModels({ provider: "anthropic", role: "chat", manifest: defaultModelManifest, listed: ["claude-sonnet-5", "claude-opus-5"], keySource: "provider-env" });
    expect(anthropic).toMatchObject({ models: ["claude-sonnet-5", "claude-opus-5"], recommended: "claude-sonnet-5" });
    expect(anthropic.reasoningEffort).toEqual({ supported: false, options: [], recommended: null });
    // Anthropic has no embeddings role in the manifest: nothing to pick.
    expect(availableModels({ provider: "anthropic", role: "embedding", manifest: defaultModelManifest, listed: ["claude-sonnet-5"], keySource: "provider-env" })).toMatchObject({ listing: "none", freeTextOnly: true, models: [] });
  });
  it("falls back to the manifest's exact ids without a key, and to free text for uncurated providers without a list", () => {
    expect(availableModels({ provider: "google", role: "embedding", manifest: defaultModelManifest, listed: null, keySource: "none" })).toMatchObject({ listing: "manifest", models: ["gemini-embedding-2"], recommended: "gemini-embedding-2", recommendedDimensions: 768 });
    expect(availableModels({ provider: "openrouter", role: "chat", manifest: defaultModelManifest, listed: null, keySource: "none" })).toMatchObject({ listing: "none", freeTextOnly: true });
    // OpenRouter / Ollama with a list but no manifest entry: the list as the provider gave it.
    const ollama = availableModels({ provider: "ollama", role: "chat", manifest: defaultModelManifest, listed: ["llama3.3:70b", "qwen3:8b"], keySource: "knowledge-settings" });
    expect(ollama).toMatchObject({ listing: "provider", curated: false, models: ["llama3.3:70b", "qwen3:8b"], recommended: null });
    expect(ollama.reasoningEffort.supported).toBe(true);
    // OpenRouter's general list holds chat models: it is not offered as embedding or reranker models.
    expect(availableModels({ provider: "openrouter", role: "rerank", manifest: defaultModelManifest, listed: ["openai/gpt-5-mini"], keySource: "knowledge-settings" })).toMatchObject({ listing: "none", freeTextOnly: true });
    expect(availableModels({ provider: "openrouter", role: "chat", manifest: defaultModelManifest, listed: ["openai/gpt-5-mini"], keySource: "knowledge-settings" })).toMatchObject({ listing: "provider", models: ["openai/gpt-5-mini"] });
  });
  it("clamps the manifest's reasoning effort to what the memory engine accepts", () => {
    expect(clampReasoningEffort("xhigh")).toBe("high");
    expect(clampReasoningEffort("max")).toBe("high");
    expect(clampReasoningEffort("minimal")).toBe("minimal");
    expect(clampReasoningEffort(undefined)).toBeNull();
    const chat = availableModels({ provider: "openai", role: "chat", manifest: manifest(2), listed: ["gpt-6-terra"], keySource: "knowledge-settings" });
    expect(chat).toMatchObject({ recommended: "gpt-6-terra", reasoningEffort: { recommended: "high" } });
  });
});

describe("provider model lists", () => {
  it("uses the saved Settings key first, then the provider-env key", () => {
    const saved = { chat: { provider: "openai" as const, baseUrl: "https://gateway.example/v1", model: "m", apiKey: "saved-key" }, embedding: { provider: "openai" as const, baseUrl: "https://gateway.example/v1", model: "e", apiKey: "saved-key", dimensions: 1536 } };
    expect(credentialFor("openai", saved, { OPENAI_API_KEY: "env-key" })).toMatchObject({ baseUrl: "https://gateway.example/v1", apiKey: "saved-key", source: "knowledge-settings" });
    expect(credentialFor("openai", null, { OPENAI_API_KEY: "env-key" })).toMatchObject({ baseUrl: "https://api.openai.com/v1", apiKey: "env-key", source: "provider-env" });
    expect(credentialFor("anthropic", saved, { ANTHROPIC_API_KEY: "env-anthropic" })).toMatchObject({ baseUrl: "https://api.anthropic.com", source: "provider-env" });
    expect(credentialFor("openrouter", saved, { OPENAI_API_KEY: "env-key" })).toBeNull();
  });
  it("calls each provider's own list endpoint with its own auth header", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) });
      if (url.startsWith("https://api.anthropic.com")) return json({ data: [{ id: "claude-sonnet-5" }], has_more: false });
      if (url.startsWith("https://generativelanguage.googleapis.com")) return json({ models: [{ name: "models/gemini-2.5-flash" }, { name: "models/bad id" }] });
      return json({ data: [{ id: "gpt-6-luna" }, { id: 7 }] });
    }) as unknown as typeof fetch;
    expect(await listProviderModels({ provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k1", source: "provider-env" }, fetchImpl)).toEqual(["gpt-6-luna"]);
    expect(await listProviderModels({ provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k2", source: "provider-env" }, fetchImpl)).toEqual(["claude-sonnet-5"]);
    expect(await listProviderModels({ provider: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k3", source: "provider-env" }, fetchImpl)).toEqual(["gemini-2.5-flash"]);
    expect(await listProviderModels({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "k4", source: "knowledge-settings" }, fetchImpl)).toEqual(["gpt-6-luna"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      "http://127.0.0.1:11434/v1/models",
    ]);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer k1");
    expect(calls[1]!.headers.get("x-api-key")).toBe("k2");
    expect(calls[1]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[2]!.headers.get("x-goog-api-key")).toBe("k3");
  });
  it("caches a list for ten minutes per provider and key fingerprint", async () => {
    let clock = 0, calls = 0;
    const cache = new ProviderModelCache(() => clock, (async () => { calls += 1; return json({ data: [{ id: "gpt-6-luna" }] }); }) as unknown as typeof fetch);
    const credential = { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k1", source: "provider-env" as const };
    await cache.list(credential);
    await cache.list(credential);
    expect(calls).toBe(1);
    await cache.list({ ...credential, apiKey: "k2" });
    expect(calls).toBe(2);
    clock += 10 * 60_000 + 1;
    await cache.list(credential);
    expect(calls).toBe(3);
  });
});

describe("Settings -> Models picker routes", () => {
  async function app(options: { fetch: typeof fetch; providerEnv?: Record<string, string>; portalUrl?: string }) {
    const root = await tempRoot();
    const instance = Fastify();
    registerModelSettingsRoutes(instance, { dataDir: root, gbrainHome: root, brain, authority: secret, providerEnv: options.providerEnv ?? {}, fetch: options.fetch, portalUrl: options.portalUrl ?? null });
    return { instance, root };
  }

  it("lists allowed models with the key Knowledge holds and never returns the key", async () => {
    const seen: string[] = [];
    const { instance } = await app({ providerEnv: { OPENAI_API_KEY: providerKey }, fetch: (async (url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("authorization") ?? "");
      return json({ data: [{ id: "gpt-6-luna" }, { id: "gpt-5-mini" }, { id: "whisper-1" }] });
    }) as unknown as typeof fetch });
    const response = await instance.inject({ method: "GET", url: "/api/settings/models/available?provider=openai&role=chat", headers: owner });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, listing: "provider", models: ["gpt-6-luna", "gpt-5-mini"], recommended: "gpt-6-luna", keySource: "provider-env", manifest: { source: "bundled", version: defaultModelManifest.version } });
    expect(response.body).not.toContain(providerKey);
    expect(seen).toEqual([`Bearer ${providerKey}`]);
    expect(response.headers["cache-control"]).toBe("no-store");
    await instance.close();
  });

  it("maps provider failures to clean codes without upstream bodies", async () => {
    for (const [status, code] of [[401, "provider_key_invalid"], [403, "provider_key_invalid"], [500, "provider_unreachable"], [429, "provider_unreachable"]] as const) {
      const { instance } = await app({ providerEnv: { OPENAI_API_KEY: providerKey }, fetch: (async () => json({ error: { message: `Incorrect API key provided: ${providerKey}` } }, status)) as unknown as typeof fetch });
      const response = await instance.inject({ method: "GET", url: "/api/settings/models/available?provider=openai&role=chat", headers: owner });
      expect(response.statusCode).toBe(200);
      // The picker falls back to the manifest's own ids and says why.
      expect(response.json()).toMatchObject({ ok: true, error: code, listing: "manifest", models: ["gpt-6-luna"] });
      expect(response.body).not.toContain(providerKey);
      expect(response.body).not.toContain("Incorrect API key");
      await instance.close();
    }
    const { instance } = await app({ providerEnv: { OPENAI_API_KEY: providerKey }, fetch: (async () => { throw new Error(`connect ECONNREFUSED ${providerKey}`); }) as unknown as typeof fetch });
    const unreachable = await instance.inject({ method: "GET", url: "/api/settings/models/available?provider=openai&role=chat", headers: owner });
    expect(unreachable.json()).toMatchObject({ error: "provider_unreachable" });
    expect(unreachable.body).not.toContain(providerKey);
    await instance.close();
  });

  it("offers free text only for OpenRouter without a list, and refuses unknown providers or roles", async () => {
    let called = false;
    const { instance } = await app({ fetch: (async () => { called = true; return json({ data: [] }); }) as unknown as typeof fetch });
    expect((await instance.inject({ method: "GET", url: "/api/settings/models/available?provider=openrouter&role=chat", headers: owner })).json()).toMatchObject({ ok: true, listing: "none", freeTextOnly: true, keySource: "none" });
    expect(called).toBe(false);
    for (const url of ["/api/settings/models/available?provider=evil&role=chat", "/api/settings/models/available?provider=openai&role=vision", "/api/settings/models/available"]) {
      expect((await instance.inject({ method: "GET", url, headers: owner })).json()).toEqual({ ok: false, error: "invalid_model_query" });
    }
    await instance.close();
  });

  it("is owner-only: an agent grant, a wrong token or a foreign origin gets 403", async () => {
    let called = false;
    const { instance } = await app({ providerEnv: { OPENAI_API_KEY: providerKey }, fetch: (async () => { called = true; return json({ data: [] }); }) as unknown as typeof fetch });
    for (const [method, url] of [["GET", "/api/settings/models/available?provider=openai&role=chat"], ["PUT", "/api/settings/models/manifest"], ["DELETE", "/api/settings/models/manifest"]] as const) {
      for (const headers of [{ authorization: "Bearer tbag_disposable-agent-grant" }, { authorization: "Bearer agent-key" }, { "x-knowledge-settings-token": "wrong" }, { ...owner, origin: "https://attacker.invalid", host: "knowledge.test" }]) {
        const response = await instance.inject({ method, url, headers, ...(method === "PUT" ? { payload: { manifest: manifest(5) } } : {}) });
        expect(response.statusCode).toBe(403);
      }
    }
    expect(called).toBe(false);
    await instance.close();
  });

  it("reports the active manifest source, stores a valid app-local manifest and rejects an invalid one", async () => {
    const { instance, root } = await app({ fetch: (async () => json({}, 404)) as unknown as typeof fetch, portalUrl: "https://portal.example" });
    expect((await instance.inject({ method: "GET", url: "/api/settings/models", headers: owner })).json()).toMatchObject({ manifest: { source: "bundled", version: defaultModelManifest.version, portal: { status: "absent" }, appLocal: { status: "not-configured" } }, embeddingLock: null });

    const invalid = await instance.inject({ method: "PUT", url: "/api/settings/models/manifest", headers: owner, payload: { manifest: "{not json" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ ok: false, error: "model_manifest_invalid", errors: [{ path: "", message: "Not valid JSON" }] });
    const wrong = await instance.inject({ method: "PUT", url: "/api/settings/models/manifest", headers: owner, payload: { manifest: { ...manifest(5), version: 0 } } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().errors[0].path).toBe("/version");
    expect(await readAppLocalManifest(root)).toEqual({ status: "not-configured" });

    const saved = await instance.inject({ method: "PUT", url: "/api/settings/models/manifest", headers: owner, payload: { manifest: JSON.stringify(manifest(5)) } });
    expect(saved.json()).toMatchObject({ ok: true, manifest: { source: "app-local", version: 5 } });
    expect((await fs.stat(path.join(root, "model-manifest.json"))).mode & 0o777).toBe(0o600);
    expect((await instance.inject({ method: "GET", url: "/api/settings/models", headers: owner })).json()).toMatchObject({ manifest: { source: "app-local", version: 5, appLocal: { status: "ok", version: 5 } } });
    expect((await instance.inject({ method: "GET", url: "/api/settings/models/available?provider=openai&role=chat", headers: owner })).json()).toMatchObject({ listing: "manifest", recommended: "gpt-6-terra", manifest: { source: "app-local", version: 5 } });

    expect((await instance.inject({ method: "DELETE", url: "/api/settings/models/manifest", headers: owner })).json()).toMatchObject({ ok: true, manifest: { source: "bundled" } });
    await instance.close();
  });

  it("reports a newer Portal manifest as the source", async () => {
    const { instance } = await app({ fetch: (async (url: string) => url.endsWith("/.well-known/tealbrick/models") ? json(manifest(7)) : json({}, 404)) as unknown as typeof fetch, portalUrl: "https://portal.example" });
    expect((await instance.inject({ method: "GET", url: "/api/settings/models", headers: owner })).json()).toMatchObject({ manifest: { source: "portal", version: 7, portal: { status: "ok", version: 7 } } });
    await instance.close();
  });

  it("reports the embedding model an existing brain is pinned to", async () => {
    const { instance, root } = await app({ fetch: (async () => json({}, 404)) as unknown as typeof fetch });
    await fs.mkdir(path.join(root, ".gbrain"));
    await fs.writeFile(path.join(root, ".gbrain/config.json"), JSON.stringify({ embedding_model: "openai:text-embedding-3-small", embedding_dimensions: 1536 }));
    expect((await instance.inject({ method: "GET", url: "/api/settings/models", headers: owner })).json().embeddingLock).toEqual({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536 });
    // Saving a different embedding model on that brain is still refused (never a silent vector-space change).
    await expect(saveModelSettings(root, root, { chat: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", apiKey: providerKey }, embedding: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-large", apiKey: providerKey, dimensions: 1536 } })).rejects.toThrow("embedding_migration_required");
    await instance.close();
  });
});
