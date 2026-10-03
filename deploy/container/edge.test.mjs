import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';

test('instance edge rejects unauthenticated routes and preserves Research scope', async () => {
  const data = await mkdtemp(`${tmpdir()}/knowledge-edge-`);
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const token = randomBytes(32).toString('hex');
  const researchToken = randomBytes(32).toString('hex');
  let revoked = false;
  let returnedOrg = 'fixture-org';
  let expiryOverride;
  const introspections=[];
  const brainCalls=[];
  const brainFixture=createHttpServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/health') {res.end(JSON.stringify({status:'ok',version:'fixture',engine:'pglite'}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);
    brainCalls.push({authorization:req.headers.authorization,...input.params});
    res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:'[]'}]}}));
  });
  await new Promise(r=>brainFixture.listen(0,'127.0.0.1',r));
  const portal=createHttpServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);introspections.push(input);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({authorized:!revoked && input.agentToken==='fixture-agent-token',
      orgId:returnedOrg,agentId:'fixture-agent',deploymentId:'fixture-deployment',
      companyId:'fixture-company',capability:input.capability,expiresAt:new Date(expiryOverride ?? Date.now()+60000).toISOString()}));
  });
  await new Promise(r=>portal.listen(0,'127.0.0.1',r));
  const program = resolve(import.meta.dirname, '../../program');
  const child = spawn(process.execPath, ['--import', 'tsx', '../deploy/container/server.ts'], {
    cwd: program,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
      KNOWLEDGE_DATA_DIR: data, KNOWLEDGE_GBRAIN_AUTOSTART: 'false', KNOWLEDGE_INSTANCE_TOKEN: token,
      GBRAIN_BASE_URL:`http://127.0.0.1:${brainFixture.address().port}`,GBRAIN_TOKEN:'fixture-unpartitioned-token',
      KNOWLEDGE_GBRAIN_PARTITION_TOKENS:JSON.stringify({'fixture-company':'fixture-own-source-token','other':'fixture-foreign-source-token'}),
      TEALBRICK_PORTAL_URL:`http://127.0.0.1:${portal.address().port}`,TEALBRICK_DEPLOYMENT_ID:'fixture-deployment',KNOWLEDGE_COMPANY_ID:'fixture-company',KNOWLEDGE_PORTAL_ORG_ID:'fixture-org',
      KNOWLEDGE_SERVICE_PRINCIPALS: JSON.stringify([{token: researchToken, principalId: 'fixture-agent', companyId: 'fixture-company', capabilities: ['research:read']}]) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let error = ''; child.stderr.on('data', chunk => { error += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(error);
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch {}
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, error);
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/`, { headers: { 'x-knowledge-instance-token': 'wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/healthz?bypass=1`)).status, 401);
    const status = await fetch(`${base}/api/status`, { headers: { 'x-knowledge-instance-token': token } });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('access-control-allow-origin'), null);
    const scoped = await fetch(`${base}/api/research/engine/notebooks`, { headers: { 'x-knowledge-instance-token': token } });
    assert.equal(scoped.status, 401, 'Instance credential must not substitute for Research authority');
    const authorized = await fetch(`${base}/api/research/engine/notebooks`, { headers: {
      'x-knowledge-instance-token': token, authorization: `Bearer ${researchToken}`,
    } });
    assert.equal(authorized.status, 200, 'Research bearer must survive the edge');
    const agentHeaders={authorization:'Bearer fixture-attachment','x-tealbrick-agent-token':'fixture-agent-token','content-type':'application/json'};
    for (const query of ['partitionKey=other', 'partitionKey=fixture-company&partitionKey=other', 'partitionKey=', '%70artitionKey=other']) {
      assert.equal((await fetch(`${base}/api/brain/entities?${query}`, {headers:agentHeaders})).status,401,'Attachment must reject foreign or ambiguous Brain partition selectors');
    }
    assert.equal((await fetch(`${base}/api/brain/entities?kind=pages`, {headers:agentHeaders})).status,200,'Attachment may read its bound partition without supplying a selector');
    assert.equal((await fetch(`${base}/api/brain/entities?kind=pages&partitionKey=fixture-company`, {headers:agentHeaders})).status,200,'Matching explicit partition remains supported');
    for (const endpoint of ['context','recall']) {
      const result=await fetch(`${base}/api/brain/${endpoint}`,{method:'POST',headers:agentHeaders,body:JSON.stringify({query:'fixture',scopeRef:'forged'})});
      assert.equal(result.status,200);
    }
    assert.deepEqual(brainCalls.map(call=>call.name),['list_pages','list_pages','query','recall']);
    assert.ok(brainCalls.every(call=>call.authorization==='Bearer fixture-own-source-token'),'GET and POST must use the bound source credential, never unpartitioned or foreign credentials');
    const beforeDetail=brainCalls.length;
    const slug='folder/a b+č';
    assert.equal((await fetch(`${base}/api/brain/entities?slug=${encodeURIComponent(slug)}&kind=all`,{headers:agentHeaders})).status,200);
    assert.equal(brainCalls.length-beforeDetail,6);
    assert.ok(brainCalls.slice(beforeDetail).every(call=>call.authorization==='Bearer fixture-own-source-token'));
    assert.equal(brainCalls.find(call=>call.name==='get_page').arguments.slug,slug,'Canonical URL forwarding preserves encoded slug values');
    returnedOrg='other-org';
    assert.equal((await fetch(`${base}/api/companies/fixture-company/knowledge/collections`,{headers:agentHeaders})).status,401);
    returnedOrg='fixture-org';
    assert.equal((await fetch(`${base}/api/companies/other/knowledge/collections`,{headers:agentHeaders})).status,401);
    assert.equal((await fetch(`${base}/api/research/engine/notebooks`,{headers:agentHeaders})).status,401);
    const collectionResponse=await fetch(`${base}/api/companies/fixture-company/knowledge/collections`,{method:'POST',headers:agentHeaders,body:JSON.stringify({name:'fixture'})});
    assert.equal(collectionResponse.status,201);
    const collection=await collectionResponse.json();
    const otherCollection=await(await fetch(`${base}/api/companies/other/knowledge/collections`,{method:'POST',headers:{...agentHeaders,'x-knowledge-instance-token':token},body:JSON.stringify({name:'other'})})).json();
    assert.equal((await fetch(`${base}/api/knowledge/collections/${otherCollection.id}/documents`,{method:'POST',headers:agentHeaders,body:JSON.stringify({title:'forbidden'})})).status,401);
    assert.equal((await fetch(`${base}/api/companies/fixture-company/knowledge/collections`,{method:'POST',headers:agentHeaders,body:JSON.stringify({name:'forbidden',sourceConfig:{provider:'github_repo'}})})).status,401);
    const documentResponse=await fetch(`${base}/api/knowledge/collections/${collection.id}/documents`,{method:'POST',headers:agentHeaders,body:JSON.stringify({title:'fixture',body:'private fixture content'})});
    assert.equal(documentResponse.status,201);
    const document=await documentResponse.json();
    assert.equal(document.createdByAgentId,'fixture-agent');
    const unicodeBody='Slovenský text žltý 🧠 remains intact';
    const unicodeBytes=Buffer.from(JSON.stringify({title:'unicode',body:unicodeBody}));
    const split=unicodeBytes.indexOf(Buffer.from('🧠'))+1;
    const unicodeResult=await new Promise((resolve,reject)=>{
      const upload=httpRequest(`${base}/api/knowledge/collections/${collection.id}/documents`,{method:'POST',headers:{...agentHeaders,'content-length':unicodeBytes.length}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
      });
      upload.on('error',reject);
      upload.write(unicodeBytes.subarray(0,split));
      setTimeout(()=>upload.end(unicodeBytes.subarray(split)),30);
    });
    assert.equal(unicodeResult.status,201);
    assert.equal(unicodeResult.body.body,unicodeBody,'UTF8 character split across request chunks must survive');
    assert.equal((await fetch(`${base}/api/knowledge/documents/${document.id}`,{headers:agentHeaders})).status,200);
    returnedOrg='foreign-org';
    assert.equal((await fetch(`${base}/api/companies/fixture-company/knowledge/collections`,{headers:agentHeaders})).status,401,'Attachment must remain bound to the configured Portal organization');
    returnedOrg='fixture-org';
    const brain=await(await fetch(`${base}/api/brain/recall`,{method:'POST',headers:agentHeaders,body:JSON.stringify({query:'fixture',scopeRef:'forged'})})).json();
    assert.equal(brain.scopeRef,'fixture-company');
    assert.ok(introspections.every(item=>Object.keys(item).sort().join(',')==='agentToken,attachment,capability,deploymentId'));
    async function slowPost(afterAuthorized) {
      const body=JSON.stringify({name:'must-not-be-created'});
      let request;
      const response=new Promise((resolve,reject)=>{
        request=httpRequest(`${base}/api/companies/fixture-company/knowledge/collections`,{method:'POST',headers:{...agentHeaders,'content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
        request.on('error',reject);
      });
      const count=introspections.length;
      request.flushHeaders();
      for(let i=0;i<100 && introspections.length===count;i++) await new Promise(r=>setTimeout(r,10));
      assert.ok(introspections.length>count,'Initial introspection must precede delayed body');
      await afterAuthorized();
      request.end(body);
      assert.equal(await response,401,'Expired/revoked delayed request must be denied at dispatch');
    }
    await slowPost(async()=>{await new Promise(r=>setTimeout(r,50));revoked=true;});
    revoked=false;
    expiryOverride=Date.now()+150;
    await slowPost(async()=>{await new Promise(r=>setTimeout(r,200));});
    expiryOverride=undefined;
    revoked=true;
    assert.equal((await fetch(`${base}/api/knowledge/documents/${document.id}`,{headers:agentHeaders})).status,401);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
    await rm(data, { recursive: true, force: true });
    await new Promise(r=>portal.close(r));
    await new Promise(r=>brainFixture.close(r));
  }
});
