import { attachmentRoute, ENGINE_READ, ENGINE_WRITE } from './attachment-auth.mjs';

/**
 * Portal app grants (`tbag_`) on the instance edge.
 *
 * The contract kit has already verified the grant for the manifest operation the request maps to (see
 * program/src/contract/app-grants.ts). This module maps that operation onto the SAME structural routes, scoping,
 * partition binding and body shaping the attachment path uses (attachment-auth.mjs + server.ts), so an app grant and
 * an attachment grant for the same edge can never reach different data. It adds no authority:
 *
 * - the operation must agree with the structural route (capability, family), or the request is refused;
 * - a native memory call must match the engine's own read/write scope for that operation;
 * - the dispatch-time check re-verifies the grant live (agent, operation and partition unchanged).
 */

/** Write tools of the memory engine have their own manifest operation and path, so read and write grants stay distinct. */
export const NATIVE_WRITE_PATH = /^\/api\/brain\/native\/write\/([a-z][a-z_]{0,63})$/u;

const DOCUMENTS_READ = 'knowledge:documents:read';
const DOCUMENTS_WRITE = 'knowledge:documents:write';
const BRAIN_READ = 'knowledge:brain:read';
const RESEARCH_READ = 'knowledge:research:read';
const RESEARCH_WRITE = 'knowledge:research:write';

/** The Portal capability each agent operation's structural route carries (its first required capability). */
export const OPERATION_CAPABILITY = Object.freeze({
  'knowledge.collections.list': DOCUMENTS_READ,
  'knowledge.collections.create': DOCUMENTS_WRITE,
  'knowledge.documents.search': DOCUMENTS_READ,
  'knowledge.documents.create': DOCUMENTS_WRITE,
  'knowledge.documents.get': DOCUMENTS_READ,
  'knowledge.brain.context': BRAIN_READ,
  'knowledge.brain.recall': BRAIN_READ,
  'knowledge.brain.entities': BRAIN_READ,
  'knowledge.engine.tools': ENGINE_READ,
  'knowledge.engine.read': ENGINE_READ,
  'knowledge.engine.write': ENGINE_WRITE,
  'knowledge.research-notebooks.list': RESEARCH_READ,
  'knowledge.research-notebooks.get': RESEARCH_READ,
  'knowledge.research-sources.list': RESEARCH_READ,
  'knowledge.research-sources.get': RESEARCH_READ,
  'knowledge.research-notes.list': RESEARCH_READ,
  'knowledge.research-notes.get': RESEARCH_READ,
  'knowledge.research-context.get': RESEARCH_READ,
  'knowledge.research-sources.add': RESEARCH_WRITE,
  'knowledge.research-sources.receipt-get': RESEARCH_WRITE,
  'knowledge.research-chat.session-create': RESEARCH_WRITE,
  'knowledge.research-chat.session-get': RESEARCH_READ,
  'knowledge.research-chat.ask': RESEARCH_WRITE,
  'knowledge.research-chat.receipt-get': RESEARCH_WRITE,
});

/** Creates the Program repeats on a retry: the edge fronts them with its idempotency ledger. */
export const EDGE_IDEMPOTENT_OPERATIONS = Object.freeze(new Set([
  'knowledge.collections.create', 'knowledge.documents.create', 'knowledge.engine.write',
]));

/** The URL the Program sees: the write alias is the native route itself. */
export function programUrl(operation, rawUrl) {
  if (operation !== 'knowledge.engine.write') return rawUrl;
  const url = new URL(rawUrl, 'http://knowledge.invalid');
  const match = NATIVE_WRITE_PATH.exec(url.pathname);
  return match ? `/api/brain/native/${match[1]}${url.search}` : null;
}

/**
 * Per-request agent authority for an admitted app grant, shaped like the attachment path's:
 * `route(method, url)` is the structural route, `check(capability, phase)` the (live) grant answer.
 */
export function appGrantAuthority({ authority, admitted, request, companyId, nativeOperationPolicy }) {
  let route = null;
  let current = null;
  // Why route() answered null, when the grant is fine but the request is not (a status and a stable error code).
  let refusal;
  const data = grant => ({
    agentId: grant.agentId, orgId: grant.orgId, expiresAt: grant.expiresAt,
    ...(grant.partitionKey !== null ? { partitionKey: grant.partitionKey } : {}),
  });
  return {
    operation: admitted.operation,
    get refusal() { return refusal; },
    route(method, rawUrl) {
      const expected = OPERATION_CAPABILITY[admitted.operation];
      const url = programUrl(admitted.operation, rawUrl);
      if (!expected) return null;
      // A write call that does not name a valid engine tool: the grant is fine, the tool does not exist.
      if (url === null) { refusal = { status: 404, error: 'operation_not_found' }; return null; }
      // Native memory: the manifest operation must be the one for the engine's own scope for this tool.
      if (admitted.operation === 'knowledge.engine.read' || admitted.operation === 'knowledge.engine.write') {
        const name = /^\/api\/brain\/native\/([^/?]+)/u.exec(url)?.[1];
        const policy = name && /^[a-z][a-z_]{0,63}$/u.test(name) && typeof nativeOperationPolicy === 'function' ? nativeOperationPolicy(name) : null;
        if (!policy) { refusal = { status: 404, error: 'operation_not_found' }; return null; }
        if ((policy.scope === 'write') !== (admitted.operation === 'knowledge.engine.write')) { refusal = { status: 403, error: 'operation_not_granted' }; return null; }
      }
      const structural = attachmentRoute(method, url, companyId, { nativeOperationPolicy });
      if (!structural || structural.capability !== expected) return null;
      if (admitted.operation === 'knowledge.engine.tools' && !(structural.native && !structural.operation)) return null;
      route = structural;
      return structural;
    },
    async check(capability, phase = 'admit') {
      let grant = admitted;
      if (phase === 'dispatch') {
        current ??= (await authority.recheck(request, admitted)) ?? false;
        if (!current) return null;
        grant = current;
      }
      if (!route) return null;
      const required = new Set([route.capability, ...(route.requires ?? [])]);
      if (required.has(capability)) return data(grant);
      // Native discovery lists write tools only when the same grant also covers the engine write operation.
      if ((route.optional ?? []).includes(capability) && capability === ENGINE_WRITE && authority.covers(grant, 'knowledge.engine.write')) return data(grant);
      return null;
    },
  };
}
