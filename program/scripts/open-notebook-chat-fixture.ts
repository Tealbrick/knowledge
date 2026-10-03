/**
 * Disposable OpenAI-compatible chat provider for the pinned Open Notebook
 * runtime fixture.
 *
 * This helper is deliberately opt-in. It starts a loopback-only provider,
 * creates one credential and one language model through Open Notebook's normal
 * authenticated APIs, and removes only those records on close(). It never
 * writes a provider payload or credential to disk and never logs a secret.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const ENABLED_FIXTURE_FLAG = "disposable";
const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const SERVER_CLOSE_TIMEOUT_MS = 5_000;
const PROVIDER_PATH = "/v1/chat/completions";
const MODEL_NAME = "knowledge-disposable-chat-fixture";
const CREDENTIAL_NAME = "knowledge-disposable-openai-compatible";
const SUCCESS_MARKER = "KNOWLEDGE_FAKE_CHAT_OK";
const CONTEXT_MARKER = "KNOWLEDGE_CONTEXT_MARKER";

export type ChatFixtureFailureMode = "none" | "reject" | "disconnect";

export type SafeProviderMessage = {
  readonly role: string;
  readonly content?: unknown;
};

export type SafeProviderCall = {
  readonly model: string;
  readonly messages?: readonly SafeProviderMessage[];
};

export type ChatModelFixture = {
  readonly modelId: string;
  readonly providerCalls: SafeProviderCall[];
  readonly setFailureMode: (mode: ChatFixtureFailureMode) => void;
  readonly close: () => Promise<void>;
};

type JsonObject = Record<string, unknown>;

class FixtureError extends Error {
  constructor(readonly code: "configuration" | "request" | "response" | "cleanup", message: string) {
    super(message);
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredFixtureFlag(): void {
  if (process.env.KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE !== ENABLED_FIXTURE_FLAG) {
    throw new FixtureError(
      "configuration",
      "KNOWLEDGE_OPEN_NOTEBOOK_FIXTURE=disposable is required for the Open Notebook chat fixture",
    );
  }
}

function loopbackBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new FixtureError("configuration", "Open Notebook URL must be a valid loopback HTTP URL");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (
    !loopback ||
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new FixtureError(
      "configuration",
      "Open Notebook URL must be a loopback HTTP origin without credentials, path, query, or fragment",
    );
  }
  return parsed.toString().replace(/\/$/u, "");
}

function requiredToken(raw: string): string {
  const token = raw.trim();
  if (!token) throw new FixtureError("configuration", "Open Notebook fixture token is required");
  return token;
}

function sendJson(response: ServerResponse, status: number, body: JsonObject): void {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", Buffer.byteLength(encoded));
  response.end(encoded);
}

function sendProviderError(response: ServerResponse): void {
  sendJson(response, 400, {
    error: {
      message: "disposable fixture rejection",
      type: "invalid_request_error",
      code: "fixture_reject",
    },
  });
}

function readBoundedJson(request: IncomingMessage, response: ServerResponse): Promise<unknown | null> {
  const contentLength = Number(request.headers["content-length"] ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    request.resume();
    sendJson(response, 413, { error: { message: "request body too large", type: "invalid_request_error" } });
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => {
      if (tooLarge) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        sendJson(response, 413, { error: { message: "request body too large", type: "invalid_request_error" } });
        request.resume();
        return;
      }
      chunks.push(bytes);
    });
    request.once("error", reject);
    request.once("end", () => {
      if (tooLarge) {
        resolve(null);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        reject(new FixtureError("request", "provider request body was empty"));
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new FixtureError("request", "provider request body was not JSON"));
      }
    });
  });
}

function safeMessages(value: unknown): readonly SafeProviderMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isObject).map((message) => ({
    role: typeof message.role === "string" ? message.role : "unknown",
    ...(Object.hasOwn(message, "content") ? { content: message.content } : {}),
  }));
}

function responseContainsMarker(value: unknown, marker: string): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) return value.some((item) => responseContainsMarker(item, marker));
  if (isObject(value)) return Object.values(value).some((item) => responseContainsMarker(item, marker));
  return false;
}

function sendChatCompletion(response: ServerResponse, model: string, includeContextMarker: boolean): void {
  const content = includeContextMarker ? `${SUCCESS_MARKER} ${CONTEXT_MARKER}` : SUCCESS_MARKER;
  sendJson(response, 200, {
    id: `chatcmpl-${randomBytes(8).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new FixtureError("request", "provider fixture did not expose an ephemeral port");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          server.closeAllConnections?.();
          server.closeIdleConnections?.();
          reject(new FixtureError("cleanup", `provider fixture close exceeded ${SERVER_CLOSE_TIMEOUT_MS}ms`));
        }, SERVER_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new FixtureError("response", "Open Notebook response exceeded the bounded fixture limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new FixtureError("response", "Open Notebook response exceeded the bounded fixture limit");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FixtureError("response", "Open Notebook response was not JSON");
  }
}

async function upstreamRequest(
  baseUrl: string,
  token: string,
  route: string,
  method: "POST" | "DELETE",
  body?: JsonObject,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new FixtureError("request", `Open Notebook ${method} ${route} request failed`);
    }
    const parsed = await readResponseBody(response);
    if (!response.ok) throw new FixtureError("request", `Open Notebook ${method} ${route} returned HTTP ${response.status}`);
    return parsed;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function responseId(value: unknown, name: string, prefix: "credential:" | "model:"): string {
  if (!isObject(value) || typeof value.id !== "string" || !value.id.startsWith(prefix)) {
    throw new FixtureError("response", `${name} response omitted its id`);
  }
  return value.id;
}

async function deleteKnown(baseUrl: string, token: string, route: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${route}`, {
        method: "DELETE",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new FixtureError("cleanup", `Open Notebook cleanup request failed for ${route}`);
    }
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok && response.status !== 404) {
      throw new FixtureError("cleanup", `Open Notebook cleanup returned HTTP ${response.status} for ${route}`);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function startChatModelFixture(upstreamUrl: string, upstreamToken: string): Promise<ChatModelFixture> {
  requiredFixtureFlag();
  const baseUrl = loopbackBaseUrl(upstreamUrl);
  const token = requiredToken(upstreamToken);
  const providerToken = `knowledge-fixture-${randomBytes(24).toString("hex")}`;
  const providerCalls: SafeProviderCall[] = [];
  let failureMode: ChatFixtureFailureMode = "none";
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url?.split("?", 1)[0] !== PROVIDER_PATH) {
      sendJson(response, 404, { error: { message: "fixture route not found", type: "invalid_request_error" } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${providerToken}`) {
      sendJson(response, 401, { error: { message: "fixture authorization failed", type: "authentication_error" } });
      return;
    }
    try {
      const body = await readBoundedJson(request, response);
      if (body === null) return;
      if (!isObject(body) || typeof body.model !== "string" || !body.model.trim()) {
        sendJson(response, 400, { error: { message: "model is required", type: "invalid_request_error" } });
        return;
      }
      const messages = safeMessages(body.messages);
      providerCalls.push({ model: body.model, ...(messages ? { messages } : {}) });
      if (failureMode === "reject") {
        sendProviderError(response);
        return;
      }
      if (failureMode === "disconnect") {
        response.destroy();
        return;
      }
      sendChatCompletion(response, body.model, responseContainsMarker(messages, CONTEXT_MARKER));
    } catch {
      if (!response.writableEnded && !response.destroyed) {
        sendJson(response, 400, { error: { message: "invalid fixture request", type: "invalid_request_error" } });
      }
    }
  });

  let credentialId: string | null = null;
  let modelId: string | null = null;
  let closePromise: Promise<void> | null = null;
  const port = await listen(server).catch(async (error) => {
    await closeServer(server).catch(() => undefined);
    throw error;
  });
  const providerBaseUrl = `http://127.0.0.1:${port}/v1`;

  const cleanup = async (): Promise<void> => {
    const errors: unknown[] = [];
    if (modelId) {
      try {
        await deleteKnown(baseUrl, token, `/api/models/${encodeURIComponent(modelId)}`);
      } catch (error) {
        errors.push(error);
      }
    }
    if (credentialId) {
      try {
        await deleteKnown(baseUrl, token, `/api/credentials/${encodeURIComponent(credentialId)}`);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await closeServer(server);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Open Notebook fixture cleanup failed");
  };

  try {
    const credential = await upstreamRequest(baseUrl, token, "/api/credentials", "POST", {
      name: CREDENTIAL_NAME,
      provider: "openai_compatible",
      modalities: ["language"],
      api_key: providerToken,
      base_url: providerBaseUrl,
    });
    credentialId = responseId(credential, "credential", "credential:");
    const model = await upstreamRequest(baseUrl, token, "/api/models", "POST", {
      name: MODEL_NAME,
      provider: "openai_compatible",
      type: "language",
      credential: credentialId,
    });
    modelId = responseId(model, "model", "model:");
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Open Notebook fixture setup and cleanup both failed");
    }
    throw error;
  }

  return {
    modelId: modelId!,
    providerCalls,
    setFailureMode: (mode) => {
      failureMode = mode;
    },
    close: () => closePromise ??= cleanup(),
  };
}
