import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startFakeHindsight, type FakeHindsightCall } from '../../program/scripts/fixtures/fake-engines.mjs';
// edge-fixture.mjs ships no declarations; its exports are used as plain values here.
import { company, deployment, org, startEdge, startFakePortal } from './edge-fixture.mjs';

type Action = 'create' | 'read' | 'update' | 'delete';
interface ManifestOperation { readonly id: string; readonly audience?: string; readonly crud: readonly Action[] }
interface Claim { readonly partitionKey: string; readonly readPartitionKeys?: readonly string[] }
interface Stored { readonly id: string; readonly companyId: string }
type RequestHeaders = Record<string, string>;
type Agent = keyof typeof CLAIMS;

/**
 * Partitions contract 2 (read-many / write-one) on the real instance edge, for every agent path: Portal attachments
 * (`x-tealbrick-agent-token`), app grants (`tbag_`, verified by the contract kit) and runtime principals (`tbkg_`).
 * Three partitions of one workspace: A = {write alpha, read [alpha, beta]}, B = {write beta, read [beta]},
 * C = {write gamma, read [gamma]}. A sees alpha + beta and never gamma, never writes into beta; B never sees alpha;
 * an id outside the read set answers exactly like a missing id; a contract 1 grant answers byte for byte as before.
 */
const manifest: { operations: ManifestOperation[] } = JSON.parse(readFileSync(new URL('../../tealbrick.app.json', import.meta.url), 'utf8'));
const agentOperations = manifest.operations.filter(op => (op.audience ?? 'agent') === 'agent');
const operationsFor = (actions: readonly Action[]) => agentOperations.filter(op => op.crud.every(action => actions.includes(action))).map(op => op.id);
const instanceToken = randomBytes(32).toString('hex');
const ALL: Action[] = ['create', 'read', 'update', 'delete'];
const pa = `${company}/alpha`, pb = `${company}/beta`, pc = `${company}/gamma`;
const bank = (partition: string) => `tb-${createHash('sha256').update(`knowledge-partition:${partition}`).digest('hex').slice(0, 32)}`;
const BANKS: Record<string, string> = { [bank(pa)]: 'alpha', [bank(pb)]: 'beta', [bank(pc)]: 'gamma' };
const CLAIMS: Record<'A' | 'B' | 'C' | 'B1' | 'BAD', Claim> = {
  A: { partitionKey: 'alpha', readPartitionKeys: ['alpha', 'beta'] },
  B: { partitionKey: 'beta', readPartitionKeys: ['beta'] },
  C: { partitionKey: 'gamma', readPartitionKeys: ['gamma'] },
  B1: { partitionKey: 'beta' },
  BAD: { partitionKey: 'alpha', readPartitionKeys: ['beta'] },
};

test('contract 2 read sets on the instance edge: attachments, app grants and runtime principals', async (t: TestContext) => {
  const hindsightKey = randomBytes(16).toString('hex');
  const hindsight = await startFakeHindsight({ apiKey: hindsightKey, answer: (call: FakeHindsightCall) => call.bank && call.path.endsWith('/memories/recall')
    ? { results: [1, 2].map(rank => ({ id: `${BANKS[call.bank!]}-${rank}`, text: `${BANKS[call.bank!]} memory ${rank}` })) } : undefined });
  const portal = await startFakePortal({ instanceToken, operationsFor });
  const edge = await startEdge({ env: {
    NODE_ENV: 'test', KNOWLEDGE_INSTANCE_TOKEN: instanceToken, KNOWLEDGE_COMPANY_ID: company, KNOWLEDGE_PORTAL_ORG_ID: org,
    TEALBRICK_PORTAL_URL: portal.url, TEALBRICK_DEPLOYMENT_ID: deployment,
    KNOWLEDGE_MEMORY_ENGINE: 'hindsight', KNOWLEDGE_HINDSIGHT_URL: hindsight.baseUrl, KNOWLEDGE_HINDSIGHT_API_KEY: hindsightKey,
  } });
  t.after(async () => { await edge.stop(); await portal.close(); await hindsight.close(); });
  const health = await (await fetch(`${edge.base}/healthz`)).json() as { partitionContract: number; capabilities: Record<string, boolean> };
  assert.equal(health.partitionContract, 2);
  assert.deepEqual(health.capabilities, { edgePartitions: true, readPartitions: true });

  // One credential per path and grant.
  const tbag = (name: string) => `tbag_${name.toLowerCase().padEnd(43, 'g')}`;
  const tbkg = (name: string) => `tbkg_${name.toLowerCase().padEnd(43, 'k')}`;
  const state = portal.state as Record<'grants' | 'attachments' | 'runtime', Record<string, unknown>>;
  for (const [name, claim] of Object.entries(CLAIMS)) {
    const { partitionKey, ...rest } = claim;
    state.grants[tbag(name)] = { agentId: `agent-${name}`, actions: ALL, partitionKey, overrides: rest };
    state.attachments[`attachment-${name}`] = claim;
    state.runtime[tbkg(name)] = claim;
  }
  const PATHS: Record<'attachment' | 'appGrant' | 'runtime', (name: string) => RequestHeaders> = {
    attachment: name => ({ authorization: `Bearer attachment-${name}`, 'x-tealbrick-agent-token': 'fixture-agent-token', 'content-type': 'application/json' }),
    appGrant: name => ({ authorization: `Bearer ${tbag(name)}`, 'content-type': 'application/json' }),
    runtime: name => ({ authorization: `Bearer ${tbkg(name)}`, 'content-type': 'application/json' }),
  };
  const call = (method: string, path: string, headers: RequestHeaders, body?: unknown) => fetch(`${edge.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const idem = () => ({ 'idempotency-key': `key-${randomBytes(8).toString('hex')}` });
  const bankCalls = (from: number) => [...new Set(hindsight.calls.slice(from).flatMap(c => c.bank ? [BANKS[c.bank] ?? c.bank] : []))].sort();

  // Each partition's own grant writes into it (app grant path); the write lands in its write partition.
  const seeded: Record<string, { collection: Stored; document: Stored }> = {};
  for (const name of ['A', 'B', 'C'] as const) {
    const collection = await call('POST', `/api/companies/${company}/knowledge/collections`, { ...PATHS.appGrant(name), ...idem() }, { name: `${name} collection` });
    assert.equal(collection.status, 201, name);
    const c = await collection.json() as Stored;
    const document = await call('POST', `/api/knowledge/collections/${c.id}/documents`, { ...PATHS.appGrant(name), ...idem() }, { title: `${name} note`, body: `${name.toLowerCase()}-marker secret` });
    assert.equal(document.status, 201, name);
    seeded[name] = { collection: c, document: await document.json() as Stored };
  }
  assert.deepEqual(['A', 'B', 'C'].map(name => seeded[name].document.companyId), [pa, pb, pc]);
  assert.match(seeded.A.collection.id, /^kcol_[a-z2-7]{20}$/u, 'new ids are random');
  assert.match(seeded.A.document.id, /^kdoc_[a-z2-7]{20}$/u);

  for (const [path, as] of Object.entries(PATHS)) {
    const label = (what: string) => `${path}: ${what}`;
    const ids = async (name: Agent, url: string) => { const r = await call('GET', url, as(name)); assert.equal(r.status, 200, label(`${name} ${url}`)); return ((await r.json()) as Stored[]).map(item => item.id).sort(); };
    // Collections and search over the read set.
    const list = `/api/companies/${company}/knowledge/collections`;
    const aList = await (await call('GET', list, as('A'))).json() as Stored[];
    assert.ok([seeded.A.collection.id, seeded.B.collection.id].every(id => aList.some(c => c.id === id)), label('A lists alpha + beta'));
    assert.ok(aList.every(c => c.companyId === pa || c.companyId === pb), label('A lists only alpha and beta'));
    assert.deepEqual(await ids('B', list), [seeded.B.collection.id], label('B lists beta'));
    assert.deepEqual(await ids('C', list), [seeded.C.collection.id], label('C lists gamma'));
    const search = async (name: Agent) => (await call('GET', `/api/companies/${company}/knowledge/search?q=marker`, as(name))).text();
    const aSearch = await search('A');
    assert.match(aSearch, /a-marker/u, label('A search alpha')); assert.match(aSearch, /b-marker/u, label('A search beta')); assert.doesNotMatch(aSearch, /c-marker/u, label('A search gamma'));
    assert.doesNotMatch(await search('B'), /a-marker|c-marker/u, label('B search'));
    // One read partition by name (an encoded `workspace/key` path: attachments only; the runtime route table refuses
    // encoded separators); a partition outside the read set is refused.
    if (path === 'attachment') assert.deepEqual(await ids('A', `/api/companies/${encodeURIComponent(pb)}/knowledge/collections`), [seeded.B.collection.id], label('A names beta'));
    assert.notEqual((await call('GET', `/api/companies/${encodeURIComponent(pc)}/knowledge/collections`, as('A'))).status, 200, label('A names gamma'));

    // A read may name one partition of its read set in the query: the effective `workspace/key` on every path, and on
    // the attachment and app-grant paths also the bare key as the grant states it (the edge maps it to its partition).
    // It then reads exactly that partition: the object by id, and a list that names the workspace lists only beta.
    const names = path === 'runtime' ? [encodeURIComponent(pb)] : [encodeURIComponent(pb), 'beta'];
    for (const name of names) {
      assert.deepEqual(await ids('A', `${list}?partitionKey=${name}`), [seeded.B.collection.id], label(`A lists naming ${name}`));
      for (const url of [`/api/knowledge/collections/${seeded.B.collection.id}?partitionKey=${name}`, `/api/knowledge/documents/${seeded.B.document.id}?partitionKey=${name}`]) {
        const read = await call('GET', url, as('A'));
        assert.equal(read.status, 200, label(`A reads ${url}`));
        assert.doesNotMatch(await read.text(), /a-marker|c-marker/u, label(`A reads only beta: ${url}`));
      }
      const named = await call('GET', `/api/companies/${company}/knowledge/search?q=marker&partitionKey=${name}`, as('A'));
      const namedSearch = await named.text();
      assert.equal(named.status, 200, label(`A searches naming ${name}`));
      assert.match(namedSearch, /b-marker/u, label(`A searches beta naming ${name}`));
      assert.doesNotMatch(namedSearch, /a-marker|c-marker/u, label(`A searches only beta naming ${name}`));
      // Writes naming a read-only partition never land in beta: refused, or the selector is ignored and it lands in alpha.
      const forged = await call('POST', `${list}?partitionKey=${name}`, { ...as('A'), ...idem() }, { name: 'forged' });
      if (forged.status === 201) assert.equal((await forged.json() as Stored).companyId, pa, label(`A creates naming ${name} lands in alpha`));
      else assert.ok(forged.status >= 400 && forged.status < 500, label(`A creates naming ${name}: ${forged.status}`));
    }
    if (path === 'runtime') {
      // The runtime path names partitions by their effective key; a bare key is not a partition of this workspace.
      assert.ok((await call('GET', `${list}?partitionKey=beta`, as('A'))).status >= 400, label('runtime: a bare key is refused'));
    }
    // Outside the read set (bare or effective): A is refused; B (read [beta]) and the contract 1 grant B1 are refused or
    // the selector is ignored. Nobody lists or reads an object of the partition it named.
    for (const [name, value] of [['A', 'gamma'], ['A', encodeURIComponent(pc)], ['B', 'alpha'], ['B', encodeURIComponent(pa)], ['B1', 'alpha'], ['B1', encodeURIComponent(pa)]] as const) {
      const foreign = name === 'A' ? seeded.C.collection.id : seeded.A.collection.id;
      const listed = await call('GET', `${list}?partitionKey=${value}`, as(name));
      const body = await listed.text();
      if (name === 'A') assert.ok(listed.status >= 400 && listed.status < 500, label(`A lists naming ${value}: ${listed.status}`));
      assert.ok(listed.status < 500 && !body.includes(foreign), label(`${name} naming ${value} does not list ${foreign}: ${listed.status}`));
      const byId = await call('GET', `/api/knowledge/collections/${foreign}?partitionKey=${value}`, as(name));
      assert.ok(byId.status >= 400 && byId.status < 500, label(`${name} reads naming ${value}: ${byId.status}`));
    }

    // By id: readable in the read set; outside it, exactly like a missing id.
    for (const url of [`/api/knowledge/documents/${seeded.B.document.id}`, `/api/knowledge/collections/${seeded.B.collection.id}`]) {
      assert.equal((await call('GET', url, as('A'))).status, 200, label(`A reads ${url}`));
    }
    const outsideReadSet: [Agent, string, string][] = [
      ['A', `/api/knowledge/documents/${seeded.C.document.id}`, '/api/knowledge/documents/kdoc_aaaaaaaaaaaaaaaaaaaa'],
      ['A', `/api/knowledge/collections/${seeded.C.collection.id}`, '/api/knowledge/collections/kcol_aaaaaaaaaaaaaaaaaaaa'],
      ['B', `/api/knowledge/documents/${seeded.A.document.id}`, '/api/knowledge/documents/kdoc_0001'],
      ['C', `/api/knowledge/documents/${seeded.B.document.id}`, '/api/knowledge/documents/kdoc_bbbbbbbbbbbbbbbbbbbb'],
    ];
    for (const [name, url, missing] of outsideReadSet) {
      const foreign = await call('GET', url, as(name)), absent = await call('GET', missing, as(name));
      // Status, every header but the clock, and the body bytes are identical.
      const shape = async (response: Response) => [response.status, [...response.headers].filter(([header]) => header !== 'date'),
        Buffer.from(await response.arrayBuffer()).toString('base64')] as const;
      const [f, m] = [await shape(foreign), await shape(absent)];
      assert.deepEqual(f, m, label(`${name} ${url} answers like a missing id`));
      assert.deepEqual([f[0], JSON.parse(Buffer.from(f[2], 'base64').toString('utf8'))], [404, { ok: false, error: 'not_found' }], label(`${name} ${url}`));
    }

    // Writes stay in the write partition: beta is readable for A, never writable.
    const intoBeta = await call('POST', `/api/knowledge/collections/${seeded.B.collection.id}/documents`, { ...as('A'), ...idem() }, { title: 'forged', body: 'forged' });
    const intoMissing = await call('POST', '/api/knowledge/collections/kcol_cccccccccccccccccccc/documents', { ...as('A'), ...idem() }, { title: 'forged', body: 'forged' });
    assert.deepEqual([intoBeta.status, await intoBeta.text()], [intoMissing.status, await intoMissing.text()], label('A writes into beta like a missing collection'));
    assert.equal(intoBeta.status, 404, label('A writes into beta'));
    if (path !== 'attachment') {
      const patched = await call('PATCH', `/api/knowledge/documents/${seeded.B.document.id}`, as('A'), { title: 'forged' });
      assert.deepEqual([patched.status, await patched.json()], [404, { ok: false, error: 'not_found' }], label('A edits a beta document'));
    }
    const mine = await call('POST', `/api/companies/${company}/knowledge/collections`, { ...as('A'), ...idem() }, { name: `A via ${path}` });
    assert.equal(mine.status, 201, label('A creates'));
    assert.equal((await mine.json() as Stored).companyId, pa, label('A creates in alpha'));

    // Brain recall: one engine call per read partition, merged; never gamma.
    let from = hindsight.calls.length;
    const recall = await call('POST', '/api/brain/recall', as('A'), { query: 'q', scopeRef: company });
    assert.equal(recall.status, 200, label('A recall'));
    assert.deepEqual(bankCalls(from), ['alpha', 'beta'], label('A recall banks'));
    const recalled = await recall.json() as { memories: { results: { id: string }[] } };
    assert.deepEqual(recalled.memories.results.map(m => m.id), ['alpha-1', 'beta-1', 'alpha-2', 'beta-2'], label('merged recall'));
    assert.doesNotMatch(JSON.stringify(recalled), /gamma/u);
    from = hindsight.calls.length;
    assert.equal((await call('POST', '/api/brain/recall', as('B'), { query: 'q', scopeRef: company })).status, 200);
    assert.deepEqual(bankCalls(from), ['beta'], label('B recall banks'));
    from = hindsight.calls.length;
    assert.equal((await call('POST', '/api/brain/context', as('A'), { query: 'q', scopeRef: company })).status, 200, label('A context'));
    assert.deepEqual(bankCalls(from), ['alpha', 'beta'], label('A context banks'));
    from = hindsight.calls.length;
    assert.equal((await call('GET', `/api/brain/entities?partitionKey=${company}`, as('A'))).status, 200, label('A entities'));
    assert.deepEqual(bankCalls(from), ['alpha', 'beta'], label('A entities banks'));
    // A selector outside the read set never reaches the engine.
    from = hindsight.calls.length;
    const gammaRecall = await call('POST', '/api/brain/recall', as('A'), path === 'runtime' ? { query: 'q', scopeRef: pc } : { query: 'q', scopeRef: company, partitionKey: pc });
    assert.ok(gammaRecall.status >= 400, label(`A recall in gamma: ${gammaRecall.status}`));
    assert.deepEqual(bankCalls(from), [], label('gamma never queried'));

    // Native memory: reads over the read set, writes only in alpha.
    from = hindsight.calls.length;
    const native = await call('POST', '/api/brain/native/recall_memories', as('A'), { ...(path === 'runtime' ? { partitionKey: company } : {}), arguments: { body: { query: 'q' } } });
    assert.equal(native.status, 200, label(`A native read ${native.status}`));
    assert.deepEqual(bankCalls(from), ['alpha', 'beta'], label('A native read banks'));
    from = hindsight.calls.length;
    const writePath = path === 'appGrant' ? '/api/brain/native/write/retain_memories' : '/api/brain/native/retain_memories';
    const written = await call('POST', writePath, { ...as('A'), ...idem() }, { ...(path === 'runtime' ? { partitionKey: company } : {}), arguments: { body: { items: [{ content: 'fact' }] } } });
    assert.equal(written.status, 200, label(`A native write ${written.status}`));
    assert.deepEqual(bankCalls(from), ['alpha'], label('A native write bank'));
    from = hindsight.calls.length;
    const forgedWrite = await call('POST', writePath, { ...as('A'), ...idem() }, { partitionKey: pb, arguments: { body: { items: [{ content: 'fact' }] } } });
    assert.ok(forgedWrite.status >= 400, label('A native write into beta is refused'));
    assert.deepEqual(bankCalls(from), [], label('beta never written'));

    // Contract 1 compatibility: a read set equal to the write key answers byte for byte like no read set.
    for (const url of [list, `/api/companies/${company}/knowledge/search?q=marker`, `/api/knowledge/documents/${seeded.B.document.id}`, `/api/knowledge/documents/${seeded.A.document.id}`]) {
      const c2 = await call('GET', url, as('B')), c1 = await call('GET', url, as('B1'));
      assert.deepEqual([c2.status, await c2.text()], [c1.status, await c1.text()], label(`B vs B1 ${url}`));
    }
    // A read set that leaves out the write key is refused outright.
    assert.ok((await call('GET', list, as('BAD'))).status >= 400, label('a read set without the write key'));
  }
  // Research: discovery works with the read-set bearer (no notebook is bound in this fixture).
  const notebooks = await call('GET', '/api/research/engine/notebooks', PATHS.attachment('A'));
  assert.equal(notebooks.status, 200);
  assert.deepEqual((await notebooks.json() as { notebooks: unknown[] }).notebooks, []);
});
