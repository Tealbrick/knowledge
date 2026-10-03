import { afterEach, describe, expect, it, vi } from "vitest";
import { listResearchNotebooks, parseResearchNotebookPage } from "./research-notebooks-api";

const notebook = { id: "notebook_1", name: "Evidence", description: "Our sources" };
const page = { provider: "open_notebook", notebooks: [notebook], pagination: { limit: 50, offset: 0, hasMore: false } };
afterEach(() => vi.unstubAllGlobals());

describe("authenticated notebook discovery transport", () => {
  it("uses only the same-origin scoped discovery endpoint with no caller company or bearer", async () => {
    const fetch = vi.fn(async () => Response.json(page)); vi.stubGlobal("fetch", fetch);
    await expect(listResearchNotebooks()).resolves.toMatchObject({ notebooks: [notebook] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/research/engine/notebooks?limit=50&offset=0");
    expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error", method: "GET" });
    expect(init.headers).not.toHaveProperty("authorization");
  });
  it("projects only bounded display fields, not upstream identifiers or credentials", () => {
    expect(parseResearchNotebookPage({ ...page, notebooks: [{ ...notebook, externalNotebookId: "notebook:private", token: "private" }] }, 0).notebooks).toEqual([notebook]);
    expect(parseResearchNotebookPage({ ...page, notebooks: [] }, 0).notebooks).toEqual([]);
  });
  it.each([
    { ...page, provider: "local" },
    { ...page, notebooks: [notebook, notebook] },
    { ...page, notebooks: [{ ...notebook, id: "../../foreign" }] },
    { ...page, notebooks: [{ ...notebook, name: "界".repeat(1400) }] },
    { ...page, notebooks: [{ ...notebook, description: null }] },
    { ...page, pagination: { limit: 10, offset: 0, hasMore: false } },
    { ...page, pagination: { limit: 50, offset: 1, hasMore: false } },
    { ...page, pagination: { limit: 50, offset: 0, hasMore: true } },
  ])("rejects malformed or mismatched pages", value => {
    expect(() => parseResearchNotebookPage(value, 0)).toThrow("invalid_research_response");
  });
  it("does not fetch invalid offsets", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const offset of [-1, 1.5, Infinity, 201]) await expect(listResearchNotebooks(offset)).rejects.toMatchObject({ code: "invalid_research_request" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves auth failure without fallback or automatic retry", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "authentication_required" }, { status: 401 })); vi.stubGlobal("fetch", fetch);
    await expect(listResearchNotebooks()).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
