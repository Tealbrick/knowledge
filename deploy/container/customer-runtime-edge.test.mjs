import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

test('direct runtime enforces all CRUD subsets, isolation, identity, claim admin boundary, and restart revocation', async t => {
  const data = await mkdtemp(`${tmpdir()}/knowledge-runtime-edge-`);
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const base = `http://127.0.0.1:${port}`;
  const instance = 'instance-fixture-only-'.repeat(3);
  const actions = ['create', 'read', 'update', 'delete'];
  const principals = Array.from({ length: 16 }, (_, mask) => ({
    token: `runtime-mask-${mask}-fixture-only-`.repeat(2), principalId: `agent-${mask}`, companyId: 'customer-a',
    capabilities: actions.filter((_, bit) => mask & (1 << bit)).map(action => `knowledge:${action}`),
  }));
  principals.push({ token: 'research-fixture-only-'.repeat(3), principalId: 'research-a', companyId: 'customer-a', capabilities: ['research:read'] });
  let child;
  let output = '';
  const stop = async () => {
    if (child && child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; }
  };
  const start = async configured => {
    child = spawn(process.execPath, ['--import', 'tsx', '../deploy/container/server.ts'], {
      cwd: resolve(import.meta.dirname, '../../program'),
      env: { PATH: process.env.PATH, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
        KNOWLEDGE_DATA_DIR: data, KNOWLEDGE_GBRAIN_AUTOSTART: 'false', KNOWLEDGE_INSTANCE_TOKEN: instance,
        KNOWLEDGE_SERVICE_PRINCIPALS: JSON.stringify(configured) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Fixture edge failed to start');
      try { ready = (await fetch(base + '/healthz')).ok; } catch {}
      if (ready) break;
      await new Promise(r => setTimeout(r, 30));
    }
    assert.ok(ready);
  };
  t.after(async () => { await stop(); await rm(data, { recursive: true, force: true }); });
  await start(principals);
  const admin = { 'x-knowledge-instance-token': instance, 'content-type': 'application/json' };
  const call = (path, method = 'GET', headers = admin, body) => {
    const requestHeaders = { ...headers };
    if (body === undefined) delete requestHeaders['content-type'];
    return fetch(base + path, { method, headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  const a = await (await call('/api/companies/customer-a/knowledge/collections', 'POST', admin, { name: 'A' })).json();
  const b = await (await call('/api/companies/customer-b/knowledge/collections', 'POST', admin, { name: 'B' })).json();
  const foreign = await (await call(`/api/knowledge/collections/${b.id}/documents`, 'POST', admin, { title: 'Foreign', body: 'foreign-content-marker' })).json();
  for (let mask = 0; mask < 16; mask++) {
    const principal = principals[mask];
    const h = { authorization: `Bearer ${principal.token}`, 'content-type': 'application/json' };
    const seeded = await (await call(`/api/knowledge/collections/${a.id}/documents`, 'POST', admin, { title: 'Seed', body: 'existing-sensitive-marker' })).json();
    const created = await call(`/api/knowledge/collections/${a.id}/documents`, 'POST', h, { title: 'Created', body: 'request-body-marker', actor: { kind: 'agent', id: 'forged-agent' } });
    assert.equal(created.status, mask & 1 ? 201 : 403, `create subset ${mask}`);
    if (mask & 1) assert.equal((await created.json()).createdByAgentId, principal.principalId);
    assert.equal((await call(`/api/knowledge/documents/${seeded.id}`, 'GET', h)).status, mask & 2 ? 200 : 403, `read subset ${mask}`);
    const updated = await call(`/api/knowledge/documents/${seeded.id}`, 'PATCH', h, { title: 'Changed' });
    assert.equal(updated.status, mask & 4 ? 200 : 403, `update subset ${mask}`);
    if (!(mask & 2)) assert.doesNotMatch(await updated.text(), /existing-sensitive-marker/);
    const deleted = await call(`/api/knowledge/documents/${seeded.id}`, 'DELETE', h);
    assert.equal(deleted.status, mask & 8 ? 200 : 403, `delete subset ${mask}`);
    if (!(mask & 2)) assert.doesNotMatch(await deleted.text(), /existing-sensitive-marker/);
    const deleteCollection = await (await call('/api/companies/customer-a/knowledge/collections', 'POST', admin,
      { name: 'private-collection-metadata' })).json();
    const collectionDeleted = await call(`/api/knowledge/collections/${deleteCollection.id}`, 'DELETE', h);
    assert.equal(collectionDeleted.status, mask & 8 ? 200 : 403, `collection delete subset ${mask}`);
    if (mask & 8) {
      const receipt = await collectionDeleted.json();
      if (mask & 2) assert.equal(receipt.name, 'private-collection-metadata');
      else assert.deepEqual(receipt, { id: deleteCollection.id, deleted: true });
    }
    assert.equal((await call(`/api/knowledge/documents/${foreign.id}`, 'GET', h)).status, 403);
    assert.equal((await call('/api/tealbrick/claim', 'GET', h)).status, 403);
    for (const path of ['/api/status', '/api/events', '/api/knowledge/collections', '/api/brain/extract-facts']) {
      assert.equal((await call(path, 'GET', h)).status, 403);
    }
  }
  const full = { authorization: `Bearer ${principals[15].token}`, 'content-type': 'application/json' };
  for (const pathname of ['/api/knowledge/../status', '/api/knowledge/documents/%2e%2e', '//api/status', 'http://knowledge.invalid/api/status']) {
    const status = await new Promise((resolveStatus, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { authorization: full.authorization } }, response => {
        response.resume(); response.on('end', () => resolveStatus(response.statusCode));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 403, `raw path bypass ${pathname}`);
  }
  const ownAccessDocument = await (await call(`/api/knowledge/collections/${a.id}/documents`, 'POST', admin, { title: 'Own access fixture' })).json();
  assert.equal((await call(`/api/knowledge/documents/${ownAccessDocument.id}/access`, 'PUT', full, {})).status, 403);
  for (const owner of ['projects', 'goals', 'issues']) {
    assert.equal((await call(`/api/${owner}/fixture-owner/knowledge/documents`, 'POST', full,
      { collectionId: a.id, title: 'Blocked owner document' })).status, 403);
    assert.equal((await call(`/api/${owner}/fixture-owner/knowledge/collections`, 'POST', full,
      { collectionId: a.id })).status, 403);
  }
  assert.equal((await call('/api/companies/customer-a/knowledge/ingest-runs', 'POST', full, {})).status, 403);
  assert.equal((await call('/api/companies/customer-a/knowledge/collections', 'POST', {
    authorization: `Bearer ${principals[2].token}`, 'content-type': 'application/json',
    'x-knowledge-instance-token': 'forged', 'x-tealbrick-agent-token': principals[15].token,
    'x-knowledge-principal': 'agent-15', 'x-forwarded-authorization': full.authorization,
  }, { name: 'Forged authority' })).status, 403);
  assert.equal((await call('/api/companies/customer-b/knowledge/collections', 'POST', full, { name: 'No' })).status, 403);
  assert.equal((await call('/api/companies/customer-a/knowledge/collections', 'POST', full, { name: 'No', sourceConfig: { provider: 'github_repo', owner: 'evil', repo: 'evil' } })).status, 403);
  assert.equal((await call(`/api/knowledge/collections/${a.id}/documents`, 'POST', full, { title: 'No', parentDocumentId: foreign.id })).status, 400);
  assert.equal((await call('/api/companies/customer-a/knowledge/collections', 'GET', { authorization: 'Bearer forged-token', 'x-tealbrick-agent-token': principals[15].token })).status, 401);
  assert.equal((await call('/api/research/engine/notebooks', 'GET', full)).status, 403);
  assert.equal((await call('/api/research/engine/notebooks', 'GET', { authorization: `Bearer ${principals[16].token}` })).status, 200);
  const queryMarker = 'query-sensitive-marker';
  assert.equal((await call(`/api/companies/customer-a/knowledge/search?q=${queryMarker}`, 'GET', full)).status, 200);

  const identity = await (await call('/api/tealbrick/claim')).json();
  assert.equal(identity.publicJwk.kty, 'OKP');
  assert.equal(identity.publicJwk.d, undefined);
  const challenge = { portalIssuer: 'https://portal.example', nonce: 'fixture_nonce_123456789', companyId: 'customer-a' };
  assert.equal((await call('/api/tealbrick/claim', 'POST', full, challenge)).status, 403);
  assert.equal((await call('/api/tealbrick/claim', 'POST', { ...admin, origin: 'https://portal.example' }, challenge)).status, 403);
  assert.equal((await call('/api/tealbrick/claim', 'POST', admin, { ...challenge, companyId: 'unknown-company' })).status, 403);
  const claimResponse = await call('/api/tealbrick/claim', 'POST', admin, challenge);
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json();
  const [head, body, signature] = claim.proof.split('.');
  assert.equal(verify(null, Buffer.from(`${head}.${body}`), createPublicKey({ key: identity.publicJwk, format: 'jwk' }), Buffer.from(signature, 'base64url')), true);
  const payload = JSON.parse(Buffer.from(body, 'base64url'));
  assert.equal(payload.nonce, challenge.nonce);
  assert.equal(payload.aud, challenge.portalIssuer);
  assert.equal(payload.companyId, 'customer-a');
  assert.equal(payload.exp - payload.iat, 300);

  // The canonical well-known path is the same handler as the /api alias: same
  // identity, same admin-only boundary, valid proofs from the same key.
  const wellKnown = '/.well-known/tealbrick/claim';
  assert.deepEqual(await (await call(wellKnown)).json(), identity);
  assert.equal((await call(wellKnown, 'GET', {})).status, 403, 'anonymous well-known claim is denied');
  assert.equal((await call(wellKnown, 'GET', { ...admin, origin: 'https://portal.example' })).status, 403);
  assert.equal((await call(wellKnown, 'GET', { ...admin, cookie: 'knowledge_browser=x' })).status, 403);
  assert.equal((await call(wellKnown, 'GET', { authorization: `Bearer ${principals[15].token}` })).status, 403);
  assert.equal((await call(wellKnown, 'POST', full, challenge)).status, 403);
  assert.equal((await call(wellKnown, 'POST', { ...admin, origin: 'https://portal.example' }, challenge)).status, 403);
  assert.equal((await call(wellKnown, 'POST', admin, { ...challenge, companyId: 'unknown-company' })).status, 403);
  assert.equal((await call(wellKnown, 'POST', admin, { ...challenge, extra: true })).status, 400);
  const aliasProof = await call(wellKnown, 'POST', admin, challenge);
  assert.equal(aliasProof.status, 200);
  const wellKnownClaim = await aliasProof.json();
  const [wHead, wBody, wSignature] = wellKnownClaim.proof.split('.');
  assert.equal(verify(null, Buffer.from(`${wHead}.${wBody}`), createPublicKey({ key: identity.publicJwk, format: 'jwk' }), Buffer.from(wSignature, 'base64url')), true);
  const wellKnownPayload = JSON.parse(Buffer.from(wBody, 'base64url'));
  for (const field of ['typ', 'version', 'nonce', 'aud', 'companyId', 'instanceId']) assert.equal(wellKnownPayload[field], payload[field], field);
  assert.equal(wellKnownPayload.exp - wellKnownPayload.iat, 300);
  assert.equal(wellKnownClaim.instanceId, identity.instanceId);
  assert.deepEqual(wellKnownClaim.publicJwk, identity.publicJwk);
  assert.equal((await call(wellKnown, 'DELETE', admin)).status, 405);
  await stop();
  assert.doesNotMatch(output, /query-sensitive-marker|request-body-marker|existing-sensitive-marker|foreign-content-marker|forged-agent/);
  assert.ok(!output.includes(instance));
  assert.ok(principals.every(p => !output.includes(p.token)));
  const db = new DatabaseSync(join(data, 'authorization-audit.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM authorization_audit').all();
    assert.ok(rows.some(r => r.principal_id === 'agent-15' && r.decision === 'admitted' && r.response_status === 201));
    assert.ok(rows.some(r => r.principal_id === 'agent-0' && r.decision === 'denied' && r.response_status === 403));
    assert.ok(!JSON.stringify(rows).includes(queryMarker));
    assert.ok(!JSON.stringify(rows).includes('request-body-marker'));
  } finally { db.close(); }
  assert.equal((await stat(join(data, 'instance-claim-identity.json'))).mode & 0o777, 0o600);
  // Removing the principal at the customer-controlled restart revokes the old bearer.
  await start(principals.filter(p => p.principalId !== 'agent-15'));
  assert.equal((await call('/api/companies/customer-a/knowledge/collections', 'GET', full)).status, 401);
  assert.deepEqual(await (await call('/api/tealbrick/claim')).json(), identity);
});
