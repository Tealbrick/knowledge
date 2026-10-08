import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { company, deployment, org, startEdge, startFakePortal } from './edge-fixture.mjs';

/**
 * The Teal Brick miniapp contract surface on the real instance edge: control endpoints (manifest, claim and its legacy alias,
 * status, settings, companions, guidance), the launch with a validated route and the settings relay, and the break-glass
 * emergency login. Agent operations are in app-grant-edge.test.mjs.
 */
const manifestFile = new URL('../../tealbrick.app.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const instanceToken = randomBytes(32).toString('hex');
const emergencyCode = randomBytes(32).toString('base64url');
const op = id => manifest.operations.find(o => o.id === id);

const json = async response => ({ status: response.status, headers: response.headers, body: await response.json().catch(() => null) });
const decode = jws => JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'));
const operationsFor = actions => manifest.operations.filter(o => (o.audience ?? 'agent') === 'agent' && o.crud.every(a => actions.includes(a))).map(o => o.id);

test('contract control endpoints, launch and emergency login on the instance edge', async t => {
  const portal = await startFakePortal({ instanceToken, operationsFor });
  const data = await mkdtemp(`${tmpdir()}/knowledge-contract-data-`);
  // The contract spellings (TEALBRICK_*): the same deployment, named the way Portal provisions a manifest app.
  const environment = {
    TEALBRICK_INSTANCE_TOKEN: instanceToken, TEALBRICK_TENANT_ID: company, TEALBRICK_PORTAL_ORG_ID: org,
    TEALBRICK_PORTAL_URL: portal.url, TEALBRICK_DEPLOYMENT_ID: deployment, TEALBRICK_EMERGENCY_CODE: emergencyCode,
    TEALBRICK_PUBLIC_ORIGIN: 'http://127.0.0.1',
  };
  let edge = await startEdge({ env: environment, data });
  t.after(async () => { await edge.stop(); await portal.close(); await rm(data, { recursive: true, force: true }); });
  const legacy = { 'x-knowledge-instance-token': instanceToken };
  const bearer = { authorization: `Bearer ${instanceToken}` };
  const at = (path, init = {}) => fetch(`${edge.base}${path}`, init);

  // --- health: the contract fields plus the partition fields Portal's rollout gate reads, no topology
  const health = await json(await at('/healthz'));
  assert.equal(health.status, 200);
  assert.deepEqual({ ok: health.body.ok, app: health.body.app, version: health.body.version, major: health.body.major },
    { ok: true, app: 'knowledge', version: manifest.app.version, major: manifest.app.major });
  assert.equal(health.body.partitionContract, 1);
  assert.equal(health.body.capabilities.edgePartitions, true);
  assert.doesNotMatch(JSON.stringify(health.body), new RegExp(`${company}|${org}|${deployment}|${portal.url}`));

  // --- the manifest, unauthenticated, equal to the release file
  const served = await json(await at('/.well-known/tealbrick/manifest'));
  assert.equal(served.status, 200);
  assert.deepEqual(served.body, manifest);

  // --- claim: one identity on both paths and both credential spellings; browser requests rejected; proof verifies
  assert.equal((await at('/.well-known/tealbrick/claim')).status, 401);
  assert.equal((await at('/api/tealbrick/claim')).status, 401);
  assert.equal((await at('/.well-known/tealbrick/claim', { headers: { ...bearer, origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await at('/.well-known/tealbrick/claim', { headers: { ...legacy, cookie: 'a=b' } })).status, 403);
  const identity = await json(await at('/.well-known/tealbrick/claim', { headers: bearer }));
  assert.equal(identity.status, 200);
  const sameIdentity = await json(await at('/api/tealbrick/claim', { headers: legacy }));
  assert.deepEqual(sameIdentity.body, identity.body);
  assert.deepEqual(Object.keys(identity.body.publicJwk).sort(), ['crv', 'kty', 'x']);
  const issuer = portal.url;
  const claim = (path, headers, input) => at(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  const nonce = 'n'.repeat(24);
  const proofs = [];
  for (const [path, headers] of [['/.well-known/tealbrick/claim', bearer], ['/api/tealbrick/claim', legacy]]) {
    const answer = await json(await claim(path, headers, { portalIssuer: issuer, nonce, companyId: company }));
    assert.equal(answer.status, 200, path);
    proofs.push(answer.body.proof);
  }
  assert.equal(proofs[0], proofs[1], 'the same nonce and body get the identical proof');
  const [head, payload, signature] = proofs[0].split('.');
  assert.ok(verify(null, Buffer.from(`${head}.${payload}`), createPublicKey({ key: identity.body.publicJwk, format: 'jwk' }), Buffer.from(signature, 'base64url')));
  assert.deepEqual(decode(proofs[0]), { typ: 'tealbrick-app-claim', version: 1, aud: issuer, nonce, instanceId: identity.body.instanceId, companyId: company, iat: decode(proofs[0]).iat, exp: decode(proofs[0]).exp });
  assert.equal((await claim('/.well-known/tealbrick/claim', bearer, { portalIssuer: issuer, nonce, companyId: 'other-company' })).status, 409);
  assert.equal((await claim('/.well-known/tealbrick/claim', bearer, { portalIssuer: 'https://other.invalid', nonce: 'm'.repeat(24), companyId: company })).status, 409, 'a bound instance refuses another issuer');
  assert.equal((await claim('/.well-known/tealbrick/claim', { 'content-type': 'application/json' }, { portalIssuer: issuer, nonce: 'k'.repeat(24), companyId: company })).status, 401);

  // --- status: instance token or settings bearer only; honest about setup
  assert.equal((await at('/.well-known/tealbrick/status')).status, 401);
  assert.equal((await at('/.well-known/tealbrick/status', { headers: { authorization: 'Bearer wrong-wrong-wrong-wrong-wrong-wrong' } })).status, 401);
  const status = await json(await at('/.well-known/tealbrick/status', { headers: legacy }));
  assert.equal(status.status, 200);
  assert.deepEqual({ ok: status.body.ok, app: status.body.app, setup: status.body.setup, version: status.body.version }, { ok: true, app: 'knowledge', setup: 'needs-settings', version: manifest.app.version });

  // --- settings: write-only secrets, staged until the model configuration is complete, provider-env never writable
  const settingsAt = headers => at('/.well-known/tealbrick/settings', { headers });
  assert.equal((await settingsAt({})).status, 401);
  const before = await json(await settingsAt(bearer));
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.values, {});
  assert.deepEqual(before.body.account, { 'providers.openaiApiKey': { source: 'account', set: false }, 'providers.anthropicApiKey': { source: 'account', set: false }, 'providers.googleApiKey': { source: 'account', set: false } }, 'provider keys read as presence only');
  const put = (headers, input) => at('/.well-known/tealbrick/settings', { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  const secret = 'sk-fixture-secret-never-echoed';
  const written = await json(await put(bearer, { values: { 'chat.apiKey': secret } }));
  assert.equal(written.status, 200);
  assert.ok(written.body.secrets['chat.apiKey'].set);
  assert.doesNotMatch(JSON.stringify(written.body), /sk-fixture/);
  const staged = await json(await put(bearer, { values: { 'chat.provider': 'openai', 'chat.model': 'chat-1' } }));
  assert.equal(staged.body.values['chat.provider'], 'openai');
  assert.notEqual(staged.body.revision, before.body.revision);
  for (const key of ['providers.openaiApiKey', 'providers.anthropicApiKey', 'providers.googleApiKey']) assert.equal((await put(bearer, { values: { [key]: 'x' } })).status, 400, 'a provider-env field is written by the hosting provider');
  assert.equal((await put(bearer, { values: { 'no.such.key': 'x' } })).status, 400);
  assert.equal((await put(bearer, { values: { 'chat.baseUrl': 'not a url' } })).status, 400);
  assert.equal((await put(bearer, { values: { 'chat.provider': 'openai' }, ifRevision: 'stale' })).status, 409);
  // A complete but wrong configuration is refused by the same checks as the owner UI; nothing is saved.
  const refused = await put(bearer, { values: { 'chat.baseUrl': 'http://127.0.0.1:9/v1', 'embedding.provider': 'openai', 'embedding.baseUrl': 'http://127.0.0.1:9/v1', 'embedding.model': 'e', 'embedding.dimensions': 1536, 'embedding.apiKey': secret } });
  const refusal = await json(refused);
  assert.equal(refusal.status, 422);
  assert.ok(refusal.body.checks.every(check => check.ok === false));
  assert.doesNotMatch(JSON.stringify(refusal.body), /sk-fixture/);

  // --- companions: instance token only; Rules is soft and not bound here
  assert.equal((await at('/.well-known/tealbrick/companions')).status, 401);
  const companions = await json(await at('/.well-known/tealbrick/companions', { headers: legacy }));
  assert.deepEqual(companions.body.companions, [{ app: 'rules-approvals', relation: 'enhances', bound: false, major: null, status: 'unknown' }]);
  assert.equal(companions.body.unlocks[0].id, 'knowledge.rules.governed-writes');
  assert.equal(companions.body.unlocks[0].effective, false);

  // --- guidance needs a live agent grant
  assert.equal((await at('/.well-known/tealbrick/guidance/1')).status, 401);
  const grantToken = `tbag_${'g'.repeat(43)}`;
  portal.state.grants[grantToken] = { agentId: 'agent-1', actions: ['read'] };
  const guidance = await at('/.well-known/tealbrick/guidance/1', { headers: { authorization: `Bearer ${grantToken}` } });
  assert.equal(guidance.status, 200);
  assert.match(await guidance.text(), /# Knowledge: guide for agents/);

  // --- launch: the Portal form POST signs the owner in with a cookie; a named route is kept exactly and must be a manifest route
  const origin = new URL(portal.url).origin;
  const ticketFor = (extra = {}) => { const ticket = randomBytes(32).toString('base64url'); portal.state.tickets[ticket] = { endpoint: edge.base, ...extra }; return ticket; };
  const launch = (fields, headers = {}) => at('/auth/launch', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin, ...headers }, body: new URLSearchParams(fields) });
  const plain = await launch({ ticket: ticketFor() });
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get('location'), `/?companyId=${company}`);
  const routed = await launch({ ticket: ticketFor(), route: '/?view=settings' });
  assert.equal(routed.status, 303);
  assert.equal(routed.headers.get('location'), '/?view=settings');
  const cookie = routed.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^knowledge_browser=/);
  assert.equal((await launch({ ticket: ticketFor(), route: '/api/status' })).status, 400, 'not a manifest route');
  assert.equal((await launch({ ticket: ticketFor(), route: 'https://evil.invalid/' })).status, 400);
  const replayTicket = ticketFor();
  assert.equal((await launch({ ticket: replayTicket })).status, 303);
  assert.equal((await launch({ ticket: replayTicket })).status, 401, 'a ticket works once');
  assert.equal((await launch({ ticket: ticketFor() }, { origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await at('/auth/launch', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket: ticketFor() }) })).status, 403);
  assert.equal((await launch({ ticket: 'x'.repeat(43) })).status, 401);
  assert.equal((await launch({ ticket: ticketFor(), purpose: 'nonsense' })).status, 400);
  assert.equal((await launch({ ticket: ticketFor({ purpose: 'settings' }) })).status, 400, 'Portal states a different purpose than the form');
  const owner = await at('/bootstrap.json', { headers: { cookie } });
  assert.equal(owner.status, 200);
  assert.equal((await at('/bootstrap.json')).status, 401);
  // Portal sends the proof it was provisioned with; with no separate proof the legacy header still carries the instance token.
  assert.equal(portal.state.redeemHeaders[0]['x-knowledge-instance-token'], instanceToken);

  // --- settings relay (purpose "settings"): server to server, no Origin, a 5-minute bearer and never a cookie
  const relay = await json(await at('/auth/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticketFor(), purpose: 'settings' }) }));
  assert.equal(relay.status, 200);
  assert.equal(relay.body.purpose, 'settings');
  assert.equal(relay.body.workspaceId, company);
  assert.match(relay.body.settingsBearer, /^tbsb_/);
  assert.ok(relay.body.expiresAt - Date.now() <= 300_000);
  assert.equal(relay.headers.get('set-cookie'), null);
  const settingsBearer = { authorization: `Bearer ${relay.body.settingsBearer}` };
  assert.equal((await at('/.well-known/tealbrick/status', { headers: settingsBearer })).status, 200);
  assert.equal((await settingsAt(settingsBearer)).status, 200);
  assert.equal((await at('/.well-known/tealbrick/claim', { headers: settingsBearer })).status, 401, 'the settings bearer is not an instance credential');
  assert.equal((await at('/.well-known/tealbrick/companions', { headers: settingsBearer })).status, 401);
  assert.equal((await at('/api/status', { headers: settingsBearer })).status, 401, 'nor an owner session');
  assert.equal((await at('/auth/launch', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.invalid' }, body: JSON.stringify({ ticket: ticketFor(), purpose: 'settings' }) })).status, 403);

  // --- emergency login: break-glass, audited, short, with a banner; the code is never stored or echoed
  const emergency = (input, headers = {}) => at('/auth/emergency', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(input) });
  assert.equal((await emergency({ code: 'wrong' })).status, 401);
  assert.equal((await at('/api/status')).status, 401, 'no Portal session and no code: no access');
  const session = await json(await emergency({ code: emergencyCode }));
  assert.equal(session.status, 200);
  assert.equal(session.body.bannerRequired, true);
  assert.match(session.body.banner, /Emergency access/);
  assert.ok(session.body.expiresAt - Date.now() <= 15 * 60_000 + 1000);
  const owned = { authorization: `Bearer ${session.body.sessionToken}` };
  assert.equal((await at('/api/status', { headers: owned })).status, 200, 'an owner session without Portal');
  const note = await json(await at('/auth/emergency/session', { headers: owned }));
  assert.deepEqual({ active: note.body.active, bannerRequired: note.body.bannerRequired }, { active: true, bannerRequired: true });
  const created = await at(`/api/companies/${company}/knowledge/collections`, { method: 'POST', headers: { ...owned, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Emergency made' }) });
  assert.equal(created.status, 201);
  assert.equal((await at(`/api/companies/${company}/knowledge/collections`, { method: 'POST', headers: { ...owned, 'content-type': 'application/json', origin: 'https://evil.invalid' }, body: JSON.stringify({ name: 'x' }) })).status, 403);
  assert.equal((await emergency({ code: emergencyCode }, owned)).status, 409, 'once per session');
  const modelsAsOwner = await at('/api/settings/models', { headers: owned });
  assert.equal(modelsAsOwner.status, 200, 'the owner route for models is reachable with the owner session');
  // The session page of a person without a Portal session offers the break-glass form.
  const page = await at('/', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 401);
  assert.match(await page.text(), /action="\/auth\/emergency"/);
  const logout = await at('/auth/emergency/logout', { method: 'POST', headers: owned });
  assert.equal(logout.status, 204);
  assert.equal((await at('/api/status', { headers: owned })).status, 401);

  // --- audit: metadata only, never the code, a key, a bearer or a setting value
  const audit = new DatabaseSync(`${data}/contract-audit.sqlite`, { readOnly: true });
  const rows = audit.prepare('SELECT * FROM contract_audit ORDER BY rowid').all();
  audit.close();
  const dump = JSON.stringify(rows);
  for (const needle of [emergencyCode, session.body.sessionToken, secret, instanceToken, 'tbsb_', 'tbes_', ticketFor()]) assert.ok(!dump.includes(needle), 'audit leaked a credential');
  assert.ok(rows.some(row => row.kind === 'emergency' && row.outcome === 'success'));
  assert.ok(rows.some(row => row.kind === 'emergency' && row.outcome === 'denied'));
  assert.ok(rows.some(row => row.kind === 'control' && row.operation === 'PUT /.well-known/tealbrick/settings' && row.outcome === 'success' && /chat\.apiKey/.test(row.code ?? '')));
  assert.ok(rows.some(row => row.kind === 'launch' && row.outcome === 'success'));
  assert.equal(((await stat(`${data}/contract-audit.sqlite`)).mode & 0o077), 0);

  // --- restart: the claim identity and the pinned issuer survive; a staged key stays staged (0600 on the volume)
  await edge.stop({ keepData: true });
  edge = await startEdge({ env: environment, data });
  const again = await json(await at('/.well-known/tealbrick/claim', { headers: bearer }));
  assert.deepEqual(again.body, identity.body, 'the claim key is never regenerated');
  assert.equal((await claim('/.well-known/tealbrick/claim', bearer, { portalIssuer: 'https://other.invalid', nonce: 'z'.repeat(24), companyId: company })).status, 409, 'rebinding stays refused after a restart');
  assert.equal((await claim('/api/tealbrick/claim', legacy, { portalIssuer: issuer, nonce: 'y'.repeat(24), companyId: company })).status, 200);
  assert.equal((await at('/api/status', { headers: owned })).status, 401, 'an emergency session does not survive a restart');
  assert.doesNotMatch(edge.output(), new RegExp(`${emergencyCode}|${instanceToken}|sk-fixture`));
});

test('the Knowledge spellings of the deployment variables still work, and a conflict stops startup', async t => {
  const portal = await startFakePortal({ instanceToken, operationsFor });
  t.after(() => portal.close());
  const edge = await startEdge({ env: { KNOWLEDGE_INSTANCE_TOKEN: instanceToken, KNOWLEDGE_COMPANY_ID: company, KNOWLEDGE_PORTAL_ORG_ID: org, TEALBRICK_PORTAL_URL: portal.url, TEALBRICK_DEPLOYMENT_ID: deployment } });
  t.after(() => edge.stop());
  const identity = await fetch(`${edge.base}/.well-known/tealbrick/claim`, { headers: { authorization: `Bearer ${instanceToken}` } });
  assert.equal(identity.status, 200, 'the contract names are filled from the Knowledge names');
  const proof = await fetch(`${edge.base}/api/tealbrick/claim`, { method: 'POST', headers: { 'x-knowledge-instance-token': instanceToken, 'content-type': 'application/json' }, body: JSON.stringify({ portalIssuer: portal.url, nonce: 'n'.repeat(24), companyId: company }) });
  assert.equal(proof.status, 200);
  await assert.rejects(startEdge({ env: { KNOWLEDGE_INSTANCE_TOKEN: instanceToken, TEALBRICK_INSTANCE_TOKEN: randomBytes(32).toString('hex') } }), /edge failed to start[\s\S]*both set to different values/);
});

test('an instance with no workspace configured keeps the legacy claim handler', async t => {
  const edge = await startEdge({ env: { KNOWLEDGE_INSTANCE_TOKEN: instanceToken, KNOWLEDGE_SERVICE_PRINCIPALS: JSON.stringify([{ token: 'x'.repeat(40), principalId: 'p', companyId: 'customer-a', capabilities: ['knowledge:read'] }]) } });
  t.after(() => edge.stop());
  const headers = { 'x-knowledge-instance-token': instanceToken, 'content-type': 'application/json' };
  const identity = await (await fetch(`${edge.base}/api/tealbrick/claim`, { headers })).json();
  assert.ok(identity.instanceId && identity.publicJwk);
  const proof = await fetch(`${edge.base}/api/tealbrick/claim`, { method: 'POST', headers, body: JSON.stringify({ portalIssuer: 'https://portal.invalid', nonce: 'n'.repeat(24), companyId: 'customer-a' }) });
  assert.equal(proof.status, 200);
  assert.equal((await proof.json()).companyId, 'customer-a', 'the legacy answer shape is unchanged');
  assert.equal((await fetch(`${edge.base}/.well-known/tealbrick/manifest`)).status, 200);
});
