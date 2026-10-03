/** Real pinned GBrain, disposable in-memory database; no provider calls or user data. */
import assert from "node:assert/strict";
import {createBenchmarkBrain} from "../../sidecars/gbrain/src/eval/longmemeval/harness.ts";
import {operationsByName} from "../../sidecars/gbrain/src/core/operations.ts";
import {dispatchNativeMemory,nativeMemoryCatalog} from "../src/brain-native-dispatch.ts";

const engine=await createBenchmarkBrain();
const a=`kb-${"a".repeat(24)}`,b=`kb-${"b".repeat(24)}`;
const version="0.48.2.0";
const config={engine:"pglite"};
let assertions=0;
function check(value:unknown,message:string){assert.ok(value,message);assertions++;}
async function call(name:string,args:Record<string,unknown>,sourceId=a,clientId="kc-fixture-a") {
  return await dispatchNativeMemory({claim:{sourceId,clientId,operation:name,expires:9999999999},name,args,operations:operationsByName as any,engine,config,version}) as any;
}
try {
  for(const source of [a,b]) await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,'{\"federated\":false}'::jsonb)",[source]);
  check(nativeMemoryCatalog(operationsByName as any,version).tools.length===21,"21 native schemas");
  // Native remember does not create a full entity page in a DB-only source.
  // Seed the page through upstream put_page, as Knowledge document projection does.
  await operationsByName.put_page!.handler({engine,config,logger:{info(){},warn(){},error(){}},remote:true,dryRun:false,sourceId:a,auth:{sourceId:a,allowedSources:[a],hasSourceGrant:true,scopes:["write"]}} as any,
    {slug:"people/fixture-vega",source_id:a,content:"---\ntitle: Fixture Vega\ntype: person\nvisibility: world\naliases:\n  - Vega Alias\n---\n# Fixture Vega\nFixture Vega prefers jasmine tea.\n"});
  const fixtureContext={engine,config,logger:{info(){},warn(){},error(){}},remote:true,dryRun:false,sourceId:a,auth:{sourceId:a,allowedSources:[a],hasSourceGrant:true,scopes:["write"]}} as any;
  await operationsByName.put_page!.handler(fixtureContext,{slug:"companies/fixture-lab",source_id:a,content:"---\ntitle: Fixture Lab\ntype: company\nvisibility: world\n---\n# Fixture Lab\nAcceptance fixture only.\n"});
  await operationsByName.add_link!.handler(fixtureContext,{from:"people/fixture-vega",to:"companies/fixture-lab",link_type:"works_at",context:"Native fixture relationship"});
  await operationsByName.add_timeline_entry!.handler(fixtureContext,{slug:"people/fixture-vega",date:"2026-09-18",summary:"Joined fixture laboratory"});
  const remembered=await call("remember",{fact:"Fixture Vega prefers jasmine tea.",provenance:"disposable acceptance fixture",entity:"Fixture Vega"});
  check(remembered.ok,`remember ${JSON.stringify(remembered)}`);
  check(remembered.data.protocol_version===1,"native protocol");
  const id=remembered.data.id;
  check(Boolean(id),"native fact id");
  const duplicate=await call("remember",{fact:"Fixture Vega prefers jasmine tea.",provenance:"disposable acceptance fixture",entity:"Fixture Vega"});
  check(duplicate.ok&&(duplicate.data.status==="duplicate"||duplicate.data.degraded_dedup===true),`native dedup or explicit keyless degradation ${JSON.stringify(duplicate)}`);
  const recall=await call("recall",{query:"jasmine"});
  check(recall.ok&&JSON.stringify(recall.data).includes("jasmine"),`recall ${JSON.stringify(recall)}`);
  const foreign=await call("recall",{query:"jasmine"},b);
  check(foreign.ok&&!JSON.stringify(foreign.data).includes("jasmine tea"),"cross-partition recall isolation");
  const entity=await call("entity",{name:"Fixture Vega"});
  check(entity.ok&&JSON.stringify(entity.data).includes("jasmine"),`entity ${JSON.stringify(entity)}`);
  const alias=await call("entity",{name:"Vega Alias"});
  check(alias.ok&&alias.data.card?.entity?.slug==="people/fixture-vega","native alias resolves same entity");
  const links=await call("get_links",{slug:"people/fixture-vega"});
  check(links.ok&&JSON.stringify(links.data).includes("works_at"),"native typed links survive wrapper");
  const timeline=await call("get_timeline",{slug:"people/fixture-vega"});
  check(timeline.ok&&JSON.stringify(timeline.data).includes("Joined fixture laboratory"),"native timeline survives wrapper");
  const context=await call("context_pack",{entities:"Fixture Vega",session_id:"fixture-session"});
  check(context.ok&&JSON.stringify(context.data).includes("jasmine"),`context ${JSON.stringify(context)}`);
  const readCases: [string,Record<string,unknown>][]=[
    ["get_page",{slug:"people/fixture-vega",include_content:true}],
    ["get_chunks",{slug:"people/fixture-vega"}],["resolve_slugs",{partial:"Fixture Vega"}],
    ["get_links",{slug:"people/fixture-vega"}],["get_backlinks",{slug:"people/fixture-vega"}],
    ["traverse_graph",{slug:"people/fixture-vega",direction:"both"}],["get_timeline",{slug:"people/fixture-vega"}],
    ["find_trajectory",{entity_slug:"people/fixture-vega"}],["takes_list",{}],["takes_search",{query:"jasmine"}],
    ["query",{query:"jasmine",expand:false}],["search",{query:"jasmine"}],
  ];
  for(const [name,args] of readCases){
    const value=await call(name,args);
    check(value.ok,`${name}: ${JSON.stringify(value)}`);
    const outside=await call(name,args,b);
    check(!JSON.stringify(outside).includes("prefers jasmine tea"),`${name} foreign content isolation`);
  }
  const delta=await call("delta",{session_id:"fixture-session"});
  check(delta.ok,`delta ${JSON.stringify(delta)}`);
  const privateFact=await call("remember",{fact:"PRIVATE_OWNER_ONLY_FIXTURE",provenance:"Privacy fixture",visibility:"private",entity:"Fixture Vega"});
  check(privateFact.ok,"native private write semantics preserved");
  const privateRecall=await call("context_pack",{entities:"Fixture Vega",include_private:true});
  check(privateRecall.ok&&!JSON.stringify(privateRecall.data).includes("PRIVATE_OWNER_ONLY_FIXTURE"),"remote cannot widen native private visibility");
  const denied=await call("forget",{id},b);
  check(!denied.ok,`cross-partition forget denied ${JSON.stringify(denied)}`);
  const forgotten=await call("forget",{id});
  check(forgotten.ok,`forget ${JSON.stringify(forgotten)}`);
  if(duplicate.data.id!==id) check((await call("forget",{id:duplicate.data.id})).ok,"expire degraded duplicate fixture");
  const after=await call("recall",{query:"jasmine"});
  check(after.ok&&!JSON.stringify(after.data.facts).includes("jasmine tea"),"expired fact absent; source page intentionally retained");
  // Compare exact native read outputs under identical trust/source context.
  for(const [name,args] of [["recall",{query:"nonexistent-fixture"}],["entity",{name:"Missing fixture"}],["list_pages",{}]] as const){
    const ctx={engine,config,logger:{info(){},warn(){},error(){}},dryRun:false,remote:true,sourceId:a,takesHoldersAllowList:["world"],auth:{clientId:"kc-fixture-a",sourceId:a,allowedSources:[a],hasSourceGrant:true,scopes:["read"]},emitResponseMeta(){}};
    const op=operationsByName[name]!;
    const raw=await op.handler(ctx as any,{...args,...(op.params.source_id?{source_id:a}:{})});
    const wrapped=await call(name,args);
    // Wall-clock latency is inherently different; all semantic fields must match.
    const semantic=(value:any)=>{const {latency_ms,...rest}=value;return rest;};
    assert.deepEqual(semantic(wrapped.data),semantic(raw),`native ${name} result parity`);assertions++;
  }
  console.log(JSON.stringify({ok:true,assertions,engine:"real upstream GBrain",version,providers:"not called",boundary:"disposable in-memory source-bound operation conformance, not model quality"}));
} finally {await engine.disconnect();}
