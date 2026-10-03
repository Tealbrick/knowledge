import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { browserAccess } from './browser-auth.mjs';
const config = { portal: 'https://portal.fixture.invalid', deploymentId: 'deployment', companyId: 'workspace', portalOrgId: 'org', instanceToken: 'server-only-secret' };
const session = 's'.repeat(43), ticket = 't'.repeat(43);
const validGrant = { schema: 1, authorized: true, product: 'knowledge', deploymentId: 'deployment', workspaceId: 'workspace', companyId: 'workspace', userId: 'owner', orgId: 'org', instanceProofAudience: 'tealbrick/knowledge/deployment', endpoint: 'https://knowledge.fixture.invalid', expiresAt: Date.now() + 3600000, session };
function fixture(method, url, headers = {}, body = '', overrides = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []); Object.assign(req, { method, url, headers });
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  const calls = [];
  const transport = async (url, options) => { calls.push({ url, options }); return Response.json({ ...validGrant, ...overrides }); };
  return { req, res, calls, transport };
}
test('launch redeems only with Portal Origin and sets protected cookie, never instance bearer', async () => {
  const f = fixture('POST', '/auth/launch?companyId=attacker&next=https://evil.invalid', { origin: config.portal, 'content-type': 'application/x-www-form-urlencoded' }, `ticket=${ticket}`);
  assert.equal((await browserAccess(config, f.req, f.res, f.transport)).handled, true);
  assert.equal(f.res.status, 303); assert.equal(f.res.headers.location, '/?companyId=workspace');
  assert.match(f.res.headers['set-cookie'], /HttpOnly; SameSite=Lax/); assert.match(f.res.headers['set-cookie'], /Secure/);
  assert.doesNotMatch(JSON.stringify(f.res), /server-only-secret/);
  assert.equal(f.calls[0].options.headers['x-knowledge-instance-token'], config.instanceToken);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { schema: 1, product: 'knowledge', deploymentId: 'deployment', ticket });
});
test('launch selects only the attested company and safely encodes reserved characters', async () => {
  const companyId = 'workspace / + & # ? = Ω';
  const f = fixture('POST', '/auth/launch?companyId=attacker&next=https://evil.invalid', { origin: config.portal, 'content-type': 'application/x-www-form-urlencoded' }, `ticket=${ticket}`);
  const transport = async (url, options) => {
    const response = await f.transport(url, options);
    return Response.json({ ...await response.json(), companyId, workspaceId: companyId });
  };
  await browserAccess({ ...config, companyId }, f.req, f.res, transport);
  assert.equal(f.res.status, 303);
  const location = new URL(f.res.headers.location, 'https://knowledge.fixture.invalid');
  assert.equal(location.origin, 'https://knowledge.fixture.invalid');
  assert.equal(location.pathname, '/');
  assert.deepEqual([...location.searchParams], [['companyId', companyId]]);
  assert.equal(location.hash, '');
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { schema: 1, product: 'knowledge', deploymentId: 'deployment', ticket });
  assert.doesNotMatch(f.res.headers.location, /attacker|evil|tttttttt|ssssssss/);
});
test('per-call validation, mutation Origin and no caller authority headers', async () => {
  for (const [method, origin, authorized] of [['GET',undefined,true], ['POST','https://knowledge.fixture.invalid',true], ['POST','https://evil.invalid',false], ['POST',undefined,false]]) {
    const f = fixture(method, '/api/knowledge/documents/doc', { cookie: `knowledge_browser=${session}`, ...(origin ? { origin } : {}) });
    assert.equal((await browserAccess(config, f.req, f.res, f.transport)).authorized, authorized); assert.equal(f.calls.length, 1);
  }
  const mixed = fixture('GET','/',{cookie:`knowledge_browser=${session}`,authorization:'Bearer attacker'});
  assert.equal((await browserAccess(config,mixed.req,mixed.res,mixed.transport)).authorized,false);assert.equal(mixed.calls.length,0);
});
test('launch CSRF, duplicate ticket, outage and wrong partition fail closed', async () => {
  for (const [origin, body] of [['https://evil.invalid',`ticket=${ticket}`],[config.portal,`ticket=${ticket}&ticket=${ticket}`]]) {
    const f=fixture('POST','/auth/launch',{origin,'content-type':'application/x-www-form-urlencoded'},body);
    await browserAccess(config,f.req,f.res,f.transport);assert.equal(f.res.status,401);assert.equal(f.calls.length,0);
  }
  for(const transport of [async()=>{throw Error('offline');},async()=>Response.json({authorized:true,companyId:'other'})]) {
    const f=fixture('GET','/',{cookie:`knowledge_browser=${session}`});
    assert.equal((await browserAccess(config,f.req,f.res,transport)).authorized,false);assert.equal(f.res.status,401);
  }
});
test('browser grants fail closed on contract, workspace, organization or audience mismatch', async () => {
  for (const overrides of [{ schema: 2 }, { product: 'marketplace' }, { workspaceId: 'foreign' }, { orgId: 'foreign-org' }, { instanceProofAudience: 'tealbrick/knowledge/foreign' }]) {
    const f = fixture('GET', '/', { cookie: `knowledge_browser=${session}` }, '', overrides);
    assert.equal((await browserAccess(config, f.req, f.res, f.transport)).authorized, false);
    assert.equal(f.res.status, 401);
  }
});
