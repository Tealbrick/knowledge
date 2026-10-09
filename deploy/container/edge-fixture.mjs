import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';

/** Shared fixtures for the contract edge tests: a real edge process and a fake Portal Core. Not a test file. */

export const company = 'fixture-company';
export const org = 'fixture-org';
export const deployment = 'fixture-deployment';

export async function freePort() {
  const reservation = createNetServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  return port;
}

const body = async req => { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; };

/**
 * A fake Portal Core. State the test edits live:
 * - `grants[token]` = { agentId, actions, operations?, partitionKey? (default null = company scope), omitPartitionKey?, overrides? }   (POST /api/runtime/app-grant/introspect)
 * - `attachments[attachment]` = extra introspection fields                            (POST /api/deployment-access/introspect)
 * - `runtime[tbkg token]` = extra runtime-principal answer fields                      (POST /api/runtime/knowledge-principal/introspect)
 * - `tickets[ticket]` = { route?, purpose? }                                          (POST /api/deployment-browser/redeem)
 * - `sessions[session]`                                                               (POST /api/deployment-browser/introspect)
 */
export async function startFakePortal({ instanceToken, operationsFor, proof = instanceToken }) {
  const state = { grants: {}, attachments: {}, runtime: {}, tickets: {}, sessions: {}, calls: [], redeemHeaders: [] };
  const server = createServer(async (req, res) => {
    const input = await body(req);
    state.calls.push({ url: req.url, headers: req.headers, body: input });
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/api/runtime/app-grant/introspect') {
      if (req.headers['x-tealbrick-instance-proof'] !== proof) return json(401, { error: 'instance_auth_required' });
      const grant = state.grants[input.token];
      if (input.deploymentId !== deployment || input.product !== 'knowledge' || !grant) return json(403, { error: 'app_grant_denied' });
      return json(200, {
        authorized: true, principalId: `tealbrick-agent:${grant.agentId}`, agentId: grant.agentId, orgId: org, workspaceId: company,
        deploymentId: deployment, product: 'knowledge', productTenantId: company, actions: grant.actions,
        operations: grant.operations ?? operationsFor(grant.actions), capabilityRevision: 1, expiresAt: Date.now() + 60_000,
        ...(grant.omitPartitionKey ? {} : { partitionKey: grant.partitionKey === undefined ? null : grant.partitionKey }), ...grant.overrides,
      });
    }
    if (req.url === '/api/runtime/knowledge-principal/introspect') {
      const extra = state.runtime[input.token];
      if (!extra) return json(403, { error: 'knowledge_principal_denied' });
      const capabilities = ['knowledge:create', 'knowledge:read', 'brain:read', 'knowledge:update', 'knowledge:delete'];
      return json(200, { authorized: true, principalId: 'tealbrick-agent:runtime-agent', agentId: 'runtime-agent', orgId: org, workspaceId: company, instanceId: input.instanceId,
        companyId: company, actions: ['create', 'read', 'update', 'delete'], capabilities, partitionGrants: [{ partitionKey: company, breadth: 'exact', maxDepth: 0, capabilities }],
        capabilityRevision: 1, expiresAt: Date.now() + 60_000, ...extra });
    }
    if (req.url === '/api/deployment-access/introspect') {
      const extra = state.attachments[input.attachment];
      return json(200, { authorized: input.agentToken === 'fixture-agent-token' && extra !== undefined, orgId: org, agentId: 'fixture-agent', deploymentId: deployment,
        companyId: company, capability: input.capability, ...extra, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (req.url === '/api/deployment-browser/redeem' || req.url === '/api/deployment-browser/introspect') {
      state.redeemHeaders.push(req.headers);
      const supplied = req.headers['x-tealbrick-instance-proof'] ?? req.headers['x-knowledge-instance-token'];
      if (supplied !== proof) return json(401, { error: 'instance_auth_required' });
      const redeem = req.url.endsWith('/redeem');
      const record = redeem ? state.tickets[input.ticket] : state.sessions[input.session];
      if (!record || record.used) return json(401, { error: 'invalid_browser_session' });
      let session = input.session;
      if (redeem) { record.used = true; session = randomBytes(32).toString('base64url'); state.sessions[session] = { ...record, used: false }; }
      return json(200, { schema: 1, authorized: true, product: 'knowledge', deploymentId: deployment, workspaceId: company, companyId: company, orgId: org, userId: 'owner-1',
        endpoint: record.endpoint, instanceProofAudience: `tealbrick/knowledge/${deployment}`, expiresAt: Date.now() + 3_600_000, ...(redeem ? { session } : {}),
        ...(record.route !== undefined ? { route: record.route } : {}), ...(record.purpose !== undefined ? { purpose: record.purpose } : {}) });
    }
    return json(404, { error: 'not_found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

/** Spawn the real instance edge (server.ts) with a fresh data volume unless one is given. */
export async function startEdge({ env = {}, data, stderr = true } = {}) {
  const volume = data ?? await mkdtemp(`${tmpdir()}/knowledge-contract-edge-`);
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', '../deploy/container/server.ts'], {
    cwd: resolve(import.meta.dirname, '../../program'),
    env: { PATH: process.env.PATH, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), KNOWLEDGE_DATA_DIR: volume, KNOWLEDGE_GBRAIN_AUTOSTART: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 400 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(`edge failed to start: ${output.slice(-800)}`);
    try { ready = (await fetch(`${base}/healthz`)).ok; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  if (!ready) throw new Error(`edge not ready: ${output.slice(-800)}`);
  const stop = async ({ keepData = false } = {}) => {
    if (child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; }
    if (!keepData && data === undefined) await rm(volume, { recursive: true, force: true });
  };
  return { base, port, data: volume, stop, output: () => output, child };
}
