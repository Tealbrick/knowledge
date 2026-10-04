import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';

const freePort = async () => {
  const reservation = createNetServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  return port;
};
const grant = letter => `tbkg_${letter.repeat(43)}`;
const sha = value => createHash('sha256').update(value).digest('hex');

test('a Portal-provisioned instance admits wired agents with no KNOWLEDGE_SERVICE_PRINCIPALS edit', async t => {
  const data = await mkdtemp(`${tmpdir()}/knowledge-portal-edge-`);
  const instanceToken = 'instance-fixture-only-'.repeat(3);
  const [port, portalPort] = [await freePort(), await freePort()];
  const base = `http://127.0.0.1:${port}`, portal = `http://127.0.0.1:${portalPort}`;
  // Fake Portal: verifies the instance-signed introspection and answers from canvas state.
  const wires = { [grant('r')]: ['knowledge:read', 'brain:read'], [grant('c')]: ['knowledge:create', 'knowledge:read', 'brain:read', 'knowledge:update', 'knowledge:delete'] };
  let instance, introspections = 0;
  const portalServer = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    introspections++;
    const [head, payload, signature] = body.proof.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const signed = verify(null, Buffer.from(`${head}.${payload}`), createPublicKey({ key: instance.publicJwk, format: 'jwk' }), Buffer.from(signature, 'base64url'));
    const capabilities = wires[body.token];
    if (req.url !== '/api/runtime/knowledge-principal/introspect' || !signed || claims.aud !== portal || claims.instanceId !== instance.instanceId ||
      claims.tokenDigest !== sha(body.token) || body.instanceId !== instance.instanceId || body.companyId !== 'customer-a' || !capabilities) {
      res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"knowledge_principal_denied"}'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authorized: true, principalId: 'tealbrick-agent:henry', agentId: 'henry', orgId: 'org-1', workspaceId: 'customer-a',
      instanceId: instance.instanceId, companyId: 'customer-a', actions: [], capabilities,
      partitionGrants: [{ partitionKey: 'customer-a', breadth: 'exact', maxDepth: 0, capabilities }], capabilityRevision: 1, expiresAt: Date.now() + 60_000 }));
  });
  await new Promise(r => portalServer.listen(portalPort, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--import', 'tsx', '../deploy/container/server.ts'], {
    cwd: resolve(import.meta.dirname, '../../program'),
    env: { PATH: process.env.PATH, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), KNOWLEDGE_DATA_DIR: data,
      KNOWLEDGE_GBRAIN_AUTOSTART: 'false', KNOWLEDGE_INSTANCE_TOKEN: instanceToken, TEALBRICK_PORTAL_URL: portal,
      TEALBRICK_DEPLOYMENT_ID: 'deployment-fixture', KNOWLEDGE_COMPANY_ID: 'customer-a', KNOWLEDGE_PORTAL_ORG_ID: 'org-1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; }
    await new Promise(r => portalServer.close(r)); await rm(data, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(`edge failed to start: ${output.slice(-500)}`);
    try { ready = (await fetch(base + '/healthz')).ok; } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(ready);
  const admin = { 'x-knowledge-instance-token': instanceToken, 'content-type': 'application/json' };
  instance = await (await fetch(base + '/api/tealbrick/claim', { headers: { 'x-knowledge-instance-token': instanceToken } })).json();
  // Claim succeeds for the Portal-bound company even before any static principal or data exists.
  const proof = await fetch(base + '/api/tealbrick/claim', { method: 'POST', headers: admin, body: JSON.stringify({ portalIssuer: portal, nonce: 'n'.repeat(24), companyId: 'customer-a' }) });
  assert.equal(proof.status, 200);
  const collection = await (await fetch(base + '/api/companies/customer-a/knowledge/collections', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'A' }) })).json();
  const seed = await (await fetch(`${base}/api/knowledge/collections/${collection.id}/documents`, { method: 'POST', headers: admin, body: JSON.stringify({ title: 'Seed', body: 'seed' }) })).json();
  const as = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  assert.equal((await fetch(`${base}/api/knowledge/documents/${seed.id}`, { headers: as(grant('r')) })).status, 200);
  assert.equal((await fetch(`${base}/api/knowledge/collections/${collection.id}/documents`, { method: 'POST', headers: as(grant('r')), body: JSON.stringify({ title: 'No' }) })).status, 403);
  const created = await fetch(`${base}/api/knowledge/collections/${collection.id}/documents`, { method: 'POST', headers: as(grant('c')), body: JSON.stringify({ title: 'Yes' }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).createdByAgentId, 'tealbrick-agent:henry');
  assert.equal((await fetch(`${base}/api/knowledge/documents/${seed.id}`, { method: 'PATCH', headers: as(grant('c')), body: JSON.stringify({ title: 'Changed' }) })).status, 200);
  assert.equal((await fetch(`${base}/api/knowledge/documents/${seed.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${grant('c')}` } })).status, 200);
  // An unwired grant is denied; a non-grant bearer never reaches Portal.
  assert.equal((await fetch(`${base}/api/companies/customer-a/knowledge/collections`, { headers: as(grant('x')) })).status, 401);
  const before = introspections;
  assert.equal((await fetch(`${base}/api/companies/customer-a/knowledge/collections`, { headers: as('not-a-portal-grant') })).status, 401);
  assert.equal(introspections, before);
  assert.doesNotMatch(output, /tbkg_/);
});
