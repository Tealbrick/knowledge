/** Native engine route only; knowledge:brain:read keeps meaning recall/context. */
export const ENGINE_READ = 'knowledge:engine:read';
export const ENGINE_WRITE = 'knowledge:engine:write';
const NATIVE_OPERATION = /^\/api\/brain\/native\/([a-z][a-z_]{0,63})$/u;

/**
 * Native memory (the selected engine's full agent surface). Discovery needs
 * knowledge:engine:read; each operation needs knowledge:engine:read or
 * knowledge:engine:write by the engine's own read/write policy. An operation
 * the engine does not expose is rejected before Portal is contacted.
 */
export function nativeAttachmentRoute(method, path, nativeOperationPolicy) {
  // Discovery lists writes too when the attachment also holds knowledge:engine:write.
  if (method === 'GET' && path === '/api/brain/native/tools') return {capability:ENGINE_READ, native:true, optional:[ENGINE_WRITE]};
  const native = NATIVE_OPERATION.exec(path);
  if (!native || method !== 'POST' || typeof nativeOperationPolicy !== 'function') return null;
  const policy = nativeOperationPolicy(native[1]);
  if (!policy || (policy.scope !== 'read' && policy.scope !== 'write')) return null;
  return {capability: policy.scope === 'write' ? ENGINE_WRITE : ENGINE_READ, native:true, operation:native[1], bodyKind:'native'};
}

/**
 * Portal per-edge memory partition claim (`partitionKey` on the attachment and its
 * introspection). Absent = the workspace default partition. Same grammar as the
 * Portal registry; `default` is reserved. Anything else present fails closed.
 */
export const EDGE_PARTITION_KEY = /^[a-z][a-z0-9-]{0,39}$/u;
export function edgePartitionClaim(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {ok:false};
  if (!Object.prototype.hasOwnProperty.call(data, 'partitionKey')) return {ok:true, partitionKey:null};
  const key = data.partitionKey;
  return typeof key === 'string' && EDGE_PARTITION_KEY.test(key) && key !== 'default' ? {ok:true, partitionKey:key} : {ok:false};
}

/**
 * Contract 2 read set (`readPartitionKeys`) of an attachment or app-grant answer, relative to its write key
 * (`partitionKey`, absent = null = the workspace default). Absent = contract 1 (`readPartitionKeys: undefined`).
 * Present, it must hold 1..64 unique entries, each null or an edge key, and contain the write key; anything else
 * fails closed. A set that is exactly the write key is the contract 1 grant (`undefined`): same path, same answers.
 */
export const MAX_READ_PARTITIONS = 64;
export function edgeReadPartitionsClaim(data) {
  const write = edgePartitionClaim(data);
  if (!write.ok) return {ok:false};
  if (!Object.prototype.hasOwnProperty.call(data, 'readPartitionKeys')) return {ok:true, partitionKey:write.partitionKey, readPartitionKeys:undefined};
  const list = data.readPartitionKeys;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_READ_PARTITIONS || new Set(list).size !== list.length) return {ok:false};
  if (list.some(key => key !== null && !(typeof key === 'string' && EDGE_PARTITION_KEY.test(key) && key !== 'default'))) return {ok:false};
  if (!list.includes(write.partitionKey)) return {ok:false};
  return {ok:true, partitionKey:write.partitionKey, readPartitionKeys: list.length === 1 ? undefined : Object.freeze([...list])};
}
/** Same write key and the same read set (as a set) in two answers of one request. */
export function sameEdgeScope(left, right) {
  const a = edgeReadPartitionsClaim(left), b = edgeReadPartitionsClaim(right);
  if (!a.ok || !b.ok || a.partitionKey !== b.partitionKey) return false;
  if (a.readPartitionKeys === undefined || b.readPartitionKeys === undefined) return a.readPartitionKeys === b.readPartitionKeys;
  return a.readPartitionKeys.length === b.readPartitionKeys.length && a.readPartitionKeys.every(key => b.readPartitionKeys.includes(key));
}
/** The effective partitions of a read set (`workspace` for null, else `workspace/key`), lower-case. */
export function effectiveReadPartitions(companyId, readPartitionKeys) {
  const base = companyId.trim().toLowerCase();
  return readPartitionKeys.map(key => key === null ? base : `${base}/${key}`);
}

/** `workspace/key`: a candidate edge-partition child of the bound workspace (confirmed after introspection). */
function partitionChildReference(reference, companyId) {
  const base = companyId.trim().toLowerCase(), value = reference.trim().toLowerCase();
  if (!value.startsWith(`${base}/`)) return false;
  const key = value.slice(base.length + 1);
  return EDGE_PARTITION_KEY.test(key) && key !== 'default';
}

export function attachmentRoute(method, rawUrl, companyId, options = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return null;
  let url;
  try { url = new URL(rawUrl, 'http://knowledge.invalid'); } catch { return null; }
  const path = url.pathname;
  const company = /^\/api\/companies\/([^/]+)\/knowledge\/(collections|search)$/u.exec(path);
  if (company) {
    const companyRef = decodeURIComponent(company[1]);
    // The workspace itself; a `workspace/key` child is admitted only for an edge whose
    // introspected partition is exactly that key (server.ts), never for a default edge.
    const child = companyRef !== companyId;
    if (child && !partitionChildReference(companyRef, companyId)) return null;
    const scope = {...(child ? {companyRef} : {}), companyResource: company[2]};
    if (company[2] === 'collections' && ['GET','POST'].includes(method)) return {
      capability: method === 'POST' ? 'knowledge:documents:write' : 'knowledge:documents:read',
      bodyKind: method === 'POST' ? 'collection' : undefined, ...scope,
    };
    if (company[2] === 'search' && method === 'GET') return {capability:'knowledge:documents:read', ...scope};
  }
  const collection = /^\/api\/knowledge\/collections\/([^/]+)\/documents$/u.exec(path);
  if (collection && method === 'POST') return {capability:'knowledge:documents:write', collectionId:decodeURIComponent(collection[1]),bodyKind:'document'};
  const collectionItem = /^\/api\/knowledge\/collections\/([^/]+)$/u.exec(path);
  if (collectionItem && method === 'GET') return {capability:'knowledge:documents:read', collectionId:decodeURIComponent(collectionItem[1])};
  const document = /^\/api\/knowledge\/documents\/([^/]+)$/u.exec(path);
  if (document && method === 'GET') return {capability:'knowledge:documents:read', documentId:decodeURIComponent(document[1])};
  if (path.startsWith('/api/brain/native/')) return nativeAttachmentRoute(method, path, options.nativeOperationPolicy);
  if (method === 'POST' && ['/api/brain/context','/api/brain/recall'].includes(path)) return {capability:'knowledge:brain:read',bodyKind:'brain'};
  if (method === 'GET' && path === '/api/brain/entities') return {capability:'knowledge:brain:read'};
  return researchAttachmentRoute(method, path);
}

const RESEARCH_READ = 'knowledge:research:read';
const RESEARCH_WRITE = 'knowledge:research:write';
const NOTEBOOK = '/api/research/notebooks/[^/]+/engine';
const SEGMENT = '[^/]+';
/**
 * Research engine routes a Portal attachment may reach. `requires` lists every
 * Portal capability the edge must verify; the Program receives a principal
 * holding exactly those (mapped to research:read / research:write) and still
 * applies its own notebook mapping and workspace checks.
 */
const RESEARCH_ROUTES = [
  ['GET', '^/api/research/engine/notebooks$', [RESEARCH_READ]],
  ['GET', `^${NOTEBOOK}$`, [RESEARCH_READ]],
  ['GET', `^${NOTEBOOK}/(?:sources|notes|context)$`, [RESEARCH_READ]],
  ['GET', `^${NOTEBOOK}/(?:sources|notes)/${SEGMENT}$`, [RESEARCH_READ]],
  ['POST', `^${NOTEBOOK}/sources$`, [RESEARCH_WRITE]],
  ['GET', `^${NOTEBOOK}/write-receipts/${SEGMENT}$`, [RESEARCH_WRITE]],
  ['POST', `^${NOTEBOOK}/chat/sessions$`, [RESEARCH_WRITE]],
  ['GET', `^${NOTEBOOK}/chat/sessions/${SEGMENT}$`, [RESEARCH_READ]],
  ['POST', `^${NOTEBOOK}/chat/sessions/${SEGMENT}/messages$`, [RESEARCH_WRITE, RESEARCH_READ]],
  ['GET', `^${NOTEBOOK}/chat/receipts/${SEGMENT}$`, [RESEARCH_WRITE, RESEARCH_READ]],
].map(([method, pattern, requires]) => ({method, pattern: new RegExp(pattern, 'u'), requires}));

export function researchAttachmentRoute(method, path) {
  const route = RESEARCH_ROUTES.find(entry => entry.method === method && entry.pattern.test(path));
  return route ? {capability: route.requires[0], research: true, requires: [...route.requires]} : null;
}

export function attachmentConfig(env) {
  const values = [env.TEALBRICK_PORTAL_URL,env.TEALBRICK_DEPLOYMENT_ID,env.KNOWLEDGE_COMPANY_ID,env.KNOWLEDGE_PORTAL_ORG_ID];
  if(values.every(v=>v===undefined)) return null;
  if(values.some(v=>!v?.trim())) throw new Error('Attachment access requires portal URL, deployment ID, company ID and portal organization ID');
  const portal = new URL(values[0]);
  if(portal.username || portal.password || portal.search || portal.hash || portal.pathname !== '/' ||
    (portal.protocol !== 'https:' && !(portal.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(portal.hostname)))) {
    throw new Error('Attachment portal must be a fixed HTTPS origin (loopback HTTP permitted for fixtures)');
  }
  return {portal:portal.origin,deploymentId:values[1],companyId:values[2],portalOrgId:values[3]};
}

export async function introspectAttachment(config, headers, capability) {
  const auth = headers.authorization;
  const agentToken = headers['x-tealbrick-agent-token'];
  if(typeof auth !== 'string' || !auth.startsWith('Bearer ') || auth.length > 8192 ||
    typeof agentToken !== 'string' || !agentToken || agentToken.length > 8192) return null;
  try {
    const response = await fetch(`${config.portal}/api/deployment-access/introspect`, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(5000),
      headers:{'content-type':'application/json'},
      body:JSON.stringify({attachment:auth.slice(7),agentToken,deploymentId:config.deploymentId,capability}),
    });
    if(!response.ok) return null;
    const chunks=[];
    let bytes=0;
    for await(const chunk of response.body ?? []) {
      const buffer=Buffer.from(chunk);
      bytes+=buffer.length;
      if(bytes>16384) return null;
      chunks.push(buffer);
    }
    const data=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
    const expiry=typeof data.expiresAt==='number' ? data.expiresAt : Date.parse(data.expiresAt);
    if(data.authorized!==true || data.deploymentId!==config.deploymentId ||
      data.companyId!==config.companyId || data.capability!==capability ||
      data.orgId!==config.portalOrgId ||
      typeof data.orgId!=='string' || !data.orgId || typeof data.agentId!=='string' || !data.agentId ||
      !Number.isFinite(expiry) || expiry<=Date.now() || !edgeReadPartitionsClaim(data).ok) return null;
    return data;
  } catch { return null; }
}
