import { createHash, randomBytes } from "node:crypto";
import type { KnowledgePrincipalResolver, KnowledgeServicePrincipal } from "./knowledge-principal.js";
import type { ResearchPrincipalProvider } from "./portal-research-principal.js";

/**
 * Portal attachment grants for Research, issued by the container edge.
 *
 * The edge introspects the agent's Portal attachment for
 * `knowledge:research:read` / `knowledge:research:write`, then forwards the
 * request in-process with a short-lived, per-request bearer minted here. The
 * Program's Research routes resolve that bearer back to a principal bound to
 * the deployment workspace with exactly the verified capabilities. Any other
 * bearer falls through to the configured static service principals, so
 * standalone Research access is unchanged.
 */

export const ATTACHMENT_RESEARCH_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  "knowledge:research:read": "research:read",
  "knowledge:research:write": "research:write",
});

const TOKEN_PATTERN = /^kedge_[A-Za-z0-9_-]{43}$/u;
const MAX_TTL_MS = 5 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface AttachmentResearchGrant {
  readonly agentId: string;
  readonly orgId: string;
  /** Portal capability names, e.g. knowledge:research:read. */
  readonly capabilities: readonly string[];
  /** Attachment expiry (epoch ms). The minted bearer never outlives it. */
  readonly expiresAt: number;
}

export interface AttachmentResearchAuthority {
  /** Mint a per-request bearer; returns null when the grant carries no Research capability. */
  issue(grant: AttachmentResearchGrant): string | null;
  revoke(token: string): void;
  readonly provider: ResearchPrincipalProvider;
}

function bearer(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const parts = header.trim().split(/\s+/u);
  return parts.length === 2 && parts[0]?.toLowerCase() === "bearer" && parts[1] ? parts[1] : null;
}

export function createAttachmentResearchAuthority(options: {
  readonly companyId: string;
  readonly fallback: KnowledgePrincipalResolver | null;
  readonly now?: () => number;
}): AttachmentResearchAuthority {
  const companyId = options.companyId.trim();
  if (!companyId) throw new Error("Attachment Research authority requires a workspace company ID");
  const now = options.now ?? Date.now;
  const active = new Map<string, { principal: KnowledgeServicePrincipal; expiresAt: number }>();
  const sweep = () => { const at = now(); for (const [key, entry] of active) if (entry.expiresAt <= at) active.delete(key); };
  return {
    issue(grant) {
      sweep();
      const capabilities = [...new Set(grant.capabilities.map((name) => ATTACHMENT_RESEARCH_CAPABILITIES[name]).filter((name): name is string => Boolean(name)))].sort();
      if (!capabilities.length || !grant.agentId || !grant.orgId || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now()) return null;
      const token = `kedge_${randomBytes(32).toString("base64url")}`;
      active.set(digest(token), {
        expiresAt: Math.min(grant.expiresAt, now() + MAX_TTL_MS),
        principal: Object.freeze({
          kind: "service" as const,
          // Stable per Portal agent so chat sessions and receipts stay owned across requests.
          principalId: `portal-agent:${digest(`${grant.orgId}\u0000${grant.agentId}`).slice(0, 40)}`,
          companyId,
          capabilities: Object.freeze(capabilities),
        }),
      });
      return token;
    },
    revoke(token) { active.delete(digest(token)); },
    provider: async (request) => {
      const token = bearer(request.headers.authorization);
      if (!token) return null;
      if (TOKEN_PATTERN.test(token)) {
        const entry = active.get(digest(token));
        if (!entry) return null;
        if (entry.expiresAt <= now()) { active.delete(digest(token)); return null; }
        return entry.principal;
      }
      return options.fallback?.configured ? options.fallback.resolve(token) : null;
    },
  };
}
