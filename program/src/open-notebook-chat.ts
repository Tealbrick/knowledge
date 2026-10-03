import type { OpenNotebookContext } from "./open-notebook.js";

const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_BYTES = 4 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_HISTORY_ITEMS = 200;
const MAX_HISTORY_BYTES = 512 * 1024;
const MAX_CONTEXT_BYTES = 512 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export type OpenNotebookChatAdapterConfig = Readonly<{
  /** Explicit server-side base URL. Browser-controlled URLs are not accepted. */
  readonly baseUrl: string;
  /** Explicit server-side credential. Never returned in errors or results. */
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
}>;

export type OpenNotebookChatMessage = Readonly<{
  readonly id: string;
  readonly type: "human" | "ai";
  readonly content: string;
}>;

export type OpenNotebookChatAnswer = Readonly<{
  readonly id: string;
  readonly type: "ai";
  readonly content: string;
}>;

export type OpenNotebookChatSession = Readonly<{
  readonly id: string;
  readonly title: string;
  readonly notebookId: string;
  readonly modelId: string | null;
  readonly created: string;
  readonly updated: string;
  readonly messages: readonly OpenNotebookChatMessage[];
}>;

export type OpenNotebookChatSessionCreateRequest = Readonly<{
  readonly title?: string;
  /** Server policy must be explicit; null/omission is not a valid app request. */
  readonly modelId: string;
}>;

export type OpenNotebookChatExecuteRequest = Readonly<{
  readonly message: string;
  /** Server policy must be explicit; null/omission is not a valid app request. */
  readonly modelId: string;
  readonly context: OpenNotebookContext;
  readonly previousMessages: readonly OpenNotebookChatMessage[];
}>;

export type OpenNotebookChatErrorCode =
  | "invalid_config"
  | "invalid_identifier"
  | "invalid_input"
  | "unavailable"
  | "timeout"
  | "http_error"
  | "unexpected_content_type"
  | "malformed_response"
  | "response_too_large"
  | "model_policy_mismatch"
  | "session_notebook_mismatch"
  | "session_identifier_mismatch"
  | "message_history_mismatch"
  | "response_mismatch";

export type OpenNotebookChatErrorDisposition = "rejected" | "ambiguous";

export class OpenNotebookChatError extends Error {
  readonly name = "OpenNotebookChatError";

  constructor(
    readonly code: OpenNotebookChatErrorCode,
    readonly operation: "models_defaults" | "session_create" | "session_get" | "execute",
    readonly disposition: OpenNotebookChatErrorDisposition,
    readonly status?: number,
  ) {
    super(`Open Notebook chat ${operation} ${code}`);
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function requiredString(value: JsonObject, key: string, operation: OpenNotebookChatError["operation"]): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new OpenNotebookChatError("malformed_response", operation, "rejected");
  }
  return field;
}

function nullableString(value: JsonObject, key: string, operation: OpenNotebookChatError["operation"]): string | null {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new OpenNotebookChatError("malformed_response", operation, "rejected");
  }
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string") {
    throw new OpenNotebookChatError("malformed_response", operation, "rejected");
  }
  return field;
}

function validateIdentifier(value: unknown, prefix: "notebook:" | "chat_session:" | "model:", operation: OpenNotebookChatError["operation"]): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value) || !value.startsWith(prefix) || value.length <= prefix.length) {
    throw new OpenNotebookChatError("invalid_identifier", operation, "rejected");
  }
  return value;
}

function validateMessageId(value: unknown, operation: OpenNotebookChatError["operation"]): string {
  if (typeof value !== "string" || value.length === 0 || bytes(value) > 4096) {
    throw new OpenNotebookChatError("malformed_response", operation, "rejected");
  }
  return value;
}

function validateChatInput(value: unknown, operation: "session_create" | "execute"): void {
  if (!isObject(value)) throw new OpenNotebookChatError("invalid_input", operation, "rejected");
}

function validateModelId(value: unknown, operation: "session_create" | "execute"): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !ID_PATTERN.test(value) || !value.startsWith("model:") || value.length <= "model:".length) {
    throw new OpenNotebookChatError("invalid_input", operation, "rejected");
  }
  return value;
}

function parseMessage(value: unknown, operation: OpenNotebookChatError["operation"]): OpenNotebookChatMessage {
  if (!isObject(value)) throw new OpenNotebookChatError("malformed_response", operation, "rejected");
  const id = validateMessageId(value.id, operation);
  const type = value.type;
  if (type !== "human" && type !== "ai") throw new OpenNotebookChatError("malformed_response", operation, "rejected");
  const content = value.content;
  if (typeof content !== "string" || bytes(content) > MAX_ANSWER_BYTES) {
    throw new OpenNotebookChatError("malformed_response", operation, "rejected");
  }
  return Object.freeze({ id, type, content });
}

function parseDefaults(value: unknown): { readonly effectiveModelId: string | null } {
  if (!isObject(value)) throw new OpenNotebookChatError("malformed_response", "models_defaults", "rejected");
  const large = nullableString(value, "large_context_model", "models_defaults");
  const chat = nullableString(value, "default_chat_model", "models_defaults");
  return { effectiveModelId: large?.trim() ? large : chat?.trim() ? chat : null };
}

function parseSession(value: unknown, expectedNotebookId: string, expectedSessionId?: string): OpenNotebookChatSession {
  if (!isObject(value)) throw new OpenNotebookChatError("malformed_response", "session_get", "rejected");
  const id = requiredString(value, "id", "session_get");
  if (!id.startsWith("chat_session:") || id.length <= "chat_session:".length || !ID_PATTERN.test(id)) {
    throw new OpenNotebookChatError("session_identifier_mismatch", "session_get", "rejected");
  }
  if (expectedSessionId !== undefined && id !== expectedSessionId) {
    throw new OpenNotebookChatError("session_identifier_mismatch", "session_get", "rejected");
  }
  const notebookId = requiredString(value, "notebook_id", "session_get");
  if (notebookId !== expectedNotebookId) {
    throw new OpenNotebookChatError("session_notebook_mismatch", "session_get", "rejected");
  }
  const title = requiredString(value, "title", "session_get");
  const modelId = nullableString(value, "model_override", "session_get");
  const created = requiredString(value, "created", "session_get");
  const updated = requiredString(value, "updated", "session_get");
  if (!Array.isArray(value.messages) || value.messages.length > MAX_HISTORY_ITEMS) {
    throw new OpenNotebookChatError("malformed_response", "session_get", "rejected");
  }
  const messages = Object.freeze(value.messages.map((item) => parseMessage(item, "session_get")));
  if (bytes(JSON.stringify(messages)) > MAX_HISTORY_BYTES) {
    throw new OpenNotebookChatError("malformed_response", "session_get", "rejected");
  }
  return Object.freeze({ id, title, notebookId, modelId, created, updated, messages });
}

function parseCreatedSession(value: unknown, expectedNotebookId: string, expectedModelId: string | null | undefined): OpenNotebookChatSession {
  if (!isObject(value)) throw new OpenNotebookChatError("malformed_response", "session_create", "rejected");
  const id = requiredString(value, "id", "session_create");
  if (!id.startsWith("chat_session:") || id.length <= "chat_session:".length || !ID_PATTERN.test(id)) {
    throw new OpenNotebookChatError("session_identifier_mismatch", "session_create", "rejected");
  }
  const notebookId = requiredString(value, "notebook_id", "session_create");
  if (notebookId !== expectedNotebookId) throw new OpenNotebookChatError("session_notebook_mismatch", "session_create", "rejected");
  const title = requiredString(value, "title", "session_create");
  const modelId = nullableString(value, "model_override", "session_create");
  if (expectedModelId !== undefined && modelId !== expectedModelId) {
    throw new OpenNotebookChatError("model_policy_mismatch", "session_create", "rejected");
  }
  const created = requiredString(value, "created", "session_create");
  const updated = requiredString(value, "updated", "session_create");
  return Object.freeze({ id, title, notebookId, modelId, created, updated, messages: Object.freeze([]) });
}

function contextBody(context: OpenNotebookContext): JsonObject {
  if (!context || typeof context !== "object" || !Array.isArray(context.sources) || !Array.isArray(context.notes)) {
    throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
  }
  const sourceIds = new Set<string>();
  const sources: Record<string, unknown> = {};
  for (const source of context.sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    const value = source as Record<string, unknown>;
    if (typeof value.id !== "string" || !ID_PATTERN.test(value.id) || !value.id.startsWith("source:") || value.id.length <= "source:".length) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    const sourceId = value.id;
    if (sourceIds.has(sourceId)) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    sourceIds.add(sourceId);
    if ((value.title !== null && typeof value.title !== "string") || (value.fullText !== null && typeof value.fullText !== "string") || !Array.isArray(value.insights)) {
      throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    }
    const insights: unknown[] = [];
    const insightIds = new Set<string>();
    for (const insight of value.insights) {
      if (!insight || typeof insight !== "object" || Array.isArray(insight)) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
      const item = insight as Record<string, unknown>;
      if (typeof item.id !== "string" || !ID_PATTERN.test(item.id) || !item.id || insightIds.has(item.id) || typeof item.insightType !== "string" || typeof item.content !== "string") {
        throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
      }
      insightIds.add(item.id);
      insights.push({ id: item.id, insight_type: item.insightType, content: item.content });
    }
    sources[sourceId] = { id: sourceId, title: value.title, full_text: value.fullText, insights };
  }
  const noteIds = new Set<string>();
  const notes: Record<string, unknown> = {};
  for (const note of context.notes) {
    if (!note || typeof note !== "object" || Array.isArray(note)) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    const value = note as Record<string, unknown>;
    if (typeof value.id !== "string" || !ID_PATTERN.test(value.id) || !value.id.startsWith("note:") || value.id.length <= "note:".length || noteIds.has(value.id)) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    if ((value.title !== null && typeof value.title !== "string") || (value.content !== null && typeof value.content !== "string")) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    noteIds.add(value.id);
    notes[value.id] = { id: value.id, title: value.title, content: value.content };
  }
  const body = { sources, notes };
  if (bytes(JSON.stringify(body)) > MAX_CONTEXT_BYTES) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
  return body;
}

function validateHistory(messages: unknown, operation: "execute"): readonly OpenNotebookChatMessage[] {
  if (!Array.isArray(messages) || messages.length > MAX_HISTORY_ITEMS) throw new OpenNotebookChatError("invalid_input", operation, "rejected");
  const parsed = Object.freeze(messages.map((message) => parseMessage(message, operation)));
  if (bytes(JSON.stringify(parsed)) > MAX_HISTORY_BYTES) throw new OpenNotebookChatError("invalid_input", operation, "rejected");
  return parsed;
}

function sameMessage(left: OpenNotebookChatMessage, right: OpenNotebookChatMessage): boolean {
  return left.id === right.id && left.type === right.type && left.content === right.content;
}

function remainingMs(deadline: number, operation: OpenNotebookChatError["operation"], disposition: OpenNotebookChatErrorDisposition): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new OpenNotebookChatError("timeout", operation, disposition);
  return remaining;
}

async function cancelResponse(response: Response | undefined): Promise<void> {
  await response?.body?.cancel().catch(() => undefined);
}

function jsonContent(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

async function readBoundedJson(response: Response, operation: OpenNotebookChatError["operation"], maxBytes: number): Promise<unknown> {
  if (!response.body) throw new OpenNotebookChatError("malformed_response", operation, "rejected");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new OpenNotebookChatError("response_too_large", operation, "rejected");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytesValue = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytesValue.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytesValue)) as unknown;
  } catch {
    throw new OpenNotebookChatError("malformed_response", operation, "rejected");
  }
}

export class OpenNotebookChatAdapter {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenNotebookChatAdapterConfig) {
    if (!config || typeof config !== "object" || typeof config.baseUrl !== "string" || typeof config.token !== "string" || !config.token.trim()) {
      throw new OpenNotebookChatError("invalid_config", "models_defaults", "rejected");
    }
    let baseUrl: URL;
    try { baseUrl = new URL(config.baseUrl); } catch { throw new OpenNotebookChatError("invalid_config", "models_defaults", "rejected"); }
    if (! ["http:", "https:"].includes(baseUrl.protocol) || baseUrl.pathname !== "/" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || (config.fetchImpl !== undefined && typeof config.fetchImpl !== "function")) {
      throw new OpenNotebookChatError("invalid_config", "models_defaults", "rejected");
    }
    const timeoutMs = config.timeoutMs ?? 3_000;
    const maxResponseBytes = config.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
      throw new OpenNotebookChatError("invalid_config", "models_defaults", "rejected");
    }
    this.baseUrl = baseUrl;
    this.token = config.token;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async createChatSession(notebookId: string, request: OpenNotebookChatSessionCreateRequest): Promise<OpenNotebookChatSession> {
    const validatedNotebookId = validateIdentifier(notebookId, "notebook:", "session_create");
    validateChatInput(request, "session_create");
    if (Object.keys(request).some((key) => !["title", "modelId"].includes(key))) throw new OpenNotebookChatError("invalid_input", "session_create", "rejected");
    const title = request.title;
    if (title !== undefined && (typeof title !== "string" || !title.trim() || bytes(title) > MAX_TITLE_BYTES)) throw new OpenNotebookChatError("invalid_input", "session_create", "rejected");
    const modelId = validateModelId(request.modelId, "session_create");
    if (modelId === undefined || modelId === null) throw new OpenNotebookChatError("invalid_input", "session_create", "rejected");
    const deadline = Date.now() + this.timeoutMs;
    if (modelId) await this.assertModelPolicy(modelId, remainingMs(deadline, "session_create", "rejected"));
    const body: JsonObject = { notebook_id: validatedNotebookId };
    if (title !== undefined) body.title = title;
    body.model_override = modelId;
    return this.requestJson("session_create", "/api/chat/sessions", {
      method: "POST", body: JSON.stringify(body), timeoutMs: remainingMs(deadline, "session_create", "ambiguous"), parse: (value) => parseCreatedSession(value, validatedNotebookId, modelId),
    });
  }

  async getChatSession(notebookId: string, externalSessionId: string): Promise<OpenNotebookChatSession> {
    const validatedNotebookId = validateIdentifier(notebookId, "notebook:", "session_get");
    const validatedSessionId = validateIdentifier(externalSessionId, "chat_session:", "session_get");
    return this.getChatSessionWithTimeout(validatedNotebookId, validatedSessionId, this.timeoutMs);
  }

  async executeChatMessage(notebookId: string, sessionId: string, request: OpenNotebookChatExecuteRequest): Promise<OpenNotebookChatAnswer> {
    const validatedNotebookId = validateIdentifier(notebookId, "notebook:", "execute");
    const validatedSessionId = validateIdentifier(sessionId, "chat_session:", "execute");
    const deadline = Date.now() + this.timeoutMs;
    validateChatInput(request, "execute");
    if (Object.keys(request).some((key) => !["message", "modelId", "context", "previousMessages"].includes(key))) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    if (typeof request.message !== "string" || !request.message.trim() || bytes(request.message) > MAX_MESSAGE_BYTES) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    const modelId = validateModelId(request.modelId, "execute");
    if (modelId === undefined || modelId === null) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    const previousMessages = validateHistory(request.previousMessages, "execute");
    const historyBytes = bytes(JSON.stringify([...previousMessages, { type: "human", content: request.message }]));
    if (historyBytes > MAX_HISTORY_BYTES) throw new OpenNotebookChatError("invalid_input", "execute", "rejected");
    const context = contextBody(request.context);
    const session = await this.getChatSessionWithTimeout(validatedNotebookId, validatedSessionId, remainingMs(deadline, "execute", "rejected"));
    if (previousMessages.length !== session.messages.length || !previousMessages.every((message, index) => sameMessage(message, session.messages[index]!))) {
      throw new OpenNotebookChatError("message_history_mismatch", "execute", "rejected");
    }
    if (session.modelId !== modelId) throw new OpenNotebookChatError("model_policy_mismatch", "execute", "rejected");
    const effectiveModelId = modelId;
    if (effectiveModelId) await this.assertModelPolicy(effectiveModelId, remainingMs(deadline, "execute", "rejected"));
    const body: JsonObject = { session_id: validatedSessionId, message: request.message, context };
    if (modelId !== undefined && modelId !== null) body.model_override = modelId;
    return this.requestJson("execute", "/api/chat/execute", {
      method: "POST", body: JSON.stringify(body), timeoutMs: remainingMs(deadline, "execute", "ambiguous"), dispatchAmbiguous: true,
      parse: (value) => this.validateExecuteResponse(value, validatedSessionId, previousMessages, request.message),
    });
  }

  private async getChatSessionWithTimeout(notebookId: string, sessionId: string, timeoutMs: number): Promise<OpenNotebookChatSession> {
    return this.requestJson("session_get", `/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET", timeoutMs, parse: (value) => parseSession(value, notebookId, sessionId),
    });
  }

  private async assertModelPolicy(requestedModelId: string, timeoutMs: number): Promise<void> {
    const defaults = await this.requestJson("models_defaults", "/api/models/defaults", { method: "GET", timeoutMs, parse: parseDefaults });
    if (defaults.effectiveModelId !== null && defaults.effectiveModelId !== requestedModelId) {
      throw new OpenNotebookChatError("model_policy_mismatch", "models_defaults", "rejected");
    }
  }

  private validateExecuteResponse(value: unknown, expectedSessionId: string, previousMessages: readonly OpenNotebookChatMessage[], message: string): OpenNotebookChatAnswer {
    if (!isObject(value) || value.session_id !== expectedSessionId || !Array.isArray(value.messages)) throw new OpenNotebookChatError("response_mismatch", "execute", "ambiguous");
    if (value.messages.length !== previousMessages.length + 2 || value.messages.length > MAX_HISTORY_ITEMS) throw new OpenNotebookChatError("message_history_mismatch", "execute", "ambiguous");
    const messages = value.messages.map((item) => parseMessage(item, "execute"));
    for (let index = 0; index < previousMessages.length; index += 1) {
      if (!sameMessage(messages[index]!, previousMessages[index]!)) throw new OpenNotebookChatError("message_history_mismatch", "execute", "ambiguous");
    }
    const human = messages[previousMessages.length]!;
    const assistant = messages[previousMessages.length + 1]!;
    if (human.type !== "human" || human.content !== message || assistant.type !== "ai") throw new OpenNotebookChatError("response_mismatch", "execute", "ambiguous");
    const ids = new Set(messages.map((item) => item.id));
    if (ids.size !== messages.length || bytes(assistant.content) > MAX_ANSWER_BYTES || bytes(JSON.stringify(messages)) > MAX_HISTORY_BYTES) throw new OpenNotebookChatError("response_mismatch", "execute", "ambiguous");
    return Object.freeze({ id: assistant.id, type: "ai" as const, content: assistant.content });
  }

  private async requestJson<T>(operation: OpenNotebookChatError["operation"], path: string, options: { readonly method: "GET" | "POST"; readonly body?: string; readonly timeoutMs?: number; readonly dispatchAmbiguous?: boolean; readonly parse: (value: unknown) => T }): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    const ambiguousAfterDispatch = options.dispatchAmbiguous === true || options.method === "POST";
    try {
      try {
        response = await this.fetchImpl(url, {
          method: options.method,
          headers: { accept: "application/json", authorization: `Bearer ${this.token}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
          ...(options.body === undefined ? {} : { body: options.body }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new OpenNotebookChatError(controller.signal.aborted ? "timeout" : "unavailable", operation, options.dispatchAmbiguous || options.method === "POST" ? "ambiguous" : "rejected");
      }
      if (!response.ok) {
        await cancelResponse(response);
        const knownCreateRejection = operation === "session_create" && [400, 401, 403, 404, 413, 422].includes(response.status);
        const disposition = options.method === "GET" || knownCreateRejection ? "rejected" : "ambiguous";
        throw new OpenNotebookChatError("http_error", operation, disposition, response.status);
      }
      if (!jsonContent(response)) {
        await cancelResponse(response);
        throw new OpenNotebookChatError("unexpected_content_type", operation, ambiguousAfterDispatch ? "ambiguous" : "rejected", response.status);
      }
      try {
        const value = await readBoundedJson(response, operation, this.maxResponseBytes);
        return options.parse(value);
      } catch (error) {
        if (error instanceof OpenNotebookChatError) {
          if (ambiguousAfterDispatch && error.disposition !== "ambiguous") throw new OpenNotebookChatError(error.code, operation, "ambiguous", error.status);
          throw error;
        }
        if (controller.signal.aborted) {
          throw new OpenNotebookChatError("timeout", operation, ambiguousAfterDispatch ? "ambiguous" : "rejected");
        }
        throw new OpenNotebookChatError("malformed_response", operation, ambiguousAfterDispatch ? "ambiguous" : "rejected");
      }
    } finally {
      controller.abort();
      await cancelResponse(response);
      clearTimeout(timer);
    }
  }
}
