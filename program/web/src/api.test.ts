import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  api,
  createDocument,
  deleteDocument,
  getBootstrap,
  getBrainEntities,
  getBrainEntity,
  ingestFiles,
  runRepoIngest,
  updateDocument,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("Knowledge browser API", () => {
  it("classifies authorization, conflict, and unavailable responses", async () => {
    for (const status of [401, 403, 409, 503]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ error: `status_${status}` }, { status }),
        ),
      );
      await expect(api("/api/example")).rejects.toMatchObject({
        status,
      } satisfies Partial<ApiError>);
    }
  });

  it("falls back to the legacy redacted status only when bootstrap is absent", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/bootstrap.json"
        ? Response.json({ error: "Not Found" }, { status: 404 })
        : Response.json({
            status: "online",
            subapps: {},
            sidecars: {
              gbrain: { status: "online", configured: true },
              knowledgeDb: { status: "configured" },
              objectStore: { status: "configured" },
            },
            counts: { documents: 12 },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getBootstrap()).resolves.toMatchObject({
      program: { version: "legacy-runtime", status: "online" },
      counts: { documents: 12 },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/bootstrap.json",
      "/api/status",
    ]);
  });

  it("uses only existing create, update, delete, file-ingest, and repository-ingest routes", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json(
        init?.method === "DELETE"
          ? { id: "kdoc_1" }
          : { id: "kdoc_1", status: "completed" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await createDocument("kcol_1", { title: "New document" });
    await updateDocument("kdoc_1", { title: "Updated" });
    await deleteDocument("kdoc_1");
    await runRepoIngest("default", "kcol_1");
    await ingestFiles("default", "kcol_1", [
      new File(["# Fixture"], "fixture.md", { type: "text/markdown" }),
    ]);
    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init?.method]),
    ).toEqual([
      ["/api/knowledge/collections/kcol_1/documents", "POST"],
      ["/api/knowledge/documents/kdoc_1", "PATCH"],
      ["/api/knowledge/documents/kdoc_1", "DELETE"],
      ["/api/companies/default/knowledge/ingest-runs", "POST"],
      ["/api/companies/default/knowledge/ingest-files", "POST"],
    ]);
    expect(fetchMock.mock.calls[4]?.[1]?.headers).not.toHaveProperty(
      "content-type",
    );
  });

  it("keeps Brain list and detail selectors encoded and forwards cancellation", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({
        ok: true,
        status: "ready",
        degradedReason: null,
        entities: [],
        facts: [],
        pendingConsolidationCount: 0,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await getBrainEntities({ limit: 25, offset: 5, kind: "entities", signal: controller.signal });
    await getBrainEntity("people/alice example", {
      depth: 3,
      direction: "both",
      linkType: "works_at",
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/brain/entities?limit=25&offset=5&kind=entities",
      "/api/brain/entities?slug=people%2Falice+example&depth=3&direction=both&linkType=works_at",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ signal: controller.signal });
  });
});
