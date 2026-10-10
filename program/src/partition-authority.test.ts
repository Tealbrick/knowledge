import { describe, expect, it } from "vitest";

import {
  authorizeKnowledgePartition,
  edgeReadSelector,
  edgeScopeFor,
  knowledgePartitionSourceId,
  namedReadPartition,
  normalizeKnowledgePartitionKey,
  isCanonicalPartitionScope,
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

describe("canonical partition scope", () => {
  it("accepts only hierarchical keys that normalization leaves unchanged", () => {
    for (const value of ["a/b", "workspace-1/personal", "a/b/c", "a/b.c_d-e"]) expect(isCanonicalPartitionScope(value), value).toBe(true);
    for (const value of ["plain", "", "a//b", "a/../b", "a/./b", "a/", "/a", "A/b", "a/B", " a/b", "a/b ", "a/.b", "a/b c", `a/${"b".repeat(260)}`, null, 7, {}, ["a/b"]]) {
      expect(isCanonicalPartitionScope(value), String(value)).toBe(false);
    }
  });
});

describe("contract 2: a read may name one partition of its read set", () => {
  const scope = (write: string | null, reads?: readonly (string | null)[]) => {
    const result = edgeScopeFor("ws", write, reads);
    if (!result.ok) throw new Error("fixture scope");
    return result.bound ?? undefined;
  };
  // C: write b, read [b, a]; the workspace alias is already narrowed to the write partition when the rule runs.
  const c = scope("b", ["b", "a"]);

  it("narrows a read naming a read partition alone, or with its own workspace, to exactly that partition", () => {
    for (const capability of ["knowledge:read", "brain:read", "research:read", "brain:native:read"]) {
      expect(namedReadPartition(c, capability, ["ws/a"]), capability).toBe("ws/a");
      expect(namedReadPartition(c, capability, ["ws/b", "ws/a"]), capability).toBe("ws/a");
      expect(namedReadPartition(c, capability, ["ws/a", "ws/b", "ws/a"]), capability).toBe("ws/a");
    }
  });

  it("leaves everything else to today's resolution (null)", () => {
    // Writes stay write-partition-only.
    for (const capability of ["knowledge:create", "knowledge:update", "knowledge:delete", "knowledge:write", "brain:write", "research:write", "brain:native:write"]) {
      expect(namedReadPartition(c, capability, ["ws/a"]), capability).toBeNull();
      expect(namedReadPartition(c, capability, ["ws/b", "ws/a"]), capability).toBeNull();
    }
    // Outside the read set, the workspace itself, the write partition alone, nothing named, or two named partitions.
    for (const direct of [["ws/z"], ["ws/b", "ws/z"], ["ws"], ["ws/b", "ws"], ["a"], ["ws/b"], [], ["ws/a", "ws/z"]]) {
      expect(namedReadPartition(c, "knowledge:read", direct), JSON.stringify(direct)).toBeNull();
    }
    // Contract 1 (no read set, or a read set equal to the write key) and unbound principals are unchanged.
    expect(scope("b")).toEqual({ alias: "ws", partitionKey: "ws/b" });
    expect(namedReadPartition(scope("b"), "knowledge:read", ["ws/b", "ws/a"])).toBeNull();
    expect(namedReadPartition(scope("b", ["b"]), "knowledge:read", ["ws/a"])).toBeNull();
    expect(namedReadPartition(undefined, "knowledge:read", ["ws/a"])).toBeNull();
    // A default write partition with a wider read set: the workspace is the write partition.
    expect(namedReadPartition(scope(null, [null, "a"]), "knowledge:read", ["ws", "ws/a"])).toBe("ws/a");
  });

  it("maps an edge read selector to its effective partition only inside the read set", () => {
    const reads = ["b", "a"] as const;
    expect(edgeReadSelector("ws", "ws", reads)).toBe("ws");
    expect(edgeReadSelector("WS", "ws", reads)).toBe("ws");
    expect(edgeReadSelector("ws/a", "ws", reads)).toBe("ws/a");
    expect(edgeReadSelector("a", "ws", reads)).toBe("ws/a");
    expect(edgeReadSelector(" B ", "ws", reads)).toBe("ws/b");
    for (const value of ["z", "ws/z", "other/a", "ws/a/x", "a/ws", "", "default", "ws/", null, 7, ["a"]]) {
      expect(edgeReadSelector(value, "ws", reads), JSON.stringify(value)).toBeNull();
    }
    // A null entry is the workspace default scope: only the workspace names it.
    expect(edgeReadSelector("ws", "ws", [null, "a"])).toBe("ws");
    expect(edgeReadSelector("a", "ws", [null, "a"])).toBe("ws/a");
  });
});
