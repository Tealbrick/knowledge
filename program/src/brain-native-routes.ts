import path from "node:path";
import {z} from "zod";
import type {FastifyInstance} from "fastify";
import type {MemoryEngine} from "./memory-engine.js";
import {BrainExtractions} from "./brain-extractions.js";
import {normalizeKnowledgePartitionKey} from "./partition-authority.js";
import {nativeOperationAuthorized} from "./brain-native-policy.js";

const requestSchema=z.object({partitionKey:z.string().min(1).max(256),arguments:z.record(z.string(),z.unknown())}).strict();
/** Native engine operations one principal may have in flight; beyond it the route answers 429. */
export const NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL=4;
export function registerNativeMemoryRoutes(app: FastifyInstance, options: {brain: MemoryEngine; dataDir: string; persistent: boolean}) {
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
    const owner=principal.principalId, running=inFlight.get(owner)??0;
    if(running>=NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL) {
      reply.header("retry-after","1");
      return reply.code(429).send({ok:false,error:"too_many_requests",suggestion:`At most ${NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL} native operations may run at once per principal. Retry a write only with the same Idempotency-Key.`});
    }
    inFlight.set(owner,running+1);
    try {
    const execute=async()=>{
      const value=await options.brain.nativeOperation(operation,input.arguments,partition,principal.principalId);
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
