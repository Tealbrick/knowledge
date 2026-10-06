import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { startFakeGBrainService, startFakeHindsight } from '../../program/scripts/fixtures/fake-engines.mjs';

/**
 * Coverage/parity through the real Portal attachment path: for every operation
 * each pinned engine exposes, an agent holding only a Portal attachment reaches
 * it through the instance edge (route -> knowledge:engine:read|write
 * introspection -> per-request principal -> Program -> MemoryEngine -> fake
 * upstream in the bound partition). Excluded operations are refused before
 * Portal is contacted.
 */
const program = resolve(import.meta.dirname, '../../program');
const company = 'fixture-company';
const plan = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'scripts/engine-coverage-report.ts', '--json', company], { cwd: program, encoding: 'utf8' }));

async function freePort() {
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  return port;
}

async function withEdge(env, run) {
  const data = await mkdtemp(`${tmpdir()}/knowledge-native-edge-`);
  const introspections = [];
  const denied = new Set();
  const portal = createHttpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); introspections.push(input.capability);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ authorized: input.agentToken === 'fixture-agent-token' && !denied.has(input.capability), orgId: 'fixture-org', agentId: 'fixture-agent',
      deploymentId: 'fixture-deployment', companyId: company, capability: input.capability, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  });
  await new Promise(r => portal.listen(0, '127.0.0.1', r));
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', '../deploy/container/server.ts'], {
    cwd: program,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), KNOWLEDGE_DATA_DIR: data, KNOWLEDGE_GBRAIN_AUTOSTART: 'false',
      KNOWLEDGE_INSTANCE_TOKEN: randomBytes(32).toString('hex'), TEALBRICK_PORTAL_URL: `http://127.0.0.1:${portal.address().port}`,
      TEALBRICK_DEPLOYMENT_ID: 'fixture-deployment', KNOWLEDGE_COMPANY_ID: company, KNOWLEDGE_PORTAL_ORG_ID: 'fixture-org', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let error = ''; child.stderr.on('data', chunk => { error += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      if (child.exitCode !== null) throw new Error(error);
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(ready, error);
    await run({ base, introspections, denied });
  } finally {
    if (child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; }
    await new Promise(r => portal.close(r));
    await rm(data, { recursive: true, force: true });
  }
}

const agent = { authorization: 'Bearer fixture-attachment', 'x-tealbrick-agent-token': 'fixture-agent-token', 'content-type': 'application/json' };
const call = (base, name, args, write, extra = {}) => fetch(`${base}/api/brain/native/${name}`, { method: 'POST',
  headers: { ...agent, ...(write ? { 'idempotency-key': `edge-${name}` } : {}) }, body: JSON.stringify({ arguments: args, ...extra }) });

async function proveEngine({ base, introspections, denied }, engine, upstreamCalls, assertUpstream) {
  const catalog = await fetch(`${base}/api/brain/native/tools`, { headers: agent });
  assert.equal(catalog.status, 200);
  assert.deepEqual((await catalog.json()).data.tools.map(tool => tool.name).sort(), engine.exposed.map(op => op.name).sort(), `${engine.engine} catalog is the full exposed surface`);
  denied.add('knowledge:engine:write');
  const readOnly = await (await fetch(`${base}/api/brain/native/tools`, { headers: agent })).json();
  assert.deepEqual(readOnly.data.tools.map(tool => tool.name).sort(), engine.exposed.filter(op => op.scope === 'read').map(op => op.name).sort(), 'a read-only grant discovers reads only');
  denied.clear();
  for (const op of engine.exposed) {
    const before = upstreamCalls.length;
    introspections.length = 0;
    const response = await call(base, op.name, op.arguments, op.scope === 'write');
    assert.equal(response.status, 200, `${engine.engine}/${op.name}: ${await response.clone().text()}`);
    assert.equal((await response.json()).ok, true, op.name);
    assert.ok(introspections.length >= 2 && introspections.every(capability => capability === op.portalCapability), `${op.name} needs exactly ${op.portalCapability}: ${introspections}`);
    assert.equal(upstreamCalls.length, before + 1, `${op.name} reached upstream once`);
    assertUpstream(op, upstreamCalls.at(-1));
  }
  // Excluded operations never cost a Portal introspection.
  for (const { name } of engine.excluded) {
    introspections.length = 0;
    assert.equal((await call(base, name, {}, true)).status, 401, name);
    assert.equal(introspections.length, 0, `${name} refused before Portal`);
  }
  // A read grant does not admit writes, and the partition is fixed by the attachment.
  const write = engine.exposed.find(op => op.scope === 'write');
  const read = engine.exposed.find(op => op.scope === 'read');
  denied.add('knowledge:engine:write');
  assert.equal((await call(base, write.name, write.arguments, true)).status, 401, 'write needs knowledge:engine:write');
  assert.equal((await call(base, read.name, read.arguments, false)).status, 200, 'read still admitted');
  denied.clear();
  assert.equal((await call(base, read.name, read.arguments, false, { partitionKey: 'other-company' })).status, 401, 'foreign partition refused');
  assert.equal((await call(base, read.name, read.arguments, false, { partitionKey: company })).status, 200, 'own partition accepted');
  // No silent widening: knowledge:brain:read (recall/context) never reaches the engine surface.
  denied.add('knowledge:engine:read');
  introspections.length = 0;
  assert.equal((await fetch(`${base}/api/brain/native/tools`, { headers: agent })).status, 401, 'discovery needs knowledge:engine:read');
  assert.equal((await call(base, read.name, read.arguments, false)).status, 401, 'engine reads need knowledge:engine:read');
  assert.ok(!introspections.includes('knowledge:brain:read'), 'the native route never asks Portal for knowledge:brain:read');
  assert.equal((await fetch(`${base}/api/brain/recall`, { method: 'POST', headers: agent, body: JSON.stringify({ query: 'x' }) })).status !== 401, true, 'recall keeps knowledge:brain:read');
  denied.clear();
}

test('every exposed Hindsight operation is reachable through a Portal attachment, in the bound bank', async () => {
  const apiKey = randomBytes(24).toString('hex');
  const fake = await startFakeHindsight({ apiKey });
  try {
    await withEdge({ KNOWLEDGE_MEMORY_ENGINE: 'hindsight', KNOWLEDGE_HINDSIGHT_URL: fake.baseUrl, KNOWLEDGE_HINDSIGHT_API_KEY: apiKey }, async edge => {
      await proveEngine(edge, plan.hindsight, fake.calls, (op, sent) => {
        assert.equal(sent.method, op.http.method, op.name);
        if (op.http.bankScoped) assert.equal(sent.bank, plan.bank, `${op.name} stays in the partition bank`);
      });
      const bankless = await call(edge.base, 'list_memories', { bank_id: 'tb-00000000000000000000000000000000' }, false);
      assert.equal(bankless.status, 400, 'caller bank selection is refused');
    });
  } finally { await fake.close(); }
  assert.equal(plan.hindsight.coverage.unaccounted.length, 0);
});

test('every exposed GBrain service operation is reachable through a Portal attachment, on the bound source', async () => {
  const adminToken = randomBytes(24).toString('hex');
  const fake = await startFakeGBrainService({ adminToken, tools: plan.gbrain.exposed.map(op => op.name) });
  try {
    await withEdge({ KNOWLEDGE_GBRAIN_URL: fake.baseUrl, KNOWLEDGE_GBRAIN_ADMIN_TOKEN: adminToken }, async edge => {
      let source;
      await proveEngine(edge, plan.gbrain, fake.calls, (op, sent) => {
        assert.equal(sent.name, op.name);
        source ??= sent.source;
        assert.equal(sent.source, source, `${op.name} uses the bound source`);
        assert.match(sent.source, /^kb-[a-f0-9]{24}$/u);
      });
      const injected = await call(edge.base, 'query', { source_id: 'kb-000000000000000000000000' }, false);
      assert.equal(injected.status, 400, 'caller source selection is refused');
    });
  } finally { await fake.close(); }
  assert.equal(plan.gbrain.coverage.unaccounted.length, 0);
});

// Opt-in: the same Portal attachment path against a REAL Hindsight at the pinned tag.
const liveUrl = process.env.KNOWLEDGE_HINDSIGHT_PARITY_URL;
const liveKey = process.env.KNOWLEDGE_HINDSIGHT_PARITY_KEY;
test('a Portal attachment retains and recalls through the edge on a real Hindsight', { skip: !liveUrl || !liveKey }, async () => {
  await withEdge({ KNOWLEDGE_MEMORY_ENGINE: 'hindsight', KNOWLEDGE_HINDSIGHT_URL: liveUrl, KNOWLEDGE_HINDSIGHT_API_KEY: liveKey }, async ({ base }) => {
    const marker = `edge-live-${Date.now().toString(36)}`;
    const retained = await call(base, 'retain_memories', { body: { items: [{ content: `Henry publishes the ${marker} meetup recap on Mondays.`, document_id: marker }] } }, true);
    assert.equal(retained.status, 200, await retained.clone().text());
    const recalled = await (await call(base, 'recall_memories', { body: { query: `When is the ${marker} recap published?` } }, false)).json();
    assert.equal(recalled.ok, true);
    assert.match(JSON.stringify(recalled.data), new RegExp(marker, 'u'));
    const documents = await (await call(base, 'list_documents', {}, false)).json();
    assert.match(JSON.stringify(documents.data), new RegExp(marker, 'u'));
    assert.equal((await call(base, 'delete_document', { document_id: marker }, true)).status, 200);
  });
});
