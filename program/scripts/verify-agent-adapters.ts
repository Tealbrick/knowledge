/** Real MCP stdio + installed Eve extension + Portal runtime -> real Knowledge/GBrain.
 * No provider credentials, no user data, no AVM processes. Node 24, via tsx.
 * Optional TEALBRICK_PACKAGES_PATH selects a locally built client suite to verify.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildKnowledgeApp} from '../src/app.js';
const run=promisify(execFile);
const suite=process.env.TEALBRICK_PACKAGES_PATH;
const repo=fileURLToPath(new URL('../../',import.meta.url));
const adapter=path.join(repo,'adapters/agent');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'knowledge-peripheral-'));
for(const key of Object.keys(process.env))if(!['PATH','BUN_INSTALL','TMPDIR','SYSTEMROOT'].includes(key))delete process.env[key];
process.env.HOME=root;
const home=path.join(root,'brain');
await fs.mkdir(path.join(home,'.gbrain'),{recursive:true});
await fs.writeFile(path.join(home,'.gbrain/config.json'),JSON.stringify({engine:'pglite',database_path:path.join(root,'brain-db'),embedding_model:'openai:text-embedding-3-small',embedding_dimensions:1536}),{mode:0o600});
const principals=[{token:'disposable-owner-token',principalId:'owner',companyId:'fixture-a',capabilities:['brain:read','knowledge:create','knowledge:update','knowledge:delete']},{token:'disposable-reader-token',principalId:'reader',companyId:'fixture-a',capabilities:['brain:read']},{token:'disposable-other-token',principalId:'other',companyId:'fixture-b',capabilities:['brain:read']}];
const app=await buildKnowledgeApp({environment:'test',config:{dataDir:root,gbrainHome:home,gbrainRepoPath:path.join(repo,'sidecars/gbrain'),gbrainAutoStart:true,gbrainBaseUrl:null,gbrainToken:null,rulesBaseUrl:null,knowledgePartitionAuthRequired:true,knowledgeServicePrincipals:principals}});
const checks:string[]=[];const closeables:any[]=[];
try {
 const url=await app.listen({host:'127.0.0.1',port:0});
 const sdk=(relative:string)=>import(pathToFileURL(path.join(adapter,'node_modules/@modelcontextprotocol/sdk/dist/esm',relative)).href);
 const {Client}=await sdk('client/index.js');const {StdioClientTransport}=await sdk('client/stdio.js');
 const {KnowledgeClient}=await import(pathToFileURL(path.join(adapter,'src/client.mjs')).href);
 const direct=new KnowledgeClient({baseUrl:url,partitionKey:'fixture-a',token:()=>principals[0].token});
 const env={PATH:process.env.PATH!,HOME:root,CI:'1',NO_COLOR:'1',KNOWLEDGE_BASE_URL:url,KNOWLEDGE_PARTITION_KEY:'fixture-a',KNOWLEDGE_SERVICE_TOKEN:principals[0].token};
 const mcp=new Client({name:'peripheral-proof',version:'1'});closeables.push(mcp);
 await mcp.connect(new StdioClientTransport({command:process.execPath,args:[path.join(adapter,'src/mcp.mjs')],env,stderr:'pipe'}));
 assert.equal((await mcp.listTools()).tools.length,2);checks.push('standalone MCP initialize/list');
 const invoke=async(name:string,args:any={})=>{const r=await mcp.callTool({name,arguments:args},undefined,{timeout:180000});return {envelope:r,result:JSON.parse(r.content[0].text)};};
 assert.equal((await invoke('knowledge_brain_tools')).result.data.tools.length,21);checks.push('MCP authenticated native catalog');
 const writeArgs={operation:'remember',arguments:{fact:'Peripheral fixture stores cobalt notebooks.',provenance:'Disposable adapter acceptance'},idempotencyKey:'adapter-proof'};
 const write=await invoke('knowledge_brain_call',writeArgs);assert.equal(write.result.ok,true,JSON.stringify(write));assert.ok(write.result.receiptId);checks.push('MCP native remember plus receipt');
 const replay=await invoke('knowledge_brain_call',writeArgs);assert.equal(replay.result.replay,true);checks.push('MCP idempotent replay');
 assert.match(JSON.stringify((await invoke('knowledge_brain_call',{operation:'recall',arguments:{}})).result),/cobalt/);checks.push('MCP recall persisted fact');
 assert.equal((await invoke('knowledge_brain_call',{operation:'recall',arguments:{source_id:'foreign'}})).envelope.isError,true);checks.push('MCP scope override rejected');
 const other=new KnowledgeClient({baseUrl:url,partitionKey:'fixture-b',token:()=>principals[2].token});
 assert.doesNotMatch(JSON.stringify(await other.invoke('knowledge_brain_call',{operation:'recall',arguments:{}})),/cobalt/);checks.push('foreign tenant cannot read fixture');
 const reader=new KnowledgeClient({baseUrl:url,partitionKey:'fixture-a',token:()=>principals[1].token});
 assert.equal((await reader.invoke('knowledge_brain_call',writeArgs)).ok,false);checks.push('read-only principal cannot remember');
 // Pack the actual built extension. Isolated consumer resolves already-installed dependencies;
 // this proves the tarball and Eve runtime, not a fresh registry download.
 const pack=JSON.parse((await run('npm',['pack','--json','--pack-destination',root],{cwd:adapter})).stdout)[0];
 const consumer=path.join(root,'consumer');const modules=path.join(consumer,'node_modules');await fs.mkdir(path.join(modules,'@tealbrick'),{recursive:true});
 const installed=path.join(modules,'@tealbrick/knowledge-agent');await fs.mkdir(installed);
 await run('tar',['-xzf',path.join(root,pack.filename),'-C',installed,'--strip-components=1']);
 const dependencies=await fs.realpath(path.join(adapter,'node_modules'));
 for(const item of await fs.readdir(dependencies)){if(item==='@tealbrick'||item==='.bin')continue;await fs.symlink(path.join(dependencies,item),path.join(modules,item));}
 await fs.writeFile(path.join(consumer,'package.json'),JSON.stringify({name:'knowledge-disposable-consumer',private:true,type:'module',dependencies:{'@tealbrick/knowledge-agent':'0.1.0',eve:'0.58.1'}}));
 await fs.mkdir(path.join(consumer,'agent/extensions'),{recursive:true});await fs.mkdir(path.join(consumer,'evals'));
 await fs.writeFile(path.join(consumer,'agent/instructions.md'),'Disposable Knowledge adapter fixture. Use the requested memory tool only.');
 await fs.writeFile(path.join(consumer,'evals/evals.config.ts'),`import {defineEvalConfig} from 'eve/evals';export default defineEvalConfig({maxConcurrency:1,timeoutMs:60000});`);
 await fs.writeFile(path.join(consumer,'agent/agent.ts'),`import {defineAgent} from 'eve';import {mockModel} from 'eve/evals';export default defineAgent({modelContextWindowTokens:100000,model:mockModel(({toolResults})=>toolResults.length?JSON.stringify(toolResults):{toolCalls:[{name:'knowledge__brain_call',input:{operation:'recall',arguments:{}}}]})});`);
 await fs.writeFile(path.join(consumer,'agent/extensions/knowledge.ts'),`import knowledge from '@tealbrick/knowledge-agent';export default knowledge({baseUrl:${JSON.stringify(url)},partitionKey:'fixture-a',tokenEnv:'KNOWLEDGE_SERVICE_TOKEN'});`);
 await fs.writeFile(path.join(consumer,'evals/knowledge.eval.ts'),`import {defineEval} from 'eve/evals';export default defineEval({async test(t){await t.send('Read the memory fixture');t.succeeded();t.calledTool('knowledge__brain_call',{count:1});t.messageIncludes('cobalt');}});`);
 const eve=path.join(modules,'eve/bin/eve.js');
 const info=JSON.parse((await run(process.execPath,[eve,'info','--json'],{cwd:consumer,env,maxBuffer:8388608})).stdout);
 assert.equal(info.status,'ready',await fs.readFile(info.artifacts.diagnostics,'utf8'));assert.equal(info.diagnostics.errors,0);assert.ok(info.tools.includes('knowledge__brain_call'));assert.ok(info.tools.includes('knowledge__brain_tools'));checks.push('tarball-installed Eve extension discovery');
 await run(process.execPath,[eve,'build'],{cwd:consumer,env,maxBuffer:8388608,timeout:180000});checks.push('tarball-installed Eve consumer production build');
 const evalResult=await run(process.execPath,[eve,'eval','--strict','--skip-report','--json','--max-concurrency','1'],{cwd:consumer,env,maxBuffer:8388608,timeout:240000});
 const evaluated=JSON.parse(evalResult.stdout.slice(evalResult.stdout.indexOf('{\n')));assert.equal(evaluated.passed,1);assert.equal(evaluated.failed,0);assert.equal(evaluated.errored,0);checks.push('real Eve session executes installed memory tool against actual GBrain');
 if(suite){
  const {RuntimeConnector}=await import(pathToFileURL(path.join(suite,'packages/portal/dist/runtime.js')).href);
  const {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT}=await import(pathToFileURL(path.join(suite,'node_modules/jose/dist/webapi/index.js')).href);
  const {privateKey,publicKey}=await generateKeyPair('ES256');const keys=createLocalJWKSet({keys:[await exportJWK(publicKey)]});
  const identity={issuer:'https://portal.invalid',org:'org',workspaceId:'workspace',agentId:'agent',connectionId:'connection'};
  const now=Math.floor(Date.now()/1000);const config=await new SignJWT({...identity,typ:'tealbrick-runtime-config',version:1,sub:'agent',iss:identity.issuer,aud:'tealbrick-runtime',iat:now,exp:now+300,revision:'a'.repeat(64),apps:[{registrationId:'r',appId:'knowledge',major:1,bindingRef:'local',instanceId:'instance',companyId:'fixture-a',actions:['read'],entitlement:{licenseId:'license',major:1}}]}).setProtectedHeader({alg:'ES256'}).sign(privateKey);
  const requests:any[]=[];const connector=new RuntimeConnector({...identity,keys,credential:()=> 'disposable-portal-token',resolveCredential:()=>principals[0].token,bindings:{local:{endpoint:url,instanceId:'instance',companyId:'fixture-a',credentialRef:'TEALBRICK_KNOWLEDGE_TOKEN'}},fetch:async(input:any,init:any)=>{const u=new URL(input);if(u.origin===identity.issuer){requests.push({path:u.pathname,body:init.body});return Response.json(u.pathname.endsWith('/ack')?{ok:true}:{config,revision:'a'.repeat(64)});}return fetch(input,init);}});
  const {createMcp}=await import(pathToFileURL(path.join(suite,'packages/codex/dist/mcp.js')).href);const {InMemoryTransport}=await sdk('inMemory.js');
  const server=createMcp(connector);closeables.push(server);const client=new Client({name:'portal-mcp-proof',version:'1'});closeables.push(client);const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  const catalog=await client.callTool({name:'tealbrick_call',arguments:{registrationId:'r',operation:'memory_tools',input:{}}});assert.equal(catalog.isError,false);assert.equal(JSON.parse(catalog.content[0].text).data.tools.some((t:any)=>t.name==='remember'),false);checks.push('Portal MCP catalog intersects server and signed grants');
  const recalled=await client.callTool({name:'tealbrick_call',arguments:{registrationId:'r',operation:'memory_native_recall',input:{arguments:{}}}});assert.equal(recalled.isError,false);assert.match(JSON.stringify(recalled),/cobalt/);checks.push('Portal MCP signed grant -> customer-side native recall');
  const denied=await client.callTool({name:'tealbrick_call',arguments:{registrationId:'r',operation:'memory_native_remember',input:{arguments:{fact:'denied',provenance:'fixture'},idempotencyKey:'denied'}}});assert.equal(denied.isError,true);checks.push('Portal MCP denies write despite broader local app token');
  assert.doesNotMatch(JSON.stringify(requests),/cobalt|disposable-owner-token/);checks.push('Portal receives no memory contents or app secret');
  const {appCallTool}=await import(pathToFileURL(path.join(suite,'packages/kit/dist/runtime-eve.js')).href);
  const originalFetch=globalThis.fetch;
  process.env.TEALBRICK_RUNTIME_CREDENTIAL='disposable-portal-token';process.env.TEALBRICK_KNOWLEDGE_TOKEN=principals[0].token;
  globalThis.fetch=async(input:any,init:any)=>{const u=new URL(input);if(u.origin===identity.issuer){if(u.pathname==='/.well-known/jwks.json')return Response.json({keys:[await exportJWK(publicKey)]});return Response.json(u.pathname.endsWith('/ack')?{ok:true}:{config,revision:'a'.repeat(64)});}return originalFetch(input,init);};
  try {
   const tool=appCallTool({...identity,credentialRef:'TEALBRICK_RUNTIME_CREDENTIAL',bindings:{local:{endpoint:url,instanceId:'instance',companyId:'fixture-a',credentialRef:'TEALBRICK_KNOWLEDGE_TOKEN'}}});
   assert.ok(tool.inputSchema.properties.operation.enum.includes('memory_native_get_page'));
   const recalled=await tool.execute({registrationId:'r',operation:'memory_native_recall',input:{arguments:{}}},{abortSignal:new AbortController().signal});
   assert.equal(recalled.ok,true);assert.match(JSON.stringify(recalled),/cobalt/);
   await assert.rejects(()=>tool.execute({registrationId:'r',operation:'memory_native_forget',input:{arguments:{id:write.result.data.id},idempotencyKey:'denied-eve'}},{abortSignal:new AbortController().signal}),/runtime_action_denied/);
   checks.push('actual Tealbrick Eve-kit executor: native recall and signed Delete denial');
  }finally{globalThis.fetch=originalFetch;delete process.env.TEALBRICK_RUNTIME_CREDENTIAL;delete process.env.TEALBRICK_KNOWLEDGE_TOKEN;}
 }
 assert.equal((await direct.invoke('knowledge_brain_call',{operation:'forget',arguments:{id:write.result.data.id},idempotencyKey:'adapter-forget'})).ok,true);checks.push('native forget through client');
 console.log(JSON.stringify({ok:true,checks,tarball:pack.filename,eve:'0.58.1',model:'deterministic fixture only; no new accuracy claim',liveServices:'untouched'},null,2));
}catch(error:any){console.error(String(error?.stdout??''),String(error?.stderr??''));throw error;}
finally{for(const item of closeables.reverse())await item.close().catch(()=>{});await app.close();await fs.rm(root,{recursive:true,force:true});}
