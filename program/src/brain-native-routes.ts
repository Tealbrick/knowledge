import path from "node:path";
import {z} from "zod";
import type {FastifyInstance} from "fastify";
import type {GBrainRuntime} from "./gbrain.js";
import {BrainExtractions} from "./brain-extractions.js";
import {authorizeKnowledgePartition, normalizeKnowledgePartitionKey} from "./partition-authority.js";
import {nativeMemoryCapabilities, nativeMemoryOperation, nativeMemoryWrites} from "./brain-native-policy.js";

const requestSchema=z.object({partitionKey:z.string().min(1).max(256),arguments:z.record(z.string(),z.unknown())}).strict();
export function registerNativeMemoryRoutes(app: FastifyInstance, options: {brain: GBrainRuntime; dataDir: string; persistent: boolean}) {
  const receipts=new BrainExtractions(options.persistent?path.join(options.dataDir,"brain-native-receipts.sqlite"):":memory:");
  app.addHook("onClose",()=>receipts.close());
  app.get("/api/brain/native/tools",async(request,reply)=>{
    reply.header("cache-control","no-store");
    const principal=request.knowledgePrincipal, partition=request.knowledgePartitionKey;
    if(!principal || !partition) return reply.code(401).send({ok:false,error:"authentication_required"});
    let result;
    try { result=await options.brain.nativeOperation("catalog",{},partition,principal.principalId); }
    catch { return reply.code(503).send({ok:false,error:"native_memory_unavailable"}); }
    if(!result.ok) return reply.code(503).send(result);
    return {...result,data:{...result.data,tools:result.data.tools.filter((t:{name:string})=>nativeMemoryCapabilities(t.name).every(cap=>authorizeKnowledgePartition(principal,partition,cap).allowed))}};
  });
  app.post("/api/brain/native/:operation",async(request,reply)=>{
    reply.header("cache-control","no-store");
    const principal=request.knowledgePrincipal, partition=request.knowledgePartitionKey;
    if(!principal || !partition) return reply.code(401).send({ok:false,error:"authentication_required"});
    const {operation}=request.params as {operation:string};
    if(!nativeMemoryOperation(operation)) return reply.code(404).send({ok:false,error:"native_operation_unavailable"});
    if(!nativeMemoryCapabilities(operation).every(cap=>authorizeKnowledgePartition(principal,partition,cap).allowed)) return reply.code(403).send({ok:false,error:"partition_scope_denied"});
    const input=requestSchema.parse(request.body);
    if(normalizeKnowledgePartitionKey(input.partitionKey)!==partition) return reply.code(403).send({ok:false,error:"partition_scope_denied"});
    const execute=async()=>{
      const value=await options.brain.nativeOperation(operation,input.arguments,partition,principal.principalId);
      // A handler/storage failure may follow a partial write. Hold the receipt;
      // never turn a transport or internal failure into permission to retry it.
      if(nativeMemoryWrites(operation) && !value.ok && ["internal","storage_error","unavailable"].includes(value.error?.error)) throw new Error("Native write requires reconciliation");
      return value;
    };
    let result;
    if(nativeMemoryWrites(operation)) {
      const key=request.headers["idempotency-key"];
      if(typeof key!=="string"||!key) return reply.code(400).send({ok:false,error:"idempotency_key_required"});
      result=await receipts.run(JSON.stringify([partition,principal.principalId,operation]),key,input.arguments,execute);
    } else {
      try {result=await execute();} catch {return reply.code(503).send({ok:false,error:{error:"unavailable",suggestion:"Inspect the runtime and retry a read. Stateful delta is at-least-once."}});}
    }
    if(!result.ok) {
      const code=typeof result.error==="object"?result.error?.error:result.error;
      reply.code(["invalid_params","provenance_required","invalid_idempotency_key"].includes(code)?400:code==="not_found"||code==="page_not_found"?404:code==="scope_denied"?403:code==="idempotency_conflict"?409:503);
    }
    return result;
  });
}
