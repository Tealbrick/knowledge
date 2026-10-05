import { describe, expect, it } from "vitest";

import { parseSettingsSection, DEFAULT_SETTINGS_SECTION } from "./SettingsPageView";
import { describeCapabilities, describeDependency, describeFeature, describeMemory } from "./service-status";

describe("service status in plain words", () => {
  it("opens every settings entry point on one default section", () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe("models");
    expect(parseSettingsSection(null)).toBe("models");
    expect(parseSettingsSection("nonsense")).toBe("models");
    expect(parseSettingsSection("runtime")).toBe("runtime");
    expect(parseSettingsSection("version-control")).toBe("developer");
  });

  it("gives the memory engine a state and a next action for each runtime state", () => {
    expect(describeMemory({ status: "online" })).toMatchObject({ state: "Running", tone: "success", nextStep: null });
    expect(describeMemory({ status: "disabled", detail: "setup_required: open Settings → Models and add your model keys" }))
      .toMatchObject({ state: "Needs setup", action: { section: "models" } });
    expect(describeMemory({ status: "disabled", detail: "GBrain autostart disabled" })).toMatchObject({ state: "Off", tone: "warning" });
    expect(describeMemory({ status: "degraded", detail: "GBrain sidecar exited (1)" }).detail).not.toMatch(/GBrain|sidecar/u);
    expect(describeMemory(undefined).state).toBe("Not working");
  });

  it("names every bootstrap dependency for people, never by its internal id", () => {
    expect(describeDependency("knowledgeDb", { status: "configured" })).toMatchObject({ name: "Document database", state: "Ready" });
    expect(describeDependency("knowledgeDb", { status: "missing-config" })).toMatchObject({ state: "Not set up", tone: "warning" });
    expect(describeDependency("objectStore", { status: "configured" }).name).toBe("File storage");
    expect(describeDependency("rules", { status: "local" })).toMatchObject({ name: "Approval rules", state: "Not used" });
    expect(describeDependency("rules", { status: "unavailable" }).nextStep).toMatch(/approval rules connection/u);
    expect(describeDependency("workEthic", { status: "contract-only" }).name).toBe("Work item links");
    expect(describeDependency("searchIndex", { status: "offline" })).toMatchObject({ name: "Search Index", state: "Needs attention" });
  });

  it("explains degraded features instead of echoing a status word", () => {
    const memory = describeMemory({ status: "disabled", detail: "setup_required" });
    expect(describeFeature("research", { status: "degraded", configured: false }, memory)).toMatchObject({ state: "Not connected", tone: "warning" });
    expect(describeFeature("research", { status: "degraded", configured: true }, memory)).toMatchObject({ state: "Connected" });
    expect(describeFeature("brain", { status: "degraded" }, memory)).toMatchObject({ state: "Limited", action: { section: "models" } });
    expect(describeFeature("documents", { status: "online" }, memory)).toMatchObject({ name: "Library", state: "Available" });
  });

  it("lists only known capabilities with their availability", () => {
    expect(describeCapabilities({ documents: true, revisionRestore: false, versionControl: false })).toEqual([
      { id: "documents", name: "Documents and collections", available: true },
      { id: "revisionRestore", name: "Restore earlier document versions", available: false },
    ]);
  });
});
