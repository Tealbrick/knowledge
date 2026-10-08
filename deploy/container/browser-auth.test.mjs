import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { browserAccess, sendSessionEnded, sessionEndedPage, sessionFrameAncestors, wantsSessionPage } from './browser-auth.mjs';
const config = { portal: 'https://portal.fixture.invalid', deploymentId: 'deployment', companyId: 'workspace', portalOrgId: 'org', instanceToken: 'server-only-secret' };
const session = 's'.repeat(43), ticket = 't'.repeat(43), ticket2 = 'u'.repeat(43);
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
  const f = fixture('POST', '/auth/launch?companyId=attacker&next=https://evil.invalid', { origin: config.portal, 'content-type': 'application/x-www-form-urlencoded' }, `ticket=${ticket2}`);
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
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { schema: 1, product: 'knowledge', deploymentId: 'deployment', ticket: ticket2 });
  assert.doesNotMatch(f.res.headers.location, /attacker|evil|uuuuuuuu|ssssssss/);
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
  // A launch from another Origin (or none) is not a Portal launch: 403 launch_origin_required. A repeated field is a 401.
  for (const [origin, body, status] of [['https://evil.invalid',`ticket=${ticket}`,403],[undefined,`ticket=${ticket}`,403],[config.portal,`ticket=${ticket}&ticket=${ticket}`,401]]) {
    const f=fixture('POST','/auth/launch',{...(origin?{origin}:{}),'content-type':'application/x-www-form-urlencoded'},body);
    await browserAccess(config,f.req,f.res,f.transport);assert.equal(f.res.status,status);assert.equal(f.calls.length,0);
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

test('only HTML page navigations get the session-ended page; API and JSON keep machine-readable 401s', async () => {
  const html = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';
  const req = (method, url, accept) => ({ method, url, headers: accept ? { accept } : {} });
  assert.equal(wantsSessionPage(req('GET', '/', html)), true);
  assert.equal(wantsSessionPage(req('GET', '/embed?view=library', html)), true);
  assert.equal(wantsSessionPage(req('HEAD', '/', html)), true);
  assert.equal(wantsSessionPage(req('POST', '/auth/launch', html)), true);
  assert.equal(wantsSessionPage(req('POST', '/', html)), false);
  assert.equal(wantsSessionPage(req('GET', '/', '*/*')), false);
  assert.equal(wantsSessionPage(req('GET', '/', 'application/json')), false);
  assert.equal(wantsSessionPage(req('GET', '/api/status', html)), false);
  assert.equal(wantsSessionPage(req('GET', '/.well-known/tealbrick/claim', html)), false);
  assert.equal(wantsSessionPage(req('GET', '/bootstrap.json', html)), false);
  const expired = fixture('GET', '/', { accept: html, cookie: `knowledge_browser=${session}` }, '', { authorized: false });
  assert.deepEqual(await browserAccess(config, expired.req, expired.res, expired.transport), { handled: true, authorized: false });
  assert.equal(expired.res.status, 401); assert.match(expired.res.headers['content-type'], /^text\/html/);
  assert.match(expired.res.body, /Your session ended/); assert.doesNotMatch(expired.res.body, /server-only-secret|<script/);
  const api = fixture('GET', '/api/status', { accept: html, cookie: `knowledge_browser=${session}` }, '', { authorized: false });
  await browserAccess(config, api.req, api.res, api.transport);
  assert.equal(api.res.body, '{"error":"browser_session_required"}');
});
test('session-ended page links only to the configured Portal origin and escapes it', () => {
  assert.match(sessionEndedPage('https://portal.example/'), /href="https:\/\/portal\.example\/" target="_top"/);
  assert.doesNotMatch(sessionEndedPage('javascript:alert(1)'), /href=/);
  assert.doesNotMatch(sessionEndedPage(undefined), /href=/);
  assert.doesNotMatch(sessionEndedPage('https://portal.example/"><script>'), /<script>/);
});

test('session page frame-ancestors: exactly self and the Portal origin, never a wildcard', () => {
  assert.equal(sessionFrameAncestors('https://portal.example/a/b?c=1'), "frame-ancestors 'self' https://portal.example");
  for (const value of [undefined, '', 'nonsense', 'https://*.example', 'javascript:alert(1)', 'file:///x']) assert.equal(sessionFrameAncestors(value), "frame-ancestors 'self'");
  const sent = {};
  const res = { writeHead: (_s, h) => Object.assign(sent, h), end() {} };
  sendSessionEnded({ method: 'GET' }, res, 'https://portal.example/', false);
  assert.match(sent['content-security-policy'], /frame-ancestors 'self' https:\/\/portal\.example$/);
  assert.doesNotMatch(sent['content-security-policy'], /\*/);
  sendSessionEnded({ method: 'GET' }, res, undefined, false);
  assert.match(sent['content-security-policy'], /frame-ancestors 'self'$/);
});

// ---- contract launch: validated route, settings relay, replay, proof headers ------------------------------------------------
const routes = new Set(['/?view=library', '/?view=settings']);
const kit = () => {
  const issued = [];
  return { issued, extras: { routeAllowed: route => routes.has(route), settingsSessions: { async issue(input) { issued.push(input); return { bearer: `tbsb_${'b'.repeat(43)}`, expiresAt: Date.now() + 300_000 }; } } } };
};
const launchConfig = (extras = {}, over = {}) => ({ ...config, replayed: new Map(), ...extras, ...over });
const form = (fields, headers = {}) => fixture('POST', '/auth/launch', { origin: config.portal, 'content-type': 'application/x-www-form-urlencoded', ...headers }, new URLSearchParams(fields).toString());
const fresh = letter => letter.repeat(43);

test('a launch route must be a manifest route and is kept exactly', async () => {
  const { extras } = kit();
  const cfg = launchConfig(extras);
  const ok = form({ ticket: fresh('a'), route: '/?view=settings' });
  await browserAccess(cfg, ok.req, ok.res, ok.transport);
  assert.equal(ok.res.status, 303); assert.equal(ok.res.headers.location, '/?view=settings');
  for (const [route, ticketLetter] of [['/api/status', 'b'], ['//evil.invalid/', 'c'], ['https://evil.invalid/', 'd'], ['/?view=settings&x=1', 'e']]) {
    const bad = form({ ticket: fresh(ticketLetter), route });
    await browserAccess(cfg, bad.req, bad.res, bad.transport);
    assert.equal(bad.res.status, 400, route); assert.equal(bad.calls.length, 0, 'an invalid route never reaches Portal');
  }
  // No route validator configured: no route is ever followed.
  const none = form({ ticket: fresh('f'), route: '/?view=settings' });
  await browserAccess(launchConfig(), none.req, none.res, none.transport);
  assert.equal(none.res.status, 400);
});

test('the Portal answer may state the route and purpose; a disagreement fails closed', async () => {
  const { extras } = kit();
  const cfg = launchConfig(extras);
  const routed = form({ ticket: fresh('a') }); const routedTransport = async () => Response.json({ ...validGrant, route: '/?view=settings' });
  await browserAccess(cfg, routed.req, routed.res, routedTransport);
  assert.equal(routed.res.headers.location, '/?view=settings');
  const wrongRoute = form({ ticket: fresh('b') });
  await browserAccess(cfg, wrongRoute.req, wrongRoute.res, async () => Response.json({ ...validGrant, route: '/api/status' }));
  assert.equal(wrongRoute.res.status, 401);
  const mismatch = form({ ticket: fresh('c'), purpose: 'launch' });
  await browserAccess(cfg, mismatch.req, mismatch.res, async () => Response.json({ ...validGrant, purpose: 'settings' }));
  assert.equal(mismatch.res.status, 400); assert.match(mismatch.res.body, /purpose_mismatch/);
});

test('the settings relay answers a 5-minute bearer as JSON, needs no Origin, and never sets a cookie', async () => {
  const { extras, issued } = kit();
  const cfg = launchConfig(extras);
  const relay = fixture('POST', '/auth/launch', { 'content-type': 'application/json' }, JSON.stringify({ ticket: fresh('a'), purpose: 'settings' }));
  await browserAccess(cfg, relay.req, relay.res, relay.transport);
  assert.equal(relay.res.status, 200);
  assert.equal(relay.res.headers['set-cookie'], undefined);
  assert.deepEqual({ ...JSON.parse(relay.res.body), expiresAt: 0 }, { tokenType: 'Bearer', settingsBearer: `tbsb_${'b'.repeat(43)}`, expiresAt: 0, purpose: 'settings', workspaceId: 'workspace' });
  assert.deepEqual(issued, [{ subject: 'owner', workspaceId: 'workspace', orgId: 'org' }]);
  // A foreign Origin is refused even for the relay, and a relay without a configured bearer minter is refused.
  const foreign = fixture('POST', '/auth/launch', { origin: 'https://evil.invalid', 'content-type': 'application/json' }, JSON.stringify({ ticket: fresh('b'), purpose: 'settings' }));
  await browserAccess(cfg, foreign.req, foreign.res, foreign.transport);
  assert.equal(foreign.res.status, 403); assert.equal(foreign.calls.length, 0);
  const unconfigured = fixture('POST', '/auth/launch', { 'content-type': 'application/json' }, JSON.stringify({ ticket: fresh('c'), purpose: 'settings' }));
  await browserAccess(launchConfig(), unconfigured.req, unconfigured.res, unconfigured.transport);
  assert.equal(unconfigured.res.status, 401);
  // A browser launch (the default purpose) still needs the Portal Origin.
  const bare = fixture('POST', '/auth/launch', { 'content-type': 'application/x-www-form-urlencoded' }, `ticket=${fresh('d')}`);
  await browserAccess(cfg, bare.req, bare.res, bare.transport);
  assert.equal(bare.res.status, 403);
});

test('a ticket is single use in the app as well, and unknown fields or purposes are refused', async () => {
  const { extras } = kit();
  const cfg = launchConfig(extras);
  const first = form({ ticket: fresh('a') }); await browserAccess(cfg, first.req, first.res, first.transport);
  assert.equal(first.res.status, 303);
  const again = form({ ticket: fresh('a') }); await browserAccess(cfg, again.req, again.res, again.transport);
  assert.equal(again.res.status, 401); assert.equal(again.calls.length, 0, 'the replay is refused without asking Portal');
  const extra = form({ ticket: fresh('b'), next: '/x' }); await browserAccess(cfg, extra.req, extra.res, extra.transport);
  assert.equal(extra.res.status, 401);
  const purpose = form({ ticket: fresh('c'), purpose: 'admin' }); await browserAccess(cfg, purpose.req, purpose.res, purpose.transport);
  assert.equal(purpose.res.status, 400);
});

test('the instance proves itself with the separate proof only when it has one', async () => {
  const separate = fixture('GET', '/', { cookie: `knowledge_browser=${session}` });
  await browserAccess({ ...config, instanceProof: 'p'.repeat(40) }, separate.req, separate.res, separate.transport);
  assert.deepEqual(Object.keys(separate.calls[0].options.headers).sort(), ['content-type', 'x-tealbrick-instance-proof']);
  assert.doesNotMatch(JSON.stringify(separate.calls[0].options), /server-only-secret/, 'the instance token never leaves when a separate proof exists');
  const shared = fixture('GET', '/', { cookie: `knowledge_browser=${session}` });
  await browserAccess({ ...config, instanceProof: config.instanceToken }, shared.req, shared.res, shared.transport);
  assert.equal(shared.calls[0].options.headers['x-knowledge-instance-token'], config.instanceToken);
  assert.equal(shared.calls[0].options.headers['x-tealbrick-instance-proof'], config.instanceToken);
});

test('Portal may name the workspace as productTenantId instead of companyId', async () => {
  const { companyId: _omitted, ...withoutCompany } = validGrant;
  const f = form({ ticket: fresh('a') });
  await browserAccess(launchConfig(), f.req, f.res, async () => Response.json({ ...withoutCompany, productTenantId: 'workspace' }));
  assert.equal(f.res.status, 303); assert.equal(f.res.headers.location, '/?companyId=workspace');
  const wrong = form({ ticket: fresh('b') });
  await browserAccess(launchConfig(), wrong.req, wrong.res, async () => Response.json({ ...withoutCompany, productTenantId: 'other' }));
  assert.equal(wrong.res.status, 401);
});

test('the relaunch page offers the break-glass form only when it is enabled', () => {
  assert.doesNotMatch(sessionEndedPage('https://portal.example/'), /\/auth\/emergency/);
  const page = sessionEndedPage('https://portal.example/', true);
  assert.match(page, /<form method="post" action="\/auth\/emergency"/); assert.match(page, /type="password"/);
  assert.doesNotMatch(page, /<script/);
});
