import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeSourceAdapters, normalizeStoredSourcePath } from "./source-adapters.js";
import type { KnowledgeCollectionSourceConfig } from "./types.js";
type RepoConfig = Exclude<KnowledgeCollectionSourceConfig, { provider: "native" }>;
const adapters = new KnowledgeSourceAdapters();
const fixture = (provider: "github_repo" | "forgejo_repo"): RepoConfig => ({
  provider, apiBaseUrl: "https://forge.example.test", owner: "team", repo: "docs",
  branch: "main", rootPath: "team-a", tokenEnvVar: "KNOWLEDGE_TEST_TOKEN",
});
const methods = ["create", "update", "read", "delete", "list"] as const;
function invoke(method: typeof methods[number], config: RepoConfig, sourcePath: string) {
  if (method === "read") return adapters.readDocument(config, sourcePath);
  if (method === "list") return adapters.listDocuments(config, sourcePath);
  if (method === "delete") return adapters.deleteDocument(config, { sourcePath, title: "Fixture", sha: "known" });
  return adapters.writeDocument(config, { sourcePath, body: "fixture", title: "Fixture", operation: method, sha: "known" });
}
beforeEach(() => { vi.stubEnv("KNOWLEDGE_TEST_TOKEN", "fixture-only"); vi.stubEnv("NODE_ENV", "test"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe.each(["github_repo", "forgejo_repo"] as const)("%s path confinement", (provider) => {
  it.each(methods)("blocks traversal before any %s request", async (method) => {
    const fetcher = vi.fn(async (_url: unknown) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    for (const path of ["../team-b/new.md", "a/../../outside.md", "./new.md", "a\\..\\outside.md", "%2e%2e/outside.md", "%252e%252e%252foutside.md", "a/\n../outside.md"]) {
      await expect(invoke(method, fixture(provider), path)).rejects.toMatchObject({ code: "knowledge_source_path_invalid", statusCode: 400 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(methods)("preserves nested literal paths for %s", async (method) => {
    const fetcher = vi.fn(async (_url: unknown) => new Response(JSON.stringify(method === "list" ? [] : method === "read" ? {content:"Zml4dHVyZQ==",encoding:"base64"} : { content: { sha: "new" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await invoke(method, fixture(provider), "guides/café #100%.md");
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.pathname).toBe(`${provider === "github_repo" ? "" : "/api/v1"}/repos/team/docs/contents/team-a/guides/caf%C3%A9%20%23100%25.md`);
  });
  it("supports empty root listings and existing root-prefixed normalization", async () => {
    const fetcher = vi.fn(async (_url: unknown) => new Response("[]")); vi.stubGlobal("fetch", fetcher);
    await adapters.listDocuments({ ...fixture(provider), rootPath: "" });
    expect(String(fetcher.mock.calls[0]![0])).toContain("/repos/team/docs/contents/?ref=main");
    expect(normalizeStoredSourcePath(fixture(provider), "/team-a/guides/start.md/")).toBe("guides/start.md");
  });
  it("rejects unsafe roots and provider paths without following them", async () => {
    const fetcher = vi.fn(async (_url: unknown) => new Response("[]"));
    vi.stubGlobal("fetch", fetcher);
    await expect(adapters.listDocuments({ ...fixture(provider), rootPath: "team-a/../team-b" })).rejects.toMatchObject({ code: "knowledge_source_path_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(adapters.readDocument(fixture(provider), `a%${"25".repeat(32_000)}41.md`)).rejects.toMatchObject({ code: "knowledge_source_path_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
    for (const path of ["team-b/file.md", "team-a/../team-b/file.md", "team-a/%2e%2e/file.md"]) {
      fetcher.mockClear();
      fetcher.mockImplementation(async () => new Response(JSON.stringify([{ type: "dir", path }])));
      await expect(adapters.listDocuments(fixture(provider))).rejects.toMatchObject({ code: "knowledge_source_path_invalid" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("recurses within the root and preserves provider-relative listing paths", async () => {
    const fetcher = vi.fn(async (_url: unknown) => new Response("[]"));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify([{ type: "dir", path: "team-a/guides" }])));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify([{ type: "file", path: "team-a/guides/start.md" }])));
    vi.stubGlobal("fetch", fetcher);
    expect(await adapters.listDocuments(fixture(provider))).toMatchObject([{ path: "guides/start.md" }]);
    expect(String(fetcher.mock.calls[1]![0])).toContain("/contents/team-a/guides?ref=main");
  });
});
