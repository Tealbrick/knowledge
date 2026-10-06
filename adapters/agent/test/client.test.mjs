import test from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeClient,toolDefinitions,nativeOperations} from '../src/client.mjs';
const settings={baseUrl:'https://knowledge.example',partitionKey:'owner/workspace',token:()=> 'fixture-secret'};
test('two stable tools reach every discovered native operation without endpoint/identity arguments',()=>{
 assert.equal(toolDefinitions.length,2);assert.equal(nativeOperations.length,21);
 assert.equal(toolDefinitions[1].inputSchema.additionalProperties,false);
 assert.equal(toolDefinitions[1].inputSchema.properties.partitionKey,undefined);
});
test('endpoint, missing credentials, scope injection and missing write keys fail closed',async()=>{
 for(const baseUrl of ['http://public.example','https://user:secret@example.test','https://example.test/path','https://example.test/?token=x'])assert.throws(()=>new KnowledgeClient({...settings,baseUrl}));
 let calls=0;const client=new KnowledgeClient({...settings,fetch:()=>{calls++;throw Error('should not run');}});
 for(const input of [{operation:'remember',arguments:{fact:'fixture'}},{operation:'recall',arguments:{source_id:'foreign'}},{operation:'recall',arguments:{},partitionKey:'foreign'},{operation:'SQL;drop',arguments:{}},{operation:'../admin',arguments:{}},{operation:'recall',arguments:{bank_id:'foreign'}}])assert.equal((await client.invoke('knowledge_brain_call',input)).ok,false);
 const missing=new KnowledgeClient({...settings,token:()=>'',fetch:()=>{calls++;}});assert.equal((await missing.invoke('knowledge_brain_tools')).ok,false);assert.equal(calls,0);
});
test('native arguments, receipts, error details and idempotency survive without retries',async()=>{
 const calls=[];const client=new KnowledgeClient({...settings,fetch:async(url,init)=>{calls.push({url,init});return Response.json({ok:false,error:'uncertain_write',receiptId:'receipt',echo:'fixture-secret'},{status:503});}});
 const result=await client.invoke('knowledge_brain_call',{operation:'remember',arguments:{fact:'fixture',provenance:'test'},idempotencyKey:'same-key'});
 assert.equal(result.receiptId,'receipt');assert.equal(result.ok,false);assert.equal(result.echo,'[REDACTED]');assert.equal(calls.length,1);
 assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers['idempotency-key'],'same-key');assert.deepEqual(JSON.parse(calls[0].init.body),{partitionKey:'owner/workspace',arguments:{fact:'fixture',provenance:'test'}});
});
test('unbounded and malformed upstream responses fail closed without leaking credentials',async()=>{
 for(const response of [()=>Response.json({ok:true},{status:403}),()=>new Response('not-json fixture-secret'),()=>new Response('x'.repeat(8*1024*1024+1))]){
  const client=new KnowledgeClient({...settings,fetch:async()=>response()});const result=await client.invoke('knowledge_brain_tools');assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/fixture-secret/);
 }
});
test('discovery forwards describe/search selectors and any well-formed engine operation',async()=>{
 const calls=[];const client=new KnowledgeClient({...settings,fetch:async(url,init)=>{calls.push({url:String(url),init});return Response.json({ok:true,data:{}});}});
 assert.equal((await client.invoke('knowledge_brain_tools',{operation:'recall_memories'})).ok,true);
 assert.equal(new URL(calls[0].url).searchParams.get('operation'),'recall_memories');
 assert.equal((await client.invoke('knowledge_brain_call',{operation:'list_mental_models',arguments:{}})).ok,true);
 assert.equal(new URL(calls[1].url).pathname,'/api/brain/native/list_mental_models');
});
