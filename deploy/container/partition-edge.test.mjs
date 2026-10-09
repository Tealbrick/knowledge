import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { startFakeHindsight } from '../../program/scripts/fixtures/fake-engines.mjs';

/**
 * Per-edge memory partitions through the real instance edge (portal-core#38 claims):
 * attachments and runtime grants carry `partitionKey` only for a non-default edge.
 * Every route family must stay inside the effective partition `company/key`, in
 * both directions, and a malformed claim must deny rather than fall back.
 */
const company = 'fixture-company';
const personal = `${company}/personal`;
const bank = partition => `tb-${createHash('sha256').update(`knowledge-partition:${partition}`).digest('hex').slice(0, 32)}`;
const grant = letter => `tbkg_${letter.repeat(43)}`;

async function freePort() {
  const reservation = createNetServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  return port;
}

test('per-edge partitions isolate every attachment and runtime route family on the instance edge', async t => {
  const data = await mkdtemp(`${tmpdir()}/knowledge-partition-edge-`);
  const apiKey = randomBytes(16).toString('hex');
  const hindsight = await startFakeHindsight({ apiKey });
  // Attachment bearer -> extra introspection fields. Missing entry = not an attachment.
  const claims = {
    'default-attachment': {}, 'personal-attachment': { partitionKey: 'personal' }, 'other-attachment': { partitionKey: 'other' },
    'bad-attachment': { partitionKey: 'Personal' }, 'reserved-attachment': { partitionKey: 'default' }, 'null-attachment': { partitionKey: null },
    'path-attachment': { partitionKey: '../personal' }, 'nested-attachment': { partitionKey: 'personal/x' },
  };
  const runtime = { [grant('d')]: {}, [grant('p')]: { partitionKey: 'personal' }, [grant('x')]: { partitionKey: 'a/b' } };
  const capabilities = ['knowledge:create', 'knowledge:read', 'brain:read', 'knowledge:update', 'knowledge:delete'];
  const portal = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/runtime/knowledge-principal/introspect') {
      const extra = runtime[input.token];
      if (!extra) { res.writeHead(403); res.end('{"error":"knowledge_principal_denied"}'); return; }
      res.end(JSON.stringify({ authorized: true, principalId: 'tealbrick-agent:henry', agentId: 'henry', orgId: 'fixture-org', workspaceId: company,
        instanceId: input.instanceId, companyId: company, actions: [], capabilities, ...extra,
        partitionGrants: [{ partitionKey: company, breadth: 'exact', maxDepth: 0, capabilities }], capabilityRevision: 1, expiresAt: Date.now() + 60_000 }));
      return;
    }
    const attachment = input.attachment, extra = claims[attachment];
    res.end(JSON.stringify({ authorized: input.agentToken === 'fixture-agent-token' && extra !== undefined, orgId: 'fixture-org', agentId: 'fixture-agent',
      deploymentId: 'fixture-deployment', companyId: company, capability: input.capability, ...extra, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  });
  await new Promise(r => portal.listen(0, '127.0.0.1', r));
  const port = await freePort(), instanceToken = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['--import', 'tsx', '../deploy/container/server.ts'], {
    cwd: resolve(import.meta.dirname, '../../program'),
    env: { PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), KNOWLEDGE_DATA_DIR: data, KNOWLEDGE_GBRAIN_AUTOSTART: 'false',
      KNOWLEDGE_INSTANCE_TOKEN: instanceToken, TEALBRICK_PORTAL_URL: `http://127.0.0.1:${portal.address().port}`, TEALBRICK_DEPLOYMENT_ID: 'fixture-deployment',
      KNOWLEDGE_COMPANY_ID: company, KNOWLEDGE_PORTAL_ORG_ID: 'fixture-org',
      KNOWLEDGE_MEMORY_ENGINE: 'hindsight', KNOWLEDGE_HINDSIGHT_URL: hindsight.baseUrl, KNOWLEDGE_HINDSIGHT_API_KEY: apiKey },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let error = ''; child.stderr.on('data', chunk => { error += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; }
    await new Promise(r => portal.close(r)); await hindsight.close(); await rm(data, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(error);
    try { ready = (await fetch(`${base}/healthz`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(ready, error);
  // Rollout gate: the public health probe Portal reads advertises the claim contract.
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.partitionContract, 2);
  assert.equal(health.capabilities.edgePartitions, true);
  assert.equal(health.capabilities.readPartitions, true);

  const admin = { 'x-knowledge-instance-token': instanceToken, 'content-type': 'application/json' };
  const as = attachment => ({ authorization: `Bearer ${attachment}`, 'x-tealbrick-agent-token': 'fixture-agent-token', 'content-type': 'application/json' });
  const get = (path, headers) => fetch(`${base}${path}`, { headers });
  const post = (path, headers, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  // The owner seeds the workspace default partition.
  const owned = await (await post(`/api/companies/${company}/knowledge/collections`, admin, { name: 'Workspace' })).json();
  const secret = await (await post(`/api/knowledge/collections/${owned.id}/documents`, admin, { title: 'Default secret', body: 'polygonface-only' })).json();

  // Collections, documents and search: the personal edge works in its own partition via the workspace id.
  const listed = await get(`/api/companies/${company}/knowledge/collections`, as('personal-attachment'));
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).every(c => c.companyId === personal && c.id !== owned.id));
  const mineResponse = await post(`/api/companies/${company}/knowledge/collections`, as('personal-attachment'), { name: 'Mine' });
  assert.equal(mineResponse.status, 201);
  const mine = await mineResponse.json();
  assert.equal(mine.companyId, personal);
  const noteResponse = await post(`/api/knowledge/collections/${mine.id}/documents`, as('personal-attachment'), { title: 'Personal note', body: 'personal-only secret' });
  assert.equal(noteResponse.status, 201);
  const note = await noteResponse.json();
  assert.equal(note.companyId, personal);
  assert.equal((await get(`/api/knowledge/documents/${note.id}`, as('personal-attachment'))).status, 200);
  assert.equal((await get(`/api/companies/${encodeURIComponent(personal)}/knowledge/collections`, as('personal-attachment'))).status, 200, 'its own explicit partition path');
  const personalSearch = await (await get(`/api/companies/${company}/knowledge/search?q=secret`, as('personal-attachment'))).text();
  assert.match(personalSearch, /personal-only/); assert.doesNotMatch(personalSearch, /polygonface-only/);
  const defaultSearch = await (await get(`/api/companies/${company}/knowledge/search?q=secret`, as('default-attachment'))).text();
  assert.match(defaultSearch, /polygonface-only/); assert.doesNotMatch(defaultSearch, /personal-only/);

  // Cross-partition denial in both directions, including by document and collection ID.
  for (const [who, path, method, body] of [
    ['personal-attachment', `/api/knowledge/documents/${secret.id}`, 'GET'],
    ['personal-attachment', `/api/knowledge/collections/${owned.id}/documents`, 'POST', { title: 'x' }],
    ['personal-attachment', `/api/companies/${encodeURIComponent(`${company}/other`)}/knowledge/collections`, 'GET'],
    ['other-attachment', `/api/knowledge/documents/${note.id}`, 'GET'],
    ['other-attachment', `/api/knowledge/collections/${mine.id}/documents`, 'POST', { title: 'x' }],
    ['default-attachment', `/api/knowledge/documents/${note.id}`, 'GET'],
    ['default-attachment', `/api/knowledge/collections/${mine.id}/documents`, 'POST', { title: 'x' }],
    ['default-attachment', `/api/companies/${encodeURIComponent(personal)}/knowledge/collections`, 'GET'],
    ['default-attachment', `/api/companies/${encodeURIComponent(personal)}/knowledge/search?q=secret`, 'GET'],
  ]) {
    const response = await fetch(`${base}${path}`, { method, headers: as(who), ...(body ? { body: JSON.stringify(body) } : {}) });
    // By id: uniform not-found (an id of another partition looks absent); by a foreign partition path: refused.
    const byId = !path.startsWith('/api/companies/');
    assert.equal(response.status, byId ? 404 : 401, `${who} ${method} ${path}`);
    const text = await response.text();
    assert.doesNotMatch(text, /only/);
    if (byId) assert.deepEqual(JSON.parse(text), { ok: false, error: 'not_found' });
  }

  // A malformed or reserved claim fails closed on every family; it never reaches the default partition.
  for (const who of ['bad-attachment', 'reserved-attachment', 'null-attachment', 'path-attachment', 'nested-attachment']) {
    assert.equal((await get(`/api/companies/${company}/knowledge/collections`, as(who))).status, 401, who);
    assert.equal((await get(`/api/knowledge/documents/${secret.id}`, as(who))).status, 401, who);
    assert.equal((await post('/api/brain/recall', as(who), { query: 'q', scopeRef: company })).status, 401, who);
    assert.equal((await post('/api/brain/native/list_documents', as(who), { arguments: {} })).status, 401, who);
    assert.equal((await get('/api/research/engine/notebooks', as(who))).status, 401, who);
  }

  // Brain recall/context/entities and native ops land in the effective partition's own Hindsight bank.
  const banks = () => hindsight.calls.filter(call => call.bank).map(call => call.bank);
  let mark = banks().length;
  const recall = await post('/api/brain/recall', as('personal-attachment'), { query: 'q', scopeRef: 'forged' });
  assert.equal(recall.status, 200);
  assert.equal((await recall.json()).scopeRef, personal);
  assert.equal((await post('/api/brain/context', as('personal-attachment'), { query: 'q', scopeRef: company })).status, 200);
  assert.equal((await post('/api/brain/native/list_documents', as('personal-attachment'), { arguments: {} })).status, 200);
  assert.equal((await post('/api/brain/native/list_documents', as('personal-attachment'), { partitionKey: company, arguments: {} })).status, 200, 'the workspace id selects its own partition');
  assert.equal((await get(`/api/brain/native/tools`, as('personal-attachment'))).status, 200);
  assert.ok(banks().length > mark);
  assert.deepEqual([...new Set(banks().slice(mark))], [bank(personal)]);
  mark = banks().length;
  assert.equal((await post('/api/brain/recall', as('default-attachment'), { query: 'q', scopeRef: company })).status, 200);
  assert.equal((await post('/api/brain/native/list_documents', as('default-attachment'), { arguments: {} })).status, 200);
  assert.deepEqual([...new Set(banks().slice(mark))], [bank(company)]);
  mark = banks().length;
  for (const [who, partitionKey] of [['personal-attachment', `${company}/other`], ['personal-attachment', `${personal}/deeper`], ['default-attachment', personal]]) {
    assert.equal((await post('/api/brain/native/list_documents', as(who), { partitionKey, arguments: {} })).status, 401, `${who} -> ${partitionKey}`);
    assert.equal((await get(`/api/brain/entities?partitionKey=${encodeURIComponent(partitionKey)}`, as(who))).status, 401, `${who} -> ${partitionKey}`);
  }
  assert.equal(banks().length, mark, 'refused selectors never reach the engine');

  // Research: a partitioned edge reaches Research discovery with a partition-bound bearer (no default notebooks).
  const notebooks = await get('/api/research/engine/notebooks', as('personal-attachment'));
  assert.equal(notebooks.status, 200);
  assert.deepEqual((await notebooks.json()).notebooks, []);

  // A partition edited mid-request is re-checked at dispatch and never re-scopes the write.
  const body = JSON.stringify({ name: 'must-not-be-created' });
  const before = (await (await get(`/api/companies/${encodeURIComponent(personal)}/knowledge/collections`, admin)).json()).length;
  const slow = await new Promise((done, fail) => {
    const request = httpRequest(`${base}/api/companies/${company}/knowledge/collections`, { method: 'POST', headers: { ...as('personal-attachment'), 'content-length': Buffer.byteLength(body) } },
      res => { res.resume(); res.on('end', () => done(res.statusCode)); });
    request.on('error', fail);
    request.flushHeaders();
    setTimeout(() => { claims['personal-attachment'] = { partitionKey: 'other' }; request.end(body); }, 150);
  });
  claims['personal-attachment'] = { partitionKey: 'personal' };
  assert.equal(slow, 401);
  assert.equal((await (await get(`/api/companies/${encodeURIComponent(personal)}/knowledge/collections`, admin)).json()).length, before);
  const otherNames = (await (await get(`/api/companies/${encodeURIComponent(`${company}/other`)}/knowledge/collections`, admin)).json()).map(c => c.name);
  assert.ok(!otherNames.includes('must-not-be-created'));

  // Runtime principals (tbkg_ grants introspected live at Portal) follow the same partition.
  const runtimeAs = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const runtimeListed = await get(`/api/companies/${company}/knowledge/collections`, runtimeAs(grant('p')));
  assert.equal(runtimeListed.status, 200);
  assert.ok((await runtimeListed.json()).some(c => c.id === mine.id));
  assert.equal((await get(`/api/knowledge/documents/${note.id}`, runtimeAs(grant('p')))).status, 200);
  assert.equal((await get(`/api/knowledge/documents/${secret.id}`, runtimeAs(grant('p')))).status, 404);
  assert.equal((await get(`/api/knowledge/documents/${note.id}`, runtimeAs(grant('d')))).status, 404);
  assert.equal((await get(`/api/knowledge/documents/${secret.id}`, runtimeAs(grant('d')))).status, 200);
  assert.equal((await get(`/api/companies/${company}/knowledge/collections`, runtimeAs(grant('x')))).status, 401, 'a malformed runtime claim denies');
  mark = banks().length;
  assert.equal((await post('/api/brain/recall', runtimeAs(grant('p')), { query: 'q', scopeRef: company })).status, 200);
  assert.deepEqual([...new Set(banks().slice(mark))], [bank(personal)]);

  // The owner keeps full access and sees the partition in its selector listing.
  assert.equal((await get(`/api/knowledge/documents/${note.id}`, admin)).status, 200);
  const partitions = await (await get(`/api/companies/${company}/knowledge/partitions`, admin)).json();
  // 'other' exists only because the owner's listing above created that partition's default collection.
  assert.deepEqual(partitions.partitions.map(p => p.key), ['other', 'personal']);
});
