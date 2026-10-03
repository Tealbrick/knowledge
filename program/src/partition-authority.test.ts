import { describe, expect, it } from "vitest";

import {
  authorizeKnowledgePartition,
  knowledgePartitionSourceId,
  normalizeKnowledgePartitionKey,
} from "./partition-authority.js";
import { createKnowledgePrincipalResolver } from "./knowledge-principal.js";

describe("Knowledge partition authority", () => {
  const principal = createKnowledgePrincipalResolver([{
    token: "partition-token",
    principalId: "fleet-alpha",
    companyId: "WorkspaceAlpha",
    capabilities: ["knowledge:read", "research:read"],
    partitionGrants: [
      { partitionKey: "WorkspaceAlpha", breadth: "descendants", maxDepth: 1, capabilities: ["knowledge:read"] },
      { partitionKey: "WorkspaceAlpha/ProjectAlpha", breadth: "exact", maxDepth: 0, capabilities: ["research:read"] },
    ],
  }]).resolve("partition-token")!;

  it("canonicalizes keys and derives a bounded opaque GBrain source id", () => {
    expect(normalizeKnowledgePartitionKey(" WorkspaceAlpha/ProjectAlpha ")).toBe("workspacealpha/projectalpha");
    expect(knowledgePartitionSourceId("WorkspaceAlpha/ProjectAlpha")).toMatch(/^kb-[a-f0-9]{24}$/u);
    expect(knowledgePartitionSourceId("WorkspaceAlpha/ProjectAlpha")).toBe(knowledgePartitionSourceId("workspacealpha/projectalpha"));
  });

  it("supports exact, descendant, and depth-bounded grants", () => {
    expect(authorizeKnowledgePartition(principal, "workspacealpha", "knowledge:read").allowed).toBe(true);
    expect(authorizeKnowledgePartition(principal, "workspacealpha/projectalpha", "knowledge:read").allowed).toBe(true);
    expect(authorizeKnowledgePartition(principal, "workspacealpha/projectalpha/subproject", "knowledge:read").allowed).toBe(false);
    expect(authorizeKnowledgePartition(principal, "workspacealpha/projectalpha", "research:read").allowed).toBe(true);
    expect(authorizeKnowledgePartition(principal, "workspacealpha/other", "research:read").allowed).toBe(false);
  });

  it("keeps legacy principals exact-company scoped", () => {
    const legacy = createKnowledgePrincipalResolver([{
      token: "legacy-token",
      principalId: "legacy",
      companyId: "WorkspaceBeta",
      capabilities: ["knowledge:read"],
    }]).resolve("legacy-token")!;
    expect(authorizeKnowledgePartition(legacy, "workspacebeta", "knowledge:read").allowed).toBe(true);
    expect(authorizeKnowledgePartition(legacy, "workspacebeta/project", "knowledge:read").allowed).toBe(false);
  });
});
