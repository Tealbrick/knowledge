import { describe, expect, it } from "vitest";

import { applyEnvAliases } from "./env-aliases.js";

describe("contract and Knowledge environment names are one setting", () => {
  it("fills each name from the other", () => {
    const env: NodeJS.ProcessEnv = { TEALBRICK_TENANT_ID: "ws-1", KNOWLEDGE_INSTANCE_TOKEN: "t".repeat(40) };
    applyEnvAliases(env);
    expect(env).toMatchObject({ TEALBRICK_TENANT_ID: "ws-1", KNOWLEDGE_COMPANY_ID: "ws-1", TEALBRICK_INSTANCE_TOKEN: "t".repeat(40), KNOWLEDGE_INSTANCE_TOKEN: "t".repeat(40) });
  });

  it("accepts both when equal and stops on a conflict without printing the value", () => {
    const equal: NodeJS.ProcessEnv = { TEALBRICK_PORTAL_ORG_ID: "org", KNOWLEDGE_PORTAL_ORG_ID: "org" };
    expect(() => applyEnvAliases(equal)).not.toThrow();
    const conflict: NodeJS.ProcessEnv = { TEALBRICK_INSTANCE_TOKEN: "a".repeat(40), KNOWLEDGE_INSTANCE_TOKEN: "b".repeat(40) };
    expect(() => applyEnvAliases(conflict)).toThrowError(/TEALBRICK_INSTANCE_TOKEN and KNOWLEDGE_INSTANCE_TOKEN/);
    try { applyEnvAliases(conflict); } catch (error) { expect(String(error)).not.toMatch(/aaaa|bbbb/); }
  });

  it("leaves an unset pair unset", () => {
    const env: NodeJS.ProcessEnv = {};
    applyEnvAliases(env);
    expect(env.TEALBRICK_TENANT_ID).toBeUndefined();
    expect(env.KNOWLEDGE_COMPANY_ID).toBeUndefined();
  });
});
