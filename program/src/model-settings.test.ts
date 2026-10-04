import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { saveModelSettings, readModelSettings, modelSettingsSummary, ModelSettingsSchema, modelSettingsEnvironment, ModelSettingsUpdateSchema, resolveModelSettingsUpdate } from "./model-settings.js";
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
