import { describe, expect, it } from "vitest";
import {
  createKnowledgePrincipalResolver,
  type KnowledgeServicePrincipalBinding,
} from "./knowledge-principal.js";

const alpha: KnowledgeServicePrincipalBinding = {
  token: "knowledge-alpha-token",
  principalId: "service-knowledge-alpha",
  companyId: "company-alpha",
  capabilities: ["notebooks:read", "research:read"],
};

const beta: KnowledgeServicePrincipalBinding = {
  token: "knowledge-beta-token",
  principalId: "service-knowledge-beta",
  companyId: "company-beta",
  capabilities: ["notebooks:read"],
};

describe("Knowledge service-principal resolver", () => {
  it("maps explicit tokens to frozen server-owned principals and never returns the token", () => {
    const resolver = createKnowledgePrincipalResolver([alpha, beta]);

    expect(resolver.configured).toBe(true);
    expect(resolver.resolve(alpha.token)).toEqual({
      kind: "service",
      principalId: "service-knowledge-alpha",
      companyId: "company-alpha",
      capabilities: ["notebooks:read", "research:read"],
    });
    expect(resolver.resolve(beta.token)).toMatchObject({ principalId: beta.principalId, companyId: beta.companyId });
    expect(JSON.stringify(resolver.resolve(alpha.token))).not.toContain(alpha.token);

    const principal = resolver.resolve(alpha.token);
    expect(principal && Object.isFrozen(principal)).toBe(true);
    expect(principal && Object.isFrozen(principal.capabilities)).toBe(true);
  });

  it("does not accept caller-supplied actor, company, or query identity", () => {
    const resolver = createKnowledgePrincipalResolver([alpha]);
    const resolve = resolver.resolve as unknown as (...args: unknown[]) => unknown;

    expect(resolve(alpha.token, { actor: "caller-controlled", companyId: "company-forged", query: "evil" })).toMatchObject({
      principalId: alpha.principalId,
      companyId: alpha.companyId,
    });
    expect(resolve("unknown-token")).toBeNull();
    expect(resolve(null)).toBeNull();
    expect(resolve(undefined)).toBeNull();
    expect(resolve("   ")).toBeNull();
  });

  it.each([
    ["empty configuration", []],
    ["empty token", [{ ...alpha, token: "   " }]],
    ["duplicate token", [alpha, { ...beta, token: alpha.token }]],
    ["duplicate principal", [alpha, { ...beta, principalId: alpha.principalId }]],
    ["empty principal", [{ ...alpha, principalId: "" }]],
    ["empty company", [{ ...alpha, companyId: "" }]],
    ["unknown field", [{ ...alpha, actor: "caller-controlled" }]],
  ] as const)("fails closed for %s", (_label, bindings) => {
    const resolver = createKnowledgePrincipalResolver(bindings as unknown as KnowledgeServicePrincipalBinding[]);
    expect(resolver.configured).toBe(false);
    expect(resolver.resolve(alpha.token)).toBeNull();
  });

  it("snapshots configuration so later caller mutation cannot change identity or grants", () => {
    const mutable = {
      token: alpha.token,
      principalId: alpha.principalId,
      companyId: alpha.companyId,
      capabilities: [...alpha.capabilities],
    };
    const resolver = createKnowledgePrincipalResolver([mutable]);

    mutable.principalId = "forged-principal";
    mutable.companyId = "forged-company";
    mutable.capabilities.push("admin:all");

    expect(resolver.resolve(alpha.token)).toEqual({
      kind: "service",
      principalId: alpha.principalId,
      companyId: alpha.companyId,
      capabilities: alpha.capabilities,
    });
  });

  it("allows an explicitly authenticated principal with no capabilities without inventing authority", () => {
    const resolver = createKnowledgePrincipalResolver([{ ...alpha, capabilities: [] }]);
    expect(resolver.resolve(alpha.token)).toMatchObject({ principalId: alpha.principalId, capabilities: [] });
  });

  it("allows independently authenticated principals to share a configured company", () => {
    const resolver = createKnowledgePrincipalResolver([{ ...alpha, companyId: "company-shared" }, { ...beta, companyId: "company-shared" }]);
    expect(resolver.resolve(alpha.token)).toMatchObject({ principalId: alpha.principalId, companyId: "company-shared" });
    expect(resolver.resolve(beta.token)).toMatchObject({ principalId: beta.principalId, companyId: "company-shared" });
  });
});
