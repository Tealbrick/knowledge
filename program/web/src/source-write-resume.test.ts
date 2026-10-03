import { describe, expect, it } from "vitest";
import { clearSourceWriteResume, loadSourceWriteResume, saveSourceWriteResume, type SourceWriteStorage } from "./source-write-resume";

function storage(initial: Record<string, string> = {}): SourceWriteStorage & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getItem(key) { return values[key] ?? null; },
    setItem(key, value) { values[key] = value; },
    removeItem(key) { delete values[key]; },
  };
}

describe("scoped source-write resume state", () => {
  it("stores only the pending idempotency key and clears it", () => {
    const target = storage();
    saveSourceWriteResume(target, "knowledge.research.source-write.v1:[\"p\",\"c\",\"n\"]", "source-write-1");
    expect(target.values["knowledge.research.source-write.v1:[\"p\",\"c\",\"n\"]"]).toBe('{"pendingKey":"source-write-1"}');
    expect(loadSourceWriteResume(target, "knowledge.research.source-write.v1:[\"p\",\"c\",\"n\"]")).toEqual({ pendingKey: "source-write-1" });
    clearSourceWriteResume(target, "knowledge.research.source-write.v1:[\"p\",\"c\",\"n\"]");
    expect(loadSourceWriteResume(target, "knowledge.research.source-write.v1:[\"p\",\"c\",\"n\"]")).toEqual({ pendingKey: null });
  });

  it("fails closed for corrupt, extra, or invalid stored values", () => {
    const cases = [
      "not-json",
      "",
      "x".repeat(1025),
      JSON.stringify({ pendingKey: "source-write-1", title: "must-not-persist" }),
      JSON.stringify({ pendingKey: "contains whitespace" }),
      JSON.stringify({ pendingKey: 42 }),
    ];
    for (const value of cases) {
      const target = storage({ key: value });
      expect(() => loadSourceWriteResume(target, "key")).toThrow("invalid_source_write_resume");
    }
  });

  it("propagates unavailable storage so the caller can disable writes", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); } };
    expect(() => loadSourceWriteResume(blocked, "key")).toThrow("blocked");
    const broken = { setItem: () => { throw new Error("blocked"); } };
    expect(() => saveSourceWriteResume(broken, "key", "source-write-1")).toThrow("blocked");
  });
});
