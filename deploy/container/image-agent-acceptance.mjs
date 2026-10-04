import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const image = process.env.KNOWLEDGE_IMAGE;
assert.ok(image, 'Set KNOWLEDGE_IMAGE to the exact built or pulled image reference');
const buildMode = process.env.KNOWLEDGE_BUILD_MODE ?? 'registry-pull';
const id = `knowledge-image-agent-${randomBytes(5).toString('hex')}`;
const restore = `${id}-restore`;
const instance = randomBytes(32).toString('hex');
const alpha = `alpha-${randomBytes(24).toString('hex')}`;
const beta = `beta-${randomBytes(24).toString('hex')}`;
const principals = JSON.stringify([
  { token: alpha, principalId: 'alpha-agent', companyId: 'workspace-alpha', capabilities: ['knowledge:create', 'knowledge:read', 'knowledge:update'], partitionGrants: [{ partitionKey: 'workspace-alpha', breadth: 'exact', maxDepth: 0, capabilities: ['knowledge:create', 'knowledge:read', 'knowledge:update'] }] },
  { token: beta, principalId: 'beta-agent', companyId: 'workspace-beta', capabilities: ['knowledge:create', 'knowledge:read'], partitionGrants: [{ partitionKey: 'workspace-beta', breadth: 'exact', maxDepth: 0, capabilities: ['knowledge:create', 'knowledge:read'] }] },
]);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
const api = (base, route, options = {}) => fetch(`${base}${route}`, { ...options, signal: options.signal ?? AbortSignal.timeout(30_000) });
const auth = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
let running = false;
let restored = false;
let base;

function start(volume) {
  docker('run', '-d', '--pull', 'never', '--name', id, '--memory', '1536m', '--memory-swap', '1536m', '--cpus', '2', '-p', '127.0.0.1::5310', '-v', `${volume}:/data`,
    '-e', `KNOWLEDGE_INSTANCE_TOKEN=${instance}`, '-e', 'KNOWLEDGE_PARTITION_AUTH_REQUIRED=true', '-e', 'KNOWLEDGE_GBRAIN_AUTOSTART=false', '-e', `KNOWLEDGE_SERVICE_PRINCIPALS=${principals}`, image);
  running = true;
  base = `http://${docker('port', id, '5310/tcp')}`;
}

async function ready() {
  for (let i = 0; i < 180; i += 1) {
    try { if ((await api(base, '/healthz')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Pulled image did not become healthy within 180 seconds');
}

async function expectStatus(route, status, options) {
  const response = await api(base, route, options);
  assert.equal(response.status, status, `${route} returned ${response.status}, expected ${status}`);
  return response;
}

try {
  docker('image', 'inspect', image);
  docker('volume', 'create', id);
  start(id);
  await ready();
  await expectStatus('/api/status', 401);

  const alphaHeaders = auth(alpha);
  const betaHeaders = auth(beta);
  const partitions = await (await expectStatus('/api/knowledge/partitions', 200, { headers: alphaHeaders })).json();
  assert.deepEqual(partitions.partitions.map(item => item.partitionKey), ['workspace-alpha']);
  const alphaCollection = await (await expectStatus('/api/companies/workspace-alpha/knowledge/collections', 201, { method: 'POST', headers: alphaHeaders, body: JSON.stringify({ name: 'Workspace alpha private knowledge' }) })).json();
  const alphaDoc = await (await expectStatus(`/api/knowledge/collections/${alphaCollection.id}/documents`, 201, { method: 'POST', headers: alphaHeaders, body: JSON.stringify({ title: 'Workspace alpha marker', body: 'alpha-only-image-acceptance', actor: { kind: 'agent', id: 'alpha-agent' } }) })).json();
  assert.deepEqual({
    companyId: alphaDoc.companyId,
    createdByAgentId: alphaDoc.createdByAgentId,
    createdByUserId: alphaDoc.createdByUserId,
    source: alphaDoc.source,
  }, {
    companyId: 'workspace-alpha',
    createdByAgentId: 'alpha-agent',
    createdByUserId: null,
    source: null,
  });
  const retrieved = await (await expectStatus(`/api/knowledge/documents/${alphaDoc.id}`, 200, { headers: alphaHeaders })).json();
  assert.equal(retrieved.body, 'alpha-only-image-acceptance');
  assert.equal(retrieved.createdByAgentId, 'alpha-agent');
  const search = await (await expectStatus('/api/companies/workspace-alpha/knowledge/search?q=alpha-only-image-acceptance', 200, { headers: alphaHeaders })).json();
  assert.equal(search[0]?.id, alphaDoc.id);
  assert.equal(search[0]?.companyId, 'workspace-alpha');
  const events = await (await expectStatus('/api/events', 200, { headers: alphaHeaders })).json();
  assert.equal(events.events.some(event => event.type === 'brain.projection.document' && event.artifactId === alphaDoc.id), true);
  await expectStatus(`/api/knowledge/documents/${alphaDoc.id}`, 403, { headers: betaHeaders });
  await expectStatus('/api/companies/workspace-beta/knowledge/collections', 201, { method: 'POST', headers: betaHeaders, body: JSON.stringify({ name: 'Workspace beta private knowledge' }) });
  await expectStatus('/api/companies/workspace-beta/knowledge/collections', 403, { method: 'POST', headers: alphaHeaders, body: JSON.stringify({ name: 'forged cross-partition write' }) });
  // A caller-supplied foreign selector is malformed scope input, so the API
  // rejects it as 400 before capability authorization; cross-partition writes
  // remain 403 because they target an authorized route with a forbidden grant.
  await expectStatus('/api/companies/workspace-alpha/knowledge/collections?partitionKey=workspace-beta', 400, { headers: alphaHeaders });

  docker('restart', id);
  base = `http://${docker('port', id, '5310/tcp')}`;
  await ready();
  assert.equal((await (await expectStatus(`/api/knowledge/documents/${alphaDoc.id}`, 200, { headers: alphaHeaders })).json()).body, 'alpha-only-image-acceptance');

  docker('stop', id);
  docker('volume', 'create', restore);
  restored = true;
  docker('run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${id}:/from:ro`, '-v', `${restore}:/to`, image, '-c', 'cp -a /from/. /to/');
  docker('rm', id);
  running = false;
  start(restore);
  await ready();
  assert.equal((await (await expectStatus(`/api/knowledge/documents/${alphaDoc.id}`, 200, { headers: alphaHeaders })).json()).body, 'alpha-only-image-acceptance');
  const state = JSON.parse(docker('inspect', id, '--format', '{{json .State}}'));
  const memory = docker('stats', '--no-stream', '--format', '{{.MemUsage}} {{.CPUPerc}}', id);
  let peak = 'unavailable';
  try { peak = docker('exec', id, 'sh', '-c', 'cat /sys/fs/cgroup/memory.peak').trim(); } catch {}
  console.log(JSON.stringify({ ok: true, image, buildMode, registryAccess: process.env.KNOWLEDGE_REGISTRY_ACCESS ?? 'unknown', proof: [buildMode, 'agent-auth', 'partition-isolation', 'synthetic-ingestion', 'retrieval', 'provenance', 'projection-event', 'volume-restart', 'cold-volume-restore'], container: { status: state.Status, memory, memoryPeakBytes: peak } }));
} finally {
  if (running) { try { docker('rm', '-f', id); } catch {} }
  try { docker('volume', 'rm', id); } catch {}
  if (restored) { try { docker('volume', 'rm', restore); } catch {} }
}
