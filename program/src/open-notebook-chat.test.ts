import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { OpenNotebookContext } from "./open-notebook.js";
import {
  OpenNotebookChatAdapter,
  OpenNotebookChatError,
  type OpenNotebookChatMessage,
} from "./open-notebook-chat.js";

const TOKEN = "disposable-open-notebook-chat-token";
const notebookId = "notebook:alpha";
const sessionId = "chat_session:alpha";
const modelId = "model:local";
const priorMessage: OpenNotebookChatMessage = Object.freeze({ id: "message:old", type: "human", content: "Earlier" });
const session = () => ({
  id: sessionId,
  title: "Research chat",
  notebook_id: notebookId,
  created: "2026-09-06T00:00:00Z",
  updated: "2026-09-06T00:00:00Z",
  message_count: 1,
  model_override: modelId,
  messages: [priorMessage],
});

const context: OpenNotebookContext = Object.freeze({
  sources: [{
    id: "source:alpha",
    title: "Alpha source",
    fullText: "Alpha full text",
    insights: [{ id: "source_insight:alpha", insightType: "Summary", content: "Alpha insight" }],
  }],
  notes: [{ id: "note:alpha", title: "Alpha note", content: "Alpha note content" }],
  tokenCount: 99,
  charCount: 123,
});

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
    });
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
    void Promise.resolve(handler(request, response, calls)).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "fixture failure" }));
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

function adapter(baseUrl: string, overrides: Partial<ConstructorParameters<typeof OpenNotebookChatAdapter>[0]> = {}): OpenNotebookChatAdapter {
  return new OpenNotebookChatAdapter({ baseUrl, token: TOKEN, ...overrides });
}

function defaults(largeContextModel: string | null = modelId, defaultChatModel: string | null = "model:fallback") {
  return { large_context_model: largeContextModel, default_chat_model: defaultChatModel };
}

describe("Open Notebook chat adapter", () => {
  it("sends the exact fixed scoped execute body, projects context, and returns only the new assistant", async () => {
    const requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];
    await fixture(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture");
        requests.push({ method: request.method ?? "", path: url.pathname, authorization: request.headers.authorization });
        if (url.pathname === `/api/chat/sessions/${encodeURIComponent(sessionId)}`) {
          json(response, session());
          return;
        }
        if (url.pathname === "/api/models/defaults") {
          json(response, defaults());
          return;
        }
        if (url.pathname === "/api/chat/execute") {
          expect(request.method).toBe("POST");
          expect(await readBody(request)).toEqual({
            session_id: sessionId,
            message: "What changed?",
            model_override: modelId,
            context: {
              sources: {
                "source:alpha": {
                  id: "source:alpha",
                  title: "Alpha source",
                  full_text: "Alpha full text",
                  insights: [{ id: "source_insight:alpha", insight_type: "Summary", content: "Alpha insight" }],
                },
              },
              notes: { "note:alpha": { id: "note:alpha", title: "Alpha note", content: "Alpha note content" } },
            },
          });
          json(response, {
            session_id: sessionId,
            messages: [priorMessage, { id: "message:new-human", type: "human", content: "What changed?" }, { id: "message:new-ai", type: "ai", content: "A concise answer" }],
          });
          return;
        }
        json(response, { error: "unexpected" }, 404);
      },
      async (baseUrl, calls) => {
        await expect(adapter(baseUrl).executeChatMessage(notebookId, sessionId, {
          message: "What changed?",
          modelId,
          context,
          previousMessages: [priorMessage],
        })).resolves.toEqual({ id: "message:new-ai", type: "ai", content: "A concise answer" });
        expect(calls.count).toBe(3);
      },
    );
    expect(requests).toEqual([
      { method: "GET", path: `/api/chat/sessions/${encodeURIComponent(sessionId)}`, authorization: `Bearer ${TOKEN}` },
      { method: "GET", path: "/api/models/defaults", authorization: `Bearer ${TOKEN}` },
      { method: "POST", path: "/api/chat/execute", authorization: `Bearer ${TOKEN}` },
    ]);
  });

  it("uses default_chat_model when large_context_model is null and creates with a fixed request", async () => {
    let body: unknown;
    await fixture(
      async (request, response) => {
        if (request.url === "/api/models/defaults") {
          json(response, defaults(null, modelId));
          return;
        }
        expect(request.method).toBe("POST");
        body = await readBody(request);
        json(response, { ...session(), messages: undefined, model_override: modelId });
      },
      async (baseUrl, calls) => {
        const created = await adapter(baseUrl).createChatSession(notebookId, { title: "New research", modelId });
        expect(created).toMatchObject({ id: sessionId, notebookId, modelId, messages: [] });
        expect(body).toEqual({ notebook_id: notebookId, title: "New research", model_override: modelId });
        expect(calls.count).toBe(2);
      },
    );
  });

  it("rejects a configured model mismatch before the execute POST", async () => {
    await fixture(
      (request, response) => {
        if (request.url?.includes("/api/chat/sessions/")) return json(response, session());
        if (request.url === "/api/models/defaults") return json(response, defaults("model:other", "model:fallback"));
        return json(response, { error: "execute must not be reached" }, 500);
      },
      async (baseUrl, calls) => {
        await expect(adapter(baseUrl).executeChatMessage(notebookId, sessionId, {
          message: "No call",
          modelId,
          context,
          previousMessages: [priorMessage],
        })).rejects.toMatchObject({ code: "model_policy_mismatch", disposition: "rejected" });
        expect(calls.count).toBe(2);
      },
    );
  });

  it("rejects a shorter upstream history before comparing message entries", async () => {
    await fixture(
      (request, response) => {
        if (request.url?.includes("/api/chat/sessions/")) return json(response, { ...session(), messages: [] });
        return json(response, defaults());
      },
      async (baseUrl, calls) => {
        await expect(adapter(baseUrl).executeChatMessage(notebookId, sessionId, {
          message: "Question", modelId, context, previousMessages: [priorMessage],
        })).rejects.toMatchObject({ code: "message_history_mismatch", disposition: "rejected" });
        expect(calls.count).toBe(1);
      },
    );
  });

  it("keeps a non-mutating GET HTTP failure rejected", async () => {
    await fixture(
      (_request, response) => json(response, { error: "not found" }, 404),
      async (baseUrl) => {
        await expect(adapter(baseUrl).getChatSession(notebookId, sessionId)).rejects.toMatchObject({ code: "http_error", status: 404, disposition: "rejected" });
      },
    );
  });

  it("rejects hostile identifiers and missing explicit model policy without network access", async () => {
    let calls = 0;
    const client = adapter("http://127.0.0.1:1", { fetchImpl: async () => { calls += 1; throw new Error("network must not run"); } });
    await expect(client.getChatSession("notebook:", sessionId)).rejects.toMatchObject({ code: "invalid_identifier", disposition: "rejected" });
    await expect(client.executeChatMessage(notebookId, sessionId, {
      message: "bad context",
      modelId,
      context: { ...context, sources: [{ ...context.sources[0]!, id: "source:" }] },
      previousMessages: [priorMessage],
    })).rejects.toMatchObject({ code: "invalid_input", disposition: "rejected" });
    await expect(client.createChatSession(notebookId, {} as never)).rejects.toMatchObject({ code: "invalid_input", disposition: "rejected" });
    await expect(client.createChatSession(notebookId, { title: "bad", modelId: "provider:model" })).rejects.toMatchObject({ code: "invalid_input", disposition: "rejected" });
    expect(calls).toBe(0);
  });

  it("marks tampered assistant history as ambiguous and never retries the POST", async () => {
    await fixture(
      async (request, response) => {
        if (request.url?.includes("/api/chat/sessions/")) return json(response, session());
        if (request.url === "/api/models/defaults") return json(response, defaults());
        expect(request.url).toBe("/api/chat/execute");
        await readBody(request);
        return json(response, { session_id: sessionId, messages: [
          { ...priorMessage, content: "tampered" },
          { id: "message:new-human", type: "human", content: "Question" },
          { id: "message:new-ai", type: "ai", content: "Answer" },
        ] });
      },
      async (baseUrl, calls) => {
        await expect(adapter(baseUrl).executeChatMessage(notebookId, sessionId, {
          message: "Question", modelId, context, previousMessages: [priorMessage],
        })).rejects.toMatchObject({ code: "message_history_mismatch", disposition: "ambiguous" });
        expect(calls.count).toBe(3);
      },
    );
  });

  it("marks malformed assistant content as ambiguous after a dispatched POST", async () => {
    await fixture(
      async (request, response) => {
        if (request.url?.includes("/api/chat/sessions/")) return json(response, session());
        if (request.url === "/api/models/defaults") return json(response, defaults());
        await readBody(request);
        return json(response, { session_id: sessionId, messages: [priorMessage, { id: "message:new-human", type: "human", content: "Question" }, { id: "message:new-ai", type: "ai", content: 123 }] });
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).executeChatMessage(notebookId, sessionId, {
          message: "Question", modelId, context, previousMessages: [priorMessage],
        })).rejects.toMatchObject({ code: "malformed_response", disposition: "ambiguous" });
      },
    );
  });

  it("marks an oversized response as ambiguous and cancels bounded input", async () => {
    await fixture(
      async (request, response) => {
        if (request.url?.includes("/api/chat/sessions/")) return json(response, session());
        if (request.url === "/api/models/defaults") return json(response, defaults());
        await readBody(request);
        response.writeHead(200, { "content-type": "application/json", connection: "keep-alive", "content-length": "100000" });
        response.end(JSON.stringify({ session_id: sessionId, messages: [priorMessage, { id: "message:new-human", type: "human", content: "Question" }, { id: "message:new-ai", type: "ai", content: "x".repeat(10_000) }] }));
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl, { maxResponseBytes: 512 }).executeChatMessage(notebookId, sessionId, {
          message: "Question", modelId, context, previousMessages: [priorMessage],
        })).rejects.toMatchObject({ code: "response_too_large", disposition: "ambiguous" });
      },
    );
  });

  it("marks a stalled execute response as ambiguous without retry", async () => {
    await fixture(
      async (request, response) => {
        if (request.url?.includes("/api/chat/sessions/")) return json(response, session());
        if (request.url === "/api/models/defaults") return json(response, defaults());
        await readBody(request);
        response.writeHead(200, { "content-type": "application/json", connection: "keep-alive", "content-length": "100000" });
        response.write("{\"session_id\":\"chat_session:alpha\"");
        await new Promise<void>(() => undefined);
      },
      async (baseUrl, calls) => {
        await expect(adapter(baseUrl, { timeoutMs: 40 }).executeChatMessage(notebookId, sessionId, {
          message: "Question", modelId, context, previousMessages: [priorMessage],
        })).rejects.toMatchObject({ code: "timeout", disposition: "ambiguous" });
        expect(calls.count).toBe(3);
      },
    );
  });

  it("marks a created session identifier mismatch ambiguous, while known create rejection is safe", async () => {
    await fixture(
      (request, response) => {
        if (request.url === "/api/models/defaults") return json(response, defaults());
        return json(response, { ...session(), id: "not-a-chat-session" });
      },
      async (baseUrl) => {
        await expect(adapter(baseUrl).createChatSession(notebookId, { title: "New", modelId })).rejects.toMatchObject({ code: "session_identifier_mismatch", disposition: "ambiguous" });
      },
    );
    await fixture(
      (_request, response) => json(response, { error: "invalid model" }, 422),
      async (baseUrl) => {
        await expect(adapter(baseUrl, { fetchImpl: async (url, init) => {
          if (String(url).endsWith("/api/models/defaults")) return new Response(JSON.stringify(defaults()), { headers: { "content-type": "application/json" } });
          return fetch(url, init);
        } }).createChatSession(notebookId, { title: "New", modelId })).rejects.toMatchObject({ code: "http_error", status: 422, disposition: "rejected" });
      },
    );
  });

  it("does not leak the bearer token in typed failures", async () => {
    const client = adapter("http://127.0.0.1:1", { fetchImpl: async () => { throw new Error(`secret ${TOKEN}`); } });
    const error = await client.getChatSession(notebookId, sessionId).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(OpenNotebookChatError);
    expect(String(error)).not.toContain(TOKEN);
  });
});
