/** Disposable, paired API/native retrieval evaluation. No gold labels mounted. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const [dataset = 'synthetic', label = 'parity'] = process.argv.slice(2);
assert(['synthetic', 'pilot'].includes(dataset));
assert(/^[a-z0-9-]+$/.test(label));
const output = `/out/${label}.jsonl`;
assert(!fs.existsSync(output), 'Reconcile existing writes before rerunning');
const settings = JSON.parse(fs.readFileSync('/fixture/settings-request.json', 'utf8'));
const operator = JSON.parse(fs.readFileSync('/fixture/operator.json', 'utf8'));
assert(['http://127.0.0.1:5314','http://127.0.0.1:5315'].includes(operator.endpoint));
const principal = operator.principals.find((p: any) => p.companyId === 'eval-b');
assert(principal);
const { modelSettingsEnvironment } = await import('/app/knowledge/program/src/model-settings.ts');
Object.assign(process.env, modelSettingsEnvironment(settings));
const { configureGateway } = await import('/app/knowledge/sidecars/gbrain/src/core/ai/gateway.ts');
configureGateway({ embedding_model: process.env.GBRAIN_EMBEDDING_MODEL, embedding_dimensions: settings.embedding.dimensions, chat_model: process.env.GBRAIN_CHAT_MODEL, expansion_model: process.env.GBRAIN_CHAT_MODEL, chat_fallback_chain: [], env: process.env, base_urls: { ollama: settings.chat.baseUrl, 'llama-server': settings.embedding.baseUrl } });
const { createBenchmarkBrain } = await import('/app/knowledge/sidecars/gbrain/src/eval/longmemeval/harness.ts');
const { operationsByName } = await import('/app/knowledge/sidecars/gbrain/src/core/operations.ts');
const engine = await createBenchmarkBrain();
const config = { engine: 'pglite', embedding_model: process.env.GBRAIN_EMBEDDING_MODEL, embedding_dimensions: settings.embedding.dimensions };
const sourceId = `kb-${createHash('sha256').update('eval-b').digest('hex').slice(0, 24)}`;
await engine.executeRaw('INSERT INTO sources (id,name,local_path) VALUES ($1,$1,NULL)', [sourceId]);
await engine.setConfig('search.cache.enabled', 'false');
let retrieval: unknown;
const ctx = { engine, config, sourceId, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} }, emitResponseMeta(key: string, value: unknown) { if (key === 'retrieval') retrieval = value; }, auth: { clientId: 'parity', sourceId, scopes: ['read','write'], allowedSources: [sourceId], hasSourceGrant: true } };
function receipt(row: object) { fs.appendFileSync(output, JSON.stringify(row) + '\n', { mode: 0o600 }); }
async function api(url: string, body?: object) {
  const response = await fetch(operator.endpoint + url, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${principal.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180000) });
  const result = await response.json();
  assert(response.ok && result.ok !== false, `Knowledge operation failed: ${response.status}/${result.degradedReason ?? result.error}`);
  return result;
}
const all = JSON.parse(fs.readFileSync(`/input/${dataset}.json`, 'utf8'));
const cases = dataset === 'synthetic' ? all : all.slice(0, 1);
const first = cases[0];
const collection = await api('/api/companies/eval-b/knowledge/collections', { name: `Memory parity ${label}` });
receipt({ event: 'start', dataset, label, collection: collection.id, cases: cases.length, sessions: first.haystack_sessions.length, fixtureSHA256: createHash('sha256').update(JSON.stringify(cases)).digest('hex'), dimensions: settings.embedding.dimensions, models: { chat: settings.chat.model, embedding: settings.embedding.model }, goldExcluded: true });
try {
  for (let i = 0; i < first.haystack_sessions.length; i++) {
    const session = first.haystack_session_ids[i];
    const date = first.haystack_dates?.[i] ?? 'unknown';
    const body = `Session date: ${date}\n\n` + first.haystack_sessions[i].map((t: any) => `${t.role}: ${t.content}`).join('\n\n');
    const doc = await api(`/api/knowledge/collections/${collection.id}/documents`, { title: `Session ${session}`, body });
    // Identical projected representation; native arm has an independent in-memory DB.
    const q = (v: unknown) => JSON.stringify(v ?? '');
    const content = `---\ntype: knowledge_document\nknowledge_document_id: ${q(doc.id)}\ncompany_id: ${q(doc.companyId)}\ncollection_id: ${q(doc.collectionId)}\nstatus: ${q(doc.status)}\ntitle: ${q(doc.title)}\nupdated_at: ${q(doc.updatedAt)}\n---\n\n# ${doc.title}\n\n${doc.summary ? doc.summary+'\n\n' : ''}${doc.body}`;
    await operationsByName.put_page.handler(ctx, { slug: `knowledge-docs/${doc.id}`, content, source_kind: 'put_page', source_uri: `knowledge-document:${doc.id}`, ingested_via: 'knowledge-program', source_id: sourceId });
    receipt({ event: 'ingest', session, documentId: doc.id, chars: body.length });
    console.log(JSON.stringify({ event: 'ingest', session, completed: i + 1, total: first.haystack_sessions.length }));
  }
  for (const item of cases) {
    for (const arm of ['knowledge', 'native-matched', 'native-default']) {
      const start = Date.now();
      try {
        retrieval = undefined;
        const knowledge = arm === 'knowledge' ? await api('/api/brain/context', { scopeRef: 'eval-b', query: item.question }) : null;
        const result = knowledge ? knowledge.answer
          : await operationsByName.query.handler(ctx, { query: item.question, source_id: sourceId, limit: 8, detail: 'medium', ...(arm === 'native-matched' ? { expand: false } : {}) });
        receipt({ event: 'query', id: item.question_id, arm, ms: Date.now()-start, ok: true, result, retrieval: knowledge ? knowledge.retrieval : retrieval });
        console.log(JSON.stringify({ event: 'query', id: item.question_id, arm, ms: Date.now()-start, rows: Array.isArray(result) ? result.length : null }));
      } catch (error) { receipt({ event: 'query', id: item.question_id, arm, ok: false, ms: Date.now()-start }); console.log(JSON.stringify({ event: 'query', id: item.question_id, arm, ok: false })); }
    }
  }
} finally { await engine.disconnect(); }
receipt({ event: 'finished', at: new Date().toISOString() });
