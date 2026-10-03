import { afterEach, describe, expect, it, vi } from "vitest";
import { getResearchNote, listResearchNotes, parseResearchNotes } from "./research-notes-api";

const envelope = { provider: "open_notebook", contractBaseline: { version: "1.14.0" }, observedVersion: null };
const note = {
  id: "note:alpha",
  title: "Alpha note",
  content: "Plain note content",
  noteType: "human",
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  commandId: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("Research notes transport", () => {
  it("requests only the mapped notebook notes endpoint and projects known fields", async () => {
    const fetch = vi.fn(async () => Response.json({ ...envelope, notes: [{ ...note, upstreamSecret: "must-not-project" }] }));
    vi.stubGlobal("fetch", fetch);
    await expect(listResearchNotes("notebook:alpha")).resolves.toEqual([note]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/research/notebooks/notebook%3Aalpha/engine/notes");
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("accepts an empty notebook and nullable note fields", () => {
    expect(parseResearchNotes({ ...envelope, notes: [] })).toEqual([]);
    expect(parseResearchNotes({ ...envelope, notes: [{ ...note, title: null, content: null, noteType: null, commandId: null }] })).toEqual([
      { ...note, title: null, content: null, noteType: null, commandId: null },
    ]);
  });

  it("fails closed for foreign, malformed, duplicate, and oversized notes", () => {
    const malformedPages = [
      { ...envelope, provider: "local", notes: [note] },
      { ...envelope, contractBaseline: null, notes: [note] },
      { ...envelope, notes: [{ ...note, id: "source:foreign" }] },
      { ...envelope, notes: [{ ...note, id: "note:../foreign" }] },
      { ...envelope, notes: [{ ...note, id: `note:${"x".repeat(129)}` }] },
      { ...envelope, notes: [{ ...note, title: "界".repeat(2049) }] },
      { ...envelope, notes: [{ ...note, content: "界".repeat(262145) }] },
      { ...envelope, notes: [{ ...note, noteType: "x".repeat(129) }] },
      { ...envelope, notes: [{ ...note, created: "x".repeat(129) }] },
      { ...envelope, notes: [{ ...note, updated: "x".repeat(129) }] },
      { ...envelope, notes: [{ ...note, commandId: "x".repeat(257) }] },
      { ...envelope, notes: [{ ...note, created: null }] },
      { ...envelope, notes: [note, note] },
      { ...envelope, notes: Array.from({ length: 501 }, (_, index) => ({ ...note, id: `note:n${index}` })) },
    ];
    for (const page of malformedPages) expect(() => parseResearchNotes(page)).toThrow("invalid_research_response");
  });

  it("does not fetch arbitrary URLs or invalid notebook identifiers", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(listResearchNotes("../foreign")).rejects.toMatchObject({ code: "invalid_research_request" });
    await expect(listResearchNotes("https://evil.example/notebook")).rejects.toMatchObject({ code: "invalid_research_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves authentication failures without fallback or retry", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "authentication_required" }, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(listResearchNotes("notebook:alpha")).rejects.toMatchObject({ status: 401, code: "authentication_required" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("forwards caller cancellation and does not substitute another credential", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: Array<[string, RequestInit]> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(listResearchNotes("notebook:alpha", controller.signal)).rejects.toMatchObject({ code: "research_request_aborted" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls[0]?.[1].headers).not.toHaveProperty("authorization");
  });

  it("requests one encoded note by server-scoped IDs and projects only the note", async () => {
    const fetch = vi.fn(async () => Response.json({ ...envelope, note: { ...note, upstreamSecret: "must-not-project" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(getResearchNote("notebook:alpha", "note:alpha")).resolves.toEqual(note);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/research/notebooks/notebook%3Aalpha/engine/notes/note%3Aalpha");
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(init.headers).not.toHaveProperty("authorization");
    expect(url).not.toContain("companyId");
    expect(url).not.toContain("principalId");
  });

  it("rejects a detail response whose note ID does not match the requested ID", async () => {
    const fetch = vi.fn(async () => Response.json({ ...envelope, note: { ...note, id: "note:other" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(getResearchNote("notebook:alpha", "note:alpha")).rejects.toMatchObject({ code: "invalid_research_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed detail responses and never fetches invalid IDs", async () => {
    const fetch = vi.fn(async () => Response.json({ ...envelope, note: { ...note, content: 42 } }));
    vi.stubGlobal("fetch", fetch);
    await expect(getResearchNote("notebook:alpha", "note:alpha")).rejects.toMatchObject({ code: "invalid_research_response" });
    await expect(getResearchNote("../foreign", "note:alpha")).rejects.toMatchObject({ code: "invalid_research_request" });
    await expect(getResearchNote("notebook:alpha", "source:foreign")).rejects.toMatchObject({ code: "invalid_research_request" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves detail authentication failures and cancellation without fallback", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "authentication_required" }, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(getResearchNote("notebook:alpha", "note:alpha")).rejects.toMatchObject({ status: 401, code: "authentication_required" });
    expect(fetch).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    fetch.mockImplementation(async () => { throw new DOMException("aborted", "AbortError"); });
    await expect(getResearchNote("notebook:alpha", "note:alpha", controller.signal)).rejects.toMatchObject({ code: "research_request_aborted" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
