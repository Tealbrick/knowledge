import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveModelSettings, readModelSettings, modelSettingsSummary, ModelSettingsSchema, modelSettingsEnvironment, ModelSettingsUpdateSchema, resolveModelSettingsUpdate, chatReadinessPayload, readinessProbe, testModelSettings } from "./model-settings.js";
import { registerModelSettingsRoutes } from "./model-settings-routes.js";
import type { GBrainRuntime } from "./gbrain.js";

const secret = "disposable-settings-owner-secret-for-tests";
const settings = { chat: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "test-chat", apiKey: "disposable-provider-key" }, embedding: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "test-embedding", apiKey: "disposable-provider-key", dimensions: 768 } };
describe("Knowledge owner model settings", () => {
  it("routes all three touchpoints through native OpenRouter with shared-provider consistency", () => {
    const connection = {provider:"openrouter",baseUrl:"https://openrouter.ai/api/v1",apiKey:"disposable-router-key"};
    const configured=ModelSettingsSchema.parse({chat:{...connection,model:"openai/gpt-5-mini",reasoningEffort:"low"},embedding:{...connection,model:"openai/text-embedding-3-small",dimensions:1536},reranker:{...connection,model:"cohere/rerank-v3.5"}});
    const env=modelSettingsEnvironment(configured);
    expect(env).toMatchObject({GBRAIN_CHAT_MODEL:"openrouter:openai/gpt-5-mini",GBRAIN_EMBEDDING_MODEL:"openrouter:openai/text-embedding-3-small",KNOWLEDGE_GBRAIN_RERANKER_MODEL:"openrouter:cohere/rerank-v3.5",OPENROUTER_BASE_URL:connection.baseUrl,OPENROUTER_API_KEY:connection.apiKey});
    expect(env.LLAMA_SERVER_RERANKER_API_KEY).toBeUndefined();
    expect(JSON.stringify(modelSettingsSummary(configured))).not.toContain(connection.apiKey);
    expect(()=>modelSettingsEnvironment({...configured,reranker:{...configured.reranker!,apiKey:"different"}})).toThrow("same endpoint and key");
  });
  it("refuses a same-width embedding-model change on an existing brain", async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"knowledge-model-migration-"));
    try {
      await fs.mkdir(path.join(root,".gbrain"));
      await fs.writeFile(path.join(root,".gbrain/config.json"),JSON.stringify({embedding_dimensions:768,embedding_model:"llama-server:old-model"}));
      await expect(saveModelSettings(root,root,settings)).rejects.toThrow("embedding_migration_required");
      await expect(fs.stat(path.join(root,"model-settings.json"))).rejects.toThrow();
    } finally { await fs.rm(root,{recursive:true,force:true}); }
  });
  it("passes an explicit reasoning budget without accepting arbitrary provider options", () => {
    const configured = ModelSettingsSchema.parse({...settings,chat:{...settings.chat,provider:"ollama",reasoningEffort:"low"}});
    expect(modelSettingsEnvironment(configured).KNOWLEDGE_GBRAIN_CHAT_REASONING_EFFORT).toBe("low");
    expect(modelSettingsEnvironment(ModelSettingsSchema.parse(settings)).KNOWLEDGE_GBRAIN_CHAT_REASONING_EFFORT).toBeUndefined();
    expect(ModelSettingsSchema.safeParse({...settings,chat:{...settings.chat,reasoningEffort:"arbitrary"}}).success).toBe(false);
  });
  it("selects the configured reranker instead of only setting its credentials", () => {
    const configured = ModelSettingsSchema.parse({ ...settings, reranker: { baseUrl: "https://models.example/v1", model: "qwen-reranker", apiKey: "test-reranker-key" } });
    expect(modelSettingsEnvironment(configured)).toMatchObject({ KNOWLEDGE_GBRAIN_RERANKER_MODEL: "llama-server-reranker:qwen-reranker", LLAMA_SERVER_RERANKER_BASE_URL: "https://models.example/v1" });
    expect(modelSettingsEnvironment(ModelSettingsSchema.parse(settings)).KNOWLEDGE_GBRAIN_RERANKER_MODEL).toBe("disabled");
  });
  it("stores keys privately, redacts reads and refuses implicit vector migrations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-models-"));
    try {
      await saveModelSettings(root, root, settings);
      expect((await fs.stat(path.join(root,"model-settings.json"))).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(modelSettingsSummary(await readModelSettings(root)))).not.toContain("disposable-provider-key");
      await fs.mkdir(path.join(root,".gbrain"));
      await fs.writeFile(path.join(root,".gbrain/config.json"),JSON.stringify({embedding_dimensions:1536}));
      await expect(saveModelSettings(root,root,settings)).rejects.toThrow("embedding_migration_required");
      expect(ModelSettingsSchema.safeParse({...settings, chat:{...settings.chat,baseUrl:"http://169.254.169.254/latest"}}).success).toBe(false);
    } finally { await fs.rm(root,{recursive:true,force:true}); }
  });
  it("does not treat an agent bearer or same-origin request as instance-owner authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),"knowledge-settings-auth-"));
    const app = Fastify();
    registerModelSettingsRoutes(app,{dataDir:root,gbrainHome:root,authority:secret,brain:{status:()=>({status:"disabled"})} as unknown as GBrainRuntime});
    try {
      for(const headers of [{},{authorization:"Bearer agent-key"},{origin:"http://knowledge.test",host:"knowledge.test"},{"x-knowledge-settings-token":"wrong"}]) expect((await app.inject({method:"GET",url:"/api/settings/models",headers})).statusCode).toBe(403);
      expect((await app.inject({method:"GET",url:"/api/settings/models",headers:{"x-knowledge-settings-token":secret}})).statusCode).toBe(200);
      expect((await app.inject({method:"PUT",url:"/api/settings/models",headers:{"x-knowledge-settings-token":secret,origin:"https://attacker.invalid",host:"knowledge.test"},payload:settings})).statusCode).toBe(403);
    } finally { await app.close(); await fs.rm(root,{recursive:true,force:true}); }
  });
  it("keeps a saved key only for the same provider and endpoint", () => {
    const saved = ModelSettingsSchema.parse(settings);
    const keyless = { chat: { ...settings.chat, apiKey: undefined, model: "renamed-chat" }, embedding: { ...settings.embedding, apiKey: "" } };
    const resolved = resolveModelSettingsUpdate(ModelSettingsUpdateSchema.parse(keyless), saved);
    expect(resolved.chat).toMatchObject({ model: "renamed-chat", apiKey: "disposable-provider-key" });
    expect(resolved.embedding.apiKey).toBe("disposable-provider-key");
    // Moving a key to a different endpoint or provider requires entering it again.
    const moved = ModelSettingsUpdateSchema.parse({ ...keyless, chat: { ...keyless.chat, baseUrl: "https://models.example/v1" } });
    expect(() => resolveModelSettingsUpdate(moved, saved)).toThrow("model_api_key_required");
    const switched = ModelSettingsUpdateSchema.parse({ ...keyless, chat: { ...keyless.chat, provider: "openrouter" } });
    expect(() => resolveModelSettingsUpdate(switched, saved)).toThrow("model_api_key_required");
    expect(() => resolveModelSettingsUpdate(ModelSettingsUpdateSchema.parse(keyless), null)).toThrow("model_api_key_required");
    // A new key replaces the saved one.
    expect(resolveModelSettingsUpdate(ModelSettingsUpdateSchema.parse({ ...keyless, chat: { ...keyless.chat, apiKey: "replacement" }, embedding: { ...keyless.embedding, apiKey: "replacement" } }), saved).chat.apiKey).toBe("replacement");
    // Two models on one provider must share an endpoint and key.
    const conflicting = ModelSettingsUpdateSchema.parse({ ...keyless, embedding: { ...keyless.embedding, apiKey: "different-key" } });
    expect(() => resolveModelSettingsUpdate(conflicting, saved)).toThrow("model_provider_conflict");
  });
  it("PUT without a key reuses the saved key and never echoes it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),"knowledge-settings-keep-"));
    const app = Fastify();
    registerModelSettingsRoutes(app,{dataDir:root,gbrainHome:root,authority:secret,brain:{status:()=>({status:"disabled"})} as unknown as GBrainRuntime});
    try {
      const headers = {"x-knowledge-settings-token":secret};
      const missing = await app.inject({method:"PUT",url:"/api/settings/models",headers,payload:{chat:{...settings.chat,apiKey:""},embedding:{...settings.embedding,apiKey:""}}});
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toEqual({ok:false,error:"model_api_key_required",component:"chat"});
      await saveModelSettings(root,root,settings);
      const summary = (await app.inject({method:"GET",url:"/api/settings/models",headers})).json();
      expect(summary.chat).toMatchObject({provider:"openai",model:"test-chat",keyConfigured:true});
      expect(JSON.stringify(summary)).not.toContain("disposable-provider-key");
      const conflict = await app.inject({method:"PUT",url:"/api/settings/models",headers,payload:{chat:{...settings.chat,apiKey:""},embedding:{...settings.embedding,apiKey:"other"}}});
      expect(conflict.json()).toEqual({ok:false,error:"model_provider_conflict",component:"settings"});
    } finally { await app.close(); await fs.rm(root,{recursive:true,force:true}); }
  });
});

describe("chat readiness payload", () => {
  const chat = { provider: "openai" as const, baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey: "k" };
  it("uses parameters every OpenAI chat model accepts", () => {
    const payload = chatReadinessPayload(chat);
    expect(payload).toMatchObject({ model: "gpt-4.1-mini", max_completion_tokens: 4096 });
    expect(payload).not.toHaveProperty("max_tokens");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
  it("sends only the owner's reasoning effort", () => {
    expect(chatReadinessPayload({ ...chat, model: "gpt-5-mini", reasoningEffort: "low" })).toMatchObject({ reasoning_effort: "low", max_completion_tokens: 4096 });
  });
  it("keeps max_tokens for OpenAI-compatible providers", () => {
    const payload = chatReadinessPayload({ ...chat, provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    expect(payload).toMatchObject({ max_tokens: 4096 });
    expect(payload).not.toHaveProperty("max_completion_tokens");
  });
});

describe("Anthropic and Google model providers", () => {
  const anthropicChat = { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5", apiKey: "fake-anthropic-key" };
  const googleChat = { provider: "google", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "fake-google-key" };
  const googleEmbedding = { provider: "google", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-embedding-2", apiKey: "fake-google-key", dimensions: 768 };
  const openaiEmbedding = { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", apiKey: "fake-openai-key", dimensions: 1536 };

  afterEach(() => { vi.restoreAllMocks(); });

  it("maps Anthropic chat with a separate embedding provider onto the memory engine environment", () => {
    const configured = ModelSettingsSchema.parse({ chat: anthropicChat, embedding: openaiEmbedding });
    expect(modelSettingsEnvironment(configured)).toMatchObject({
      GBRAIN_CHAT_MODEL: "anthropic:claude-sonnet-5",
      GBRAIN_EXPANSION_MODEL: "anthropic:claude-sonnet-5",
      GBRAIN_EMBEDDING_MODEL: "openai:text-embedding-3-small",
      GBRAIN_EMBEDDING_DIMENSIONS: "1536",
      ANTHROPIC_API_KEY: "fake-anthropic-key",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      OPENAI_API_KEY: "fake-openai-key",
    });
  });

  it("maps Google chat and embeddings onto one shared key", () => {
    const configured = ModelSettingsSchema.parse({ chat: googleChat, embedding: googleEmbedding });
    const env = modelSettingsEnvironment(configured);
    expect(env).toMatchObject({ GBRAIN_CHAT_MODEL: "google:gemini-2.5-flash", GBRAIN_EMBEDDING_MODEL: "google:gemini-embedding-2", GBRAIN_EMBEDDING_DIMENSIONS: "768", GOOGLE_GENERATIVE_AI_API_KEY: "fake-google-key" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(() => modelSettingsEnvironment({ ...configured, embedding: { ...configured.embedding, apiKey: "different" } })).toThrow("same endpoint and key");
    expect(JSON.stringify(modelSettingsSummary(configured))).not.toContain("fake-google-key");
  });

  it("tells the owner to pick an embedding provider when Anthropic is chosen for embeddings", async () => {
    const update = ModelSettingsUpdateSchema.parse({ chat: anthropicChat, embedding: { ...anthropicChat, model: "none", dimensions: 1024 } });
    let thrown: unknown;
    try { resolveModelSettingsUpdate(update, null); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "embedding_provider_required", component: "embedding" });
    // The stored shape never accepts it.
    expect(ModelSettingsSchema.safeParse({ chat: anthropicChat, embedding: { ...anthropicChat, dimensions: 1024 } }).success).toBe(false);
    // The owner route answers with the same code, before any provider is called.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-settings-anthropic-"));
    const app = Fastify();
    const testModels = vi.fn();
    registerModelSettingsRoutes(app, { dataDir: root, gbrainHome: root, authority: secret, brain: { status: () => ({ status: "disabled" }) } as unknown as GBrainRuntime, testModels });
    try {
      const response = await app.inject({ method: "PUT", url: "/api/settings/models", headers: { "x-knowledge-settings-token": secret }, payload: { chat: anthropicChat, embedding: { ...anthropicChat, model: "none", dimensions: 1024 } } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: "embedding_provider_required", component: "embedding" });
      expect(testModels).not.toHaveBeenCalled();
    } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("uses only the official host, defaults it, and keeps a saved key across URL spellings", () => {
    const { baseUrl: _omit, ...withoutUrl } = anthropicChat;
    const update = ModelSettingsUpdateSchema.parse({ chat: withoutUrl, embedding: openaiEmbedding });
    expect(resolveModelSettingsUpdate(update, null).chat.baseUrl).toBe("https://api.anthropic.com");
    const saved = ModelSettingsSchema.parse({ chat: anthropicChat, embedding: openaiEmbedding });
    const keyless = ModelSettingsUpdateSchema.parse({ chat: { ...withoutUrl, apiKey: "", baseUrl: "https://api.anthropic.com/v1" }, embedding: { ...openaiEmbedding, apiKey: "" } });
    expect(resolveModelSettingsUpdate(keyless, saved).chat).toMatchObject({ apiKey: "fake-anthropic-key", baseUrl: "https://api.anthropic.com" });
    for (const baseUrl of ["https://api.anthropic.com.evil.test", "https://proxy.example/v1", "http://api.anthropic.com"]) {
      expect(ModelSettingsUpdateSchema.safeParse({ chat: { ...anthropicChat, baseUrl }, embedding: openaiEmbedding }).success, baseUrl).toBe(false);
    }
    expect(ModelSettingsUpdateSchema.safeParse({ chat: { ...googleChat, baseUrl: "https://example.test" }, embedding: googleEmbedding }).success).toBe(false);
    // OpenAI-compatible providers still need an endpoint.
    expect(ModelSettingsUpdateSchema.safeParse({ chat: { provider: "openai", model: "m", apiKey: "k" }, embedding: openaiEmbedding }).success).toBe(false);
  });

  it("keeps reasoning effort and unsafe Google model ids out", () => {
    expect(ModelSettingsSchema.safeParse({ chat: { ...anthropicChat, reasoningEffort: "low" }, embedding: openaiEmbedding }).success).toBe(false);
    expect(ModelSettingsSchema.safeParse({ chat: { ...googleChat, model: "gemini/../../v1/keys" }, embedding: googleEmbedding }).success).toBe(false);
    expect(ModelSettingsSchema.safeParse({ chat: googleChat, embedding: { ...googleEmbedding, model: "x?key=1" } }).success).toBe(false);
  });

  it("probes Anthropic and Google on their native APIs at the official host", () => {
    const settings = ModelSettingsSchema.parse({ chat: anthropicChat, embedding: googleEmbedding });
    const chat = readinessProbe("chat", settings.chat, settings);
    expect(chat.url).toBe("https://api.anthropic.com/v1/messages");
    expect(chat.headers).toMatchObject({ "x-api-key": "fake-anthropic-key", "anthropic-version": "2023-06-01" });
    const embedding = readinessProbe("embedding", settings.embedding, settings);
    expect(embedding.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents");
    expect(embedding.headers["x-goog-api-key"]).toBe("fake-google-key");
    expect((embedding.payload as { requests: { outputDimensionality: number }[] }).requests.every(request => request.outputDimensionality === 768)).toBe(true);
    expect(readinessProbe("chat", ModelSettingsSchema.parse({ chat: googleChat, embedding: googleEmbedding }).chat, settings).url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  });

  it("grades Anthropic chat and Google chat and embeddings from their native responses", async () => {
    const settings = ModelSettingsSchema.parse({ chat: googleChat, embedding: googleEmbedding });
    // Nine canary inputs: each question lies closest to its answer.
    const vector = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0.001));
    const axes = [0, 0, 1, 2, 2, 3, 4, 4, 5];
    const seen: string[] = [];
    const answer = (url: string) => {
      seen.push(url);
      if (url.endsWith(":batchEmbedContents")) return { embeddings: axes.map(axis => ({ values: vector(axis) })) };
      if (url.endsWith(":generateContent")) return { candidates: [{ content: { parts: [{ text: "READY" }] }, finishReason: "STOP" }] };
      return { content: [{ type: "text", text: "READY" }], stop_reason: "end_turn" };
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(JSON.stringify(answer(String(input))), { status: 200 }));
    expect(await testModelSettings(settings)).toEqual({ ok: true, checks: [{ component: "embedding", ok: true }, { component: "chat", ok: true }] });
    const anthropic = ModelSettingsSchema.parse({ chat: anthropicChat, embedding: googleEmbedding });
    expect((await testModelSettings(anthropic)).ok).toBe(true);
    expect(seen).toContain("https://api.anthropic.com/v1/messages");
    // A reply cut off by the token limit, or an empty one, is not ready.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(JSON.stringify(String(input).endsWith("/messages")
      ? { content: [{ type: "text", text: "RE" }], stop_reason: "max_tokens" } : answer(String(input))), { status: 200 }));
    expect((await testModelSettings(anthropic)).checks).toContainEqual({ component: "chat", ok: false, error: "invalid_model_response" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 401 }));
    expect((await testModelSettings(settings)).checks).toEqual([{ component: "embedding", ok: false, error: "provider_http_401" }, { component: "chat", ok: false, error: "provider_http_401" }]);
  });
});
