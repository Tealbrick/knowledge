import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  OPEN_NOTEBOOK_MAX_SOURCE_CONTENT_BYTES,
  OPEN_NOTEBOOK_MAX_SOURCE_TITLE_BYTES,
  OpenNotebookAdapter,
  OpenNotebookAdapterError,
} from "./open-notebook.js";

const TOKEN = "disposable-open-notebook-write-token";
const notebookId = "notebook:alpha";
const source = {
  id: "source:created",
  title: "Disposable source",
  topics: [],
  asset: null,
  full_text: "Disposable source content",
  embedded: false,
  embedded_chunks: 0,
  file_available: null,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  command_id: null,
  status: null,
};

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse, calls: { count: number }) => void | Promise<void>,
  run: (baseUrl: string, calls: { count: number }) => Promise<void>,
): Promise<void> {
  const calls = { count: 0 };
  const server = createServer((request, response) => {
    calls.count += 1;
    void handler(request, response, calls);
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

function adapter(
  baseUrl: string,
  overrides: Partial<ConstructorParameters<typeof OpenNotebookAdapter>[0]> = {},
): OpenNotebookAdapter {
  return new OpenNotebookAdapter({ baseUrl, token: TOKEN, ...overrides });
}

describe("Open Notebook v1.14.0 text-source write adapter", () => {
  it("accepts the same documented byte limits as the durable route ledger", async () => {
    expect(OPEN_NOTEBOOK_MAX_SOURCE_TITLE_BYTES).toBe(4096);
    expect(OPEN_NOTEBOOK_MAX_SOURCE_CONTENT_BYTES).toBe(512 * 1024);
    let calls = 0;
    const client = adapter("http://127.0.0.1:1", { fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      expect(Buffer.byteLength(body.title)).toBe(4096);
      expect(Buffer.byteLength(body.content)).toBe(512 * 1024);
      return new Response(JSON.stringify(source), { headers: { "content-type": "application/json" } });
    } });
    await client.createNotebookTextSource(notebookId, { title: "t".repeat(4096), content: "x".repeat(512 * 1024) });
    expect(calls).toBe(1);
  });
  it("sends exactly one fixed JSON POST and returns the safe source projection", async () => {
    let requestMethod: string | undefined;
    let requestUrl: string | undefined;
    let authorization: string | undefined;
    let contentType: string | undefined;
    let requestBody: unknown;
    await fixture(
      async (request, response) => {
        requestMethod = request.method;
        requestUrl = request.url;
        authorization = request.headers.authorization;
        contentType = request.headers["content-type"];
        requestBody = JSON.parse(await readBody(request));
        json(response, { ...source, future_field: "ignored" });
      },
      async (baseUrl, calls) => {
        await expect(
          adapter(baseUrl).createNotebookTextSource(notebookId, {
            title: "Disposable source",
            content: "Disposable source content",
          }),
        ).resolves.toEqual({
          id: source.id,
          title: source.title,
          topics: [],
          asset: null,
          fullText: source.full_text,
          embedded: false,
          embeddedChunks: 0,
          insightsCount: null,
          fileAvailable: null,
          created: source.created,
          updated: source.updated,
          commandId: null,
          status: null,
        });
        expect(calls.count).toBe(1);
      },
    );
    expect(requestMethod).toBe("POST");
    expect(requestUrl).toBe("/api/sources/json");
    expect(authorization).toBe(`Bearer ${TOKEN}`);
    expect(contentType).toContain("application/json");
    expect(requestBody).toEqual({
      type: "text",
      notebooks: [notebookId],
      content: "Disposable source content",
      title: "Disposable source",
      transformations: [],
      embed: false,
      delete_source: false,
      async_processing: false,
    });
  });

  it("rejects unknown caller fields and invalid bounded input before dispatch", async () => {
    let calls = 0;
    await fixture(
      (_request, response) => {
        calls += 1;
        json(response, source);
      },
      async (baseUrl) => {
        const cases: Array<[string, unknown, string]> = [
          ["hostile notebook ID", "notebook/alpha", "invalid_identifier"],
          ["empty title", { title: "", content: "content" }, "invalid_input"],
          ["empty content", { title: "title", content: "   " }, "invalid_input"],
          [
            "oversized title",
            { title: "x".repeat(OPEN_NOTEBOOK_MAX_SOURCE_TITLE_BYTES + 1), content: "content" },
            "invalid_input",
          ],
          [
            "oversized content",
            { title: "title", content: "x".repeat(OPEN_NOTEBOOK_MAX_SOURCE_CONTENT_BYTES + 1) },
            "invalid_input",
          ],
          [
            "unknown field",
            { title: "title", content: "content", notebooks: ["notebook:other"] },
            "invalid_input",
          ],
        ];
        for (const [_name, request, code] of cases) {
          await expect(
            adapter(baseUrl).createNotebookTextSource(
              _name === "hostile notebook ID" ? "notebook/alpha" : notebookId,
              request as never,
            ),
          ).rejects.toMatchObject({
            code,
            operation: "notebook_source_create",
            disposition: "rejected",
          });
        }
      },
    );
    expect(calls).toBe(0);
  });

  it.each([400, 401, 403, 404, 413, 422])(
    "classifies upstream %s as a rejected write without retrying",
    async (status) => {
      await fixture(
        (_request, response) => json(response, { detail: `rejected ${TOKEN}` }, status),
        async (baseUrl, calls) => {
          const error = await adapter(baseUrl).createNotebookTextSource(notebookId, {
            title: "title",
            content: "content",
          }).catch((value: unknown) => value);
          expect(error).toBeInstanceOf(OpenNotebookAdapterError);
          expect(error).toMatchObject({
            code: "http_error",
            operation: "notebook_source_create",
            status,
            disposition: "rejected",
          });
          expect((error as Error).message).not.toContain(TOKEN);
          expect(calls.count).toBe(1);
        },
      );
    },
  );

  it.each([418, 429, 500, 503])(
    "classifies upstream %s as ambiguous because the write may have occurred",
    async (status) => {
      await fixture(
        (_request, response) => json(response, { detail: `ambiguous ${TOKEN}` }, status),
        async (baseUrl, calls) => {
          await expect(
            adapter(baseUrl).createNotebookTextSource(notebookId, {
              title: "title",
              content: "content",
            }),
          ).rejects.toMatchObject({
            code: "http_error",
            operation: "notebook_source_create",
            status,
            disposition: "ambiguous",
          });
          expect(calls.count).toBe(1);
        },
      );
    },
  );

  it("classifies timeout, oversized, malformed, and unexpected responses as ambiguous", async () => {
    await fixture(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      },
      async (baseUrl) => {
        await expect(
          adapter(baseUrl, { timeoutMs: 50 }).createNotebookTextSource(notebookId, {
            title: "title",
            content: "content",
          }),
        ).rejects.toMatchObject({
          code: "timeout",
          operation: "notebook_source_create",
          disposition: "ambiguous",
        });
      },
    );

    await fixture(
      (_request, response) => {
        json(response, { ...source, padding: "x".repeat(200) });
      },
      async (baseUrl) => {
        await expect(
          adapter(baseUrl, { maxResponseBytes: 64 }).createNotebookTextSource(notebookId, {
            title: "title",
            content: "content",
          }),
        ).rejects.toMatchObject({
          code: "response_too_large",
          operation: "notebook_source_create",
          disposition: "ambiguous",
        });
      },
    );

    await fixture(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("not-json");
      },
      async (baseUrl) => {
        await expect(
          adapter(baseUrl).createNotebookTextSource(notebookId, {
            title: "title",
            content: "content",
          }),
        ).rejects.toMatchObject({
          code: "malformed_response",
          operation: "notebook_source_create",
          disposition: "ambiguous",
        });
      },
    );

    await fixture(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(JSON.stringify(source));
      },
      async (baseUrl) => {
        await expect(
          adapter(baseUrl).createNotebookTextSource(notebookId, {
            title: "title",
            content: "content",
          }),
        ).rejects.toMatchObject({
          code: "unexpected_content_type",
          operation: "notebook_source_create",
          disposition: "ambiguous",
        });
      },
    );
  });

  it("rejects redirects without following or forwarding the token", async () => {
    let redirected = false;
    await fixture(
      (request, response) => {
        if (request.url === "/redirected") {
          redirected = true;
        }
        response.writeHead(307, { location: "/redirected" });
        response.end();
      },
      async (baseUrl, calls) => {
        await expect(
          adapter(baseUrl).createNotebookTextSource(notebookId, {
            title: "title",
            content: "content",
          }),
        ).rejects.toMatchObject({
          code: "unavailable",
          operation: "notebook_source_create",
          disposition: "ambiguous",
        });
        expect(calls.count).toBe(1);
        expect(redirected).toBe(false);
      },
    );
  });

  it("classifies a network failure as ambiguous without returning the secret", async () => {
    const fetchImpl = (async () => {
      throw new Error(`network failure ${TOKEN}`);
    }) as typeof fetch;
    const error = await adapter("http://127.0.0.1:1", { fetchImpl })
      .createNotebookTextSource(notebookId, { title: "title", content: "content" })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(OpenNotebookAdapterError);
    expect(error).toMatchObject({
      code: "unavailable",
      operation: "notebook_source_create",
      disposition: "ambiguous",
    });
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("rejects a response with a non-source ID as an ambiguous malformed write", async () => {
    await fixture(
      (_request, response) => json(response, { ...source, id: "note:wrong-table" }),
      async (baseUrl) => {
        await expect(
          adapter(baseUrl).createNotebookTextSource(notebookId, {
            title: "title",
            content: "content",
          }),
        ).rejects.toMatchObject({
          code: "malformed_response",
          operation: "notebook_source_create",
          disposition: "ambiguous",
        });
      },
    );
  });
});
