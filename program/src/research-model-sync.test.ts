import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelSettingsSchema, type ModelSettings } from "./model-settings.js";
import { registerModelSettingsRoutes } from "./model-settings-routes.js";
import type { GBrainRuntime } from "./gbrain.js";
import {
  ResearchModelSync,
  effectiveResearchBindings,
  readResearchSettings,
  researchBaseUrl,
  resolveResearchChatModelId,
} from "./research-model-sync.js";

const ENGINE = "http://research-engine.test/";
const ENGINE_TOKEN = "fake-engine-token";
const KEY = "fake-provider-key-one";
const ROTATED = "fake-provider-key-two";
const settings = (apiKey = KEY, embeddingModel = "text-embedding-3-small"): ModelSettings => ModelSettingsSchema.parse({
  chat: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey },
  embedding: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: embeddingModel, apiKey, dimensions: 1536 },
});

type Call = { method: string; path: string; body: Record<string, unknown> | undefined; auth: string | null };

/** In-memory Open Notebook v1.14.0 credentials/models/defaults/notebooks API. */
class FakeEngine {
  calls: Call[] = [];
  encryption = true;
  credentials: { id: string; name: string; provider: string; modalities: string[]; base_url: string | null; api_key: string | null }[] = [];
  models: { id: string; name: string; provider: string; type: string; credential: string | null }[] = [];
  defaults: Record<string, string | null> = { default_chat_model: null, default_embedding_model: null, default_transformation_model: null, default_tools_model: null, large_context_model: null };
  notebooks: { id: string; name: string }[] = [];
  sources: unknown[] = [];
  notes: unknown[] = [];
  failPath: RegExp | null = null;
  private counter = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const headers = new Headers(init?.headers);
    this.calls.push({ method, path: url.pathname + url.search, body, auth: headers.get("authorization") });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (this.failPath?.test(url.pathname)) return this.json(500, { detail: `upstream failure leaking ${body?.api_key ?? ""}` });
    if (headers.get("authorization") !== `Bearer ${ENGINE_TOKEN}`) return this.json(401, { detail: "unauthorized" });
    const p = url.pathname;
    const id = (prefix: string) => `${prefix}:${(++this.counter).toString(36)}`;
    if (method === "GET" && p === "/api/credentials/status") return this.json(200, { configured: {}, source: {}, encryption_configured: this.encryption });
    if (method === "GET" && p.startsWith("/api/credentials/by-provider/")) {
      const provider = decodeURIComponent(p.split("/").pop()!);
      return this.json(200, this.credentials.filter((c) => c.provider === provider).map(this.publicCredential));
    }
    if (method === "GET" && p.startsWith("/api/credentials/")) {
      const found = this.credentials.find((c) => c.id === decodeURIComponent(p.split("/").pop()!));
      return found ? this.json(200, this.publicCredential(found)) : this.json(404, { detail: "Credential not found" });
    }
    if (method === "POST" && p === "/api/credentials") {
      const created = { id: id("credential"), name: String(body!.name), provider: String(body!.provider), modalities: body!.modalities as string[], base_url: (body!.base_url as string) ?? null, api_key: (body!.api_key as string) ?? null };
      this.credentials.push(created);
      return this.json(201, this.publicCredential(created));
    }
    if (method === "PUT" && p.startsWith("/api/credentials/")) {
      const found = this.credentials.find((c) => c.id === decodeURIComponent(p.split("/").pop()!));
      if (!found) return this.json(404, { detail: "Credential not found" });
      if (body!.api_key !== undefined) found.api_key = body!.api_key as string;
      if ("base_url" in body!) found.base_url = (body!.base_url as string | null) || null;
      if (body!.modalities) found.modalities = body!.modalities as string[];
      return this.json(200, this.publicCredential(found));
    }
    if (method === "GET" && p === "/api/models") return this.json(200, this.models.filter((m) => !url.searchParams.get("type") || m.type === url.searchParams.get("type")));
    if (method === "POST" && p === "/api/models") {
      if (this.models.some((m) => m.provider.toLowerCase() === String(body!.provider).toLowerCase() && m.name.toLowerCase() === String(body!.name).toLowerCase() && m.type === body!.type)) return this.json(400, { detail: "exists" });
      const created = { id: id("model"), name: String(body!.name), provider: String(body!.provider), type: String(body!.type), credential: (body!.credential as string) ?? null };
      this.models.push(created);
      return this.json(200, created);
    }
    if (method === "DELETE" && p.startsWith("/api/models/")) {
      this.models = this.models.filter((m) => m.id !== decodeURIComponent(p.split("/").pop()!));
      return this.json(200, { message: "Model deleted successfully" });
    }
    if (method === "GET" && p === "/api/models/defaults") return this.json(200, this.defaults);
    if (method === "PUT" && p === "/api/models/defaults") { Object.assign(this.defaults, body); return this.json(200, this.defaults); }
    if (method === "GET" && p === "/api/sources") return this.json(200, this.sources.slice(0, Number(url.searchParams.get("limit") ?? 50)));
    if (method === "GET" && p === "/api/notes") return this.json(200, this.notes);
    if (method === "POST" && p === "/api/notebooks") {
      const created = { id: id("notebook"), name: String(body!.name) };
      this.notebooks.push(created);
      return this.json(200, { ...created, description: "", archived: false, created: "", updated: "", source_count: 0, note_count: 0 });
    }
    return this.json(404, { detail: "Not Found" });
  };

  writes() { return this.calls.filter((call) => call.method !== "GET"); }
  private publicCredential = ({ api_key, ...rest }: FakeEngine["credentials"][number]) => ({ ...rest, has_api_key: Boolean(api_key), created: "", updated: "", model_count: 0 });
  private json(status: number, value: unknown) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
}

class LocalNotebooks {
  owners = new Map<string, string>();
  create = (companyId: string) => { const id = `notebook_${this.owners.size + 1}`; this.owners.set(id, companyId); return id; };
  ownerOf = (id: string) => this.owners.get(id) ?? null;
}

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-research-sync-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const syncer = (engine: FakeEngine, extra: Partial<ConstructorParameters<typeof ResearchModelSync>[0]> = {}) => new ResearchModelSync({
  baseUrl: ENGINE, token: ENGINE_TOKEN, dataDir: root, fetchImpl: engine.fetch, companyId: "company-1", notebooks: new LocalNotebooks(), ...extra,
});

describe("Research model sync", () => {
  it("configures credential, models, defaults and a workspace binding without storing the key", async () => {
    const engine = new FakeEngine();
    const notebooks = new LocalNotebooks();
    const sync = syncer(engine, { notebooks });
    const result = await sync.sync(settings());
    expect(result).toEqual({ status: "configured" });

    expect(engine.credentials).toEqual([expect.objectContaining({ name: "tealbrick-knowledge-openai", provider: "openai", api_key: KEY, base_url: null, modalities: ["embedding", "language"] })]);
    const credentialId = engine.credentials[0]!.id;
    expect(engine.models).toEqual([
      expect.objectContaining({ name: "gpt-4.1-mini", provider: "openai", type: "language", credential: credentialId }),
      expect.objectContaining({ name: "text-embedding-3-small", provider: "openai", type: "embedding", credential: credentialId }),
    ]);
    const [chat, embedding] = engine.models;
    expect(engine.defaults).toMatchObject({ default_chat_model: chat!.id, default_transformation_model: chat!.id, default_tools_model: chat!.id, large_context_model: chat!.id, default_embedding_model: embedding!.id });
    expect(engine.notebooks).toHaveLength(1);
    expect(engine.calls.every((call) => call.auth === `Bearer ${ENGINE_TOKEN}`)).toBe(true);

    const file = path.join(root, "research-settings.json");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain(KEY);
    const persisted = await readResearchSettings(root);
    expect(persisted).toMatchObject({ credentialId, chatModelId: chat!.id, embeddingModelId: embedding!.id, pendingNotebook: null, lastResult: { status: "configured" } });
    expect(persisted.appliedFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted.bindings).toEqual([{ knowledgeNotebookId: "notebook_1", companyId: "company-1", externalNotebookId: engine.notebooks[0]!.id }]);
    expect(notebooks.ownerOf("notebook_1")).toBe("company-1");
    // Request-time readers see the new state without a restart.
    expect(sync.chatModelId()).toBe(chat!.id);
    expect(sync.bindings()).toEqual(persisted.bindings);
    expect(JSON.stringify(sync.summary())).not.toContain(KEY);
    expect(sync.summary()).toMatchObject({ status: "configured", chatModelConfigured: true, notebookBound: true });
  });

  it("re-runs idempotently with PUT instead of duplicate creates", async () => {
    const engine = new FakeEngine();
    const notebooks = new LocalNotebooks();
    const sync = syncer(engine, { notebooks });
    await sync.sync(settings());
    engine.calls = [];
    expect(await sync.sync(settings())).toEqual({ status: "configured" });
    expect(engine.credentials).toHaveLength(1);
    expect(engine.models).toHaveLength(2);
    expect(engine.notebooks).toHaveLength(1);
    expect(engine.writes().map((call) => `${call.method} ${call.path.replace(/credential%3A[a-z0-9]+/u, "ID")}`)).toEqual(["PUT /api/credentials/ID", "PUT /api/models/defaults"]);
    // A fresh process reading the same file reaches the same answer.
    const restarted = syncer(engine, { notebooks });
    await restarted.load();
    engine.calls = [];
    expect(await restarted.sync(settings(), { onlyIfStale: true })).toEqual({ status: "configured" });
    expect(engine.writes()).toEqual([]);
  });

  it("rotates the key with a credential PUT and a new fingerprint", async () => {
    const engine = new FakeEngine();
    const sync = syncer(engine);
    await sync.sync(settings());
    const before = (await readResearchSettings(root)).appliedFingerprint;
    engine.calls = [];
    expect(await sync.sync(settings(ROTATED), { onlyIfStale: true })).toEqual({ status: "configured" });
    expect(engine.credentials).toHaveLength(1);
    expect(engine.credentials[0]!.api_key).toBe(ROTATED);
    expect(engine.writes().filter((call) => call.method === "POST")).toEqual([]);
    const after = await readResearchSettings(root);
    expect(after.appliedFingerprint).not.toBe(before);
    const raw = await fs.readFile(path.join(root, "research-settings.json"), "utf8");
    expect(raw).not.toContain(ROTATED);
    expect(raw).not.toContain(KEY);
  });

  it("re-applies at startup when Open Notebook lost the defaults", async () => {
    const engine = new FakeEngine();
    const notebooks = new LocalNotebooks();
    await syncer(engine, { notebooks }).sync(settings());
    engine.defaults.default_chat_model = null;
    const restarted = syncer(engine, { notebooks });
    expect(await restarted.sync(settings(), { onlyIfStale: true })).toEqual({ status: "configured" });
    expect(engine.defaults.default_chat_model).toBe(engine.models[0]!.id);
  });

  it("refuses to switch an embedding model that existing content uses", async () => {
    const engine = new FakeEngine();
    engine.models.push({ id: "model:old", name: "nomic-embed-text", provider: "ollama", type: "embedding", credential: null });
    engine.defaults.default_embedding_model = "model:old";
    engine.sources.push({ id: "source:1" });
    const sync = syncer(engine);
    expect(await sync.sync(settings())).toEqual({ status: "embedding_migration_required" });
    expect(engine.defaults.default_embedding_model).toBe("model:old");
    // Chat still follows Settings -> Models.
    expect(engine.defaults.default_chat_model).toBe(sync.chatModelId());
    expect((await readResearchSettings(root)).appliedFingerprint).toBeNull();

    // With no sources or notes there is nothing to re-embed, so the switch is safe.
    engine.sources = [];
    expect(await sync.sync(settings())).toEqual({ status: "configured" });
    expect(engine.defaults.default_embedding_model).not.toBe("model:old");
  });

  it("relinks a same-name model that uses another credential", async () => {
    const engine = new FakeEngine();
    engine.models.push({ id: "model:manual", name: "GPT-4.1-mini", provider: "openai", type: "language", credential: "credential:manual" });
    const sync = syncer(engine);
    expect(await sync.sync(settings())).toEqual({ status: "configured" });
    expect(engine.models.find((model) => model.id === "model:manual")).toBeUndefined();
    expect(engine.models.filter((model) => model.type === "language")).toEqual([expect.objectContaining({ credential: engine.credentials[0]!.id })]);
  });

  it("skips when Research is not installed and reports missing encryption", async () => {
    const engine = new FakeEngine();
    expect(await syncer(engine, { baseUrl: null }).sync(settings())).toEqual({ status: "not-installed" });
    expect(await syncer(engine, { token: null }).sync(settings())).toEqual({ status: "not-installed" });
    expect(engine.calls).toEqual([]);
    await expect(fs.stat(path.join(root, "research-settings.json"))).rejects.toThrow();
    engine.encryption = false;
    expect(await syncer(engine).sync(settings())).toEqual({ status: "encryption_not_configured" });
    expect(engine.writes()).toEqual([]);
  });

  it("maps self-hosted providers onto Open Notebook providers", async () => {
    const engine = new FakeEngine();
    const selfHosted = ModelSettingsSchema.parse({
      chat: { provider: "ollama", baseUrl: "http://ollama.internal:11434/v1", model: "qwen3", apiKey: "any" },
      embedding: { provider: "llama-server", baseUrl: "http://llama.internal:8080", model: "nomic", apiKey: "any", dimensions: 768 },
    });
    expect(await syncer(engine).sync(selfHosted)).toEqual({ status: "configured" });
    expect(engine.credentials.map(({ name, provider, base_url }) => ({ name, provider, base_url }))).toEqual([
      { name: "tealbrick-knowledge-ollama", provider: "ollama", base_url: "http://ollama.internal:11434" },
      { name: "tealbrick-knowledge-openai_compatible", provider: "openai_compatible", base_url: "http://llama.internal:8080/v1" },
    ]);
    expect(researchBaseUrl("openrouter", "https://openrouter.ai/api/v1/")).toBeNull();
    expect(researchBaseUrl("openai", "https://proxy.example/v1")).toBe("https://proxy.example/v1");
  });

  it("reports upstream failures by code only", async () => {
    const engine = new FakeEngine();
    engine.failPath = /^\/api\/credentials$/u;
    const result = await syncer(engine).sync(settings());
    expect(result).toEqual({ status: "failed", error: "research_http_500:credential_create" });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(await fs.readFile(path.join(root, "research-settings.json"), "utf8")).not.toContain(KEY);
  });

  it("unions env and persisted bindings and fails closed on conflicting mappings", () => {
    const env = [{ knowledgeNotebookId: "notebook_a", companyId: "c1", externalNotebookId: "notebook:x" }];
    expect(effectiveResearchBindings(env, [...env])).toEqual(env);
    const conflicting = effectiveResearchBindings(env, [{ knowledgeNotebookId: "notebook_b", companyId: "c1", externalNotebookId: "notebook:x" }]);
    expect(conflicting).toHaveLength(2); // the route mapping index rejects duplicate external ids
  });

  it("keeps an env binding for the workspace instead of creating another", async () => {
    const engine = new FakeEngine();
    const notebooks = new LocalNotebooks();
    notebooks.owners.set("notebook_env", "company-1");
    const sync = syncer(engine, { notebooks, envBindings: [{ knowledgeNotebookId: "notebook_env", companyId: "company-1", externalNotebookId: "notebook:env" }] });
    expect(await sync.sync(settings())).toEqual({ status: "configured" });
    expect(engine.notebooks).toEqual([]);
    expect(sync.bindings()).toHaveLength(1);
  });

  it("resolves the chat model from the env override, else the synced model", () => {
    expect(resolveResearchChatModelId("model:env", { chatModelId: () => "model:synced" })).toBe("model:env");
    expect(resolveResearchChatModelId(null, { chatModelId: () => "model:synced" })).toBe("model:synced");
    expect(resolveResearchChatModelId(" ", { chatModelId: () => null })).toBeNull();
  });
});

describe("Settings -> Models route with Research", () => {
  const secret = "disposable-settings-owner-secret-for-tests";
  const brain = { status: () => ({ status: "online" }), close: async () => undefined, start: async () => undefined } as unknown as GBrainRuntime;
  const testModels = async () => ({ ok: true, checks: [] });

  it("keeps the memory save when Research fails and reports the Research status", async () => {
    const engine = new FakeEngine();
    engine.failPath = /^\/api\/credentials/u;
    const app = Fastify();
    registerModelSettingsRoutes(app, { dataDir: root, gbrainHome: root, brain, authority: secret, testModels, research: syncer(engine) });
    try {
      const response = await app.inject({ method: "PUT", url: "/api/settings/models", headers: { "x-knowledge-settings-token": secret }, payload: settings() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, configured: true, research: { status: "failed" } });
      expect(response.body).not.toContain(KEY);
      expect(JSON.parse(await fs.readFile(path.join(root, "model-settings.json"), "utf8")).chat.model).toBe("gpt-4.1-mini");
      const summary = await app.inject({ method: "GET", url: "/api/settings/models", headers: { "x-knowledge-settings-token": secret } });
      expect(summary.json().research).toMatchObject({ status: "failed" });
      expect(summary.body).not.toContain(KEY);
    } finally { await app.close(); }
  });

  it("configures Research on save", async () => {
    const engine = new FakeEngine();
    const app = Fastify();
    registerModelSettingsRoutes(app, { dataDir: root, gbrainHome: root, brain, authority: secret, testModels, research: syncer(engine) });
    try {
      const response = await app.inject({ method: "PUT", url: "/api/settings/models", headers: { "x-knowledge-settings-token": secret }, payload: settings() });
      expect(response.json().research).toEqual({ status: "configured" });
      expect(response.body).not.toContain(KEY);
      expect(engine.defaults.default_chat_model).toBeTruthy();
    } finally { await app.close(); }
  });

  it("reports not-installed when no Research engine is configured", async () => {
    const app = Fastify();
    registerModelSettingsRoutes(app, { dataDir: root, gbrainHome: root, brain, authority: secret, testModels });
    try {
      const response = await app.inject({ method: "PUT", url: "/api/settings/models", headers: { "x-knowledge-settings-token": secret }, payload: settings() });
      expect(response.json().research).toEqual({ status: "not-installed" });
    } finally { await app.close(); }
  });
});
