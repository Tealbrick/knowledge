import { describe, expect, it } from "vitest";
import { createAttachmentResearchAuthority } from "./attachment-research-principal.js";
import { createKnowledgePrincipalResolver } from "./knowledge-principal.js";
// @ts-expect-error - plain ESM edge module without type declarations
import { attachmentRoute } from "../../deploy/container/attachment-auth.mjs";

const request = (token?: string) => ({ method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("Portal attachment Research authority", () => {
  it("mints a short-lived bearer bound to the workspace with exactly the verified capabilities", async () => {
    let now = 1_000;
    const authority = createAttachmentResearchAuthority({ companyId: "company-a", fallback: null, now: () => now });
    const token = authority.issue({ agentId: "agent-1", orgId: "org-1", capabilities: ["knowledge:research:write", "knowledge:research:read", "knowledge:brain:read"], expiresAt: 61_000 })!;
    expect(token).toMatch(/^kedge_[A-Za-z0-9_-]{43}$/u);
    const principal = await authority.provider(request(token), "research:read");
    expect(principal).toMatchObject({ kind: "service", companyId: "company-a", capabilities: ["research:read", "research:write"] });
    expect(principal!.principalId).toMatch(/^portal-agent:[a-f0-9]{40}$/u);
    // Stable identity per Portal agent, so chat sessions stay owned across requests.
    const again = authority.issue({ agentId: "agent-1", orgId: "org-1", capabilities: ["knowledge:research:read"], expiresAt: 61_000 })!;
    expect((await authority.provider(request(again), "research:read"))!.principalId).toBe(principal!.principalId);
    expect((await authority.provider(request(again), "research:read"))!.capabilities).toEqual(["research:read"]);
    authority.revoke(token);
    expect(await authority.provider(request(token), "research:read")).toBeNull();
    now = 61_000;
    expect(await authority.provider(request(again), "research:read")).toBeNull();
  });

  it("refuses grants without Research capabilities or already expired", () => {
    const authority = createAttachmentResearchAuthority({ companyId: "company-a", fallback: null, now: () => 1_000 });
    expect(authority.issue({ agentId: "a", orgId: "o", capabilities: ["knowledge:documents:read"], expiresAt: 9_000 })).toBeNull();
    expect(authority.issue({ agentId: "a", orgId: "o", capabilities: ["knowledge:research:read"], expiresAt: 999 })).toBeNull();
  });

  it("keeps static service principals working and never resolves guessed edge bearers", async () => {
    const fallback = createKnowledgePrincipalResolver([{ token: "static-research-token-for-tests", principalId: "static-agent", companyId: "company-a", capabilities: ["research:read"] }]);
    const authority = createAttachmentResearchAuthority({ companyId: "company-a", fallback });
    expect(await authority.provider(request("static-research-token-for-tests"), "research:read")).toMatchObject({ principalId: "static-agent" });
    expect(await authority.provider(request(`kedge_${"a".repeat(43)}`), "research:read")).toBeNull();
    expect(await authority.provider(request(), "research:read")).toBeNull();
  });

  it("maps only Research engine routes to knowledge:research capabilities", () => {
    const base = "/api/research/notebooks/notebook_1/engine";
    expect(attachmentRoute("GET", "/api/research/engine/notebooks", "c")).toMatchObject({ capability: "knowledge:research:read", requires: ["knowledge:research:read"] });
    expect(attachmentRoute("GET", `${base}/context`, "c")).toMatchObject({ capability: "knowledge:research:read" });
    expect(attachmentRoute("POST", `${base}/sources`, "c")).toMatchObject({ capability: "knowledge:research:write" });
    expect(attachmentRoute("POST", `${base}/chat/sessions/s1/messages`, "c")).toMatchObject({ requires: ["knowledge:research:write", "knowledge:research:read"] });
    expect(attachmentRoute("GET", `${base}/chat/receipts/k1`, "c")).toMatchObject({ requires: ["knowledge:research:write", "knowledge:research:read"] });
    for (const [method, url] of [["DELETE", `${base}/sources/s1`], ["GET", "/api/research/summary?companyId=c"], ["POST", "/api/research/chat"], ["GET", `${base}/../../../settings/models`], ["GET", "/api/settings/models"]]) {
      expect(attachmentRoute(method, url, "c")).toBeNull();
    }
  });
});
