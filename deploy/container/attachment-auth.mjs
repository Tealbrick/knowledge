export function attachmentRoute(method, rawUrl, companyId) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return null;
  let url;
  try { url = new URL(rawUrl, 'http://knowledge.invalid'); } catch { return null; }
  const path = url.pathname;
  const company = /^\/api\/companies\/([^/]+)\/knowledge\/(collections|search)$/u.exec(path);
  if (company) {
    if (decodeURIComponent(company[1]) !== companyId) return null;
    if (company[2] === 'collections' && ['GET','POST'].includes(method)) return {
      capability: method === 'POST' ? 'knowledge:documents:write' : 'knowledge:documents:read',
      bodyKind: method === 'POST' ? 'collection' : undefined,
    };
    if (company[2] === 'search' && method === 'GET') return {capability:'knowledge:documents:read'};
  }
  const collection = /^\/api\/knowledge\/collections\/([^/]+)\/documents$/u.exec(path);
  if (collection && method === 'POST') return {capability:'knowledge:documents:write', collectionId:decodeURIComponent(collection[1]),bodyKind:'document'};
  const document = /^\/api\/knowledge\/documents\/([^/]+)$/u.exec(path);
  if (document && method === 'GET') return {capability:'knowledge:documents:read', documentId:decodeURIComponent(document[1])};
  if (method === 'POST' && ['/api/brain/context','/api/brain/recall'].includes(path)) return {capability:'knowledge:brain:read',bodyKind:'brain'};
  if (method === 'GET' && path === '/api/brain/entities') return {capability:'knowledge:brain:read'};
  return null;
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
      !Number.isFinite(expiry) || expiry<=Date.now()) return null;
    return data;
  } catch { return null; }
}
