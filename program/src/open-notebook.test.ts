import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  OPEN_NOTEBOOK_DEFAULT_MAX_RESPONSE_BYTES,
  OPEN_NOTEBOOK_CONTRACT_BASELINE,
  OPEN_NOTEBOOK_OBSERVED_VERSION,
  OpenNotebookAdapter,
  OpenNotebookAdapterError,
} from "./open-notebook.js";

const TOKEN = "disposable-open-notebook-token";
const notebook = {
  id: "notebook:fixture",
  name: "Fixture notebook",
  description: "Disposable fixture",
  archived: false,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  source_count: 2,
  note_count: 1,
};

const notebookB = {
  id: "notebook:beta",
  name: "Beta notebook",
  description: "Second disposable notebook",
  archived: false,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  source_count: 1,
  note_count: 1,
};

const sourceA = {
  id: "source:alpha",
  title: "Alpha source",
  topics: ["alpha"],
  asset: { file_path: null, url: "https://example.test/alpha" },
  full_text: "Alpha source text",
  embedded: true,
  embedded_chunks: 2,
  insights_count: 1,
  file_available: null,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  command_id: null,
  status: null,
  processing_info: null,
  notebooks: ["notebook:alpha"],
};

const sourceB = {
  ...sourceA,
  id: "source:beta",
  title: "Beta source",
  topics: ["beta"],
  asset: { file_path: null, url: "https://example.test/beta" },
  full_text: "Beta source text",
  notebooks: ["notebook:beta"],
};

const misboundSource = {
  ...sourceA,
  id: "source:misbound",
  title: "Unexpectedly misbound source",
  notebooks: ["notebook:beta"],
};

const noteA = {
  id: "note:alpha",
  title: "Alpha note",
  content: "Alpha note content",
  note_type: "human",
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  command_id: null,
};

const noteB = {
  ...noteA,
  id: "note:beta",
  title: "Beta note",
  content: "Beta note content",
};

const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse, calls: { count: number }) => void,
  run: (baseUrl: string, calls: { count: number }) => Promise<void>,
) {
  const calls = { count: 0 };
  const server = createServer((request, response) => {
    calls.count += 1;
    handler(request, response, calls);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
}

const adapter = (baseUrl: string, overrides: Partial<ConstructorParameters<typeof OpenNotebookAdapter>[0]> = {}) =>
  new OpenNotebookAdapter({ baseUrl, token: TOKEN, ...overrides });

describe("Open Notebook v1.14.0 read-only adapter", () => {
  it("publishes the immutable upstream release/ref and safe defaults", () => {
    expect(OPEN_NOTEBOOK_CONTRACT_BASELINE).toMatchObject({
      repository: "https://github.com/lfnovo/open-notebook",
      release: "v1.14.0",
      commit: "30c7e2a63e43b7f270fc2c638f0b6246934a53f4",
      source: {
        notebooks: "api/routers/notebooks.py",
        sources: "api/routers/sources.py",
        notes: "api/routers/notes.py",
        models: "api/models.py",
      },
    });
    expect(OPEN_NOTEBOOK_OBSERVED_VERSION).toBeNull();
    expect(OPEN_NOTEBOOK_DEFAULT_MAX_RESPONSE_BYTES).toBe(256 * 1024);
  });

  it("reads exact health, capabilities, and notebook-list responses", async () => {
    const seen: string[] = [];
    await fixture(
      (request, response) => {
        seen.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
        if (request.url === "/health") {
          json(response, { status: "healthy" });
        } else if (request.url?.startsWith("/api/capabilities")) {
          json(response, {
            docling_available: false,
            crawl4ai_available: true,
            crawl4ai_remote_configured: false,
          });
        } else {
          json(response, [notebook]);
        }
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).health()).resolves.toMatchObject({
          contractBaseline: OPEN_NOTEBOOK_CONTRACT_BASELINE,
          observedVersion: null,
          status: "healthy",
        });
        await expect(adapter(baseUrl).capabilities()).resolves.toMatchObject({
          doclingAvailable: false,
          crawl4aiAvailable: true,
          crawl4aiRemoteConfigured: false,
        });
        await expect(adapter(baseUrl).listNotebooks({ archived: false })).resolves.toEqual([
          {
            id: notebook.id,
            name: notebook.name,
            description: notebook.description,
            archived: false,
            created: notebook.created,
            updated: notebook.updated,
            sourceCount: 2,
            noteCount: 1,
          },
        ]);
      },
    );
    expect(seen).toEqual([
      `GET /health Bearer ${TOKEN}`,
      `GET /api/capabilities Bearer ${TOKEN}`,
      `GET /api/notebooks?order_by=updated+desc&archived=false Bearer ${TOKEN}`,
    ]);
  });

  it("does not offer unscoped search or ask because the pinned upstream request has no notebook scope", () => {
    expect("search" in OpenNotebookAdapter.prototype).toBe(false);
    expect("ask" in OpenNotebookAdapter.prototype).toBe(false);
    expect("getSource" in OpenNotebookAdapter.prototype).toBe(false);
  });

  it("reads notebook detail, notebook-scoped sources and notes, then source detail after membership", async () => {
    const calls: string[] = [];
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        calls.push(`${request.method} ${url.pathname}${url.search}`);
        if (url.pathname === "/api/notebooks/notebook%3Aalpha") {
          json(response, { ...notebook, id: "notebook:alpha" });
        } else if (url.pathname === "/api/sources") {
          expect(url.searchParams.get("notebook_id")).toBe("notebook:alpha");
          expect(["50", "100"]).toContain(url.searchParams.get("limit"));
          expect(url.searchParams.get("offset")).toBe("0");
          expect(url.searchParams.get("sort_by")).toBe("updated");
          expect(url.searchParams.get("sort_order")).toBe("desc");
          json(response, [{ ...sourceA, future_field: "ignored additive field" }]);
        } else if (url.pathname === "/api/notes") {
          expect(url.searchParams.get("notebook_id")).toBe("notebook:alpha");
          json(response, [{ ...noteA, future_field: "ignored additive field" }]);
        } else if (url.pathname === "/api/sources/source%3Aalpha") {
          json(response, sourceA);
        } else {
          json(response, { error: "unexpected route" }, 404);
        }
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebook("notebook:alpha")).resolves.toMatchObject({
          id: "notebook:alpha",
          name: notebook.name,
        });
        await expect(adapter(baseUrl).listNotebookSources("notebook:alpha")).resolves.toEqual([
          {
            id: sourceA.id,
            title: sourceA.title,
            topics: ["alpha"],
            asset: { filePath: null, url: sourceA.asset.url },
            fullText: null,
            embedded: true,
            embeddedChunks: 2,
            insightsCount: 1,
            fileAvailable: null,
            created: sourceA.created,
            updated: sourceA.updated,
            commandId: null,
            status: null,
          },
        ]);
        await expect(adapter(baseUrl).listNotebookNotes("notebook:alpha")).resolves.toEqual([
          {
            id: noteA.id,
            title: noteA.title,
            content: noteA.content,
            noteType: noteA.note_type,
            created: noteA.created,
            updated: noteA.updated,
            commandId: null,
          },
        ]);
        await expect(adapter(baseUrl).getNotebookSource("notebook:alpha", "source:alpha")).resolves.toMatchObject({
          id: sourceA.id,
          fullText: sourceA.full_text,
          asset: { filePath: null, url: sourceA.asset.url },
        });
      },
    );
    expect(calls).toEqual([
      "GET /api/notebooks/notebook%3Aalpha",
      "GET /api/sources?notebook_id=notebook%3Aalpha&limit=50&offset=0&sort_by=updated&sort_order=desc",
      "GET /api/notes?notebook_id=notebook%3Aalpha",
      "GET /api/sources?notebook_id=notebook%3Aalpha&limit=100&offset=0&sort_by=updated&sort_order=desc",
      "GET /api/sources/source%3Aalpha",
    ]);
  });

  it("rejects notebook detail whose returned ID differs from the mapped ID", async () => {
    await fixture(
      (_request, response) => {
        json(response, notebookB);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebook("notebook:alpha")).rejects.toMatchObject({
          code: "identifier_mismatch",
          operation: "notebook",
        });
      },
    );
  });

  it("rejects source detail whose returned ID differs from the mapped source ID", async () => {
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/sources") {
          json(response, [sourceA]);
        } else if (url.pathname === "/api/sources/source%3Aalpha") {
          json(response, { ...sourceA, id: "source:other", notebooks: ["notebook:alpha"] });
        } else {
          json(response, { error: "unexpected route" }, 404);
        }
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookSource("notebook:alpha", sourceA.id)).rejects.toMatchObject({
          code: "identifier_mismatch",
          operation: "notebook_source",
        });
      },
    );
  });

  it("reads note detail only after notebook membership and rechecks membership before returning content", async () => {
    const calls: string[] = [];
    let membershipReads = 0;
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        calls.push(`${request.method} ${url.pathname}${url.search}`);
        if (url.pathname === "/api/notes" && url.searchParams.get("notebook_id") === "notebook:alpha") {
          membershipReads += 1;
          json(response, [noteA]);
        } else if (url.pathname === "/api/notes/note%3Aalpha") {
          json(response, noteA);
        } else {
          json(response, { error: "unexpected route" }, 404);
        }
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookNote("notebook:alpha", noteA.id)).resolves.toMatchObject({
          id: noteA.id,
          content: noteA.content,
        });
      },
    );
    expect(membershipReads).toBe(2);
    expect(calls).toEqual([
      "GET /api/notes?notebook_id=notebook%3Aalpha",
      "GET /api/notes/note%3Aalpha",
      "GET /api/notes?notebook_id=notebook%3Aalpha",
    ]);
  });

  it("denies an absent note before calling the upstream detail endpoint", async () => {
    let detailCalls = 0;
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/notes") {
          json(response, [noteA]);
        } else if (url.pathname.startsWith("/api/notes/")) {
          detailCalls += 1;
          json(response, noteB);
        } else {
          json(response, { error: "unexpected route" }, 404);
        }
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookNote("notebook:alpha", noteB.id)).rejects.toMatchObject({
          code: "notebook_membership_denied",
          operation: "notebook_note",
        });
      },
    );
    expect(detailCalls).toBe(0);
  });

  it("rejects mismatched note detail IDs and unlink during the final membership recheck", async () => {
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/notes") json(response, [noteA]);
        else if (url.pathname === "/api/notes/note%3Aalpha") json(response, noteB);
        else json(response, { error: "unexpected route" }, 404);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookNote("notebook:alpha", noteA.id)).rejects.toMatchObject({
          code: "identifier_mismatch",
          operation: "notebook_note",
        });
      },
    );

    let membershipReads = 0;
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/notes") {
          membershipReads += 1;
          json(response, membershipReads === 1 ? [noteA] : []);
        } else if (url.pathname === "/api/notes/note%3Aalpha") {
          json(response, noteA);
        } else {
          json(response, { error: "unexpected route" }, 404);
        }
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookNote("notebook:alpha", noteA.id)).rejects.toMatchObject({
          code: "notebook_membership_denied",
          operation: "notebook_note",
        });
      },
    );
    expect(membershipReads).toBe(2);
  });

  it("requires the detail response to include an explicit nullable content field", async () => {
    const { content: _content, ...detailWithoutContent } = noteA;
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/notes") json(response, [noteA]);
        else if (url.pathname === "/api/notes/note%3Aalpha") json(response, detailWithoutContent);
        else json(response, { error: "unexpected route" }, 404);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookNote("notebook:alpha", noteA.id)).rejects.toMatchObject({
          code: "malformed_response",
          operation: "notebook_note",
        });
      },
    );
  });

  it("bounds and validates every note in the membership inventory", async () => {
    await fixture(
      (_request, response) => {
        json(response, Array.from({ length: 501 }, (_, index) => ({ ...noteA, id: `note:${index}` })));
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookNote("notebook:alpha", noteA.id)).rejects.toMatchObject({
          code: "malformed_response",
          operation: "notebook_note",
        });
      },
    );

    await fixture(
      (_request, response) => {
        json(response, [{ ...noteA, id: "source:foreign" }]);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookNote("notebook:alpha", noteA.id)).rejects.toMatchObject({
          code: "malformed_response",
          operation: "notebook_note",
        });
      },
    );
  });

  it("keeps one deadline across membership, detail, and membership recheck", async () => {
    let membershipReads = 0;
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/notes") {
          membershipReads += 1;
          if (membershipReads === 1) json(response, [noteA]);
          else {
            response.writeHead(200, { "content-type": "application/json" });
            response.write("[");
          }
        } else if (url.pathname === "/api/notes/note%3Aalpha") {
          json(response, noteA);
        } else {
          json(response, { error: "unexpected route" }, 404);
        }
      },
      async (baseUrl) => {
        const started = Date.now();
        await expect(adapter(baseUrl, { timeoutMs: 60 }).getNotebookNote("notebook:alpha", noteA.id)).rejects.toMatchObject({
          code: "timeout",
          operation: "notebook_note",
        });
        expect(Date.now() - started).toBeLessThan(250);
      },
    );
    expect(membershipReads).toBe(2);
  });

  it("keeps notebook A and B isolated and denies source membership before source detail", async () => {
    const detailCalls: string[] = [];
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/sources") {
          const notebookId = url.searchParams.get("notebook_id");
          json(response, notebookId === "notebook:alpha" ? [sourceA] : [sourceB]);
        } else if (url.pathname.startsWith("/api/sources/")) {
          detailCalls.push(url.pathname);
          const sourceId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
          json(response, sourceId === sourceB.id ? sourceB : sourceA);
        } else if (url.pathname === "/api/notes") {
          json(response, url.searchParams.get("notebook_id") === "notebook:alpha" ? [noteA] : [noteB]);
        } else {
          json(response, { error: "unexpected route" }, 404);
        }
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).listNotebookSources("notebook:alpha")).resolves.toMatchObject([
          { id: sourceA.id },
        ]);
        await expect(adapter(baseUrl).listNotebookSources("notebook:beta")).resolves.toMatchObject([
          { id: sourceB.id },
        ]);
        await expect(adapter(baseUrl).listNotebookNotes("notebook:alpha")).resolves.toMatchObject([
          { id: noteA.id },
        ]);
        await expect(adapter(baseUrl).listNotebookNotes("notebook:beta")).resolves.toMatchObject([
          { id: noteB.id },
        ]);
        await expect(adapter(baseUrl).getNotebookSource("notebook:alpha", sourceB.id)).rejects.toMatchObject({
          code: "notebook_membership_denied",
          operation: "notebook_source",
        });
        await expect(adapter(baseUrl).getNotebookSource("notebook:beta", sourceB.id)).resolves.toMatchObject({
          id: sourceB.id,
          fullText: sourceB.full_text,
        });
      },
    );
    expect(detailCalls).toEqual(["/api/sources/source%3Abeta"]);
  });

  it("rejects malformed or hostile mapped IDs before any HTTP request", async () => {
    let calls = 0;
    await fixture(
      (_request, response) => {
        calls += 1;
        json(response, []);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebook("../alpha")).rejects.toMatchObject({
          code: "invalid_identifier",
          operation: "notebook",
        });
        await expect(adapter(baseUrl).listNotebookSources("notebook/alpha")).rejects.toMatchObject({
          code: "invalid_identifier",
          operation: "notebook_sources",
        });
        await expect(adapter(baseUrl).getNotebookSource("notebook:alpha", "source?beta")).rejects.toMatchObject({
          code: "invalid_identifier",
          operation: "notebook_source",
        });
        await expect(adapter(baseUrl).getNotebookNote("notebook:alpha", "source:beta")).rejects.toMatchObject({
          code: "invalid_identifier",
          operation: "notebook_note",
        });
        await expect(adapter(baseUrl).getNotebook("a".repeat(129))).rejects.toMatchObject({
          code: "invalid_identifier",
          operation: "notebook",
        });
        await expect(adapter(baseUrl).listNotebookSources("notebook:alpha", null as never)).rejects.toMatchObject({
          code: "invalid_config",
          operation: "notebook_sources",
        });
      },
    );
    expect(calls).toBe(0);
  });

  it("rejects source membership when detail reports an unexpected notebook", async () => {
    let detailCalls = 0;
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/sources") {
          json(response, [misboundSource]);
        } else if (url.pathname === "/api/sources/source%3Amisbound") {
          detailCalls += 1;
          json(response, misboundSource);
        } else {
          json(response, { error: "unexpected route" }, 404);
        }
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookSource("notebook:alpha", misboundSource.id)).rejects.toMatchObject({
          code: "notebook_membership_denied",
          operation: "notebook_source",
        });
      },
    );
    expect(detailCalls).toBe(1);
  });

  it("bounds notebook-scoped source responses before projection", async () => {
    await fixture(
      (_request, response) => {
        json(response, [{ ...sourceA, padding: "x".repeat(400) }]);
      },
      async (baseUrl) => {
        await expect(
          adapter(baseUrl, { maxResponseBytes: 64 }).listNotebookSources("notebook:alpha"),
        ).rejects.toMatchObject({
          code: "response_too_large",
          operation: "notebook_sources",
        });
      },
    );
  });

  it("enforces one total deadline across paged membership and detail", async () => {
    let sourceListCalls = 0;
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...sourceA,
      id: `source:${index}`,
      title: `Source ${index}`,
    }));
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/sources") {
          sourceListCalls += 1;
          if (sourceListCalls === 1) {
            json(response, firstPage);
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.write("[");
          }
          return;
        }
        json(response, { error: "unexpected route" }, 404);
      },
      async (baseUrl) => {
        const started = Date.now();
        await expect(
          adapter(baseUrl, { timeoutMs: 60 }).getNotebookSource("notebook:alpha", "source:missing"),
        ).rejects.toMatchObject({
          code: "timeout",
          operation: "notebook_source",
        });
        expect(Date.now() - started).toBeLessThan(250);
      },
    );
    expect(sourceListCalls).toBe(2);
  });

  it.each([
    ["health", { status: "ready" }],
    ["capabilities", { docling_available: false, crawl4ai_available: false, crawl4ai_remote_configured: false, extra: true }],
    ["notebooks", [{ ...notebook, extra: true }]],
  ])("rejects malformed or unknown %s response fields", async (operation, body) => {
    await fixture(
      (_request, response) => json(response, body),
      async (baseUrl) => {
        const call = operation === "health" ? adapter(baseUrl).health() : operation === "capabilities" ? adapter(baseUrl).capabilities() : adapter(baseUrl).listNotebooks();
        await expect(call).rejects.toMatchObject({ code: "malformed_response", operation });
      },
    );
  });

  it("rejects non-JSON and non-success responses without exposing upstream detail", async () => {
    await fixture(
      (_request, response) => {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`provider secret ${TOKEN}`);
      },
      async (baseUrl) => {
        const error = await adapter(baseUrl).health().catch((value: unknown) => value);
        expect(error).toBeInstanceOf(OpenNotebookAdapterError);
        expect((error as Error).message).not.toContain(TOKEN);
        expect(error).toMatchObject({ code: "http_error", operation: "health", status: 502 });
      },
    );
  });

  it("rejects a successful response with a non-JSON content type", async () => {
    await fixture(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end('{"status":"healthy"}');
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).health()).rejects.toMatchObject({
          code: "unexpected_content_type",
          operation: "health",
        });
      },
    );
  });

  it("cancels a non-success response body instead of buffering it", async () => {
    let canceled = false;
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 503,
        headers: new Headers({ "content-type": "text/plain" }),
        body: {
          cancel: async () => {
            canceled = true;
          },
        },
      }) as unknown as Response) as typeof fetch;
    await expect(adapter("http://127.0.0.1", { fetchImpl }).health()).rejects.toMatchObject({
      code: "http_error",
      operation: "health",
      status: 503,
    });
    expect(canceled).toBe(true);
  });

  it("bounds response bytes before parsing", async () => {
    await fixture(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "healthy", padding: "x".repeat(200) }));
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl, { maxResponseBytes: 32 }).health()).rejects.toMatchObject({
          code: "response_too_large",
          operation: "health",
        });
      },
    );
  });

  it("rejects redirects without following or forwarding the token", async () => {
    let redirected = false;
    await fixture(
      (request, response) => {
        if (request.url === "/redirected") redirected = true;
        response.writeHead(307, { location: "/redirected" });
        response.end();
      },
      async (baseUrl, calls) => {
        await expect(adapter(baseUrl).health()).rejects.toMatchObject({ code: "unavailable" });
        expect(calls.count).toBe(1);
        expect(redirected).toBe(false);
      },
    );
  });

  it("times out a configured peer that never completes and does not fake success", async () => {
    await fixture(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl, { timeoutMs: 50 }).health()).rejects.toMatchObject({
          code: "timeout",
          operation: "health",
        });
      },
    );
  });

  it("rejects invalid config and a down configured peer", async () => {
    expect(() => new OpenNotebookAdapter({ baseUrl: "http://127.0.0.1:1", token: "" })).toThrowError(
      expect.objectContaining({ code: "invalid_config" }),
    );
    expect(() => new OpenNotebookAdapter({ baseUrl: "http://127.0.0.1:1/ignored-prefix", token: TOKEN })).toThrowError(
      expect.objectContaining({ code: "invalid_config" }),
    );
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(
      new OpenNotebookAdapter({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN }).health(),
    ).rejects.toMatchObject({ code: "unavailable", operation: "health" });
  });
});
