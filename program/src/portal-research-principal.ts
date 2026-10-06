import type { KnowledgeServicePrincipal } from './knowledge-principal.js';
import type { KnowledgePartitionGrant } from './partition-authority.js';

export type ResearchPrincipalProvider = (request: {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  method: string;
}, capability: string) => Promise<KnowledgeServicePrincipal | null>;

interface PortalPrincipal {
  id: string;
  type: 'user' | 'agent';
  org: string;
  subject: string;
}
/** Structural contract for @tealbrick/portal; the host supplies its trusted verifier. */
export interface KnowledgePortalVerifier {
  authenticate(request: Request): Promise<{ ok: true; principal: PortalPrincipal } | { ok: false; status: number; code: string }>;
  verifyAttachment(token: string, principal: PortalPrincipal, required: { agentId: string; audience: string; capability: string }): Promise<{ ok: true; attachmentId: string; expiresAt: number; partitionGrants?: readonly KnowledgePartitionGrant[] } | { ok: false; status: number; code: string }>;
}

/** Opt-in Research adapter. Does not authenticate legacy Documents/Brain routes.
 * Each verifier must be pinned by the trusted host to its issuer, org and agent name.
 * No bearer, bundle, company label or attachment is accepted without verification.
 */
export function createPortalResearchPrincipalProvider(options: {
  audience: string;
  bindings: readonly { agentId: string; name: string; companyId: string; verifier: KnowledgePortalVerifier; partitionGrants?: readonly KnowledgePartitionGrant[] }[];
}): ResearchPrincipalProvider {
  if (!options.audience || !options.bindings.length) throw new Error('Portal Research authority configuration required');
  const ids = new Set<string>();
  const bindings = options.bindings.map(binding => {
    if (!binding.agentId || !binding.name || !binding.companyId || ids.has(binding.agentId) || typeof binding.verifier?.authenticate !== 'function' || typeof binding.verifier?.verifyAttachment !== 'function') throw new Error('Invalid Portal Research binding');
    ids.add(binding.agentId);
    return Object.freeze({ ...binding });
  });
  const audience = options.audience;
  return async (input, capability) => {
    if (!['research:read', 'research:write'].includes(capability)) return null;
    const attachment = input.headers['x-tealbrick-attachment'];
    const authorization = input.headers.authorization;
    if (typeof attachment !== 'string' || !attachment || typeof authorization !== 'string') return null;
    const headers = new Headers({ authorization });
    // The legacy x-kybernesis-bundle header is still accepted by the Portal verifier
    // (@tealbrick/portal legacyBundleHeader); keep forwarding it for older installs.
    for (const name of ['x-tealbrick-bundle', 'x-kybernesis-bundle']) {
      const value = input.headers[name];
      if (Array.isArray(value)) return null;
      if (value) headers.set(name, value);
    }
    const request = new Request('https://knowledge.invalid/research-authority', { headers });
    for (const binding of bindings) {
      const authenticated = await binding.verifier.authenticate(request);
      if (!authenticated.ok) { if (authenticated.status === 503) throw new Error('Portal authority unavailable'); continue; }
      const proof = await binding.verifier.verifyAttachment(attachment, authenticated.principal, { agentId: binding.agentId, audience, capability });
      if (!proof.ok) { if (proof.status === 503) throw new Error('Portal authority unavailable'); continue; }
      const capabilities = [capability];
      const other = capability === 'research:read' ? 'research:write' : 'research:read';
      const additional = await binding.verifier.verifyAttachment(attachment, authenticated.principal, { agentId: binding.agentId, audience, capability: other });
      if (additional.ok) capabilities.push(other);
      else if (additional.status === 503) throw new Error('Portal authority unavailable');
      const partitionGrants = proof.partitionGrants ?? binding.partitionGrants;
      return Object.freeze({
        kind: 'service',
        principalId: `portal:${authenticated.principal.subject}:${binding.agentId}`,
        companyId: binding.companyId,
        capabilities: Object.freeze(capabilities.sort()),
        ...(partitionGrants ? { partitionGrants: Object.freeze(partitionGrants.map((grant) => Object.freeze({ ...grant }))) } : {}),
      });
    }
    return null;
  };
}
