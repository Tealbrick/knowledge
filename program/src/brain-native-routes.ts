import path from "node:path";
import {z} from "zod";
import type {FastifyInstance} from "fastify";
import type {MemoryEngine} from "./memory-engine.js";
import {BrainExtractions} from "./brain-extractions.js";
import {normalizeKnowledgePartitionKey} from "./partition-authority.js";
import {nativeOperationAuthorized} from "./brain-native-policy.js";
import {EngineCallLimiter, engineResponseCap, fanOut, mergeNativeResults, nativeMergeBounds} from "./brain-read-view.js";

/**
 * Contract 2: native reads that run once per partition of the read set and merge (stateless lookups, lists and
 * searches). Every other read (cursors and session packs such as delta and context_pack, model calls such as
 * synthesize, think and reflect, bank administration views) runs in one partition only: the one the request selects,
 * its own by default; a request names a read partition to use that one instead.
 */
export const FAN_OUT_NATIVE_READS: ReadonlySet<string> = new Set([
  // GBrain
  "recall", "entity", "query", "search", "get_page", "list_pages", "get_chunks", "resolve_slugs", "get_links", "get_backlinks",
  "traverse_graph", "get_timeline", "find_trajectory", "takes_list", "takes_search",
  // Hindsight
  "recall_memories", "list_memories", "get_memory", "list_entities", "get_entity", "get_entity_graph", "get_graph", "list_documents",
  "get_document", "list_document_chunks", "get_chunk", "search_knowledge_base", "get_knowledge_page", "get_knowledge_base_tree",
  "list_mental_models", "get_mental_model", "list_tags",
]);

/**
 * Native reads that spend model budget or run a model (synthesis, reflection, prompt previews, dry runs). For an edge
 * principal they run only in its write partition (PRD: reflect is single-area, in the write area); naming a read-only
 * partition of the read set is refused with 403 model_operation_write_partition_only.
 */
export const MODEL_COST_NATIVE_OPERATIONS: ReadonlySet<string> = new Set(["think", "synthesize", "reflect", "test_bank_llm"]);
export function modelCostNativeOperation(name: string): boolean {
  return MODEL_COST_NATIVE_OPERATIONS.has(name) || name.startsWith("preview_") || name.startsWith("dry_run_");
}

const requestSchema=z.object({partitionKey:z.string().min(1).max(256),arguments:z.record(z.string(),z.unknown())}).strict();
/** Native engine operations one principal may have in flight; beyond it the route answers 429. */
export const NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL=4;
/**
 * Native requests one principal may have admitted at once (429 beyond). Engine calls are bounded separately and
 * shared with fan-out reads: EngineCallLimiter, MAX_ENGINE_CALLS_PER_PRINCIPAL (brain-read-view.ts).
 */
export function registerNativeMemoryRoutes(app: FastifyInstance, options: {brain: MemoryEngine; dataDir: string; persistent: boolean; engineCalls?: EngineCallLimiter}) {
  const engineCalls=options.engineCalls ?? new EngineCallLimiter();
  const receipts=new BrainExtractions(options.persistent?path.join(options.dataDir,"brain-native-receipts.sqlite"):":memory:");
  app.addHook("onClose",()=>receipts.close());
  const inFlight=new Map<string,number>();
  app.get("/api/brain/native/tools",async(request,reply)=>{
    reply.header("cache-control","no-store");
    const principal=request.knowledgePrincipal, partition=request.knowledgePartitionKey;
    if(!principal || !partition) return reply.code(401).send({ok:false,error:"authentication_required"});
    // Discovery: ?operation=<name> describes one operation, ?query=<text> searches the catalog.
    const query=(request.query??{}) as Record<string,unknown>;
    const selector=Object.fromEntries(["operation","query"].filter(key=>typeof query[key]==="string"&&query[key]).map(key=>[key,String(query[key]).slice(0,200)]));
    let result;
    try { result=await options.brain.nativeOperation("catalog",selector,partition,principal.principalId); }
    catch { return reply.code(503).send({ok:false,error:"native_memory_unavailable"}); }
    if(!result.ok) return reply.code(503).send(result);
    const visible=(t:{name:string})=>{const policy=options.brain.nativeOperationPolicy(t.name);return !!policy&&nativeOperationAuthorized(principal,partition,policy);};
    const tools=result.data.tools.filter(visible).filter((t:{name:string;description?:string})=>!selector.query||`${t.name} ${t.description??""}`.toLowerCase().includes(selector.query.toLowerCase()));
    if(selector.operation&&!tools.some((t:{name:string})=>t.name===selector.operation)) return reply.code(404).send({ok:false,error:"native_operation_unavailable"});
    return {...result,data:{...result.data,tools:selector.operation?tools.filter((t:{name:string})=>t.name===selector.operation):tools}};
  });
  app.post("/api/brain/native/:operation",async(request,reply)=>{
    reply.header("cache-control","no-store");
    const principal=request.knowledgePrincipal, partition=request.knowledgePartitionKey;
    if(!principal || !partition) return reply.code(401).send({ok:false,error:"authentication_required"});
    const {operation}=request.params as {operation:string};
    const policy=options.brain.nativeOperationPolicy(operation);
    if(!policy) return reply.code(404).send({ok:false,error:"native_operation_unavailable"});
    if(!nativeOperationAuthorized(principal,partition,policy)) return reply.code(403).send({ok:false,error:"partition_scope_denied"});
    const writes=policy.scope==="write";
    const input=requestSchema.parse(request.body);
    if(normalizeKnowledgePartitionKey(input.partitionKey)!==partition) return reply.code(403).send({ok:false,error:"partition_scope_denied"});
    const bound=principal.boundPartition;
    if(bound && modelCostNativeOperation(operation) && partition!==bound.partitionKey) {
      return reply.code(403).send({ok:false,error:"model_operation_write_partition_only",
        suggestion:"Model operations (think, synthesize, reflect, preview_*, dry_run_*) run only in this agent's write partition: name the workspace or omit the read partition."});
    }
    const owner=principal.principalId, running=inFlight.get(owner)??0;
    if(running>=NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL) {
      reply.header("retry-after","1");
      return reply.code(429).send({ok:false,error:"too_many_requests",suggestion:`At most ${NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL} native operations may run at once per principal. Retry a write only with the same Idempotency-Key.`});
    }
    inFlight.set(owner,running+1);
    try {
    // Contract 2: a read of its own partition reads every partition of the principal's read set, merged.
    const view=!writes && FAN_OUT_NATIVE_READS.has(operation) ? request.knowledgeReadPartitions : undefined;
    const execute=async()=>{
      if(view) return mergeNativeResults(await fanOut(view,(scope)=>options.brain.nativeOperation(operation,input.arguments,scope,principal.principalId),{limiter:engineCalls,principalId:owner}),
        // The caller's limit (top level or Hindsight body) and the engine's response cap bound the merged answer.
        nativeMergeBounds(input.arguments,engineResponseCap(options.brain.engine)));
      const value=await engineCalls.run(owner,()=>options.brain.nativeOperation(operation,input.arguments,partition,principal.principalId));
      // A handler/storage failure may follow a partial write. Hold the receipt;
      // never turn a transport or internal failure into permission to retry it.
      if(writes && !value.ok && ["internal","storage_error","unavailable"].includes(value.error?.error)) throw new Error("Native write requires reconciliation");
      return value;
    };
    let result;
    if(writes) {
      const key=request.headers["idempotency-key"];
      if(typeof key!=="string"||!key) return reply.code(400).send({ok:false,error:"idempotency_key_required"});
      result=await receipts.run(JSON.stringify([partition,principal.principalId,operation]),key,input.arguments,execute);
    } else {
      try {result=await execute();} catch {return reply.code(503).send({ok:false,error:{error:"unavailable",suggestion:"Inspect the runtime and retry a read. Stateful delta is at-least-once."}});}
    }
    if(!result.ok) {
      const code=typeof result.error==="object"?result.error?.error:result.error;
      reply.code(["invalid_params","argument_refused","provenance_required","invalid_idempotency_key","rejected"].includes(code)?400:code==="not_found"||code==="page_not_found"?404:code==="scope_denied"?403:code==="idempotency_conflict"||code==="conflict"?409:["upstream_auth_failed","invalid_response"].includes(code)?502:503);
    }
    return result;
    } finally { const left=(inFlight.get(owner)??1)-1; if(left>0) inFlight.set(owner,left); else inFlight.delete(owner); }
  });
}
