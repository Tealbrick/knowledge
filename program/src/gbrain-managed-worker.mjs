/** Knowledge-owned, loopback-only adapter to the pinned GBrain core.
 * Not a general GBrain admin/MCP server. Only the Program can mint source
 * capabilities. No filesystem, network ingest, SQL or source-management tool
 * is exposed. Private memory is read in an explicitly source-bound context.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { verifyManagedBrainToken } from "./gbrain-managed-auth.ts";
import { BrainScheduler } from "./brain-scheduler.ts";
import { verifyNativeMemoryToken } from "./brain-native-auth.ts";
import { dispatchNativeMemory, nativeMemoryCatalog, nativeMemoryStream } from "./brain-native-dispatch.ts";

const repo = process.env.KNOWLEDGE_GBRAIN_REPO_PATH;
const secret = process.env.KNOWLEDGE_MANAGED_BRAIN_SECRET;
if (!repo || !secret || secret.length < 32) throw new Error("Managed Brain configuration missing");
const upstream = (file) => import(pathToFileURL(path.join(repo, "src", file)).href);
const { loadConfig, loadConfigWithEngine, toEngineConfig } = await upstream("core/config.ts");
const { createEngine } = await upstream("core/engine-factory.ts");
const { buildGatewayConfig } = await upstream("core/ai/build-gateway-config.ts");
const { configureGateway } = await upstream("core/ai/gateway.ts");
const { operationsByName } = await upstream("core/operations.ts");
const fileConfig = loadConfig();
if (!fileConfig) throw new Error("Managed Brain is not initialized");
configureGateway(buildGatewayConfig(fileConfig));
const engine = await createEngine(toEngineConfig(fileConfig));
await engine.connect(toEngineConfig(fileConfig));
await engine.initSchema();
// Owner model setup selects the actual search reranker, not just its key.
const rerankerModel = process.env.KNOWLEDGE_GBRAIN_RERANKER_MODEL;
if (rerankerModel) {
  if (rerankerModel === "disabled") await engine.setConfig("search.reranker.enabled", "false");
  else {
    if (!/^(llama-server-reranker|openrouter):[a-zA-Z0-9._:/-]{1,180}$/u.test(rerankerModel)) throw new Error("Invalid managed reranker model");
    await engine.setConfig("search.reranker.model", rerankerModel);
    await engine.setConfig("search.reranker.enabled", "true");
  }
}
const config = await loadConfigWithEngine(engine, fileConfig);
const reasoningEffort = process.env.KNOWLEDGE_GBRAIN_CHAT_REASONING_EFFORT;
if (reasoningEffort) {
  if (!["none", "minimal", "low", "medium", "high"].includes(reasoningEffort)) throw new Error("Invalid managed reasoning effort");
  const model = process.env.GBRAIN_CHAT_MODEL;
  if (!model || !/^(openai|ollama|openrouter):/u.test(model)) throw new Error("Managed reasoning model missing");
  // Native gateway configuration, not a replacement generation pipeline.
  config.provider_chat_options = { ...config.provider_chat_options, [model]: { ...config.provider_chat_options?.[model], reasoningEffort } };
}
configureGateway(buildGatewayConfig(config));
const { version } = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8"));
// Fail startup if an upstream upgrade invalidates the reviewed memory surface.
nativeMemoryCatalog(operationsByName, version);

// Internal delete uses source-filtered facts first. Never expose upstream's
// legacy forget_fact(id) directly: its numeric-id handler is not source fenced.
operationsByName.knowledge_delete_projection = {
  params: { slug: { type: "string", required: true }, session_id: { type: "string", required: true } },
  async handler(ctx, p) {
    if (!/^knowledge-(?:docs|research\/sources)\/[a-z0-9_-]+$/u.test(p.slug)) throw new Error("invalid_projection");
    const expected = `${p.slug.startsWith("knowledge-docs/") ? "document" : "research"}:${p.slug.split("/").at(-1)}`;
    if (p.session_id !== expected) throw new Error("invalid_projection");
    // This operation is an internal canonical-record cleanup, not a remote
    // recall response. Keep its source-bound owner visibility so private facts
    // are deleted along with their source record.
    const ownerContext = { ...ctx, remote: false };
    for (let batch = 0; batch < 10; batch++) {
      const found = await operationsByName.recall.handler(ownerContext, { session_id: p.session_id, limit: 100 });
      if (!found.facts?.length) break;
      for (const fact of found.facts) await operationsByName.forget_fact.handler(ownerContext, { id: fact.id, reason: "Canonical Knowledge record removed" });
      if (batch === 9) throw new Error("deletion_batch_incomplete");
    }
    try { return await operationsByName.delete_page.handler(ownerContext, { slug: p.slug, source_id: ctx.sourceId }); }
    catch (error) { if (error?.code === "page_not_found") return { status: "absent" }; throw error; }
  },
};
const allowed = new Set(["put_page", "knowledge_delete_projection", "extract_facts", "recall", "query", "list_pages", "entity", "get_timeline", "find_trajectory", "get_page", "get_links", "traverse_graph"]);
const logger = { info() {}, warn() {}, error() {} }; // Upstream messages may contain corpus or credentials.
const scheduler = new BrainScheduler();
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.KNOWLEDGE_MANAGED_BRAIN_PORT),
  maxRequestBodySize: 1024 * 1024,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        await engine.executeRaw("SELECT 1");
        return Response.json({ status: "ok", version, transport: "http", db: "ok", adapter: "knowledge-source-v1" });
      } catch { return Response.json({ status: "unavailable" }, { status: 503 }); }
    }
    if (request.method !== "POST" || url.pathname !== "/mcp") return new Response(null, { status: 404 });
    // A web page is never an internal Program caller, even on loopback.
    if (request.headers.has("origin")) return new Response(null, { status: 403 });
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /u, "");
    if (bearer.startsWith("kn2.")) {
      const claim = verifyNativeMemoryToken(secret, bearer);
      if (!claim) return new Response(null, {status:401});
      if (scheduler.size >= 16) return Response.json({error:"busy"},{status:429});
      let call; try { call=await request.json(); } catch { return new Response(null,{status:400}); }
      if (call?.jsonrpc!=="2.0" || typeof call.id!=="string" || call.method!=="tools/call" || call.params?.name!=="knowledge_native" || !call.params?.arguments || typeof call.params.arguments!=="object" || Array.isArray(call.params.arguments)) return new Response(null,{status:400});
      return nativeMemoryStream(call.id, ()=>scheduler.run("foreground",request.signal,async()=>{
        await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, NULL, '{\"federated\":false}'::jsonb) ON CONFLICT (id) DO NOTHING",[claim.sourceId]);
        const started=Date.now();
        const result=await dispatchNativeMemory({claim,name:claim.operation,args:call.params.arguments,operations:operationsByName,engine,config,version});
        console.log(JSON.stringify({event:"knowledge.brain.native",operation:claim.operation,sourceId:claim.sourceId,clientId:claim.clientId,ok:result.ok,code:result.error?.error,durationMs:Date.now()-started}));
        return result;
      }));
    }
    const sourceId = verifyManagedBrainToken(secret, bearer);
    if (!sourceId) return new Response(null, { status: 401 });
    if (scheduler.size >= 16) return Response.json({ error: "busy" }, { status: 429 });
    let body;
    try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
    const name = body?.params?.name;
    const args = body?.params?.arguments;
    if (body?.jsonrpc !== "2.0" || typeof body.id !== "string" || body.method !== "tools/call" || !allowed.has(name) || !args || typeof args !== "object" || Array.isArray(args)) return new Response(null, { status: 400 });
    if (args.source_id !== undefined && args.source_id !== sourceId) return new Response(null, { status: 403 });
    const operation = operationsByName[name];
    // Drop the adapter's source hint where upstream doesn't accept it. Scope
    // lives in the authenticated context, never in a caller-selected default.
    const params = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "source_id"));
    if (Object.keys(params).some(key => !(key in operation.params))) return new Response(null, { status: 400 });
    if (operation.params.source_id) params.source_id = sourceId;
    for (const [key, def] of Object.entries(operation.params)) {
      const value = params[key];
      if (value === undefined) { if (def.required) return new Response(null, { status: 400 }); continue; }
      if (def.type === "array" ? !Array.isArray(value) : typeof value !== def.type) return new Response(null, { status: 400 });
    }
    const execute = async () => {
    const started = Date.now();
    try {
      // DB-only source: canonical documents remain Knowledge-owned. SQL is
      // parameterized and engine-portable; never accepts a caller path/URL.
      await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, NULL, '{\"federated\":false}'::jsonb) ON CONFLICT (id) DO NOTHING", [sourceId]);
      const responseMeta = {};
      const ctx = {
        // Managed MCP requests are remote principals, even though this worker
        // calls the operation handler in-process. Preserve remote privacy
        // defaults (for example, world-only legacy recall) at this boundary.
        engine, config, logger, dryRun: false, remote: true,
        sourceId, auth: { token: "internal", clientId: sourceId, scopes: ["read", "write"], sourceId, allowedSources: [sourceId], hasSourceGrant: true },
        emitResponseMeta(key, value) { if (key === "retrieval") responseMeta.retrieval = value; },
      };
      const data = await operation.handler(ctx, params);
      console.log(JSON.stringify({ event: "knowledge.brain.operation", operation: name, sourceId, ok: true, durationMs: Date.now() - started }));
      return { jsonrpc: "2.0", id: body.id, result: { _meta: responseMeta, content: [{ type: "text", text: JSON.stringify(data) }] } };
    } catch (error) {
      const code = ["permission_denied", "scope_denied", "embedding_failed", "extraction_failed", "rate_limited", "invalid_params", "page_not_found", "unavailable"].includes(error?.code) ? error.code : "operation_failed";
      const reason = ["provider_error", "truncated_output", "chat_unavailable", "malformed_output", "refusal", "content_filter", "non_terminal_stop"].includes(error?.reason) ? error.reason : undefined;
      console.log(JSON.stringify({ event: "knowledge.brain.operation", operation: name, sourceId, ok: false, code, reason, durationMs: Date.now() - started }));
      return { jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code }) }] } };
    }
    };
    // Keep local HTTP transport alive across slow model prefill/generation.
    // Client disconnect never cancels an already-started native write.
    const lane = name === "extract_facts" ? "extraction" : name === "knowledge_delete_projection" ? "barrier" : "foreground";
    const encoder = new TextEncoder();
    let disconnected = false;
    let heartbeat;
    const stream = new ReadableStream({
      start(controller) {
        const send = text => { if (!disconnected) { try { controller.enqueue(encoder.encode(text)); } catch { disconnected = true; } } };
        send(": accepted\n\n");
        heartbeat = setInterval(() => send(": working\n\n"), 15000);
        scheduler.run(lane, request.signal, execute).then(result => send(`data: ${JSON.stringify(result)}\n\n`), () => {
          send(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: '{"error":"unavailable"}' }] } })}\n\n`);
        }).finally(() => { clearInterval(heartbeat); if (!disconnected) { disconnected = true; controller.close(); } });
      },
      cancel() { disconnected = true; clearInterval(heartbeat); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  },
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => { server.stop(true); await engine.disconnect(); process.exit(0); });
