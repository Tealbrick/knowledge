import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceDisplayName } from "./SettingsPageView";
import { DEFAULT_PARTITION_LABEL, getPartitions, partitionKeyOf, partitionOptions } from "./partitions";
import type { FrontendBootstrap } from "./types";

const workspace = "3f32db87-6f74-4ecf-b7b8-8c72c54f30a3";
const listing = (keys: string[]) => ({ companyId: workspace, defaultPartitionKey: workspace, partitions: keys.map((key) => ({ key, partitionKey: `${workspace}/${key}` })) });

afterEach(() => vi.unstubAllGlobals());

describe("memory partition selector", () => {
  it("defaults to the workspace and lists edge partitions by key", () => {
    expect(partitionOptions(workspace, undefined, workspace)).toEqual([{ value: workspace, label: DEFAULT_PARTITION_LABEL }]);
    expect(DEFAULT_PARTITION_LABEL).toBe("Workspace (default)");
    expect(partitionOptions(workspace, listing(["ops", "personal"]), workspace)).toEqual([
      { value: workspace, label: "Workspace (default)" },
      { value: `${workspace}/ops`, label: "ops" },
      { value: `${workspace}/personal`, label: "personal" },
    ]);
  });

  it("keeps the selected partition even before it holds data, and drops listing entries that are not this workspace's children", () => {
    const foreign = { ...listing(["ops"]), partitions: [...listing(["ops"]).partitions, { key: "x", partitionKey: "other/x" }, { key: "deep", partitionKey: `${workspace}/a/deep` }] };
    expect(partitionOptions(workspace, foreign, `${workspace}/personal`).map((option) => option.label)).toEqual(["Workspace (default)", "ops", "personal"]);
  });

  it("recognises only direct, valid edge-partition children", () => {
    expect(partitionKeyOf(workspace, `${workspace}/personal`)).toBe("personal");
    expect(partitionKeyOf("Fixture-A", "fixture-a/personal")).toBe("personal");
    for (const scope of [workspace, `${workspace}/default`, `${workspace}/a/b`, `${workspace}/Bad_Key`, "other/personal", "default"]) expect(partitionKeyOf(workspace, scope), scope).toBeNull();
  });

  it("labels a partition scope with the workspace name", () => {
    const boot = { scope: { defaultCompanyId: workspace, workspaceLabel: "Polygonface" } } as FrontendBootstrap;
    expect(workspaceDisplayName(boot, workspace)).toBe("Polygonface");
    expect(workspaceDisplayName(boot, `${workspace}/personal`)).toBe("Polygonface · personal");
    expect(workspaceDisplayName({ scope: { defaultCompanyId: workspace } } as FrontendBootstrap, `${workspace}/personal`)).toBe("This workspace · personal");
  });

  it("reads the owner listing for the workspace", async () => {
    const fetch = vi.fn(async () => Response.json(listing(["personal"])));
    vi.stubGlobal("fetch", fetch);
    expect((await getPartitions(workspace)).partitions[0]?.key).toBe("personal");
    expect(fetch).toHaveBeenCalledWith(`/api/companies/${workspace}/knowledge/partitions`, expect.anything());
  });
});
