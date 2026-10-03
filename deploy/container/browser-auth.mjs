import { attachmentConfig } from './attachment-auth.mjs';

const cookieName = 'knowledge_browser';
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const contractVersion = 1;
const product = 'knowledge';
export function browserConfig(env) {
  const config = attachmentConfig(env);
  return config ? { ...config, instanceToken: env.KNOWLEDGE_INSTANCE_TOKEN } : null;
}
async function portal(config, operation, credentials, transport) {
  try {
    const response = await transport(`${config.portal}/api/deployment-browser/${operation}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'x-knowledge-instance-token': config.instanceToken }, body: JSON.stringify({ schema: contractVersion, product, deploymentId: config.deploymentId, ...credentials }) });
    if (!response.ok) return null;
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > 16384) return null; chunks.push(Buffer.from(chunk)); }
    const grant = JSON.parse(Buffer.concat(chunks).toString());
    if (grant.schema !== contractVersion || grant.authorized !== true || grant.product !== product || grant.deploymentId !== config.deploymentId || grant.workspaceId !== config.companyId || grant.companyId !== config.companyId || typeof grant.userId !== 'string' || !grant.userId || grant.orgId !== config.portalOrgId || typeof grant.orgId !== 'string' || !grant.orgId || grant.instanceProofAudience !== `tealbrick/${product}/${config.deploymentId}` || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now()) return null;
    const origin = new URL(grant.endpoint);
    if (origin.origin !== grant.endpoint || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname)))) return null;
    return grant;
  } catch { return null; }
}

/** Handle launch locally; authorize owner browser traffic before proxying. */
export async function browserAccess(config, req, res, transport = fetch) {
  if (!config) return { handled: false, authorized: false };
  const path = new URL(req.url, 'http://knowledge.invalid').pathname;
  const deny = () => { res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"browser_session_required"}'); return { handled: true, authorized: false }; };
  if (path === '/auth/launch') {
    if (req.method !== 'POST' || req.headers.origin !== config.portal || req.headers.authorization || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return deny();
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 2048) return deny(); chunks.push(Buffer.from(chunk)); }
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    if (form.getAll('ticket').length !== 1 || [...form.keys()].some(k => k !== 'ticket') || !opaque(form.get('ticket'))) return deny();
    const grant = await portal(config, 'redeem', { ticket: form.get('ticket') }, transport);
    if (!grant || !opaque(grant.session)) return deny();
    // Select the deployment's attested workspace in the standalone frontend.
    // This is presentation scope; the cookie remains the authorization boundary.
    const location = `/?${new URLSearchParams({ companyId: grant.companyId })}`;
    res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': `${cookieName}=${grant.session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.floor((grant.expiresAt - Date.now()) / 1000))}${grant.endpoint.startsWith('https:') ? '; Secure' : ''}` });
    res.end(); return { handled: true, authorized: false };
  }
  const session = req.headers.cookie?.match(/(?:^|;\s*)knowledge_browser=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
  if (!session) return { handled: false, authorized: false };
  if (req.headers.authorization || req.headers['x-tealbrick-agent-token'] || req.headers['x-knowledge-instance-token']) return deny();
  const grant = await portal(config, 'introspect', { session }, transport);
  if (!grant || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== grant.endpoint)) return deny();
  // The owner session belongs to this whole single-customer instance. This is
  // not an agent grant or a multi-partition authorization claim.
  return { handled: false, authorized: true, grant };
}
