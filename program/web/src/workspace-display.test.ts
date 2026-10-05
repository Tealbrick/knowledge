import { describe, expect, it } from "vitest";
import { memoryBadgeFor } from "./App";
import { workspaceDisplayName } from "./SettingsPageView";
import type { FrontendBootstrap } from "./types";

const boot = (scope: FrontendBootstrap["scope"]) => ({ scope } as FrontendBootstrap);

describe("workspace display (Tealbrick/knowledge#11)", () => {
  it("shows the Portal workspace name, never the raw id", () => {
    expect(workspaceDisplayName(boot({ defaultCompanyId: "3f32db87-6f74-4ecf-b7b8-8c72c54f30a3", workspaceLabel: "Polygonface" }), "3f32db87-6f74-4ecf-b7b8-8c72c54f30a3")).toBe("Polygonface");
    expect(workspaceDisplayName(boot({ defaultCompanyId: "3f32db87-6f74-4ecf-b7b8-8c72c54f30a3" }), "3f32db87-6f74-4ecf-b7b8-8c72c54f30a3")).toBe("This workspace");
    expect(workspaceDisplayName(boot({ defaultCompanyId: "default" }), "default")).toBe("Default workspace");
  });
  it("does not label another workspace with this workspace's name", () => {
    expect(workspaceDisplayName(boot({ defaultCompanyId: "a", workspaceLabel: "Polygonface" }), "b")).toBe("This workspace");
  });
});

describe("memory badge", () => {
  it("treats a memory engine that is not set up as a next step, not an error", () => {
    expect(memoryBadgeFor({ state: "Needs setup" })).toEqual({ label: "Set up memory", tone: "default", sidebar: "Set up" });
    expect(memoryBadgeFor({ state: "Off" }).tone).toBe("default");
    expect(memoryBadgeFor({ state: "Running" })).toEqual({ label: "Memory ready", tone: "success" });
    expect(memoryBadgeFor({ state: "Not working" }).tone).toBe("warning");
  });
});
