import { describe, expect, it } from "vitest";
import { managedBrainToken, verifyManagedBrainToken } from "./gbrain-managed-auth.js";
import { knowledgePartitionSourceId } from "./partition-authority.js";

describe("managed Brain source capabilities", () => {
  it("binds a credential to exactly one source and survives a same-secret restart", () => {
    const secret = "disposable-test-secret-not-a-real-secret";
    const a = knowledgePartitionSourceId("eval-a"), b = knowledgePartitionSourceId("eval-b");
    const token = managedBrainToken(secret, a);
    expect(verifyManagedBrainToken(secret, token)).toBe(a);
    expect(verifyManagedBrainToken(secret, token.replace(a, b))).toBeNull();
    expect(verifyManagedBrainToken(`${secret}-rotated`, token)).toBeNull();
    expect(verifyManagedBrainToken(secret, `${token}x`)).toBeNull();
    expect(verifyManagedBrainToken(secret, "default")).toBeNull();
    expect(() => managedBrainToken(secret, "__all__")).toThrow();
  });
});
