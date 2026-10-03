import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { OpenNotebookAdapter } from "./open-notebook.js";

const TOKEN = "disposable-open-notebook-context-token";
const notebookId = "notebook:alpha";

const sourceRecord = (id: string) => ({
  id,
  title: `Title ${id}`,
  topics: [],
  asset: null,
  embedded: false,
  embedded_chunks: 0,
  insights_count: 1,
  file_available: null,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  command_id: null,
  status: null,
});

const noteRecord = (id: string) => ({
  id,
  title: `Title ${id}`,
  content: `Content ${id}`,
  note_type: "human",
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  command_id: null,
});

const contextResponse = (sourceId = "source:alpha", noteId = "note:alpha") => ({
  context: {
    sources: [{
      id: sourceId,
      title: "Alpha source",
      full_text: "Alpha full content",
      insights: [{
        id: "source_insight:alpha",
        source_id: sourceId,
        insight_type: "Summary",
        content: "Alpha insight",
        created: "ignored metadata",
      }],
      raw_provider_metadata: "must not escape",
    }],
    notes: [{
      id: noteId,
      title: "Alpha note",
      content: "Alpha note content",
      note_type: "human",
      raw_provider_metadata: "must not escape",
    }],
    raw_context_metadata: "must not escape",
  },
  token_count: 17,
  char_count: 39,
  raw_response_metadata: "must not escape",
});

const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body);
}

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse, calls: { count: number }) => void | Promise<void>,
  run: (baseUrl: string, calls: { count: number }) => Promise<void>,
) {
  const calls = { count: 0 };
  const server = createServer((request, response) => {
    calls.count += 1;
    void Promise.resolve(handler(request, response, calls)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const adapter = (baseUrl: string, overrides: Partial<ConstructorParameters<typeof OpenNotebookAdapter>[0]> = {}) =>
  new OpenNotebookAdapter({ baseUrl, token: TOKEN, ...overrides });

describe("Open Notebook provider-free notebook context", () => {
  it("enumerates membership, sends fixed full-content config, rechecks membership, and projects safely", async () => {
    const requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];
    await fixture(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        requests.push({ method: request.method ?? "", path: `${url.pathname}${url.search}`, authorization: request.headers.authorization });
        if (url.pathname === "/api/sources") {
          expect(url.searchParams.get("notebook_id")).toBe(notebookId);
          expect(url.searchParams.get("limit")).toBe("100");
          expect(url.searchParams.get("offset")).toBe("0");
          json(response, [sourceRecord("source:alpha")]);
          return;
        }
        if (url.pathname === "/api/notes") {
          expect(url.searchParams.get("notebook_id")).toBe(notebookId);
          json(response, [noteRecord("note:alpha")]);
          return;
        }
        if (url.pathname === "/api/chat/context") {
          expect(request.method).toBe("POST");
          expect(await readBody(request)).toEqual({
            notebook_id: notebookId,
            context_config: {
              sources: { "source:alpha": "full content" },
              notes: { "note:alpha": "full content" },
            },
          });
          json(response, contextResponse());
          return;
        }
        json(response, { error: "unexpected route" }, 404);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookContext(notebookId)).resolves.toEqual({
          sources: [{
            id: "source:alpha",
            title: "Alpha source",
            fullText: "Alpha full content",
            insights: [{ id: "source_insight:alpha", insightType: "Summary", content: "Alpha insight" }],
          }],
          notes: [{ id: "note:alpha", title: "Alpha note", content: "Alpha note content" }],
          tokenCount: 17,
          charCount: 39,
        });
      },
    );
    expect(requests.map((item) => `${item.method} ${item.path}`)).toEqual([
      "GET /api/sources?notebook_id=notebook%3Aalpha&limit=100&offset=0&sort_by=updated&sort_order=desc",
      "GET /api/notes?notebook_id=notebook%3Aalpha",
      "POST /api/chat/context",
      "GET /api/sources?notebook_id=notebook%3Aalpha&limit=100&offset=0&sort_by=updated&sort_order=desc",
      "GET /api/notes?notebook_id=notebook%3Aalpha",
    ]);
    expect(requests.every((item) => item.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("sends explicit empty source and note maps instead of allowing upstream all-item fallback", async () => {
    let postedBody: unknown;
    await fixture(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/sources") return json(response, []);
        if (url.pathname === "/api/notes") return json(response, []);
        if (url.pathname === "/api/chat/context") {
          postedBody = await readBody(request);
          return json(response, { context: { sources: [], notes: [] }, token_count: 0, char_count: 0 });
        }
        return json(response, { error: "unexpected route" }, 404);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookContext(notebookId)).resolves.toEqual({ sources: [], notes: [], tokenCount: 0, charCount: 0 });
      },
    );
    expect(postedBody).toEqual({ notebook_id: notebookId, context_config: { sources: {}, notes: {} } });
  });

  it("rejects hostile mapped IDs before any HTTP request", async () => {
    let calls = 0;
    await fixture(
      (_request, response) => {
        calls += 1;
        json(response, []);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookContext("notebook/../alpha")).rejects.toMatchObject({ code: "invalid_identifier", operation: "notebook_context" });
        await expect(adapter(baseUrl).getNotebookContext("a".repeat(129))).rejects.toMatchObject({ code: "invalid_identifier", operation: "notebook_context" });
      },
    );
    expect(calls).toBe(0);
  });

  it.each([
    ["malformed source full text", { ...contextResponse(), context: { ...contextResponse().context, sources: [{ ...contextResponse().context.sources[0], full_text: 42 }] } }],
    ["malformed note content", { ...contextResponse(), context: { ...contextResponse().context, notes: [{ ...contextResponse().context.notes[0], content: 42 }] } }],
    ["malformed insight", { ...contextResponse(), context: { ...contextResponse().context, sources: [{ ...contextResponse().context.sources[0], insights: [{ id: "source_insight:alpha", insight_type: "Summary", content: null }] }] } }],
  ])("rejects %s types", async (_label, body) => {
    await fixture(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/sources") return json(response, [sourceRecord("source:alpha")]);
        if (url.pathname === "/api/notes") return json(response, [noteRecord("note:alpha")]);
        if (url.pathname === "/api/chat/context") {
          await readBody(request);
          return json(response, body);
        }
        return json(response, { error: "unexpected route" }, 404);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookContext(notebookId)).rejects.toMatchObject({ code: "malformed_response", operation: "notebook_context" });
      },
    );
  });

  it.each([
    ["missing requested source", { ...contextResponse(), context: { ...contextResponse().context, sources: [] } }],
    ["foreign source", contextResponse("source:foreign")],
    ["bare source prefix", contextResponse("source:")],
    ["bare note prefix", contextResponse("source:alpha", "note:")],
    ["duplicate source", { ...contextResponse(), context: { ...contextResponse().context, sources: [...contextResponse().context.sources, ...contextResponse().context.sources] } }],
    ["mismatched insight parent", { ...contextResponse(), context: { ...contextResponse().context, sources: [{ ...contextResponse().context.sources[0], insights: [{ ...contextResponse().context.sources[0].insights[0], source_id: "source:foreign" }] }] } }],
  ])("rejects %s without exposing partial context", async (_label, body) => {
    await fixture(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/sources") return json(response, [sourceRecord("source:alpha")]);
        if (url.pathname === "/api/notes") return json(response, [noteRecord("note:alpha")]);
        if (url.pathname === "/api/chat/context") {
          await readBody(request);
          return json(response, body);
        }
        return json(response, { error: "unexpected route" }, 404);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookContext(notebookId)).rejects.toMatchObject({ code: "incomplete_context", operation: "notebook_context" });
      },
    );
  });

  it("rejects a source inventory above the bounded context limit using one overflow probe", async () => {
    let sourceCalls = 0;
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname !== "/api/sources") return json(response, { error: "unexpected route" }, 404);
        sourceCalls += 1;
        if (sourceCalls === 1) return json(response, Array.from({ length: 100 }, (_, index) => sourceRecord(`source:${index}`)));
        return json(response, [sourceRecord("source:overflow")]);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookContext(notebookId)).rejects.toMatchObject({ code: "context_limit_exceeded", operation: "notebook_context" });
      },
    );
    expect(sourceCalls).toBe(2);
  });

  it("rejects a note inventory above the bounded context limit before POST", async () => {
    let postCalls = 0;
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/sources") return json(response, []);
        if (url.pathname === "/api/notes") return json(response, Array.from({ length: 101 }, (_, index) => noteRecord(`note:${index}`)));
        if (url.pathname === "/api/chat/context") {
          postCalls += 1;
          return json(response, contextResponse());
        }
        return json(response, { error: "unexpected route" }, 404);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookContext(notebookId)).rejects.toMatchObject({ code: "context_limit_exceeded", operation: "notebook_context" });
      },
    );
    expect(postCalls).toBe(0);
  });

  it("rejects membership changes observed after the context POST", async () => {
    let sourceCalls = 0;
    await fixture(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/sources") {
          sourceCalls += 1;
          return json(response, [sourceRecord(sourceCalls <= 1 ? "source:alpha" : "source:beta")]);
        }
        if (url.pathname === "/api/notes") return json(response, [noteRecord("note:alpha")]);
        if (url.pathname === "/api/chat/context") {
          await readBody(request);
          return json(response, contextResponse());
        }
        return json(response, { error: "unexpected route" }, 404);
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).getNotebookContext(notebookId)).rejects.toMatchObject({ code: "context_membership_changed", operation: "notebook_context" });
      },
    );
    expect(sourceCalls).toBe(2);
  });

  it("enforces one total deadline across inventory and context calls", async () => {
    await fixture(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        if (url.pathname === "/api/sources") return json(response, []);
        if (url.pathname === "/api/notes") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write("[");
          return;
        }
        return json(response, contextResponse());
      },
      async (baseUrl) => {
        const started = Date.now();
        await expect(adapter(baseUrl, { timeoutMs: 60 }).getNotebookContext(notebookId)).rejects.toMatchObject({ code: "timeout", operation: "notebook_context" });
        expect(Date.now() - started).toBeLessThan(300);
      },
    );
  });
});
