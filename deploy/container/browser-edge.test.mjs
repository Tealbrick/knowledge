import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test('actual Knowledge edge launches an owner browser, admits local document controls and revokes each call', async t => {
  const data = await mkdtemp(`${tmpdir()}/knowledge-browser-edge-`);
  const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const base = `http://127.0.0.1:${port}`, instance = 'i'.repeat(43), session = 's'.repeat(43), ticket = 't'.repeat(43);
  let revoked = false, used = false; const calls = [];
  const portal = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); calls.push(input);
    let authorized = !revoked && req.headers['x-knowledge-instance-token'] === instance && input.schema === 1 && input.product === 'knowledge' && input.deploymentId === 'deployment';
    if (req.url.endsWith('/redeem')) { authorized &&= !used && input.ticket === ticket; used = true; }
    else authorized &&= input.session === session;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ schema: 1, authorized, product: 'knowledge', session, deploymentId: 'deployment', workspaceId: 'workspace', companyId: 'workspace', userId: 'owner', orgId: 'org', instanceProofAudience: 'tealbrick/knowledge/deployment', endpoint: base, expiresAt: Date.now() + 60000 }));
  });
  await new Promise(r => portal.listen(0, '127.0.0.1', r));
  const portalOrigin = `http://127.0.0.1:${portal.address().port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', '../deploy/container/server.ts'], { cwd: resolve(import.meta.dirname, '../../program'), env: { PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), KNOWLEDGE_DATA_DIR: data, KNOWLEDGE_GBRAIN_AUTOSTART: 'false', KNOWLEDGE_INSTANCE_TOKEN: instance, TEALBRICK_PORTAL_URL: portalOrigin, TEALBRICK_DEPLOYMENT_ID: 'deployment', KNOWLEDGE_COMPANY_ID: 'workspace', KNOWLEDGE_PORTAL_ORG_ID: 'org' }, stdio: ['ignore','ignore','pipe'] });
  let errors='';child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { if (child.exitCode === null) { const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited; } await new Promise(r=>portal.close(r));await rm(data,{recursive:true,force:true}); });
  let ready=false;
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(errors);try{ready=(await fetch(base+'/healthz')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready,errors);
  const launch=()=>fetch(base+'/auth/launch?companyId=foreign',{method:'POST',redirect:'manual',headers:{origin:portalOrigin,'content-type':'application/x-www-form-urlencoded'},body:`ticket=${ticket}`});
  const response=await launch();assert.equal(response.status,303);
  assert.equal(response.headers.get('location'),'/?companyId=workspace');
  assert.deepEqual(calls[0],{schema:1,product:'knowledge',deploymentId:'deployment',ticket});
  const cookie=response.headers.get('set-cookie').split(';')[0];assert.doesNotMatch(cookie,/iiiiiiii/);
  assert.equal((await launch()).status,401);
  const html={accept:'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'};
  // A reused launch ticket submitted by the Portal form is a page navigation: show the relaunch page.
  const reused=await fetch(base+'/auth/launch',{method:'POST',redirect:'manual',headers:{...html,origin:portalOrigin,'content-type':'application/x-www-form-urlencoded'},body:`ticket=${ticket}`});
  assert.equal(reused.status,401);assert.match(reused.headers.get('content-type'),/^text\/html/);
  assert.match(await reused.text(),/Your session ended/);
  // Unauthenticated browser navigation gets a readable page with a Portal link; API/JSON stays JSON.
  const shell=await fetch(base+'/',{headers:html});
  assert.equal(shell.status,401);assert.match(shell.headers.get('content-type'),/^text\/html/);
  assert.equal(shell.headers.get('cache-control'),'no-store');
  assert.match(shell.headers.get('content-security-policy'),/default-src 'none'/);
  const page=await shell.text();
  assert.match(page,/Reopen Knowledge from Teal Brick Portal/);
  assert.ok(page.includes(`href="${portalOrigin}/"`));
  assert.doesNotMatch(page,/<script|iiiiiiii|workspace|deployment/);
  assert.equal((await fetch(base+'/',{method:'HEAD',headers:html})).status,401);
  const apiHtml=await fetch(base+'/api/status',{headers:html});
  assert.equal(apiHtml.status,401);assert.deepEqual(await apiHtml.json(),{ok:false,error:'instance_auth_required'});
  const bootstrapHtml=await fetch(base+'/bootstrap.json',{headers:html});
  assert.equal(bootstrapHtml.status,401);assert.match(bootstrapHtml.headers.get('content-type'),/json/);
  const plain=await fetch(base+'/');
  assert.equal(plain.status,401);assert.deepEqual(await plain.json(),{ok:false,error:'instance_auth_required'});
  assert.equal((await fetch(base+'/api/status',{headers:{cookie}})).status,200);
  const companyId=new URL(response.headers.get('location'),base).searchParams.get('companyId');
  const path=`/api/companies/${encodeURIComponent(companyId)}/knowledge/collections`;
  assert.equal((await fetch(base+path,{method:'POST',headers:{cookie,origin:'https://evil.invalid','content-type':'application/json'},body:'{"name":"Denied"}'})).status,401);
  assert.equal((await fetch(base+path,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:'{"name":"Browser sample"}'})).status,201);
  assert.equal((await(await fetch(base+path,{headers:{cookie}})).json())[0].name,'Browser sample');
  assert.equal((await fetch(base+'/api/research/engine/notebooks',{headers:{cookie}})).status,503,'unconfigured Research remains unavailable; owner session does not invent its configuration');
  assert.equal((await fetch(base+'/',{headers:{...html,cookie}})).status,200,'a live session still opens the app shell');
  revoked=true;
  const expiredApi=await fetch(base+'/api/status',{headers:{cookie}});
  assert.equal(expiredApi.status,401);assert.deepEqual(await expiredApi.json(),{error:'browser_session_required'});
  const expiredShell=await fetch(base+'/?view=library',{headers:{...html,cookie}});
  assert.equal(expiredShell.status,401);assert.match(await expiredShell.text(),/Your session ended/);
  assert.ok(calls.length>=7);
});
