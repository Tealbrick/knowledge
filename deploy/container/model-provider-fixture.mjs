import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

// Disposable OpenAI-compatible endpoint for structural setup checks only.
// It does not run a language or embedding model and must never be read as
// evidence of answer quality, grounding, or production readiness.
const dimension = 1536;
const canary = [
  'Which animal purrs and chases mice?',
  'A cat purrs and hunts mice.',
  'A diesel engine powers a delivery truck.',
  'How do I bake a loaf of bread?',
  'Mix flour, yeast and water, let the dough rise, then bake it.',
  'A database index speeds up SQL queries.',
  "How many copies of the artist's debut album were released?",
  'The musician released only 500 copies of the first album.',
  'Schools use virtual reality for classroom instruction.',
];
const evidence = { embeddingCanaryRequests: 0, chatReadinessRequests: 0, embeddingOtherRequests: 0,
  chatOtherRequests: 0, canaryDimensions: dimension, label: 'deterministic-structural-fixture' };
const respond = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
};
const vectorFor = (text) => {
  const known = canary.indexOf(text);
  const vector = Array(dimension).fill(0);
  if (known >= 0) {
    const group = Math.floor(known / 3);
    const item = known % 3;
    vector[group * 2 + (item === 2 ? 1 : 0)] = 1;
    return vector;
  }
  for (const word of text.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
    const digest = createHash('sha256').update(word).digest();
    const index = digest.readUInt32BE(0) % dimension;
    vector[index] += digest[4] & 1 ? 1 : -1;
  }
  if (vector.every(value => value === 0)) vector[0] = 1;
  return vector;
};
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { if (raw) body = JSON.parse(raw); } catch { respond(res, 400, { error: 'invalid_json' }); return; }
  if (req.method === 'GET' && req.url === '/healthz') { respond(res, 200, { ok: true, fixture: evidence.label }); return; }
  if (req.method === 'GET' && req.url === '/__fixture/evidence') { respond(res, 200, evidence); return; }
  if (req.method === 'GET' && req.url === '/v1/models') {
    respond(res, 200, { object: 'list', data: [
      { id: 'knowledge-structural-fixture-chat', object: 'model', owned_by: 'fixture' },
      { id: 'knowledge-structural-fixture-embedding', object: 'model', owned_by: 'fixture' },
    ] }); return;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/')) { respond(res, 404, { error: 'not_found' }); return; }
  if (req.headers.authorization !== `Bearer ${process.env.KNOWLEDGE_FIXTURE_KEY}`) { respond(res, 401, { error: 'unauthorized' }); return; }
  if (req.url === '/v1/embeddings') {
    const input = Array.isArray(body.input) ? body.input : [body.input];
    const texts = input.map(value => typeof value === 'string' ? value : JSON.stringify(value));
    if (texts.length === canary.length && texts.every((value, index) => value === canary[index])) evidence.embeddingCanaryRequests++;
    else evidence.embeddingOtherRequests++;
    respond(res, 200, { object: 'list', data: texts.map((text, index) => ({ object: 'embedding', index, embedding: vectorFor(text) })), model: body.model ?? 'fixture-embedding', usage: { prompt_tokens: texts.length, total_tokens: texts.length } });
    return;
  }
  if (req.url === '/v1/chat/completions') {
    const readiness = body.messages?.some(message => message?.content === 'Reply with READY.') === true;
    if (readiness) evidence.chatReadinessRequests++; else evidence.chatOtherRequests++;
    respond(res, 200, { id: 'chatcmpl-fixture', object: 'chat.completion', created: 0, model: body.model ?? 'fixture-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'READY' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    return;
  }
  respond(res, 404, { error: 'unsupported_fixture_route' });
});

server.listen(5319, '0.0.0.0', () => console.log(JSON.stringify({ event: 'fixture-listening', port: 5319, label: evidence.label })));
