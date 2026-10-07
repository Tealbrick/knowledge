import { createServer, request as proxyRequest } from "node:http";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { buildKnowledgeApp } from "../../program/src/app.js";
import { loadConfig } from "../../program/src/config.js";
import { createKnowledgePrincipalResolver } from "../../program/src/knowledge-principal.js";
import { bearerToken, effectiveKnowledgePartition, normalizeKnowledgePartitionKey } from "../../program/src/partition-authority.js";
import { customerRuntimeRoute } from "../../program/src/customer-runtime-access.js";
import { KnowledgeInstanceClaim } from "../../program/src/instance-claim.js";
import { createPortalPrincipalResolver, portalPrincipalConfig } from "../../program/src/portal-principal.js";
import { createAttachmentResearchAuthority } from "../../program/src/attachment-research-principal.js";
import { attachmentConfig, attachmentRoute, edgePartitionClaim, introspectAttachment } from "./attachment-auth.mjs";
import { browserConfig, browserAccess, sendSessionEnded, wantsSessionPage } from "./browser-auth.mjs";

// A caller-sized body is not an authorization failure; report it as 413 so the
// app does not mistake an oversized upload for an ended session.
class RequestTooLarge extends Error {}

// One instance is one trust boundary. This edge does not grant tenant isolation.
const token = process.env.KNOWLEDGE_INSTANCE_TOKEN ?? "";
if (token.length < 32 || token.length > 1024 || /[^\x21-\x7e]/u.test(token)) {
  throw new Error("KNOWLEDGE_INSTANCE_TOKEN must be 32-1024 printable non-space ASCII characters");
}
const expected = createHash("sha256").update(token).digest();
// Internal attestation from this instance edge to its loopback Program.
const settingsAuthority = randomBytes(32).toString("hex");
process.env.KNOWLEDGE_SETTINGS_TOKEN = settingsAuthority;
const attachment = attachmentConfig(process.env);
const browser = browserConfig(process.env);
const config = loadConfig();
if (config.knowledgeServicePrincipals.some(principal => typeof principal?.token === "string" && principal.token.trim() === token)) {
  throw new Error("Knowledge runtime credentials must be distinct from the instance recovery token");
}
const runtimePrincipals = createKnowledgePrincipalResolver(config.knowledgeServicePrincipals);
const instanceClaim = new KnowledgeInstanceClaim(config.dataDir);
// Portal-provisioned instances resolve agent grants live against Portal; no
// per-agent KNOWLEDGE_SERVICE_PRINCIPALS edit or redeploy is required.
const portalBinding = portalPrincipalConfig(process.env);
const portalPrincipals = portalBinding ? createPortalPrincipalResolver({ ...portalBinding, signer: instanceClaim }) : undefined;
// Portal attachments with knowledge:research:* reach Research engine routes
// through a per-request bearer minted below; static service principals keep working.
const attachmentResearch = attachment
  ? createAttachmentResearchAuthority({ companyId: attachment.companyId, fallback: runtimePrincipals.configured ? runtimePrincipals : null })
  : null;
const app = await buildKnowledgeApp({ config: { ...config, host: "127.0.0.1", port: 0 }, portalPrincipals,
  ...(attachmentResearch ? { researchPrincipalProvider: attachmentResearch.provider, brainPrincipalProvider: attachmentResearch.provider } : {}) });
// The selected engine's read/write policy per native operation (Portal knowledge:engine:read / :write).
const nativeOperationPolicy = app.getDecorator<(operation: string) => { scope: "read" | "write" } | null>("knowledgeNativeOperationPolicy");
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Missing internal listener");
const server = createServer(async (req, res) => {
  try {
  const browserResult = await browserAccess(browser, req, res);
  if (browserResult.handled) return;
  const supplied = req.headers["x-knowledge-instance-token"];
  const publicHealth = req.method === "GET" && req.url === "/healthz";
  const instanceAuthorized = typeof supplied === "string" && timingSafeEqual(expected, createHash("sha256").update(supplied).digest());
  if (req.url?.split("?", 1)[0] === "/api/tealbrick/claim") {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    // Only explicit recovery/admin authority; a browser session or agent bearer cannot sign.
    if (!instanceAuthorized || req.headers.origin !== undefined || req.headers.cookie !== undefined) {
      res.writeHead(403); res.end('{"ok":false,"error":"claim_admin_required"}'); return;
    }
    if (req.method === "GET") {
      res.end(JSON.stringify({ instanceId: instanceClaim.instanceId, publicJwk: instanceClaim.publicJwk })); return;
    }
    if (req.method !== "POST") { res.writeHead(405); res.end('{"error":"method_not_allowed"}'); return; }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk); bytes += buffer.length;
        if (bytes > 4096) throw new Error("invalid_claim_challenge");
        chunks.push(buffer);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const proof = instanceClaim.signChallenge(input);
      const configuredScope = (portalBinding !== null && normalizeKnowledgePartitionKey(portalBinding.companyId) === proof.companyId) ||
        config.knowledgeServicePrincipals.some(principal =>
        normalizeKnowledgePartitionKey(principal.companyId) === proof.companyId ||
        principal.partitionGrants?.some(grant => normalizeKnowledgePartitionKey(grant.partitionKey) === proof.companyId));
      const existingScope = app.getDecorator<(companyId: string) => boolean>("knowledgeHasPartition")(proof.companyId);
      if (!configuredScope && !existingScope) { res.writeHead(403); res.end('{"error":"claim_scope_unknown"}'); return; }
      res.end(JSON.stringify(proof)); return;
    } catch { res.writeHead(400); res.end('{"error":"invalid_claim_challenge"}'); return; }
  }
  const suppliedBearer = bearerToken({ headers: req.headers });
  // Only an admitted direct-runtime route may cost a Portal introspection; anything else is
  // rejected without contacting Portal.
  const runtimePrincipal = runtimePrincipals.resolve(suppliedBearer) ??
    (portalPrincipals && customerRuntimeRoute(req.method ?? "", req.url ?? "") ? await portalPrincipals.resolve(suppliedBearer) : null);
  const runtimeAuthorized = !!runtimePrincipal && customerRuntimeRoute(req.method ?? "", req.url ?? "");
  let attachmentAuthorized = false;
  let dispatchGrant: {capability:string;agentId:string;orgId:string;requires:string[];optional:string[];expiresAt:number;native:boolean;partitionKey:string|null} | undefined;
  let researchBearer: string | null = null;
  let replacementBody: string | Buffer | undefined;
  let replacementUrl: string | undefined;
  if (!publicHealth && !instanceAuthorized && !runtimeAuthorized && !browserResult.authorized && attachment) {
    try {
      const route = attachmentRoute(req.method, req.url, attachment.companyId, { nativeOperationPolicy });
      const grant=route ? await introspectAttachment(attachment,req.headers,route.capability) : null;
      // Per-edge memory partition from Portal (absent = the workspace default partition).
      // Every introspection for this request must report the same one.
      const claim = grant ? edgePartitionClaim(grant) : null;
      const edgePartition: string | null = claim?.ok ? claim.partitionKey : null;
      const partition = grant ? effectiveKnowledgePartition(attachment.companyId, edgePartition) : null;
      if (grant && (!claim?.ok || (edgePartition !== null && !partition))) throw new Error('invalid partition claim');
      const samePartition = (other: unknown) => { const c = edgePartitionClaim(other); return c.ok && c.partitionKey === edgePartition; };
      // A partitioned edge may name its workspace; that selects its own partition, never the default.
      const workspacePartition = normalizeKnowledgePartitionKey(attachment.companyId);
      const selectsPartition = (value: unknown) => { const key = normalizeKnowledgePartitionKey(value);
        return key === partition || (edgePartition !== null && key === workspacePartition); };
      // Research routes may need more than one capability (chat send needs read and write).
      let researchAdmitted = !route?.research;
      let expiresAt = grant ? (typeof grant.expiresAt === 'number' ? grant.expiresAt : Date.parse(grant.expiresAt)) : 0;
      if(route?.research && grant && attachmentResearch) {
        researchAdmitted = true;
        for(const capability of route.requires.slice(1)) {
          const extra=await introspectAttachment(attachment,req.headers,capability);
          if(!extra || extra.agentId!==grant.agentId || extra.orgId!==grant.orgId || !samePartition(extra)) { researchAdmitted=false; break; }
          expiresAt=Math.min(expiresAt, typeof extra.expiresAt === 'number' ? extra.expiresAt : Date.parse(extra.expiresAt));
        }
      }
      if(route && grant && researchAdmitted) {
        attachmentAuthorized = true;
        dispatchGrant={capability:route.capability,agentId:grant.agentId,orgId:grant.orgId,requires:route.requires ?? [route.capability],optional:route.optional ?? [],expiresAt,native:route.native===true,partitionKey:edgePartition};
        // Admission and dispatch must use the same parsed path, including
        // encoded company IDs and normalized segments.
        const url = new URL(req.url!, 'http://knowledge.invalid');
        replacementUrl = `${url.pathname}${url.search}`;
        // Storage scope: the workspace, or exactly its `workspace/key` partition (stored under that companyId).
        const scopeCompany = edgePartition === null ? attachment.companyId : partition!;
        if (route.companyResource) {
          // A `workspace/key` path is only this edge's own partition; a default edge never reaches a child.
          if (route.companyRef !== undefined && (edgePartition === null || normalizeKnowledgePartitionKey(route.companyRef) !== partition)) throw new Error('partition mismatch');
          if (edgePartition !== null) replacementUrl = `/api/companies/${encodeURIComponent(partition!)}/knowledge/${route.companyResource}${url.search}`;
        }
        if (route.capability === 'knowledge:brain:read' || route.native) {
          if (!partition) throw new Error('invalid bound partition');
          const selectors = url.searchParams.getAll('partitionKey');
          if (selectors.length > 1 || selectors.some(value => !selectsPartition(value))) throw new Error('partition mismatch');
          url.searchParams.set('partitionKey', partition);
          replacementUrl = `${url.pathname}${url.search}`;
        }
        if(route.collectionId) {
          const result=await app.inject({method:'GET',url:`/api/companies/${encodeURIComponent(scopeCompany)}/knowledge/collections`});
          attachmentAuthorized=result.statusCode===200 && result.json().some((item: {id:string})=>item.id===route.collectionId);
        }
        if(route.documentId) {
          const result=await app.inject({method:'GET',url:`/api/knowledge/documents/${encodeURIComponent(route.documentId)}`});
          const owner=result.statusCode===200 ? result.json().companyId : null;
          // No cross-partition ID access: the document must live in exactly this edge's partition.
          attachmentAuthorized=edgePartition===null ? owner===attachment.companyId : typeof owner==='string' && normalizeKnowledgePartitionKey(owner)===partition;
        }
        if(attachmentAuthorized && route.bodyKind) {
          const chunks: Buffer[]=[];
          let bytes=0;
          for await(const chunk of req) {
            const buffer=Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes+=buffer.length;
            if(bytes>1_048_576) throw new RequestTooLarge();
            chunks.push(buffer);
          }
          const parsed=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
          if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error('object required');
          const fields = route.bodyKind==='collection' ? ['name','description'] : route.bodyKind==='document'
            ? ['title','body','bodyFormat','status','summary'] : route.bodyKind==='native' ? ['partitionKey','arguments'] : ['query','scopeRef','purpose','sourceIds'];
          if(Object.keys(parsed).some(key=>!fields.includes(key))) throw new Error('unsupported fields');
          // Native memory is always the bound partition; a foreign selector is refused, never rewritten.
          if(route.bodyKind==='native' && parsed.partitionKey!==undefined && !selectsPartition(parsed.partitionKey)) throw new Error('partition mismatch');
          replacementBody=JSON.stringify(route.bodyKind==='brain' ? {...parsed,scopeRef:scopeCompany,partitionKey:partition}
            : route.bodyKind==='native' ? {partitionKey:partition,arguments:parsed.arguments}
            : route.bodyKind==='document' ? {...parsed,actor:{kind:'agent',id:grant.agentId}} : parsed);
        }
      }
    } catch { attachmentAuthorized=false; }
  }
  // Body upload and ownership reads can outlive a short attachment. Recheck
  // the live grant at dispatch, after consuming all caller-controlled delay.
  if(attachmentAuthorized && attachment && dispatchGrant) {
    for(const capability of dispatchGrant.requires) {
      const current=await introspectAttachment(attachment,req.headers,capability);
      const currentClaim=current ? edgePartitionClaim(current) : null;
      // A partition edited mid-request (Portal also fails deployment_grant_changed) never re-scopes it.
      attachmentAuthorized=!!current && current.agentId===dispatchGrant.agentId && current.orgId===dispatchGrant.orgId &&
        !!currentClaim?.ok && currentClaim.partitionKey===dispatchGrant.partitionKey;
      if(!attachmentAuthorized) break;
    }
    if(attachmentAuthorized && attachmentResearch && (dispatchGrant.native || dispatchGrant.requires.some(capability => capability.startsWith('knowledge:research:')))) {
      // Optional grants (native discovery: knowledge:engine:write) widen only what the catalog lists.
      const granted=[...dispatchGrant.requires];
      for(const capability of dispatchGrant.optional) {
        const extra=await introspectAttachment(attachment,req.headers,capability);
        const extraClaim=extra ? edgePartitionClaim(extra) : null;
        if(extra && extra.agentId===dispatchGrant.agentId && extra.orgId===dispatchGrant.orgId && extraClaim?.ok && extraClaim.partitionKey===dispatchGrant.partitionKey) granted.push(capability);
      }
      researchBearer=attachmentResearch.issue({agentId:dispatchGrant.agentId,orgId:dispatchGrant.orgId,capabilities:granted,expiresAt:dispatchGrant.expiresAt,
        ...(dispatchGrant.partitionKey!==null ? {partitionKey:dispatchGrant.partitionKey} : {})}, dispatchGrant.native ? 'brain' : 'research');
      attachmentAuthorized=researchBearer!==null;
    }
  }
  if (browserResult.authorized && !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '')) {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1_048_576) throw new RequestTooLarge();
      chunks.push(buffer);
    }
    replacementBody = Buffer.concat(chunks, bytes);
    const freshBrowser = await browserAccess(browser, req, res);
    if (freshBrowser.handled) return;
    if (!freshBrowser.authorized || freshBrowser.grant.userId !== browserResult.grant.userId) throw new Error('browser authorization changed');
  }
  if (!publicHealth && !instanceAuthorized && !runtimeAuthorized && !attachmentAuthorized && !browserResult.authorized) {
    // A person opening the app without (or after) a Portal session gets a
    // readable relaunch page; API and agent callers keep the JSON contract.
    if (!runtimePrincipal && wantsSessionPage(req)) { sendSessionEnded(req, res, browser?.portal ?? attachment?.portal); return; }
    res.writeHead(runtimePrincipal ? 403 : 401, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: runtimePrincipal ? "runtime_route_denied" : "instance_auth_required" }));
    return;
  }
  const headers = { ...req.headers };
  delete headers["x-knowledge-settings-token"];
  if (instanceAuthorized || browserResult.authorized) headers["x-knowledge-settings-token"] = settingsAuthority;
  delete headers["x-knowledge-instance-token"];
  // Display-only workspace name from the Portal browser grant; never accepted from a client.
  delete headers["x-knowledge-workspace-label"];
  const workspaceName = browserResult.authorized ? (browserResult.grant as { workspaceName?: unknown }).workspaceName : undefined;
  if (typeof workspaceName === "string" && workspaceName.trim()) headers["x-knowledge-workspace-label"] = encodeURIComponent(workspaceName.trim().slice(0, 80));
  delete headers["x-tealbrick-agent-token"];
  if(attachmentAuthorized) delete headers.authorization;
  // Valid only for this in-flight request; revoked as soon as it completes.
  if(attachmentAuthorized && researchBearer) {
    const minted = researchBearer;
    headers.authorization = `Bearer ${minted}`;
    res.once('close', () => attachmentResearch?.revoke(minted));
  }
  if (browserResult.authorized) {
    delete headers.authorization;
    if (headers.cookie) {
      const retained = headers.cookie.split(';').filter(value => !value.trim().startsWith('knowledge_browser=')).join(';');
      if (retained.trim()) headers.cookie = retained;
      else delete headers.cookie;
    }
  }
  if(replacementBody!==undefined) {
    delete headers['transfer-encoding'];
    headers['content-length']=String(Buffer.byteLength(replacementBody));
  }
  // A validated direct bearer survives to the Program for per-operation/resource checks.
  const upstream = proxyRequest({ hostname: "127.0.0.1", port: address.port,
    method: req.method, path: replacementUrl ?? req.url, headers }, (response) => {
    const responseHeaders = { ...response.headers };
    delete responseHeaders["access-control-allow-origin"];
    res.writeHead(response.statusCode ?? 502, responseHeaders);
    response.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end('{"ok":false,"error":"knowledge_unavailable"}');
  });
  req.on("aborted", () => upstream.destroy());
  if(replacementBody!==undefined) upstream.end(replacementBody);
  else req.pipe(upstream);
  } catch (error) {
    if (error instanceof RequestTooLarge) {
      if (!res.headersSent) res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
      res.end('{"ok":false,"error":"request_too_large"}');
      return;
    }
    if (!res.headersSent && wantsSessionPage(req)) { sendSessionEnded(req, res, browser?.portal ?? attachment?.portal); return; }
    if (!res.headersSent) res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"ok":false,"error":"request_denied"}');
  }
});
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.listen(Number(process.env.PORT ?? 5310), process.env.HOST ?? "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  server.close(() => { void app.close().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
});
