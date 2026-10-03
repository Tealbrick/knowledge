/** Program -> signed capability -> Bun worker -> real GBrain -> SSE round trip. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {GBrainRuntime} from "../src/gbrain.js";
import {loadConfig} from "../src/config.js";
import {buildKnowledgeApp} from "../src/app.js";

// A keyless, disposable test must never inherit provider keys or an operator brain.
for(const key of Object.keys(process.env)) if(!["PATH","BUN_INSTALL","TMPDIR","SYSTEMROOT"].includes(key)) delete process.env[key];
const root=await fs.mkdtemp(path.join(os.tmpdir(),"knowledge-native-wire-"));
process.env.HOME=root;
const home=path.join(root,"brain");
const repo=fileURLToPath(new URL("../../sidecars/gbrain",import.meta.url));
await fs.mkdir(path.join(home,".gbrain"),{recursive:true});
await fs.writeFile(path.join(home,".gbrain/config.json"),JSON.stringify({engine:"pglite",database_path:path.join(root,"database"),embedding_model:"openai:text-embedding-3-small",embedding_dimensions:1536}),{mode:0o600});
const runtime=new GBrainRuntime(loadConfig({environment:"test",config:{dataDir:root,gbrainHome:home,gbrainRepoPath:repo,gbrainAutoStart:true,gbrainBaseUrl:null,gbrainToken:null,rulesBaseUrl:null}}));
let app: Awaited<ReturnType<typeof buildKnowledgeApp>>|undefined;
try {
  await runtime.start();
  assert.equal(runtime.status().status,"online",JSON.stringify(runtime.status()));
  const call=(name:string,args:Record<string,unknown>={},partition="fixture-a")=>runtime.nativeOperation(name,args,partition,"fixture-agent");
  const catalog=await call("catalog");
  assert.equal(catalog.ok,true);
  assert.equal(catalog.data.tools.length,21);
  const write=await call("remember",{fact:"Wire fixture uses the cobalt notebook.",provenance:"Disposable transport test"});
  assert.equal(write.ok,true,JSON.stringify(write));
  const recall=await call("recall");
  assert.ok(JSON.stringify(recall.data.facts).includes("cobalt"));
  const foreign=await call("recall",{},"fixture-b");
  assert.ok(!JSON.stringify(foreign.data.facts).includes("cobalt"));
  const invalid=await call("remember",{fact:"Rejected fixture",provenance:""});
  assert.equal(invalid.ok,false);
  assert.equal(invalid.error.error,"provenance_required");
  const synthesis=await call("synthesize",{question:"What is in a nonexistent fixture?"});
  assert.equal(synthesis.ok,false,"No-model synthesis must not masquerade as success");
  assert.equal(synthesis.error.error,"unavailable");
  const erased=await call("forget",{id:write.data.id});
  assert.equal(erased.ok,true,JSON.stringify(erased));
  await runtime.close();
  await runtime.start();
  const after=await call("recall");
  assert.ok(!JSON.stringify(after.data.facts).includes("cobalt"),"expiration survives a real worker restart");
  await runtime.close();
  const config={dataDir:root,gbrainHome:home,gbrainRepoPath:repo,gbrainAutoStart:true,gbrainBaseUrl:null,gbrainToken:null,rulesBaseUrl:null,knowledgeDatabasePath:path.join(root,"knowledge.sqlite"),knowledgeServicePrincipals:[{token:"fixture-only-not-a-real-token",principalId:"fixture-agent",companyId:"fixture-a",capabilities:["brain:read","knowledge:create","knowledge:update","knowledge:delete"]}]};
  const writeHttp={method:"POST" as const,headers:{authorization:"Bearer fixture-only-not-a-real-token","content-type":"application/json","idempotency-key":"native-wire-fixture"},body:JSON.stringify({partitionKey:"fixture-a",arguments:{fact:"HTTP native fixture prefers cobalt.",provenance:"Disposable API test"}})};
  for(let iteration=0;iteration<2;iteration++){
    app=await buildKnowledgeApp({environment:"test",config});
    const url=await app.listen({host:"127.0.0.1",port:0});
    const unauthorized=await fetch(`${url}/api/brain/native/recall`,{...writeHttp,headers:{"content-type":"application/json"}});
    assert.equal(unauthorized.status,401);await unauthorized.arrayBuffer();
    const response=await fetch(`${url}/api/brain/native/remember`,writeHttp);
    assert.equal(response.status,200);
    const receipt=await response.json() as any;
    assert.ok(receipt.receiptId);
    if(iteration)assert.equal(receipt.replay,true,"persistent receipt survives whole Program restart");
    const recallHttp=await fetch(`${url}/api/brain/native/recall`,{...writeHttp,body:JSON.stringify({partitionKey:"fixture-a",arguments:{}})});
    const facts=(await recallHttp.json() as any).data.facts;
    assert.equal(facts.filter((f:any)=>JSON.stringify(f).includes("HTTP native fixture")).length,1,"real API retry does not duplicate fact");
    await app.close();app=undefined;
  }
  console.log(JSON.stringify({ok:true,transport:"Authenticated HTTP Program -> signed worker -> native GBrain",cases:15,receiptRestart:"passed",modelQuality:"not measured; no model configured",production:"untouched"}));
} finally {
  await app?.close();
  await runtime.close();
  await fs.rm(root,{recursive:true,force:true});
}
