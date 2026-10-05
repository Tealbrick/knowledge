import { describe, expect, it } from "vitest";
import { sanitizeGBrainResult, stripPrivacyFences } from "./gbrain-privacy.js";

const facts = (inner: string) => `<!--- gbrain:facts:begin -->${inner}<!--- gbrain:facts:end -->`;
const takes = (inner: string) => `<!--- gbrain:takes:begin -->${inner}<!--- gbrain:takes:end -->`;

describe("Knowledge-side GBrain privacy enforcement", () => {
  it("strips every fence, not just the first (A7)", () => {
    expect(stripPrivacyFences(`a ${facts("secret1")} b ${takes("secret2")} c ${facts("secret3")} d`)).toBe("a  b  c  d");
  });
  it("drops nested, overlapping and unclosed fences whole (A7)", () => {
    expect(stripPrivacyFences(`a <!--- gbrain:facts:begin --> x ${takes("y")} z <!--- gbrain:facts:end --> b`)).toBe("a  b");
    expect(stripPrivacyFences("a <!--- gbrain:facts:begin --> secret <!--- gbrain:takes:begin --> more <!--- gbrain:facts:end --> tail")).toBe("a ");
    expect(stripPrivacyFences("visible <!--- GBRAIN:FACTS:BEGIN --> secret forever")).toBe("visible ");
    expect(stripPrivacyFences("stray <!--- gbrain:facts:end --> text")).toBe("stray  text");
    expect(stripPrivacyFences("no fences here")).toBe("no fences here");
  });
  it("withholds private counts and unverifiable open loops (A6, A13)", () => {
    const result = sanitizeGBrainResult({ facts: [], total: 0, pending_consolidation_count: 7, card: { name: "henry", open_loops: [{ text: "x" }] } }, "kb-a");
    expect(result).toEqual({ facts: [], total: 0, card: { name: "henry" } });
  });
  it("drops link and graph rows that name another source (A9)", () => {
    const result = sanitizeGBrainResult({ links: [
      { to_slug: "a", source_id: "kb-a", origin_source_id: "kb-a" },
      { to_slug: "b", source_id: "kb-a", origin_source_id: "kb-b" },
      { to_slug: "c", source_id: "kb-c" },
      { to_slug: "d", origin_source_id: null },
    ] }, "kb-a") as { links: Array<{ to_slug: string }> };
    expect(result.links.map(link => link.to_slug)).toEqual(["a", "d"]);
  });
  it("sanitizes nested page text and keeps ordinary values", () => {
    expect(sanitizeGBrainResult({ page: { compiled_truth: `Body ${facts("p")}`, chunks: [{ text: takes("t") + "ok" }] }, n: 3, ok: true }, "kb-a"))
      .toEqual({ page: { compiled_truth: "Body ", chunks: [{ text: "ok" }] }, n: 3, ok: true });
  });
});
