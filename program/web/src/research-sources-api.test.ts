import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getResearchSource,
  listResearchSources,
  parseResearchSourceDetail,
  parseResearchSourcePage,
} from "./research-sources-api";

const envelope = { provider: "open_notebook", contractBaseline: { version: "1.14.0" }, observedVersion: null };
const source = {
  id: "source:alpha",
  title: "Alpha source",
  topics: ["research"],
  asset: { url: null },
  embedded: true,
  embeddedChunks: 2,
  insightsCount: 1,
  fileAvailable: true,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  commandId: null,
  status: "completed",
};

afterEach(() => vi.unstubAllGlobals());

describe("Research source transport", () => {
  it("requests only the mapped engine inventory and projects a bounded page", async () => {
    const fetch = vi.fn(async () => Response.json({ ...envelope, sources: [source], pagination: { limit: 50, offset: 0 } }));
    vi.stubGlobal("fetch", fetch);
    await expect(listResearchSources("notebook-a")).resolves.toMatchObject({ sources: [{ id: "source:alpha" }], pagination: { limit: 50, offset: 0 } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/research/notebooks/notebook-a/engine/sources?limit=50&offset=0");
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", redirect: "error" });
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("reads full source text through the encoded mapped detail route", async () => {
    const fetch = vi.fn(async () => Response.json({ ...envelope, source: { ...source, fullText: "Plain source text" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(getResearchSource("notebook-a", "source:alpha")).resolves.toMatchObject({ id: "source:alpha", fullText: "Plain source text" });
    const firstCall = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe("/api/research/notebooks/notebook-a/engine/sources/source%3Aalpha");
  });

  it("fails closed for foreign, mismatched, and malformed projections", () => {
    expect(() => parseResearchSourcePage({ ...envelope, sources: [{ ...source, id: "notebook:foreign" }], pagination: { limit: 50, offset: 0 } }, { limit: 50, offset: 0 })).toThrow("invalid_research_response");
    expect(() => parseResearchSourceDetail({ ...envelope, source: { ...source, id: "source:foreign", fullText: "wrong" } }, "source:alpha")).toThrow("invalid_research_response");
    expect(() => parseResearchSourcePage({ ...envelope, sources: [source], pagination: { limit: 20, offset: 0 } }, { limit: 50, offset: 0 })).toThrow("invalid_research_response");
    expect(() => parseResearchSourcePage({ ...envelope, sources: [source, source], pagination: { limit: 50, offset: 0 } }, { limit: 50, offset: 0 })).toThrow("invalid_research_response");
    expect(() => parseResearchSourceDetail({ ...envelope, source: { ...source, fullText: 42 } }, "source:alpha")).toThrow("invalid_research_response");
  });

  it("never fetches arbitrary URLs or unbounded identifiers", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(listResearchSources("../foreign")).rejects.toMatchObject({ code: "invalid_research_request" });
    await expect(getResearchSource("notebook-a", "https://evil.example/source")).rejects.toMatchObject({ code: "invalid_research_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves server authentication failures without fallback or retry", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "authentication_required" }, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(listResearchSources("notebook-a")).rejects.toMatchObject({ status: 401, code: "authentication_required" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
