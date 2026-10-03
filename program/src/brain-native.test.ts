import {afterEach, describe, expect, it, vi} from "vitest";
import {nativeMemoryToken, verifyNativeMemoryToken} from "./brain-native-auth.js";
import {dispatchNativeMemory, nativeMemoryCatalog} from "./brain-native-dispatch.js";
import {NATIVE_MEMORY_OPERATIONS} from "./brain-native-policy.js";
import {buildKnowledgeApp} from "./app.js";
import {GBrainRuntime} from "./gbrain.js";
import {classifyKnowledgeOperation} from "./policy.js";

const secret="fixture-secret-not-real-".repeat(3), sourceId=`kb-${"a".repeat(24)}`;
const claim={sourceId,clientId:`kc-${"b".repeat(64)}`,operation:"remember",expires:9999999999};
afterEach(()=>vi.restoreAllMocks());
it("binds signed capabilities to operation, source, principal and expiration",()=>{
  const token=nativeMemoryToken(secret,sourceId,"agent-a","remember",1000000);
  expect(verifyNativeMemoryToken(secret,token,1000001)).toMatchObject({sourceId,operation:"remember"});
  expect(verifyNativeMemoryToken(secret,token,1300000)).toBeNull();
  expect(verifyNativeMemoryToken(secret,token+"a",1000001)).toBeNull();
  expect(verifyNativeMemoryToken(secret+"x",token,1000001)).toBeNull();
  expect(verifyNativeMemoryToken(secret,token,1000001)?.clientId).not.toBe(verifyNativeMemoryToken(secret,nativeMemoryToken(secret,sourceId,"agent-b","remember",1000000),1000001)?.clientId);
});
it("delegates native contracts and preserves results/metadata with a remote source fence",async()=>{
  const handler=vi.fn(async(ctx,args)=>{ctx.emitResponseMeta("warning","native warning");return {protocol_version:1,exact:args};});
  const op={name:"remember",description:"Upstream",scope:"write",params:{fact:{type:"string",required:true},source_id:{type:"string"}},handler};
  const base={claim,name:"remember",args:{fact:"Fixture"},operations:{remember:op},engine:{},config:{},version:"fixture"};
  const result=await dispatchNativeMemory(base);
  expect(result).toMatchObject({ok:true,data:{protocol_version:1,exact:{fact:"Fixture",source_id:sourceId}},metadata:{warning:"native warning"}});
  expect(handler.mock.calls[0]![0]).toMatchObject({remote:true,sourceId,takesHoldersAllowList:["world"],auth:{clientId:claim.clientId,allowedSources:[sourceId]}});
  for(const args of [{fact:"x",source_id:"foreign"},{fact:"x",remote:false},{fact:7},{}]) expect(await dispatchNativeMemory({...base,args})).toMatchObject({ok:false,error:{error:"invalid_params"}});
  expect(await dispatchNativeMemory({...base,name:"forget"})).toMatchObject({ok:false,error:{error:"scope_denied"}});
  expect(handler).toHaveBeenCalledTimes(1);
});
it("derives catalog schemas from upstream and fails closed on contract drift",()=>{
  const operations=Object.fromEntries(NATIVE_MEMORY_OPERATIONS.map(name=>[name,{name,description:`native ${name}`,scope:name==="remember"||name==="forget"?"write":"read",params:{query:{type:"string",required:true},source_id:{type:"string"}},handler:async()=>null}]));
  const catalog=nativeMemoryCatalog(operations,"fixture");
  expect(catalog.tools).toHaveLength(21);
  expect(catalog.tools[0]?.inputSchema).toEqual({type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false});
  expect(()=>nativeMemoryCatalog({...operations,remember:{...operations.remember!,scope:"admin"}},"fixture")).toThrow();
  expect(()=>nativeMemoryCatalog({...operations,query:{...operations.query!,scope:"write"}},"fixture")).toThrow();
});
it("preserves native error fields while redacting configured credentials",async()=>{
  vi.stubEnv("KNOWLEDGE_NATIVE_TEST_SECRET","private-fixture-credential");
  try {
    const error={code:"invalid_params",toJSON:()=>({error:"invalid_params",message:"private-fixture-credential",suggestion:"Fix input",protocol_version:1})};
    const result=await dispatchNativeMemory({claim:{...claim,operation:"recall"},name:"recall",args:{},operations:{recall:{name:"recall",description:"native",params:{},scope:"read",handler:async()=>{throw error;}}},engine:{},config:{},version:"fixture"});
    expect(result).toMatchObject({ok:false,error:{error:"invalid_params",message:"[REDACTED]",suggestion:"Fix input",protocol_version:1}});
  } finally {vi.unstubAllEnvs();}
});
it("classifies native reads/writes by their actual operation without forwarding fact payloads",()=>{
  expect(classifyKnowledgeOperation({method:"POST",pathname:"/api/brain/native/forget",body:{partitionKey:"fixture-a",arguments:{fact:"private"}}})).toMatchObject({operation:"knowledge.brain.native.forget",companyId:"fixture-a",payload:{method:"POST"}});
  expect(JSON.stringify(classifyKnowledgeOperation({method:"POST",pathname:"/api/brain/native/remember",body:{arguments:{fact:"private"}}}))).not.toContain("private");
});
describe.each([false,true])("native API requires attested authority (legacy required=%s)",required=>{
  it("enforces capabilities/partition and idempotent native writes",async()=>{
    const invoke=vi.spyOn(GBrainRuntime.prototype,"nativeOperation").mockImplementation(async op=>op==="catalog"?{ok:true,data:{tools:[{name:"remember"},{name:"recall"},{name:"forget"}]}}:{ok:true,data:{id:"fact-1",protocol_version:1}});
    const app=await buildKnowledgeApp({environment:"test",config:{gbrainAutoStart:false,partitionAuthorizationRequired:required,knowledgeServicePrincipals:[
      {token:"fixture-reader",principalId:"reader",companyId:"fixture-a",capabilities:["brain:read"]},
      {token:"fixture-writer",principalId:"writer",companyId:"fixture-a",capabilities:["brain:read","knowledge:create","knowledge:update","knowledge:delete"]},
    ]}});
    try {
      const post=(token:string|undefined,op:string,key?:string,partitionKey="fixture-a",args={fact:"test"})=>app.inject({method:"POST",url:`/api/brain/native/${op}`,headers:{...(token?{authorization:`Bearer ${token}`}:{}) ,...(key?{"idempotency-key":key}:{})},payload:{partitionKey,arguments:args}});
      expect((await post(undefined,"recall")).statusCode).toBe(401);
      expect((await post("fixture-reader","remember","a")).statusCode).toBe(403);
      expect((await post("fixture-reader","forget","a")).statusCode).toBe(403);
      expect((await post("fixture-writer","recall",undefined,"fixture-b")).statusCode).toBe(403);
      expect((await post("fixture-writer","remember")).statusCode).toBe(400);
      expect((await post("fixture-writer","remember","once")).statusCode).toBe(200);
      const count=invoke.mock.calls.length;
      expect((await post("fixture-writer","remember","once")).statusCode).toBe(200);
      expect(invoke.mock.calls).toHaveLength(count);
      expect((await post("fixture-writer","remember","once","fixture-a",{fact:"different"})).statusCode).toBe(409);
      const catalog=await app.inject({url:"/api/brain/native/tools?partitionKey=fixture-a",headers:{authorization:"Bearer fixture-reader"}});
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().data.tools).toEqual([{name:"recall"}]);
      invoke.mockResolvedValue({ok:false,error:{error:"internal"}});
      expect((await post("fixture-writer","remember","uncertain")).statusCode).toBe(503);
      const held=invoke.mock.calls.length;
      expect((await post("fixture-writer","remember","uncertain")).statusCode).toBe(503);
      expect(invoke.mock.calls).toHaveLength(held);
    } finally {await app.close();}
  });
});
