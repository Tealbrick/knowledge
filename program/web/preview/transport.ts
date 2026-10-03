/** App-owned, disposable adapter. Never delegates to the browser network. */
export function installPreview() {
  const stamp = () => new Date().toISOString();
  const record = (value: Record<string, unknown>): Record<string, any> => ({ id: crypto.randomUUID(), companyId: 'default', createdAt: stamp(), updatedAt: stamp(), ...value });
  const collections = [record({ id: 'welcome', name: 'Team handbook', description: 'Explore and edit these sample documents.', sourceConfig: { provider: 'native' } })];
  const documents = [record({ id: 'welcome-doc', collectionId: 'welcome', title: 'Welcome to Knowledge', slug: 'welcome', summary: 'A shared home for documents, research and memory.', body: '# Welcome to Knowledge\n\nCollect your team’s durable knowledge in one place.\n\n## Try the real controls\n\nEdit this document, create a collection, add a comment, or explore Brain. Every change stays in this disposable preview.\n\n## Example workflow\n\nResearch a question, save a conclusion, then promote it into your team handbook.', bodyFormat: 'markdown', status: 'published', parentDocumentId: null, source: null }), record({ id: 'launch-plan', collectionId: 'welcome', title: 'Product launch checklist', slug: 'launch-plan', summary: 'A sample launch plan for a small team.', body: '# Launch checklist\n\n- Confirm the audience and product promise\n- Review onboarding with five customers\n- Assign release ownership\n- Capture feedback in the research notebook', bodyFormat: 'markdown', status: 'draft', parentDocumentId: null, source: null })];
  const notebooks = [record({ id: 'customer-research', title: 'Customer discovery', summary: 'Sample interview synthesis', focusPrompt: 'What makes onboarding easier?', slug: 'customer-discovery', status: 'active' })];
  const sources = [record({ id: 'interview', notebookId: 'customer-research', notebookTitle: 'Customer discovery', title: 'Interview notes — sample team', content: 'Teams want to explore a product before connecting services. Clear ownership and easy reset help customers learn safely.', summary: 'Preview first; connect services when ready.', sourceType: 'text', status: 'ready', url: null })];
  const outputs: Record<string, any>[] = [];
  const comments: Record<string, any>[] = [];
  const links: Record<string, any>[] = [];
  const bindings: Record<string, any>[] = [];
  const events: Record<string, any>[] = [];
  const revisions: Record<string, any>[] = [];
  const policies = new Map<string, any>();
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const unavailable = () => reply({ error: 'preview_operation_unavailable', message: 'This operation needs a connected runtime. Preview never calls providers or integrations.' }, 409);
  const mutate = (rows: Record<string, any>[], id: string, method: string, body: any) => {
    const item = rows.find(row => row.id === id);
    if (!item) return reply({ error: 'not_found' }, 404);
    if (method === 'DELETE') rows.splice(rows.indexOf(item), 1);
    if (method === 'PATCH' || method === 'PUT') Object.assign(item, body, { updatedAt: stamp() });
    return reply(item);
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://preview.invalid');
    const p = url.pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (method !== 'GET') events.unshift({ eventId: crypto.randomUUID(), type: 'preview.local-change', timestamp: stamp(), payload: { path: p, method } });
    if (p === '/bootstrap.json') return reply({ ok: true, program: { id: 'knowledge', name: 'Knowledge', version: 'preview', environment: 'disposable browser preview', status: 'preview' }, subapps: {}, dependencies: Object.fromEntries(['gbrain','knowledgeDb','objectStore','rules','workEthic'].map(key => [key, { status: 'preview', detail: 'Sample data only; no service connected.', configured: false }])), counts: { documents: documents.length, researchNotebooks: notebooks.length }, authorization: { generalDomainBearerRequired: false, brainExtractFacts: 'unavailable-in-preview', credentialExposedToBrowser: false }, surfaces: { standalone: '/', embed: '/embed', status: '/status', openapi: '/openapi.json', swagger: '/swagger.json' }, scope: { defaultCompanyId: 'default' }, capabilities: { documents: true, research: true, brain: true, bindings: true, fileIngest: false, repositoryIngest: false, revisionRestore: false, browserManagedConnections: false, versionControl: false } });
    if (p === '/openapi.json') return reply({ openapi: '3.1.0', info: { title: 'Knowledge preview adapter', version: 'preview' }, paths: {} });
    if (p.endsWith('/knowledge/collections') && p.includes('/companies/')) {
      if (method === 'POST') { const item = record({ ...body, sourceConfig: { provider: 'native' } }); collections.push(item as any); return reply(item); }
      return reply(collections.map(c => ({ ...c, documentCount: documents.filter(d => d.collectionId === c.id).length })));
    }
    if (p.endsWith('/knowledge/search')) return reply(documents.filter(d => (!url.searchParams.get('collectionId') || d.collectionId === url.searchParams.get('collectionId')) && `${d.title} ${d.body}`.toLowerCase().includes((url.searchParams.get('q') ?? '').toLowerCase())).map(d => ({ ...d, collectionName: collections.find(c => c.id === d.collectionId)?.name, excerpt: d.body.slice(0, 180) })));
    let match = p.match(/^\/api\/knowledge\/collections\/([^/]+)\/documents$/);
    if (match && method === 'POST') { const item = record({ collectionId: match[1], parentDocumentId: null, source: null, summary: null, slug: 'preview', bodyFormat: 'markdown', status: 'draft', ...body }); documents.push(item as any); return reply(item); }
    match = p.match(/^\/api\/knowledge\/collections\/([^/]+)$/);
    if (match) return mutate(collections, match[1], method, body);
    match = p.match(/^\/api\/knowledge\/documents\/([^/]+)(?:\/(revisions|comments|access|attachments|links))?$/);
    if (match) {
      const [, id, section] = match;
      if (!section) { if (method === 'PATCH') { const old = documents.find(d => d.id === id); if (old) revisions.push(record({ ...old, documentId: id, version: revisions.length + 1 })); } return mutate(documents, id, method, body); }
      if (section === 'access') { if (method === 'PUT') policies.set(id, { documentId: id, companyId: 'default', ...body }); return reply(policies.get(id) ?? { documentId: id, companyId: 'default', accessMode: 'workspace', inheritFromParent: true, grants: [] }); }
      if (section === 'attachments') return method === 'GET' ? reply([]) : unavailable();
      const rows = section === 'comments' ? comments : section === 'links' ? links : revisions;
      if (method === 'POST') { const item = record({ documentId: id, sourceDocumentId: id, bodyFormat: 'markdown', ...body }); rows.push(item); return reply(item); }
      return reply(rows.filter(row => row.documentId === id || row.sourceDocumentId === id));
    }
    if (p === '/api/research/browser-session') return reply({ enabled: false, authenticated: false });
    if (p === '/api/research/summary') return reply({ companyId: 'default', notebooks, counts: { notebooks: notebooks.length, sources: sources.length }, activeNotebookId: notebooks[0]?.id, posture: { preview: { available: true, mode: 'sample data', degraded: true, reason: 'Open Local records below to explore disposable research. Authenticated provider features require a connected runtime.' } } });
    if (p.match(/\/companies\/[^/]+\/research\/notebooks$/)) { if (method === 'POST') { const item = record({ status: 'active', ...body }); notebooks.push(item as any); return reply(item); } return reply(notebooks); }
    if (p === '/api/research/notebook') return reply({ ...notebooks.find(n => n.id === url.searchParams.get('notebookId')), sources, entries: [], outputs, linkedDocuments: [] });
    match = p.match(/^\/api\/research\/notebooks\/([^/]+)$/);
    if (match) return mutate(notebooks, match[1], method, body);
    if (p.endsWith('/research/sources')) { if (method === 'POST') { const item = record({ status: 'ready', ...body }); sources.push(item as any); return reply({ source: item }); } return reply(sources); }
    if (p.endsWith('/outputs')) { if (method === 'POST') { const item = record({ notebookId: p.split('/')[4], promotionState: 'draft', ...body }); outputs.push(item); return reply(item); } return reply(outputs); }
    if (p === '/api/research/ask') return reply({ mode: 'preview', notebookId: body.notebookId, answer: 'Sample synthesis: teams value exploring the product before connecting services. Clear ownership and an easy reset help them learn. This fixed example is not a model response.', citations: [{ kind: 'source', title: sources[0].title, excerpt: sources[0].content, score: 1, sourceId: sources[0].id }], degraded: true, degradedReason: 'Deterministic preview response; no model called.', strategy: { retrievalMode: 'sample', candidateCount: 1, citationCount: 1 } });
    if (p === '/api/brain/entities') {
      const slug = url.searchParams.get('slug');
      if (slug) return reply({ ok: true, status: 'ready', source: 'preview fixture', degradedReason: null, slug, card: { slug, title: 'Sample product team', type: 'organization', aliases: ['Launch team'], summary: 'A fictional team exploring Knowledge.', updatedAt: stamp(), openThreads: ['Validate onboarding'], backlinkCount: 1, activeFactCount: 1 }, facts: [{ id: 'fact-1', fact: 'The sample team prefers trying the product before connecting services.', kind: 'preference', entitySlug: slug, confidence: 1, source: 'Preview sample interview', createdAt: stamp() }], relationships: [], timeline: [{ date: '2026-09-01', summary: 'Sample discovery interview completed', type: 'research' }], provenance: [{ source: 'Preview fixture' }] });
      return reply({ ok: true, status: 'ready', source: 'preview fixture', degradedReason: null, entities: [{ slug: 'sample-team', title: 'Sample product team', label: 'Sample product team', type: 'organization', factCount: 1 }], total: 1, pagination: { limit: 50, offset: 0, returned: 1, scanned: 1, complete: true, hasMore: false } });
    }
    if (p === '/api/brain/recall' || p === '/api/brain/context') return reply({ ok: true, status: 'ready', mode: 'preview', query: body.query, answer: 'Sample memory: the product team values clear ownership and preview access before connecting services.', memories: [], citations: ['Preview sample interview'], degradedReason: 'Fixed sample result; no GBrain or model called.' });
    if (p === '/api/bindings') { if (method === 'POST') { const item = record({ bindingId: crypto.randomUUID(), ...body }); bindings.push(item); return reply(item); } return reply(bindings); }
    if (p === '/api/events') return reply({ ok: true, events });
    return unavailable();
  };
}
