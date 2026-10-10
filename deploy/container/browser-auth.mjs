import { createHash } from 'node:crypto';
import { attachmentConfig } from './attachment-auth.mjs';

const cookieName = 'knowledge_browser';
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const contractVersion = 1;
const product = 'knowledge';
/**
 * `extras` carries what the contract kit supplies (this file is plain JS and cannot import the kit):
 * `settingsSessions` (mints the 5-minute settings bearer), `routeAllowed(route)` (a launch route must be a manifest
 * frontend route), `audit` (metadata-only sink) and `emergencyEnabled` (the relaunch page offers the break-glass form).
 * All optional so the launch keeps working without them.
 */
export function browserConfig(env, extras = {}) {
  const config = attachmentConfig(env);
  if (!config) return null;
  return {
    ...config, instanceToken: env.KNOWLEDGE_INSTANCE_TOKEN,
    // Portal's proof for this instance: a separate one when the deployment has it, else the instance token.
    instanceProof: env.TEALBRICK_PORTAL_INSTANCE_PROOF?.trim() || env.KNOWLEDGE_INSTANCE_TOKEN,
    settingsSessions: extras.settingsSessions, routeAllowed: extras.routeAllowed, audit: extras.audit, emergencyEnabled: extras.emergencyEnabled === true,
    replayed: new Map(),
  };
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
export function sessionEndedPage(portalUrl, emergencyEnabled = false) {
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
.action { display: inline-block; padding: 9px 16px; border-radius: 8px; background: var(--brand); color: #fff; text-decoration: none; font-weight: 600; border: 0; font: inherit; font-weight: 600; cursor: pointer; }
.emergency { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); }
.emergency h2 { margin: 0 0 6px; font-size: 16px; }
.emergency label { display: block; margin: 0 0 6px; font-size: 13px; color: var(--muted); }
.emergency input { box-sizing: border-box; width: 100%; margin-bottom: 12px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; }
</style>
</head>
<body>
<main>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><rect width="48" height="48" rx="8" fill="#173f3c"/><g fill="#f3f1e9" transform="translate(7 7)"><path d="M2 9 20 1l14 7-18 9L2 9Z"/><path d="M2 12v12l14 8V20L2 12Zm18 8v12l14-8V12l-14 8Z"/></g></svg>
<h1>Your session ended</h1>
<p>Reopen Knowledge from Teal Brick Portal to continue. Your documents and settings are unchanged.</p>
${portalLink}
${emergencyEnabled ? `<form method="post" action="/auth/emergency" class="emergency">
<h2>Portal is not available?</h2>
<p>Sign in with the emergency code of this deployment. The session is short and audited.</p>
<label for="code">Emergency code</label>
<input id="code" name="code" type="password" autocomplete="off" required />
<button type="submit" class="action">Sign in</button>
</form>` : ''}
</main>
</body>
</html>
`;
}

/**
 * `frame-ancestors` for the session page. Portal frames the standalone settings page, so a framed navigation whose
 * session ended lands here: this origin and the configured Portal origin (http/https, origin only) may frame it.
 * Without a usable Portal URL it is 'self' only. Never a wildcard.
 */
// A CSP source must be a plain http(s) origin: no wildcard, no userinfo, no path.
const PLAIN_ORIGIN = /^https?:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;
export function sessionFrameAncestors(portalUrl) {
  try {
    const url = portalUrl ? new URL(portalUrl) : null;
    if (url && (url.protocol === 'https:' || url.protocol === 'http:') && PLAIN_ORIGIN.test(url.origin)) return `frame-ancestors 'self' ${url.origin}`;
  } catch { /* unusable Portal URL: 'self' only */ }
  return "frame-ancestors 'self'";
}

/** Send the session page with the same 401 status the JSON response would carry. */
export function sendSessionEnded(req, res, portalUrl, emergencyEnabled = false) {
  const body = sessionEndedPage(portalUrl, emergencyEnabled);
  res.writeHead(401, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; ${sessionFrameAncestors(portalUrl)}`,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * How the instance proves itself to Portal: exactly one header, the contract header `x-tealbrick-instance-proof`. It
 * carries the separate app-to-Portal proof (TEALBRICK_PORTAL_INSTANCE_PROOF) when the deployment has one, so the instance
 * token never leaves the instance; otherwise the instance token, which Portal Core holds as this deployment's proof.
 * The legacy `x-knowledge-instance-token` is no longer sent: Portal's gateway refuses both headers together as
 * 400 ambiguous_instance_proof, which broke owner launch on 0.4.5–0.5.1.
 */
function proofHeaders(config) {
  return { 'x-tealbrick-instance-proof': config.instanceProof || config.instanceToken };
}

async function portal(config, operation, credentials, transport) {
  try {
    const response = await transport(`${config.portal}/api/deployment-browser/${operation}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', ...proofHeaders(config) }, body: JSON.stringify({ schema: contractVersion, product, deploymentId: config.deploymentId, ...credentials }) });
    if (!response.ok) return null;
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > 16384) return null; chunks.push(Buffer.from(chunk)); }
    const grant = JSON.parse(Buffer.concat(chunks).toString());
    if (grant.schema !== contractVersion || grant.authorized !== true || grant.product !== product || grant.deploymentId !== config.deploymentId || grant.workspaceId !== config.companyId || (grant.companyId ?? grant.productTenantId) !== config.companyId || typeof grant.userId !== 'string' || !grant.userId || grant.orgId !== config.portalOrgId || typeof grant.orgId !== 'string' || !grant.orgId || grant.instanceProofAudience !== `tealbrick/${product}/${config.deploymentId}` || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now()) return null;
    const origin = new URL(grant.endpoint);
    if (origin.origin !== grant.endpoint || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname)))) return null;
    return grant;
  } catch { return null; }
}

const LAUNCH_FIELDS = new Set(['ticket', 'route', 'purpose']);
const LAUNCH_PURPOSES = new Set(['launch', 'settings']);
const REPLAY_WINDOW_MS = 600_000;
const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(payload));
  return { handled: true, authorized: false };
};
const audit = (config, outcome, status, code) => { try { config.audit?.record({ kind: 'launch', outcome, status, code }); } catch { /* audit never changes the outcome */ } };

/**
 * POST /auth/launch. Portal form-POSTs a single-use ticket from its own Origin (purpose `launch`, the default), or its
 * server posts the ticket for the settings relay (purpose `settings`, no browser Origin): the app answers with a
 * 5-minute settings bearer and never a cookie. A `route` must be a manifest frontend route.
 */
async function launch(config, req, res, transport, deny) {
  const contentType = String(req.headers['content-type'] ?? '');
  const form = contentType.startsWith('application/x-www-form-urlencoded');
  if (req.method !== 'POST' || req.headers.authorization || (!form && !contentType.startsWith('application/json'))) return deny();
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 2048) return deny(); chunks.push(Buffer.from(chunk)); }
  const text = Buffer.concat(chunks).toString();
  const fields = {};
  try {
    if (form) {
      const params = new URLSearchParams(text);
      for (const key of params.keys()) if (!LAUNCH_FIELDS.has(key) || params.getAll(key).length !== 1) return deny();
      for (const key of LAUNCH_FIELDS) if (params.has(key)) fields[key] = params.get(key);
    } else {
      const body = JSON.parse(text);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return deny();
      for (const [key, value] of Object.entries(body)) { if (!LAUNCH_FIELDS.has(key) || typeof value !== 'string') return deny(); fields[key] = value; }
    }
  } catch { return deny(); }
  const requested = fields.purpose === undefined || fields.purpose === '' ? 'launch' : fields.purpose;
  if (!LAUNCH_PURPOSES.has(requested)) { audit(config, 'invalid', 400, 'invalid_purpose'); return sendJson(res, 400, { error: 'invalid_purpose' }); }
  const origin = req.headers.origin;
  // A browser launch comes from the Portal origin. The settings relay is server to server: no Origin, but a foreign one is refused.
  if (origin !== config.portal && !(requested === 'settings' && origin === undefined)) { audit(config, 'denied', 403, 'launch_origin_required'); return sendJson(res, 403, { error: 'launch_origin_required' }); }
  if (requested === 'settings' && !config.settingsSessions) return deny();
  const formRoute = fields.route === undefined || fields.route === '' ? undefined : fields.route;
  if (formRoute !== undefined && !(typeof config.routeAllowed === 'function' && config.routeAllowed(formRoute))) { audit(config, 'invalid', 400, 'invalid_route'); return sendJson(res, 400, { error: 'invalid_route' }); }
  if (!opaque(fields.ticket)) return deny();
  // A ticket works once. Portal refuses a replay too; this refuses it even while Portal is slow or down.
  const key = createHash('sha256').update(fields.ticket).digest('hex');
  const at = Date.now();
  const replayed = (config.replayed ??= new Map());
  for (const [seen, until] of replayed) if (until <= at) replayed.delete(seen);
  if (replayed.has(key)) { audit(config, 'denied', 401, 'launch_ticket_replayed'); return deny(); }
  if (replayed.size >= 10_000) replayed.delete(replayed.keys().next().value);
  replayed.set(key, at + REPLAY_WINDOW_MS);
  const grant = await portal(config, 'redeem', { ticket: fields.ticket }, transport);
  if (!grant) { audit(config, 'denied', 401, 'launch_ticket_invalid'); return deny(); }
  // When Portal states the purpose or route in its answer, that wins; a purpose that disagrees with the request is refused.
  if (grant.purpose !== undefined && !LAUNCH_PURPOSES.has(grant.purpose)) return deny();
  if (grant.purpose !== undefined && grant.purpose !== requested) { audit(config, 'invalid', 400, 'purpose_mismatch'); return sendJson(res, 400, { error: 'purpose_mismatch' }); }
  if (grant.route !== undefined && !(typeof grant.route === 'string' && typeof config.routeAllowed === 'function' && config.routeAllowed(grant.route))) return deny();
  if (requested === 'settings') {
    const issued = await config.settingsSessions.issue({ subject: grant.userId, workspaceId: grant.workspaceId, orgId: grant.orgId });
    audit(config, 'success', 200, 'settings');
    return sendJson(res, 200, { tokenType: 'Bearer', settingsBearer: issued.bearer, expiresAt: issued.expiresAt, purpose: 'settings', workspaceId: grant.workspaceId });
  }
  if (!opaque(grant.session)) return deny();
  // Select the deployment's attested workspace in the standalone frontend.
  // This is presentation scope; the cookie remains the authorization boundary.
  // A named route is kept exactly; the frontend then takes the attested workspace from its bootstrap. Without a route the
  // launch keeps selecting the workspace in the URL, as before.
  const route = grant.route ?? formRoute;
  const location = route === undefined ? `/?${new URLSearchParams({ companyId: grant.companyId ?? grant.workspaceId })}` : route;
  audit(config, 'success', 303, 'launch');
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': `${cookieName}=${grant.session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.floor((grant.expiresAt - Date.now()) / 1000))}${grant.endpoint.startsWith('https:') ? '; Secure' : ''}` });
  res.end(); return { handled: true, authorized: false };
}

/** Handle launch locally; authorize owner browser traffic before proxying. */
export async function browserAccess(config, req, res, transport = fetch) {
  if (!config) return { handled: false, authorized: false };
  const path = new URL(req.url, 'http://knowledge.invalid').pathname;
  const deny = () => {
    if (wantsSessionPage(req)) { sendSessionEnded(req, res, config.portal, config.emergencyEnabled === true); return { handled: true, authorized: false }; }
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"browser_session_required"}'); return { handled: true, authorized: false };
  };
  if (path === '/auth/launch') return launch(config, req, res, transport, deny);
  const session = req.headers.cookie?.match(/(?:^|;\s*)knowledge_browser=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
  if (!session) return { handled: false, authorized: false };
  if (req.headers.authorization || req.headers['x-tealbrick-agent-token'] || req.headers['x-knowledge-instance-token']) return deny();
  const grant = await portal(config, 'introspect', { session }, transport);
  if (!grant || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== grant.endpoint)) return deny();
  // The owner session belongs to this whole single-customer instance. This is
  // not an agent grant or a multi-partition authorization claim.
  return { handled: false, authorized: true, grant };
}
