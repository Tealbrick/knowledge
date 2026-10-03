import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.KNOWLEDGE_SMOKE_HOST, 'Set the independently verified isolated guest hostname');
assert.equal(hostname(), process.env.KNOWLEDGE_SMOKE_HOST, 'Wrong smoke host');
const mode = process.env.KNOWLEDGE_SMOKE_MODE;
assert.ok(['first-use', 'model-fixture'].includes(mode), 'Set KNOWLEDGE_SMOKE_MODE=first-use or model-fixture');
const id = `knowledge-fixture-${mode}-${randomBytes(5).toString('hex')}`;
const token = randomBytes(32).toString('hex');
const fixtureKey = `fixture-${randomBytes(16).toString('hex')}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
assert.ok(['x86_64', 'amd64'].includes(docker('info', '--format', '{{.Architecture}}')), 'Native amd64 Docker daemon required');
assert.ok(process.env.KNOWLEDGE_IMAGE, 'Set the exact approved locally built image');
const imageId = docker('image', 'inspect', process.env.KNOWLEDGE_IMAGE, '--format', '{{.Id}}');
console.log(JSON.stringify({ event: 'approved-image', tag: process.env.KNOWLEDGE_IMAGE, imageId }));
const headers = { 'x-knowledge-instance-token': token, 'content-type': 'application/json' };
let started = false;
let createdVolume = false;
const restoreVolume = `${id}-restore`;
let createdRestoreVolume = false;
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'model-provider-fixture.mjs');
const modelFixtureRuns = [];
const measure = () => console.log(JSON.stringify({ event: 'container-measurement',
  state: JSON.parse(docker('inspect', id, '--format', '{{json .State}}')),
  memory: docker('exec', id, 'sh', '-c', 'cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.events'),
  stats: docker('stats', '--no-stream', '--format', '{{.MemUsage}} {{.CPUPerc}}', id) }));
const api = async (base, route, options = {}) => fetch(`${base}${route}`, { ...options, signal: options.signal ?? AbortSignal.timeout(180_000) });
const json = async (response) => {
  const body = await response.json();
  assert.ok(response.ok, `${response.url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
};
let base;
async function ready() {
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Knowledge startup exceeded 300 seconds');
}
async function status() { return json(await api(base, '/api/status', { headers })); }
async function settings() { return json(await api(base, '/api/settings/models', { headers })); }
async function assertSetupRequired() {
  const configured = await settings();
  assert.equal(configured.configured, false);
  assert.equal(configured.brain.status, 'disabled');
  const current = await status();
  assert.equal(current.sidecars?.gbrain?.status, 'disabled');
  assert.match(current.sidecars?.gbrain?.detail ?? '', /^setup_required:/);
  console.log(JSON.stringify({ event: 'first-use-setup-required', configured: configured.configured,
    brain: configured.brain, detail: current.sidecars.gbrain.detail }));
}
async function launchFixture() {
  docker('cp', fixturePath, `${id}:/tmp/knowledge-openai-fixture.mjs`);
  docker('exec', '-d', '-e', `KNOWLEDGE_FIXTURE_KEY=${fixtureKey}`, id, 'node', '/tmp/knowledge-openai-fixture.mjs');
  const fixtureBase = `http://${docker('port', id, '5319/tcp')}`;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${fixtureBase}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Synthetic model fixture did not start');
}
async function configureFixture() {
  await launchFixture();
  const endpoint = 'http://127.0.0.1:5319/v1';
  const modelSettings = {
    chat: { provider: 'openai', baseUrl: endpoint, model: 'knowledge-structural-fixture-chat', apiKey: fixtureKey },
    embedding: { provider: 'openai', baseUrl: endpoint, model: 'knowledge-structural-fixture-embedding', apiKey: fixtureKey, dimensions: 1536 },
  };
  const response = await api(base, '/api/settings/models', { method: 'PUT', headers, body: JSON.stringify(modelSettings), signal: AbortSignal.timeout(360_000) });
  const configured = await json(response);
  assert.equal(configured.ok, true);
  assert.equal(configured.configured, true);
  assert.equal(configured.brain?.status, 'online');
  assert.deepEqual(configured.checks?.map(check => ({ component: check.component, ok: check.ok })), [
    { component: 'embedding', ok: true }, { component: 'chat', ok: true },
  ]);
  const persisted = await settings();
  assert.equal(persisted.configured, true);
  assert.equal(JSON.stringify(persisted).includes(fixtureKey), false, 'Model keys must not be returned');
  const canaryEvidence = await fixtureEvidence();
  console.log(JSON.stringify({ event: 'synthetic-model-setup', fixture: 'deterministic-openai-compatible-structural-canary',
    checks: configured.checks, brain: configured.brain, keyRedacted: true,
    limitation: 'Fixture responses prove endpoint/schema/readiness wiring only; they make no model quality claim.' }));
  return canaryEvidence;
}
async function fixtureEvidence() {
  const fixtureBase = `http://${docker('port', id, '5319/tcp')}`;
  const response = await fetch(`${fixtureBase}/__fixture/evidence`);
  assert.equal(response.status, 200);
  return response.json();
}
async function waitForProjectedPage(slug) {
  for (let i = 0; i < 60; i++) {
    const response = await api(base, '/api/brain/entities?kind=pages&partitionKey=fixture&limit=100', { headers, signal: AbortSignal.timeout(10_000) });
    const pages = await json(response);
    if (pages.ok === true && pages.pages?.some(page => page.slug === slug)) return pages;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Brain did not enumerate projected document ${slug}`);
}
async function waitForBrainOnline() {
  for (let i = 0; i < 300; i++) {
    const current = await status();
    if (current.sidecars?.gbrain?.status === 'online') return current;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const current = await status();
  throw new Error(`Brain did not recover from persisted model settings after restart: ${current.sidecars?.gbrain?.status} ${current.sidecars?.gbrain?.detail ?? ''}`);
}
try {
  docker('volume', 'create', id);
  createdVolume = true;
  docker('run', '-d', '--pull', 'never', '--name', id, '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '2',
    '-p', '127.0.0.1::5310', '-p', '127.0.0.1::5319', '-v', `${id}:/data`,
    '-e', `KNOWLEDGE_INSTANCE_TOKEN=${token}`, '-e', 'KNOWLEDGE_AUTO_EXTRACT=false', process.env.KNOWLEDGE_IMAGE);
  started = true;
  base = `http://${docker('port', id, '5310/tcp')}`;
  await ready();
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  if (mode === 'first-use') await assertSetupRequired();
  else {
    await assertSetupRequired();
    modelFixtureRuns.push(await configureFixture());
  }

  const post = async (route, body) => {
    const response = await api(base, route, { method: 'POST', headers, body: JSON.stringify(body) });
    return json(response);
  };
  const collection = await post('/api/companies/fixture/knowledge/collections', { name: id });
  const doc = await post(`/api/knowledge/collections/${collection.id}/documents`, {
    title: id, body: `Synthetic persistence marker ${id}`, bodyFormat: 'markdown',
  });
  const read = await json(await api(base, `/api/knowledge/documents/${doc.id}`, { headers }));
  assert.equal(read.body, doc.body);
  const before = await status();
  console.log(JSON.stringify({ event: 'container-status', status: before }));
  measure();
  if (mode === 'model-fixture') {
    const pages = await waitForProjectedPage(`knowledge-docs/${doc.id}`);
    console.log(JSON.stringify({ event: 'brain-projection', ok: true, slug: `knowledge-docs/${doc.id}`, pageCount: pages.pages.length }));
  }

  docker('restart', id);
  base = `http://${docker('port', id, '5310/tcp')}`;
  await ready();
  const restored = await json(await api(base, `/api/knowledge/documents/${doc.id}`, { headers }));
  assert.equal(restored.body, doc.body);
  if (mode === 'first-use') await assertSetupRequired();
  else {
    const persisted = await settings();
    assert.equal(persisted.configured, true, 'Model settings must survive volume restart');
    assert.equal(JSON.stringify(persisted).includes(fixtureKey), false, 'Persisted model keys must not be returned');
    const recovered = await waitForBrainOnline();
    assert.equal(recovered.sidecars.gbrain.status, 'online', 'Brain must recover from persisted model settings without a replacement PUT');
    await waitForProjectedPage(`knowledge-docs/${doc.id}`);
  }
  const after = await status();
  console.log(JSON.stringify({ event: 'post-restart-status', status: after }));
  // Cold-copy the entire stopped volume, then prove recovery into a distinct
  // volume and a new container. Never copy a live SQLite/PGlite data directory.
  docker('stop', id);
  docker('volume', 'create', restoreVolume);
  createdRestoreVolume = true;
  docker('run', '--rm', '--network', 'none', '--entrypoint', 'sh',
    '-v', `${id}:/from:ro`, '-v', `${restoreVolume}:/to`, process.env.KNOWLEDGE_IMAGE,
    '-c', 'cp -a /from/. /to/');
  docker('rm', id);
  started = false;
  docker('run', '-d', '--pull', 'never', '--name', id, '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '2',
    '-p', '127.0.0.1::5310', '-v', `${restoreVolume}:/data`,
    '-e', `KNOWLEDGE_INSTANCE_TOKEN=${token}`, '-e', 'KNOWLEDGE_AUTO_EXTRACT=false', process.env.KNOWLEDGE_IMAGE);
  started = true;
  base = `http://${docker('port', id, '5310/tcp')}`;
  await ready();
  const recoveredDoc = await json(await api(base, `/api/knowledge/documents/${doc.id}`, { headers }));
  assert.equal(recoveredDoc.body, doc.body);
  if (mode === 'first-use') await assertSetupRequired();
  else {
    assert.equal((await settings()).configured, true);
    await waitForBrainOnline();
    await waitForProjectedPage(`knowledge-docs/${doc.id}`);
  }
  console.log(JSON.stringify({ event: 'cold-volume-restore', ok: true, distinctVolume: true, newContainer: true, mode }));
  assert.equal(docker('exec', id, 'sh', '-c', 'awk \'/^Uid:/{print $2}\' /proc/1/status'), '1000');
  measure();
  let evidence = { mode, fixtureUsed: false };
  if (mode === 'model-fixture') {
    assert.equal(modelFixtureRuns.length, 1, 'Expected one initial synthetic model setup canary');
    assert.ok(modelFixtureRuns[0].embeddingCanaryRequests >= 1, 'Expected structural embedding canary during model setup');
    assert.ok(modelFixtureRuns[0].chatReadinessRequests >= 1, 'Expected chat readiness check during model setup');
    assert.equal(modelFixtureRuns[0].canaryDimensions, 1536);
    evidence = { mode, fixture: 'deterministic-openai-compatible-structural-canary', runs: modelFixtureRuns };
  }
  console.log(JSON.stringify({ ok: true, mode, proof: ['standalone-admin-edge-auth', 'document-create-read', 'volume-restart', 'cold-volume-restore', 'uid-1000', ...(mode === 'model-fixture' ? ['brain-setup', 'document-projection'] : ['fresh-brain-setup-required'])], evidence,
    modelQualityClaim: false, agentInvocation: false }));
} finally {
  if (started) {
    try { measure(); } catch (error) { console.log(JSON.stringify({ event: 'measurement-unavailable', error: error.message })); }
    docker('rm', '-f', id);
  }
  if (createdVolume) docker('volume', 'rm', id);
  if (createdRestoreVolume) docker('volume', 'rm', restoreVolume);
}
