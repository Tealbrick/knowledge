import { attachmentConfig } from './attachment-auth.mjs';

const cookieName = 'knowledge_browser';
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const contractVersion = 1;
const product = 'knowledge';
export function browserConfig(env) {
  const config = attachmentConfig(env);
  return config ? { ...config, instanceToken: env.KNOWLEDGE_INSTANCE_TOKEN } : null;
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * A top-level browser navigation (not fetch/XHR) that asks for HTML. API and
 * JSON routes keep their machine-readable 401 so clients can branch on codes.
 */
export function wantsSessionPage(req) {
  const accept = String(req.headers.accept ?? '');
  if (!/\btext\/html\b/i.test(accept)) return false;
  let path;
  try { path = new URL(req.url ?? '/', 'http://knowledge.invalid').pathname; } catch { return false; }
  if (path.startsWith('/api/') || path.startsWith('/.well-known/') || path.endsWith('.json')) return false;
  if (req.method === 'POST') return path === '/auth/launch';
  return req.method === 'GET' || req.method === 'HEAD';
}

/** Static, script-free "session ended" page. Carries no session or deployment detail. */
export function sessionEndedPage(portalUrl) {
  let portalLink = '';
  try {
    const url = portalUrl ? new URL(portalUrl) : null;
    if (url && (url.protocol === 'https:' || url.protocol === 'http:')) portalLink = `<a class="action" href="${escapeHtml(url.origin + '/')}" target="_top" rel="noreferrer">Open Teal Brick Portal</a>`;
  } catch { portalLink = ''; }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Session ended · Teal Brick Knowledge</title>
<style>
:root { color-scheme: light dark; --bg: #f6f4ee; --paper: #fffdf9; --ink: #1d2523; --muted: #56625f; --brand: #173f3c; --line: #d9d6cc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bg: #111615; --paper: #18201f; --ink: #eef0ec; --muted: #a7b1ad; --brand: #6fb8ad; --line: #2c3634; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); }
main { box-sizing: border-box; width: min(440px, calc(100vw - 32px)); padding: 32px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); }
h1 { margin: 20px 0 8px; font-size: 22px; letter-spacing: 0; }
p { margin: 0 0 20px; line-height: 1.5; color: var(--muted); }
.action { display: inline-block; padding: 9px 16px; border-radius: 8px; background: var(--brand); color: #fff; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><rect width="48" height="48" rx="8" fill="#173f3c"/><g fill="#f3f1e9" transform="translate(7 7)"><path d="M2 9 20 1l14 7-18 9L2 9Z"/><path d="M2 12v12l14 8V20L2 12Zm18 8v12l14-8V12l-14 8Z"/></g></svg>
<h1>Your session ended</h1>
<p>Reopen Knowledge from Teal Brick Portal to continue. Your documents and settings are unchanged.</p>
${portalLink}
</main>
</body>
</html>
`;
}

/** Send the session page with the same 401 status the JSON response would carry. */
export function sendSessionEnded(req, res, portalUrl) {
  const body = sessionEndedPage(portalUrl);
  res.writeHead(401, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  });
  res.end(req.method === 'HEAD' ? undefined : body);
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
  const deny = () => {
    if (wantsSessionPage(req)) { sendSessionEnded(req, res, config.portal); return { handled: true, authorized: false }; }
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"browser_session_required"}'); return { handled: true, authorized: false };
  };
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
