import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { startFakeHindsight } from '../../program/scripts/fixtures/fake-engines.mjs';
import { appGrantAuthority, NATIVE_WRITE_PATH, OPERATION_CAPABILITY, programUrl } from './app-grant-edge.mjs';
import { company, deployment, org, startEdge, startFakePortal } from './edge-fixture.mjs';

/**
 * Portal app grants (`tbag_`, verified by the contract kit) on the real instance edge, next to the unchanged Portal
 * attachment path. For the same edge partition both reach exactly the same data; neither can leave it.
 */
const manifest = JSON.parse(readFileSync(new URL('../../tealbrick.app.json', import.meta.url), 'utf8'));
const agentOperations = manifest.operations.filter(op => (op.audience ?? 'agent') === 'agent');
const ownerOperations = manifest.operations.filter(op => op.audience === 'owner');
const operationsFor = actions => agentOperations.filter(op => op.crud.every(action => actions.includes(action))).map(op => op.id);
const instanceToken = randomBytes(32).toString('hex');
const grant = letter => `tbag_${letter.repeat(43)}`;
const ALL = ['create', 'read', 'update', 'delete'];
const personal = `${company}/personal`;

test('every agent operation maps onto the structural route of its Portal capability, and owner operations onto none', () => {
  const policy = name => ({ scope: name.startsWith('write_') ? 'write' : 'read' });
  const sample = (path, value = 'sample') => path.replace(/\{([^}]+)\}/g, (_, name) => name === 'companyId' ? company : name === 'operation' ? (path.includes('/write/') ? 'write_thing' : 'read_thing') : value);
  assert.deepEqual(Object.keys(OPERATION_CAPABILITY).sort(), agentOperations.map(op => op.id).sort(), 'one capability mapping per agent operation, none for owner operations');
  for (const operation of agentOperations) {
    const admitted = { operation: operation.id, agentId: 'a', orgId: org, expiresAt: Date.now() + 1000, partitionKey: null };
    const auth = appGrantAuthority({ authority: {}, admitted, request: { headers: {} }, companyId: company, nativeOperationPolicy: policy });
    const route = auth.route(operation.method, sample(operation.path));
    assert.ok(route, `${operation.id} has a structural route (${operation.method} ${operation.path})`);
    assert.equal(route.capability, OPERATION_CAPABILITY[operation.id], operation.id);
    if (operation.id.startsWith('knowledge.research-')) assert.equal(route.research, true, operation.id);
    if (operation.id.startsWith('knowledge.engine.')) assert.equal(route.native, true, operation.id);
  }
  // The edge's own route table admits no route the manifest does not declare as an agent operation.
  assert.ok(ownerOperations.length > 0 && ownerOperations.every(op => !(op.id in OPERATION_CAPABILITY)));
  assert.equal(programUrl('knowledge.engine.write', '/api/brain/native/write/remember?x=1'), '/api/brain/native/remember?x=1');
  assert.equal(programUrl('knowledge.engine.write', '/api/brain/native/write/Bad-Name'), null);
  assert.equal(programUrl('knowledge.documents.get', '/api/knowledge/documents/a'), '/api/knowledge/documents/a');
  assert.ok(NATIVE_WRITE_PATH.test('/api/brain/native/write/forget'));
});

test('app grants and attachments reach the same data per partition; every refusal is stable', async t => {
  const hindsightKey = randomBytes(16).toString('hex');
  const hindsight = await startFakeHindsight({ apiKey: hindsightKey });
  const portal = await startFakePortal({ instanceToken, operationsFor });
  const edge = await startEdge({ env: {
    NODE_ENV: 'test', KNOWLEDGE_INSTANCE_TOKEN: instanceToken, KNOWLEDGE_COMPANY_ID: company, KNOWLEDGE_PORTAL_ORG_ID: org,
    TEALBRICK_PORTAL_URL: portal.url, TEALBRICK_DEPLOYMENT_ID: deployment,
    KNOWLEDGE_MEMORY_ENGINE: 'hindsight', KNOWLEDGE_HINDSIGHT_URL: hindsight.baseUrl, KNOWLEDGE_HINDSIGHT_API_KEY: hindsightKey,
  } });
  t.after(async () => { await edge.stop(); await portal.close(); await hindsight.close(); });
  const { base } = edge;
  const { grants, attachments } = portal.state;
  Object.assign(grants, {
    [grant('f')]: { agentId: 'agent-a', actions: ALL },
    [grant('r')]: { agentId: 'reader', actions: ['read'] },
    [grant('w')]: { agentId: 'writer', actions: ['create'] },
    [grant('p')]: { agentId: 'agent-a', actions: ALL, partitionKey: 'personal' },
    [grant('o')]: { agentId: 'other', actions: ALL, partitionKey: 'other' },
    [grant('x')]: { agentId: 'bad', actions: ALL, partitionKey: 'Personal' },
    [grant('d')]: { agentId: 'bad', actions: ALL, partitionKey: 'default' },
    [grant('n')]: { agentId: 'null-edge', actions: ALL, partitionKey: null },
    [grant('a')]: { agentId: 'absent-edge', actions: ALL, omitPartitionKey: true },
    [grant('l')]: { agentId: 'liar', actions: ALL, operations: [...ownerOperations.map(op => op.id), 'knowledge.collections.list'] },
    [grant('u')]: { agentId: 'editor', actions: ['create', 'read', 'update'] },
    [grant('k')]: { agentId: 'deleter', actions: ['read', 'delete'] },
  });
  Object.assign(attachments, { 'default-attachment': {}, 'personal-attachment': { partitionKey: 'personal' } });
  const admin = { 'x-knowledge-instance-token': instanceToken, 'content-type': 'application/json' };
  const as = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const bare = token => ({ authorization: `Bearer ${token}` }); // a DELETE has no body, so no JSON content type
  const attached = name => ({ authorization: `Bearer ${name}`, 'x-tealbrick-agent-token': 'fixture-agent-token', 'content-type': 'application/json' });
  const call = (method, path, headers, body) => fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const idem = () => ({ 'idempotency-key': `key-${randomBytes(8).toString('hex')}` });
  const bank = partition => `tb-${createHash('sha256').update(`knowledge-partition:${partition}`).digest('hex').slice(0, 32)}`;

  // The owner seeds the workspace default partition.
  const owned = await (await call('POST', `/api/companies/${company}/knowledge/collections`, admin, { name: 'Workspace' })).json();
  const secret = await (await call('POST', `/api/knowledge/collections/${owned.id}/documents`, admin, { title: 'Default secret', body: 'polygonface-only' })).json();

  // --- default partition with a full grant: create, replay, conflict, read, search
  const key = idem();
  const made = await call('POST', `/api/companies/${company}/knowledge/collections`, { ...as(grant('f')), ...key }, { name: 'Agent made' });
  assert.equal(made.status, 201);
  const collection = await made.json();
  assert.equal(collection.companyId, company);
  const replay = await call('POST', `/api/companies/${company}/knowledge/collections`, { ...as(grant('f')), ...key }, { name: 'Agent made' });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal((await replay.json()).id, collection.id, 'the same key and body return the first answer, not a second collection');
  assert.equal((await call('POST', `/api/companies/${company}/knowledge/collections`, { ...as(grant('f')), ...key }, { name: 'A different body' })).status, 409);
  assert.equal((await call('POST', `/api/companies/${company}/knowledge/collections`, as(grant('f')), { name: 'No key' })).status, 400);
  assert.equal((await call('POST', `/api/companies/${company}/knowledge/collections`, { ...as(grant('f')), 'idempotency-key': ' bad key' }, { name: 'x' })).status, 400);
  const names = async () => (await (await call('GET', `/api/companies/${company}/knowledge/collections`, admin)).json()).map(c => c.name).filter(n => n === 'Agent made').length;
  assert.equal(await names(), 1);
  const noted = await call('POST', `/api/knowledge/collections/${collection.id}/documents`, { ...as(grant('f')), ...idem() }, { title: 'Agent note', body: 'agent body text' });
  assert.equal(noted.status, 201);
  const note = await noted.json();
  assert.equal(note.createdByAgentId, 'agent-a', 'the verified agent id is the document actor');
  assert.equal((await call('GET', `/api/knowledge/documents/${note.id}`, as(grant('r')))).status, 200);
  assert.match(await (await call('GET', `/api/companies/${company}/knowledge/search?q=agent`, as(grant('r')))).text(), /Agent note/);
  assert.equal((await call('GET', `/api/knowledge/documents/${secret.id}`, as(grant('r')))).status, 200, 'default edge reads the default partition');

  // --- the CRUD actions decide; the response codes are the kit's stable ones
  const denied = async (method, path, token, body) => { const r = await call(method, path, token ? as(token) : {}, body); return { status: r.status, error: (await r.json().catch(() => ({}))).error }; };
  assert.deepEqual(await denied('POST', `/api/companies/${company}/knowledge/collections`, grant('r'), { name: 'x' }), { status: 403, error: 'operation_not_granted' });
  assert.deepEqual(await denied('GET', `/api/companies/${company}/knowledge/collections`, grant('w')), { status: 403, error: 'operation_not_granted' });
  assert.deepEqual(await denied('GET', `/api/companies/${company}/knowledge/collections`, null), { status: 401, error: 'instance_auth_required' }, 'no credential at all keeps the edge answer');
  assert.deepEqual(await denied('GET', `/api/companies/${company}/knowledge/collections`, grant('z')), { status: 401, error: 'grant_denied' });

  // --- owner-only operations are never reachable with a grant, even if Portal (wrongly) lists them
  for (const operation of ownerOperations) {
    const path = operation.path.replace(/\{[^}]+\}/g, 'doc-1');
    assert.deepEqual(await denied(operation.method, path, grant('f'), operation.method === 'GET' ? undefined : {}), { status: 403, error: 'operation_owner_only' }, operation.id);
    assert.deepEqual(await denied(operation.method, path, grant('l'), operation.method === 'GET' ? undefined : {}), { status: 403, error: 'operation_owner_only' }, `${operation.id} (Portal lists it)`);
  }
  assert.equal((await call('GET', `/api/knowledge/documents/${note.id}`, admin)).status, 200, 'the owner session is untouched');
  assert.equal((await call('PATCH', `/api/knowledge/documents/${note.id}`, admin, { title: 'Owner edit' })).status, 200);
  // Undeclared routes are not agent operations at all.
  for (const [method, path] of [['GET', '/api/status'], ['GET', '/api/bindings'], ['POST', '/api/brain/extract-facts'], ['GET', '/api/knowledge/partitions'], ['GET', '/bootstrap.json']]) {
    assert.deepEqual(await denied(method, path, grant('f'), method === 'GET' ? undefined : {}), { status: 403, error: 'operation_unknown' }, path);
  }

  // --- a malformed or reserved partition claim denies; it never reaches the default partition
  for (const letter of ['x', 'd']) {
    for (const [method, path] of [['GET', `/api/companies/${company}/knowledge/collections`], ['GET', `/api/knowledge/documents/${secret.id}`], ['POST', '/api/brain/recall']]) {
      assert.deepEqual(await denied(method, path, grant(letter), method === 'POST' ? { query: 'q', scopeRef: company } : undefined), { status: 403, error: 'partition_claim_invalid' }, `${letter} ${path}`);
    }
  }

  // --- an ABSENT partitionKey (Portal Core today) is refused, never defaulted; an explicit null is the company scope
  for (const [method, path] of [['GET', `/api/companies/${company}/knowledge/collections`], ['GET', `/api/knowledge/documents/${secret.id}`], ['POST', '/api/brain/recall']]) {
    assert.deepEqual(await denied(method, path, grant('a'), method === 'POST' ? { query: 'q', scopeRef: company } : undefined), { status: 403, error: 'partition_binding_required' }, `absent ${path}`);
  }
  assert.equal((await call('GET', `/api/knowledge/documents/${secret.id}`, as(grant('n')))).status, 200, 'explicit null reads the company default scope');

  // --- a partitioned grant works in its own partition (via the workspace id) exactly like the personal attachment
  const listed = await call('GET', `/api/companies/${company}/knowledge/collections`, as(grant('p')));
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).every(c => c.companyId === personal && c.id !== owned.id));
  const mineResponse = await call('POST', `/api/companies/${company}/knowledge/collections`, { ...as(grant('p')), ...idem() }, { name: 'Mine' });
  assert.equal(mineResponse.status, 201);
  const mine = await mineResponse.json();
  assert.equal(mine.companyId, personal);
  const personalNote = await (await call('POST', `/api/knowledge/collections/${mine.id}/documents`, { ...as(grant('p')), ...idem() }, { title: 'Personal note', body: 'personal-only secret' })).json();
  assert.equal(personalNote.companyId, personal);
  // The attachment edge for the same partition sees the same collection and note: one partition, two ways in.
  assert.ok((await (await call('GET', `/api/companies/${company}/knowledge/collections`, attached('personal-attachment'))).json()).some(c => c.id === mine.id));
  assert.equal((await call('GET', `/api/knowledge/documents/${personalNote.id}`, attached('personal-attachment'))).status, 200);
  // Uniform not-found (0.5.0): on the attachment path too, an id of another partition answers exactly like a missing id.
  const foreignAttached = await call('GET', `/api/knowledge/documents/${note.id}`, attached('personal-attachment'));
  const missingAttached = await call('GET', '/api/knowledge/documents/kdoc_missing', attached('personal-attachment'));
  assert.equal(foreignAttached.status, 404);
  assert.deepEqual([missingAttached.status, await missingAttached.text()], [404, await foreignAttached.text()]);
  const personalSearch = await (await call('GET', `/api/companies/${company}/knowledge/search?q=secret`, as(grant('p')))).text();
  assert.match(personalSearch, /personal-only/);
  assert.doesNotMatch(personalSearch, /polygonface-only/);
  // Cross-partition refusal, in both directions and by id, path and selector. An id of another partition looks absent.
  assert.deepEqual(await denied('GET', `/api/knowledge/documents/${secret.id}`, grant('p')), { status: 404, error: 'not_found' });
  assert.deepEqual(await denied('GET', `/api/knowledge/documents/${personalNote.id}`, grant('f')), { status: 404, error: 'not_found' });
  assert.deepEqual(await denied('GET', `/api/knowledge/documents/${personalNote.id}`, grant('o')), { status: 404, error: 'not_found' });
  assert.deepEqual(await denied('POST', `/api/knowledge/collections/${owned.id}/documents`, grant('p'), { title: 'x' }), { status: 404, error: 'not_found' });
  assert.deepEqual(await denied('POST', `/api/knowledge/collections/${mine.id}/documents`, grant('o'), { title: 'x' }), { status: 404, error: 'not_found' });

  // --- document update and delete are agent operations: gated by the grant's update / delete CRUD action, bound to the partition
  const adminStatus = async id => (await call('GET', `/api/knowledge/documents/${id}`, admin)).status;
  const newDoc = async (token, collectionId, title) => (await (await call('POST', `/api/knowledge/collections/${collectionId}/documents`, { ...as(token), ...idem() }, { title, body: 'to edit' })).json());
  const edited = await call('PATCH', `/api/knowledge/documents/${note.id}`, as(grant('f')), { title: 'Agent edit', body: 'edited by the agent' });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).title, 'Agent edit');
  assert.equal((await (await call('GET', `/api/knowledge/documents/${note.id}`, as(grant('r')))).json()).body, 'edited by the agent');
  assert.equal((await call('PATCH', `/api/knowledge/documents/${note.id}`, as(grant('u')), { summary: 'sum' })).status, 200, 'an update-only grant may edit');
  assert.deepEqual(await denied('PATCH', `/api/knowledge/documents/${note.id}`, grant('u'), { collectionId: 'x' }), { status: 403, error: 'request_denied' }, 'only the document fields are accepted');
  assert.deepEqual(await denied('PATCH', `/api/knowledge/documents/${note.id}`, grant('r'), { title: 'x' }), { status: 403, error: 'operation_not_granted' });
  assert.deepEqual(await denied('PATCH', `/api/knowledge/documents/${note.id}`, grant('w'), { title: 'x' }), { status: 403, error: 'operation_not_granted' });
  assert.deepEqual(await denied('PATCH', `/api/knowledge/documents/${note.id}`, grant('k'), { title: 'x' }), { status: 403, error: 'operation_not_granted' });
  assert.deepEqual(await denied('DELETE', `/api/knowledge/documents/${note.id}`, grant('r')), { status: 403, error: 'operation_not_granted' });
  assert.deepEqual(await denied('DELETE', `/api/knowledge/documents/${note.id}`, grant('u')), { status: 403, error: 'operation_not_granted' });
  assert.equal(await adminStatus(note.id), 200, 'refused deletes leave the document');
  // Cross-partition, by id: another partition's document looks absent for edit and delete, in both directions.
  const mineDoc = await newDoc(grant('p'), mine.id, 'Cross check');
  const defaultDoc = await newDoc(grant('f'), collection.id, 'Default cross check');
  for (const [method, id, token, body] of [
    ['PATCH', mineDoc.id, grant('f'), { title: 'x' }], ['DELETE', mineDoc.id, grant('f')], ['PATCH', mineDoc.id, grant('o'), { title: 'x' }], ['DELETE', mineDoc.id, grant('o')],
    ['PATCH', defaultDoc.id, grant('p'), { title: 'x' }], ['DELETE', defaultDoc.id, grant('p')], ['PATCH', secret.id, grant('p'), { title: 'x' }], ['DELETE', secret.id, grant('p')],
  ]) assert.deepEqual(await denied(method, `/api/knowledge/documents/${id}`, token, body), { status: 404, error: 'not_found' }, `${method} ${id}`);
  assert.equal((await (await call('GET', `/api/knowledge/documents/${mineDoc.id}`, admin)).json()).title, 'Cross check');
  assert.equal(await adminStatus(defaultDoc.id), 200);
  // The attachment path is unchanged: it has no document edit or delete route.
  assert.equal((await call('PATCH', `/api/knowledge/documents/${mineDoc.id}`, attached('personal-attachment'), { title: 'x' })).status, 401);
  assert.equal((await call('DELETE', `/api/knowledge/documents/${mineDoc.id}`, attached('personal-attachment'))).status, 401);
  assert.equal(await adminStatus(mineDoc.id), 200);
  // Inside its own partition a full grant edits and deletes; a grant with delete only cannot edit.
  assert.equal((await call('PATCH', `/api/knowledge/documents/${mineDoc.id}`, as(grant('p')), { title: 'Edited in partition' })).status, 200);
  assert.deepEqual(await denied('PATCH', `/api/knowledge/documents/${defaultDoc.id}`, grant('k'), { title: 'x' }), { status: 403, error: 'operation_not_granted' });
  assert.equal((await call('DELETE', `/api/knowledge/documents/${mineDoc.id}`, bare(grant('p')))).status, 200);
  assert.equal(await adminStatus(mineDoc.id), 404);
  // A DELETE that still declares a JSON body type with an empty body (Content-Length: 0) is a DELETE without a body.
  const emptyJsonDoc = await newDoc(grant('p'), mine.id, 'Empty JSON delete');
  assert.equal((await fetch(`${base}/api/knowledge/documents/${emptyJsonDoc.id}`, { method: 'DELETE', headers: as(grant('p')), body: '' })).status, 200);
  assert.equal(await adminStatus(emptyJsonDoc.id), 404);
  assert.equal((await call('DELETE', `/api/knowledge/documents/${defaultDoc.id}`, bare(grant('k')))).status, 200, 'a delete grant deletes');
  assert.equal(await adminStatus(defaultDoc.id), 404);
  assert.deepEqual(await denied('DELETE', `/api/knowledge/documents/${defaultDoc.id}`, grant('f')), { status: 404, error: 'not_found' }, 'a deleted document looks absent');
  for (const [token, path] of [
    [grant('p'), `/api/companies/${encodeURIComponent(`${company}/other`)}/knowledge/collections`],
    [grant('f'), `/api/companies/${encodeURIComponent(personal)}/knowledge/collections`],
    [grant('f'), `/api/companies/${encodeURIComponent(personal)}/knowledge/search?q=secret`],
  ]) assert.deepEqual(await denied('GET', path, token), { status: 403, error: 'request_denied' }, path);
  assert.equal((await call('GET', `/api/companies/${encodeURIComponent(personal)}/knowledge/collections`, as(grant('p')))).status, 200, 'its own explicit partition path');
  const ownNames = (await (await call('GET', `/api/companies/${encodeURIComponent(`${company}/other`)}/knowledge/collections`, admin)).json()).map(c => c.name);
  assert.ok(!ownNames.includes('Mine'));

  // --- Brain recall and native memory land in the effective partition's bank
  const banks = () => hindsight.calls.filter(c => c.bank).map(c => c.bank);
  let mark = banks().length;
  const recall = await call('POST', '/api/brain/recall', as(grant('p')), { query: 'q', scopeRef: 'forged' });
  assert.equal(recall.status, 200);
  assert.equal((await recall.json()).scopeRef, personal);
  assert.equal((await call('POST', '/api/brain/context', as(grant('p')), { query: 'q', scopeRef: company })).status, 200);
  assert.equal((await call('GET', '/api/brain/entities', as(grant('p')))).status, 200);
  assert.equal((await call('POST', '/api/brain/native/list_documents', as(grant('p')), { arguments: {} })).status, 200);
  assert.deepEqual([...new Set(banks().slice(mark))], [bank(personal)]);
  mark = banks().length;
  assert.equal((await call('POST', '/api/brain/recall', as(grant('f')), { query: 'q', scopeRef: company })).status, 200);
  assert.deepEqual([...new Set(banks().slice(mark))], [bank(company)]);
  mark = banks().length;
  for (const [token, partitionKey] of [[grant('p'), `${company}/other`], [grant('p'), `${personal}/deeper`], [grant('f'), personal]]) {
    assert.equal((await call('POST', '/api/brain/native/list_documents', as(token), { partitionKey, arguments: {} })).status, 403, `${partitionKey}`);
    assert.equal((await call('GET', `/api/brain/entities?partitionKey=${encodeURIComponent(partitionKey)}`, as(token))).status, 403, `${partitionKey}`);
  }
  assert.equal(banks().length, mark, 'refused selectors never reach the engine');

  // --- native memory: read and write are different operations with their own paths; discovery follows the grant
  assert.deepEqual(await denied('POST', '/api/brain/native/write/list_documents', grant('f'), { arguments: {} }), { status: 403, error: 'operation_not_granted' }, 'a read tool through the write operation');
  assert.deepEqual(await denied('POST', '/api/brain/native/retain_memories', grant('f'), { arguments: {} }), { status: 403, error: 'operation_not_granted' }, 'a write tool through the read operation');
  assert.deepEqual(await denied('POST', '/api/brain/native/no_such_tool', grant('f'), { arguments: {} }), { status: 404, error: 'operation_not_found' });
  assert.deepEqual(await denied('POST', '/api/brain/native/write/list_documents', grant('r'), { arguments: {} }), { status: 403, error: 'operation_not_granted' }, 'a read-only edge has no engine write');
  const writeKey = idem();
  mark = hindsight.calls.length;
  const retained = await call('POST', '/api/brain/native/write/retain_memories', { ...as(grant('p')), ...writeKey }, { arguments: { body: { items: [{ content: 'remember this', document_id: 'doc-x' }] } } });
  assert.ok(retained.status < 400, `native write ${retained.status}`);
  const retainedAgain = await call('POST', '/api/brain/native/write/retain_memories', { ...as(grant('p')), ...writeKey }, { arguments: { body: { items: [{ content: 'remember this', document_id: 'doc-x' }] } } });
  assert.equal(retainedAgain.headers.get('idempotent-replayed'), 'true');
  assert.equal(hindsight.calls.slice(mark).filter(c => c.method === 'POST' && /\/memories$/.test(c.path)).length, 1, 'a replay does not write twice');
  assert.deepEqual([...new Set(hindsight.calls.slice(mark).filter(c => c.bank).map(c => c.bank))], [bank(personal)]);
  const toolsFull = await (await call('GET', '/api/brain/native/tools', as(grant('f')))).json();
  const toolsRead = await (await call('GET', '/api/brain/native/tools', as(grant('r')))).json();
  const toolScopes = list => new Map(list.data.tools.map(tool => [tool.name, tool.scope]));
  assert.equal(toolScopes(toolsFull).get('retain_memories'), 'write');
  assert.equal(toolScopes(toolsFull).get('list_documents'), 'read');
  assert.equal(toolScopes(toolsRead).has('retain_memories'), false, 'a read-only edge is not shown write tools');
  assert.equal(toolScopes(toolsRead).get('list_documents'), 'read');
  assert.ok([...toolScopes(toolsRead).values()].every(scope => scope === 'read'));

  // --- research is reached through the same Program checks; no notebook is bound, so discovery is empty and ids are absent
  const notebooks = await call('GET', '/api/research/engine/notebooks', as(grant('p')));
  assert.equal(notebooks.status, 200);
  assert.deepEqual((await notebooks.json()).notebooks, []);
  assert.ok((await call('GET', '/api/research/notebooks/nb-1/engine/sources', as(grant('r')))).status < 500);
  assert.deepEqual(await denied('POST', '/api/research/notebooks/nb-1/engine/sources', grant('r'), { title: 't', content: 'c' }), { status: 403, error: 'operation_not_granted' });

  // --- revocation and Portal outage fail closed; nothing is cached across requests
  const revoked = `tbag_${'v'.repeat(43)}`;
  grants[revoked] = { agentId: 'short-lived', actions: ALL };
  assert.equal((await call('GET', `/api/companies/${company}/knowledge/collections`, as(revoked))).status, 200);
  delete grants[revoked];
  assert.deepEqual(await denied('GET', `/api/companies/${company}/knowledge/collections`, revoked), { status: 401, error: 'grant_denied' });
  // A partition edited mid-request is re-checked at dispatch and never re-scopes the write.
  const before = (await (await call('GET', `/api/companies/${encodeURIComponent(personal)}/knowledge/collections`, admin)).json()).length;
  const bodyText = JSON.stringify({ name: 'must-not-be-created' });
  const { request: httpRequest } = await import('node:http');
  const slow = await new Promise((done, fail) => {
    const request = httpRequest(`${base}/api/companies/${company}/knowledge/collections`, { method: 'POST', headers: { ...as(grant('p')), ...idem(), 'content-length': Buffer.byteLength(bodyText) } },
      res => { res.resume(); res.on('end', () => done(res.statusCode)); });
    request.on('error', fail);
    request.flushHeaders();
    setTimeout(() => { grants[grant('p')] = { agentId: 'agent-a', actions: ALL, partitionKey: 'other' }; request.end(bodyText); }, 150);
  });
  grants[grant('p')] = { agentId: 'agent-a', actions: ALL, partitionKey: 'personal' };
  assert.equal(slow, 403, 'the changed edge no longer matches what was admitted');
  assert.equal((await (await call('GET', `/api/companies/${encodeURIComponent(personal)}/knowledge/collections`, admin)).json()).length, before);

  // --- the instance proof goes to Portal on every introspection; the grant never leaves in a body other than the wire
  const introspections = portal.state.calls.filter(c => c.url === '/api/runtime/app-grant/introspect');
  assert.ok(introspections.length > 20);
  assert.ok(introspections.every(c => c.headers['x-tealbrick-instance-proof'] === instanceToken && !c.headers.cookie && !c.headers.origin && !c.headers.authorization));
  assert.ok(introspections.every(c => Object.keys(c.body).sort().join() === 'deploymentId,product,token'));

  // --- audit: metadata only, agent and partition named, no payload, no token
  const audit = new DatabaseSync(`${edge.data}/contract-audit.sqlite`, { readOnly: true });
  const rows = audit.prepare("SELECT * FROM contract_audit WHERE kind = 'grant' ORDER BY rowid").all();
  audit.close();
  assert.ok(rows.some(r => r.operation === 'knowledge.documents.create' && r.outcome === 'admitted' && r.actor === 'agent-a' && r.status === 201));
  assert.ok(rows.some(r => r.outcome === 'denied' && r.code === 'operation_owner_only'));
  assert.ok(rows.some(r => r.outcome === 'admitted' && r.partition_key === 'personal'));
  const dump = JSON.stringify(rows);
  for (const needle of ['tbag_', 'agent body text', 'personal-only', 'Personal note', instanceToken]) assert.ok(!dump.includes(needle), `audit leaked ${needle}`);
  assert.doesNotMatch(edge.output(), /tbag_[A-Za-z0-9_-]{43}/);
  void secret;
});

test('a Portal outage fails closed with a stable code and the edge keeps serving the owner', async t => {
  const portal = await startFakePortal({ instanceToken, operationsFor });
  const edge = await startEdge({ env: { KNOWLEDGE_INSTANCE_TOKEN: instanceToken, KNOWLEDGE_COMPANY_ID: company, KNOWLEDGE_PORTAL_ORG_ID: org, TEALBRICK_PORTAL_URL: portal.url, TEALBRICK_DEPLOYMENT_ID: deployment } });
  t.after(async () => { await edge.stop(); });
  portal.state.grants[grant('a')] = { agentId: 'a', actions: ALL };
  const request = () => fetch(`${edge.base}/api/companies/${company}/knowledge/collections`, { headers: { authorization: `Bearer ${grant('a')}` } });
  assert.equal((await request()).status, 200);
  await portal.close();
  const outage = await request();
  assert.equal(outage.status, 503);
  assert.equal((await outage.json()).error, 'grant_verification_unavailable');
  assert.equal((await fetch(`${edge.base}/api/companies/${company}/knowledge/collections`, { headers: { 'x-knowledge-instance-token': instanceToken } })).status, 200);
  // An instance with no Portal binding has no grant verification at all.
  const standalone = await startEdge({ env: { KNOWLEDGE_INSTANCE_TOKEN: instanceToken } });
  t.after(() => standalone.stop());
  const none = await fetch(`${standalone.base}/api/companies/default/knowledge/collections`, { headers: { authorization: `Bearer ${grant('a')}` } });
  assert.equal(none.status, 503);
  assert.equal((await none.json()).error, 'portal_unconfigured');
});
