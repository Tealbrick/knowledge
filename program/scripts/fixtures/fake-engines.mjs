import { createServer } from 'node:http';

/**
 * Disposable stand-ins for the pinned upstream engine services, used only by
 * the coverage/parity tests. They record what Knowledge sends (route, bank,
 * source, tool) and answer with neutral success; they never model upstream
 * semantics and are not evidence of answer quality.
 */

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

/**
 * Fake `hindsight-api` (tenant key auth, bank-scoped routes). `answer(call)` may return a JSON value for a bank-scoped
 * call (for example per-bank recall results); returning undefined keeps the neutral default answer.
 */
export async function startFakeHindsight({ apiKey, version = '0.10.2', answer }) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://hindsight.invalid');
    const body = await readBody(req);
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && url.pathname === '/health') return json(200, { status: 'healthy', database: 'connected' });
    if (req.headers.authorization !== `Bearer ${apiKey}`) return json(401, { detail: 'unauthorized' });
    const bank = /^\/v1\/default\/banks\/([^/]+)/u.exec(url.pathname)?.[1] ?? null;
    calls.push({ method: req.method, path: url.pathname, rawPath: req.url.split('?')[0], query: Object.fromEntries(url.searchParams), bank: bank && decodeURIComponent(bank),
      contentType: req.headers['content-type'] ?? null, body: body.length && /json/u.test(req.headers['content-type'] ?? '') ? JSON.parse(body.toString('utf8')) : body.length ? `<${body.length} bytes>` : null });
    if (req.method === 'GET' && url.pathname === '/version') return json(200, { api_version: version });
    if (url.pathname.startsWith('/v1/default/chunks/')) {
      const chunkId = decodeURIComponent(url.pathname.slice('/v1/default/chunks/'.length));
      return json(200, { chunk_id: chunkId, bank_id: chunkId.split('_')[0], chunk_text: 'fixture' });
    }
    if (/\/attachments\/[^/]+$/u.test(url.pathname) || url.pathname.startsWith('/v1/default/files/download/')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from([0x50, 0x4b, 0x03, 0x04])); return;
    }
    const custom = answer ? answer(calls.at(-1)) : undefined;
    if (custom !== undefined) return json(200, custom);
    if (url.pathname.endsWith('/documents') && req.method === 'GET') return json(200, { items: [{ id: 'knowledge-doc:doc-1', updated_at: '2026-10-06T00:00:00Z' }], total: 1, limit: 100, offset: 0 });
    return json(200, { ok: true, fixture: true });
  });
  const baseUrl = await listen(server);
  return { baseUrl, calls, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Fake `gbrain serve --http` (admin API, client_credentials, stateless MCP). */
export async function startFakeGBrainService({ adminToken, tools, version = '0.60.57.0' }) {
  const calls = [];
  const clients = new Map();
  const tokens = new Map();
  let counter = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gbrain.invalid');
    const raw = (await readBody(req)).toString('utf8');
    const json = (status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && url.pathname === '/health') return json(200, { status: 'ok', version, engine: 'postgres' });
    if (url.pathname === '/admin/login') {
      return JSON.parse(raw).token === adminToken ? json(200, { status: 'authenticated' }, { 'set-cookie': 'gbrain_admin=fixture-session; HttpOnly' }) : json(401, {});
    }
    if (url.pathname === '/admin/api/register-client') {
      if (req.headers.cookie !== 'gbrain_admin=fixture-session') return json(401, {});
      const input = JSON.parse(raw);
      const id = `client-${++counter}`;
      clients.set(id, { secret: `secret-${counter}`, source: input.source, scopes: input.scopes });
      return json(200, { clientId: id, clientSecret: `secret-${counter}` });
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(raw);
      const client = clients.get(form.get('client_id'));
      if (!client || client.secret !== form.get('client_secret')) return json(401, { error: 'invalid_client' });
      const token = `tok-${form.get('client_id')}`;
      tokens.set(token, client);
      return json(200, { access_token: token, token_type: 'bearer', expires_in: 3600 });
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const client = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /u, ''));
      if (!client) return json(401, {});
      const message = JSON.parse(raw);
      if (message.method === 'tools/list') {
        return json(200, { jsonrpc: '2.0', id: message.id, result: { tools: tools.map(name => ({ name, description: `fixture ${name}`,
          inputSchema: { type: 'object', properties: { source_id: { type: 'string' }, slug: { type: 'string' } }, required: [] } })) } });
      }
      const { name, arguments: args } = message.params;
      calls.push({ name, args, source: client.source, scopes: client.scopes });
      // Knowledge's revision probe (get_page include_content) sees an absent page, so projections create.
      const absent = name === 'get_page' && args?.include_content === true;
      // Mimics upstream image-loader errors that echo file bytes, sizes and existence.
      const imageLeak = name === 'search_by_image' && typeof args?.image_url === 'string' && args.image_url.includes('leak');
      const payload = imageLeak ? { error: 'invalid_params', message: 'Unsupported image format. Magic bytes: 23230a2320486f7374204461 (size 1234 bytes; File not found: /etc/hosts)' }
        : absent ? { error: 'page_not_found' } : { ok: true, operation: name };
      return json(200, { jsonrpc: '2.0', id: message.id, result: { isError: absent || imageLeak, content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    }
    return json(404, {});
  });
  const baseUrl = await listen(server);
  return { baseUrl, calls, close: () => new Promise(resolve => server.close(resolve)) };
}
