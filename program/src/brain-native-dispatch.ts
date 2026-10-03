import {MEMORY_VERBS, NATIVE_MEMORY_OPERATIONS, NATIVE_MEMORY_GUIDANCE, nativeMemoryCapabilities} from "./brain-native-policy.js";
import type {NativeMemoryClaim} from "./brain-native-auth.js";

type Param = {type: string; required?: boolean; enum?: unknown[]; items?: Param; [key: string]: unknown};
type Operation = {name: string; description: string; params: Record<string, Param>; scope: string; localOnly?: boolean; annotations?: unknown; handler: (ctx: any, args: any) => Promise<unknown>};
export function nativeMemoryCatalog(operations: Record<string, Operation>, version: string) {
  const tools = NATIVE_MEMORY_OPERATIONS.map(name => {
    const op = operations[name];
    const scope = name === "remember" || name === "forget" ? "write" : "read";
    if (!op || op.localOnly || op.scope !== scope) throw new Error(`Native memory contract mismatch: ${name}`);
    const properties = Object.fromEntries(Object.entries(op.params).filter(([key]) => key !== "source_id").map(([key, def]) => {
      const {required: _, ...schema} = def; return [key, schema];
    }));
    return {name, description: op.description, inputSchema: {type: "object", properties, required: Object.keys(op.params).filter(k => k !== "source_id" && op.params[k]!.required), additionalProperties: false}, annotations: op.annotations,
      scope: op.scope, requiredCapabilities: nativeMemoryCapabilities(name), protocolVersion: (MEMORY_VERBS as readonly string[]).includes(name) ? 1 : null};
  });
  return {engine: "gbrain", engineVersion: version, contract: "knowledge.native-memory/v1", trust: "remote-source-bound", tools, guidance: NATIVE_MEMORY_GUIDANCE,
    sourceSelection: "source_id is server-attested from partitionKey; caller overrides are rejected",
    excluded: "Host administration, filesystem/network ingest, source/credential management, local-only operations and other non-catalog operations are not agent-callable. Canonical document writes and extraction retain their existing Knowledge APIs."};
}
function valid(value: unknown, def: Param): boolean {
  if (def.type === "array") return Array.isArray(value) && (!def.items || value.every(v => valid(v, def.items!)));
  if (def.type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === def.type && (def.type !== "number" || Number.isFinite(value)) && (!def.enum || def.enum.includes(value));
}
function nativeFailure(error: any, version: string) {
  // Keep native protocol fields, but never relay provider credentials or arbitrary exceptions.
  const isNative = typeof error?.toJSON === "function" && typeof error?.code === "string";
  const raw = isNative ? error.toJSON() : {error: "internal", message: "Native memory operation failed", suggestion: "Inspect the private Knowledge runtime logs before retrying a write.", protocol_version: 1};
  const secrets = Object.entries(process.env).filter(([k,v])=>/(?:TOKEN|SECRET|API_KEY|PASSWORD)/u.test(k) && v && v.length >= 8).map(([,v])=>v!);
  const text = JSON.stringify(raw);
  const redacted = secrets.reduce((s,key)=>s.split(key).join("[REDACTED]"), text);
  return {ok: false, engine: "gbrain", engineVersion: version, error: JSON.parse(redacted)};
}
/** Delegates unchanged arguments/results to upstream under its remote trust rules. */
export async function dispatchNativeMemory(input: {claim: NativeMemoryClaim; name: string; args: Record<string, unknown>; operations: Record<string, Operation>; engine: any; config: any; version: string}) {
  const {claim, name, args, operations, engine, config, version} = input;
  if (name !== claim.operation || (name !== "catalog" && !(NATIVE_MEMORY_OPERATIONS as readonly string[]).includes(name))) return {ok: false, error: {error: "scope_denied", message: "Operation does not match signed grant", suggestion: "Use an authorized operation."}};
  if (name === "catalog") return {ok: true, data: nativeMemoryCatalog(operations, version)};
  const op = operations[name];
  const scope = name === "remember" || name === "forget" ? "write" : "read";
  if (!op || op.localOnly || op.scope !== scope) return {ok: false, error: {error: "scope_denied", message: "Operation is not an agent memory operation", suggestion: "Use the advertised catalog."}};
  // Never accept source/context/identity/dry-run injection or silently discard unknown params.
  if (Object.keys(args).some(k => k === "source_id" || !Object.hasOwn(op.params,k)) || Object.entries(op.params).some(([k,d])=>k !== "source_id" && (args[k] === undefined ? d.required : !valid(args[k],d)))) {
    return {ok: false, error: {error: "invalid_params", message: "Arguments do not match the native contract", suggestion: "Read the advertised native inputSchema. source_id is selected by Knowledge.", ...((MEMORY_VERBS as readonly string[]).includes(name)?{protocol_version:1}:{})}};
  }
  const metadata: Record<string, unknown> = {};
  try {
    const ctx = {engine, config, logger: {info(){},warn(){},error(){}}, dryRun: false, remote: true, sourceId: claim.sourceId, takesHoldersAllowList: ["world"],
      auth: {token: "internal", clientId: claim.clientId, sourceId: claim.sourceId, allowedSources: [claim.sourceId], hasSourceGrant: true, scopes: op.scope === "write" ? ["write"] : ["read"]},
      emitResponseMeta(key: string,value: unknown){metadata[key]=value;}};
    const result = await op.handler(ctx, {...args, ...(op.params.source_id ? {source_id: claim.sourceId} : {})});
    return {ok: true, engine: "gbrain", engineVersion: version, operation: name, data: result, metadata};
  } catch (error) { return nativeFailure(error, version); }
}

/** Bounded transport heartbeats, not a retry of an uncertain operation. */
export function nativeMemoryStream(id: string, execute: () => Promise<unknown>): Response {
  const encoder = new TextEncoder(); let cancelled = false; let heartbeat: ReturnType<typeof setInterval>;
  const body = new ReadableStream({
    start(controller) {
      const send = (text: string) => { if (!cancelled) controller.enqueue(encoder.encode(text)); };
      send(": accepted\n\n"); heartbeat=setInterval(()=>send(": working\n\n"),15000);
      execute().then(result=>send(`data: ${JSON.stringify({jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify(result)}]}})}\n\n`),()=>send(`data: ${JSON.stringify({jsonrpc:"2.0",id,error:{code:-32603,message:"Native memory unavailable"}})}\n\n`)).finally(()=>{clearInterval(heartbeat);if(!cancelled)controller.close();});
    },
    cancel(){cancelled=true;clearInterval(heartbeat);},
  });
  return new Response(body,{headers:{"content-type":"text/event-stream","cache-control":"no-store"}});
}
