import { describe, expect, it } from "vitest";

import { frameAncestorsDirective, portalFrameOrigin } from "./frame-ancestors.js";

describe("frame-ancestors", () => {
  it("allows exactly the configured Portal origin next to 'self'", () => {
    expect(frameAncestorsDirective("https://portal.example/some/path?x=1")).toBe("frame-ancestors 'self' https://portal.example");
    expect(frameAncestorsDirective("http://127.0.0.1:3000/")).toBe("frame-ancestors 'self' http://127.0.0.1:3000");
  });

  it("is 'self' only when the Portal URL is unset, empty or unusable", () => {
    for (const value of [undefined, null, "", "   ", "not a url", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      expect(frameAncestorsDirective(value)).toBe("frame-ancestors 'self'");
    }
    expect(portalFrameOrigin("ftp://portal.example")).toBeNull();
  });

  it("never emits a wildcard", () => {
    for (const value of [undefined, "*", "https://*.example", "https://portal.example"]) {
      expect(frameAncestorsDirective(value)).not.toMatch(/\*/u);
    }
    expect(frameAncestorsDirective("https://*.example")).toBe("frame-ancestors 'self'");
  });
});
