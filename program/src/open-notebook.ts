/**
 * Server-only, bounded adapter foundation for the pinned Open Notebook API.
 *
 * This module deliberately does not read environment variables, expose a
 * browser client, or accept an arbitrary path/unvalidated external ID. It
 * exposes only the explicitly scoped reads and the fixed text-source write
 * below; Knowledge remains the canonical SQLite owner. A caller must resolve
 * a trusted Knowledge grant to an external notebook before exposing any
 * result, and must follow a successful write with a scoped membership read.
 */

/**
 * The source/ref whose response contracts this adapter supports. This is a
 * compatibility baseline, not a version observed from a remote peer.
 */
export const OPEN_NOTEBOOK_CONTRACT_BASELINE = Object.freeze({
  repository: "https://github.com/lfnovo/open-notebook",
  release: "v1.14.0",
  commit: "30c7e2a63e43b7f270fc2c638f0b6246934a53f4",
  source: Object.freeze({
    health: "api/main.py",
    capabilities: "api/routers/capabilities.py",
    notebooks: "api/routers/notebooks.py",
    sources: "api/routers/sources.py",
    notes: "api/routers/notes.py",
    models: "api/models.py",
  }),
} as const);

/** The current probe does not establish a remote service version. */
export const OPEN_NOTEBOOK_OBSERVED_VERSION = null;

export const OPEN_NOTEBOOK_DEFAULT_TIMEOUT_MS = 3_000;
export const OPEN_NOTEBOOK_DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const OPEN_NOTEBOOK_MAX_EXTERNAL_ID_BYTES = 128;
export const OPEN_NOTEBOOK_MAX_SOURCE_TITLE_BYTES = 4 * 1024;
export const OPEN_NOTEBOOK_MAX_SOURCE_CONTENT_BYTES = 512 * 1024;

const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type OpenNotebookAdapterConfig = {
  /** Explicit server-side base URL. Do not pass a browser-controlled value. */
  readonly baseUrl: string;
  /** Explicit server-side credential, never sent to a browser. */
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
};

export type OpenNotebookErrorCode =
  | "invalid_config"
  | "invalid_input"
  | "unavailable"
  | "timeout"
  | "http_error"
  | "unexpected_content_type"
  | "malformed_response"
  | "response_too_large"
  | "invalid_identifier"
  | "identifier_mismatch"
  | "notebook_membership_denied"
  | "context_limit_exceeded"
  | "context_membership_changed"
  | "incomplete_context";

export type OpenNotebookErrorDisposition = "rejected" | "ambiguous";

export class OpenNotebookAdapterError extends Error {
  readonly name = "OpenNotebookAdapterError";

  constructor(
    readonly code: OpenNotebookErrorCode,
    readonly operation:
      | "health"
      | "capabilities"
      | "notebooks"
      | "notebook"
      | "notebook_sources"
      | "notebook_notes"
      | "notebook_note"
      | "notebook_source"
      | "notebook_source_create"
      | "notebook_context",
    readonly status?: number,
    readonly disposition?: OpenNotebookErrorDisposition,
  ) {
    super(`Open Notebook ${operation} ${code}`);
  }
}

export type OpenNotebookHealth = {
  readonly contractBaseline: typeof OPEN_NOTEBOOK_CONTRACT_BASELINE;
  readonly observedVersion: typeof OPEN_NOTEBOOK_OBSERVED_VERSION;
  readonly status: "healthy";
};

export type OpenNotebookCapabilities = {
  readonly contractBaseline: typeof OPEN_NOTEBOOK_CONTRACT_BASELINE;
  readonly observedVersion: typeof OPEN_NOTEBOOK_OBSERVED_VERSION;
  readonly doclingAvailable: boolean;
  readonly crawl4aiAvailable: boolean;
  readonly crawl4aiRemoteConfigured: boolean;
};

export type OpenNotebookNotebook = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly archived: boolean;
  readonly created: string;
  readonly updated: string;
  readonly sourceCount: number;
  readonly noteCount: number;
}>;

export type OpenNotebookAsset = Readonly<{
  readonly filePath: string | null;
  readonly url: string | null;
}>;

export type OpenNotebookSource = Readonly<{
  readonly id: string;
  readonly title: string | null;
  readonly topics: readonly string[] | null;
  readonly asset: OpenNotebookAsset | null;
  readonly fullText: string | null;
  readonly embedded: boolean;
  readonly embeddedChunks: number;
  readonly insightsCount: number | null;
  readonly fileAvailable: boolean | null;
  readonly created: string;
  readonly updated: string;
  readonly commandId: string | null;
  readonly status: string | null;
}>;

export type OpenNotebookNote = Readonly<{
  readonly id: string;
  readonly title: string | null;
  readonly content: string | null;
  readonly noteType: string | null;
  readonly created: string;
  readonly updated: string;
  readonly commandId: string | null;
}>;

export type OpenNotebookSourceListOptions = Readonly<{
  readonly limit?: number;
  readonly offset?: number;
  readonly sortBy?: "type" | "title" | "created" | "updated" | "insights_count" | "embedded";
  readonly sortOrder?: "asc" | "desc";
}>;

export type OpenNotebookContextInsight = Readonly<{
  readonly id: string;
  readonly insightType: string;
  readonly content: string;
}>;

export type OpenNotebookContextSource = Readonly<{
  readonly id: string;
  readonly title: string | null;
  readonly fullText: string | null;
  readonly insights: readonly OpenNotebookContextInsight[];
}>;

export type OpenNotebookContextNote = Readonly<{
  readonly id: string;
  readonly title: string | null;
  readonly content: string | null;
}>;

export type OpenNotebookContext = Readonly<{
  readonly sources: readonly OpenNotebookContextSource[];
  readonly notes: readonly OpenNotebookContextNote[];
  readonly tokenCount: number;
  readonly charCount: number;
}>;

/**
 * The only caller-controlled fields accepted by the text-source write.
 * Notebook association, source type, processing, embedding, and
 * transformation policy are fixed by the adapter and never accepted here.
 */
export type OpenNotebookTextSourceRequest = Readonly<{
  readonly title: string;
  readonly content: string;
}>;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function stringField(value: JsonObject, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function booleanField(value: JsonObject, key: string): boolean | null {
  const field = value[key];
  return typeof field === "boolean" ? field : null;
}

function nonNegativeIntegerField(value: JsonObject, key: string): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : null;
}

function malformed(operation: OpenNotebookAdapterError["operation"]): never {
  throw new OpenNotebookAdapterError("malformed_response", operation);
}

async function cancelResponse(response: Response | undefined): Promise<void> {
  await response?.body?.cancel().catch(() => undefined);
}

function hasJsonContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function parseHealth(value: unknown): OpenNotebookHealth {
  if (!isJsonObject(value) || !hasExactKeys(value, ["status"])) {
    malformed("health");
  }
  if (value.status !== "healthy") {
    malformed("health");
  }
  return Object.freeze({
    contractBaseline: OPEN_NOTEBOOK_CONTRACT_BASELINE,
    observedVersion: OPEN_NOTEBOOK_OBSERVED_VERSION,
    status: "healthy",
  });
}

function parseCapabilities(value: unknown): OpenNotebookCapabilities {
  const keys = ["crawl4ai_available", "crawl4ai_remote_configured", "docling_available"] as const;
  if (!isJsonObject(value) || !hasExactKeys(value, keys)) {
    malformed("capabilities");
  }
  const doclingAvailable = booleanField(value, "docling_available");
  const crawl4aiAvailable = booleanField(value, "crawl4ai_available");
  const crawl4aiRemoteConfigured = booleanField(value, "crawl4ai_remote_configured");
  if (doclingAvailable === null || crawl4aiAvailable === null || crawl4aiRemoteConfigured === null) {
    malformed("capabilities");
  }
  return Object.freeze({
    contractBaseline: OPEN_NOTEBOOK_CONTRACT_BASELINE,
    observedVersion: OPEN_NOTEBOOK_OBSERVED_VERSION,
    doclingAvailable,
    crawl4aiAvailable,
    crawl4aiRemoteConfigured,
  });
}

const NOTEBOOK_RESPONSE_KEYS = [
  "archived",
  "created",
  "description",
  "id",
  "name",
  "note_count",
  "source_count",
  "updated",
] as const;

function parseNotebookRecord(value: unknown, operation: OpenNotebookAdapterError["operation"]): OpenNotebookNotebook {
  if (!isJsonObject(value) || !hasExactKeys(value, NOTEBOOK_RESPONSE_KEYS)) {
    malformed(operation);
  }
  const id = stringField(value, "id");
  const name = stringField(value, "name");
  const description = stringField(value, "description");
  const created = stringField(value, "created");
  const updated = stringField(value, "updated");
  const archived = booleanField(value, "archived");
  const sourceCount = nonNegativeIntegerField(value, "source_count");
  const noteCount = nonNegativeIntegerField(value, "note_count");
  if (
    !id ||
    name === null ||
    description === null ||
    created === null ||
    updated === null ||
    archived === null ||
    sourceCount === null ||
    noteCount === null
  ) {
    malformed(operation);
  }
  return Object.freeze({
    id,
    name,
    description,
    archived,
    created,
    updated,
    sourceCount,
    noteCount,
  });
}

function parseNotebooks(value: unknown): readonly OpenNotebookNotebook[] {
  if (!Array.isArray(value)) {
    malformed("notebooks");
  }
  return Object.freeze(
    value.map((item) => parseNotebookRecord(item, "notebooks")),
  );
}

function requiredString(value: JsonObject, key: string, operation: OpenNotebookAdapterError["operation"]): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    malformed(operation);
  }
  return field;
}

function optionalString(value: JsonObject, key: string, operation: OpenNotebookAdapterError["operation"]): string | null {
  const field = value[key];
  if (field === undefined || field === null) {
    return null;
  }
  if (typeof field !== "string") {
    malformed(operation);
  }
  return field;
}

function requiredBoolean(value: JsonObject, key: string, operation: OpenNotebookAdapterError["operation"]): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    malformed(operation);
  }
  return field;
}

function optionalBoolean(value: JsonObject, key: string, operation: OpenNotebookAdapterError["operation"]): boolean | null {
  const field = value[key];
  if (field === undefined || field === null) {
    return null;
  }
  if (typeof field !== "boolean") {
    malformed(operation);
  }
  return field;
}

function requiredNonNegativeInteger(
  value: JsonObject,
  key: string,
  operation: OpenNotebookAdapterError["operation"],
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    malformed(operation);
  }
  return field;
}

function optionalStringArray(
  value: JsonObject,
  key: string,
  operation: OpenNotebookAdapterError["operation"],
): readonly string[] | null {
  const field = value[key];
  if (field === undefined || field === null) {
    return null;
  }
  if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
    malformed(operation);
  }
  return Object.freeze([...field]);
}

function parseAsset(value: JsonObject, operation: OpenNotebookAdapterError["operation"]): OpenNotebookAsset | null {
  const asset = value.asset;
  if (asset === undefined || asset === null) {
    return null;
  }
  if (!isJsonObject(asset)) {
    malformed(operation);
  }
  return Object.freeze({
    filePath: optionalString(asset, "file_path", operation),
    url: optionalString(asset, "url", operation),
  });
}

function parseSource(
  value: unknown,
  operation: "notebook_sources" | "notebook_source" | "notebook_source_create",
  includeFullText: boolean,
  includeInsightsCount: boolean,
): OpenNotebookSource {
  if (!isJsonObject(value)) {
    malformed(operation);
  }
  return Object.freeze({
    id: requiredString(value, "id", operation),
    title: optionalString(value, "title", operation),
    topics: optionalStringArray(value, "topics", operation),
    asset: parseAsset(value, operation),
    fullText: includeFullText ? optionalString(value, "full_text", operation) : null,
    embedded: requiredBoolean(value, "embedded", operation),
    embeddedChunks: requiredNonNegativeInteger(value, "embedded_chunks", operation),
    insightsCount: includeInsightsCount
      ? requiredNonNegativeInteger(value, "insights_count", operation)
      : null,
    fileAvailable: optionalBoolean(value, "file_available", operation),
    created: requiredString(value, "created", operation),
    updated: requiredString(value, "updated", operation),
    commandId: optionalString(value, "command_id", operation),
    status: optionalString(value, "status", operation),
  });
}

function parseSourceList(value: unknown): readonly OpenNotebookSource[] {
  if (!Array.isArray(value)) {
    malformed("notebook_sources");
  }
  return Object.freeze(value.map((item) => parseSource(item, "notebook_sources", false, true)));
}

function parseSourceDetail(value: unknown): OpenNotebookSource {
  return parseSource(value, "notebook_source", true, false);
}

function parseCreatedSource(value: unknown): OpenNotebookSource {
  if (!isJsonObject(value)) {
    malformed("notebook_source_create");
  }
  const source = parseSource(value, "notebook_source_create", true, false);
  try {
    const sourceId = validateExternalId(source.id, "notebook_source_create");
    if (!sourceId.startsWith("source:") || sourceId.length <= "source:".length) {
      malformed("notebook_source_create");
    }
  } catch (error) {
    if (error instanceof OpenNotebookAdapterError && error.code === "invalid_identifier") {
      malformed("notebook_source_create");
    }
    throw error;
  }
  return source;
}

function parseSourceDetailForNotebook(
  value: unknown,
  notebookId: string,
  sourceId: string,
): OpenNotebookSource {
  if (!isJsonObject(value)) {
    malformed("notebook_source");
  }
  const memberships = value.notebooks;
  if (memberships !== undefined && memberships !== null) {
    if (!Array.isArray(memberships) || memberships.some((item) => typeof item !== "string")) {
      malformed("notebook_source");
    }
    if (!memberships.includes(notebookId)) {
      throw new OpenNotebookAdapterError("notebook_membership_denied", "notebook_source");
    }
  }
  const source = parseSourceDetail(value);
  if (source.id !== sourceId) {
    throw new OpenNotebookAdapterError("identifier_mismatch", "notebook_source");
  }
  return source;
}

function parseNote(value: unknown): OpenNotebookNote {
  if (!isJsonObject(value)) {
    malformed("notebook_notes");
  }
  return Object.freeze({
    id: requiredString(value, "id", "notebook_notes"),
    title: optionalString(value, "title", "notebook_notes"),
    content: optionalString(value, "content", "notebook_notes"),
    noteType: optionalString(value, "note_type", "notebook_notes"),
    created: requiredString(value, "created", "notebook_notes"),
    updated: requiredString(value, "updated", "notebook_notes"),
    commandId: optionalString(value, "command_id", "notebook_notes"),
  });
}

function parseNoteDetail(value: unknown, expectedNoteId: string): OpenNotebookNote {
  if (!isJsonObject(value) || !Object.prototype.hasOwnProperty.call(value, "content") ||
    (value.content !== null && typeof value.content !== "string")) {
    malformed("notebook_note");
  }
  const note = parseNote(value);
  if (note.id !== expectedNoteId) {
    throw new OpenNotebookAdapterError("identifier_mismatch", "notebook_note");
  }
  return note;
}

function parseNotes(value: unknown): readonly OpenNotebookNote[] {
  if (!Array.isArray(value)) {
    malformed("notebook_notes");
  }
  return Object.freeze(value.map(parseNote));
}

function validateNotebookNoteMembership(notes: readonly OpenNotebookNote[]): void {
  if (notes.length > MAX_NOTEBOOK_NOTE_MEMBERSHIP) {
    malformed("notebook_note");
  }
  const seen = new Set<string>();
  for (const note of notes) {
    try {
      validateNoteId(note.id, "notebook_note");
    } catch (error) {
      if (error instanceof OpenNotebookAdapterError && error.code === "invalid_identifier") {
        malformed("notebook_note");
      }
      throw error;
    }
    if (seen.has(note.id)) {
      malformed("notebook_note");
    }
    seen.add(note.id);
  }
}

const MAX_CONTEXT_ITEMS = 100;

function contextFailure(code: "context_limit_exceeded" | "context_membership_changed" | "incomplete_context"): never {
  throw new OpenNotebookAdapterError(code, "notebook_context");
}

function contextNullableString(value: JsonObject, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(value, key)) malformed("notebook_context");
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string") malformed("notebook_context");
  return field;
}

function contextRecordId(value: unknown, prefix: "source:" | "note:"): string {
  let id: string;
  try {
    id = validateExternalId(value, "notebook_context");
  } catch {
    contextFailure("incomplete_context");
  }
  if (!id.startsWith(prefix) || id.length <= prefix.length) contextFailure("incomplete_context");
  return id;
}

function parseContextInsight(value: unknown, sourceId: string): OpenNotebookContextInsight {
  if (!isJsonObject(value)) malformed("notebook_context");
  const id = requiredString(value, "id", "notebook_context");
  const insightType = requiredString(value, "insight_type", "notebook_context");
  const content = requiredString(value, "content", "notebook_context");
  if (Object.prototype.hasOwnProperty.call(value, "source_id") && value.source_id !== sourceId) {
    contextFailure("incomplete_context");
  }
  return Object.freeze({ id, insightType, content });
}

function parseContextSource(value: unknown): OpenNotebookContextSource {
  if (!isJsonObject(value)) malformed("notebook_context");
  const id = requiredString(value, "id", "notebook_context");
  const title = contextNullableString(value, "title");
  const fullText = contextNullableString(value, "full_text");
  if (!Array.isArray(value.insights)) malformed("notebook_context");
  return Object.freeze({
    id,
    title,
    fullText,
    insights: Object.freeze(value.insights.map((insight) => parseContextInsight(insight, id))),
  });
}

function parseContextNote(value: unknown): OpenNotebookContextNote {
  if (!isJsonObject(value)) malformed("notebook_context");
  const id = requiredString(value, "id", "notebook_context");
  const title = contextNullableString(value, "title");
  const content = contextNullableString(value, "content");
  return Object.freeze({ id, title, content });
}

function parseNotebookContext(value: unknown): OpenNotebookContext {
  if (!isJsonObject(value) || !isJsonObject(value.context) || !Array.isArray(value.context.sources) || !Array.isArray(value.context.notes)) {
    malformed("notebook_context");
  }
  const tokenCount = nonNegativeIntegerField(value, "token_count");
  const charCount = nonNegativeIntegerField(value, "char_count");
  if (tokenCount === null || charCount === null) malformed("notebook_context");
  return Object.freeze({
    sources: Object.freeze(value.context.sources.map(parseContextSource)),
    notes: Object.freeze(value.context.notes.map(parseContextNote)),
    tokenCount,
    charCount,
  });
}

const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_NOTEBOOK_SOURCE_MEMBERSHIP_PAGES = 100;
const MAX_NOTEBOOK_NOTE_MEMBERSHIP = 500;

type ContextMembership = Readonly<{
  readonly sourceIds: readonly string[];
  readonly noteIds: readonly string[];
}>;

function contextRemaining(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new OpenNotebookAdapterError("timeout", "notebook_context");
  return remaining;
}

function notebookNoteRemaining(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new OpenNotebookAdapterError("timeout", "notebook_note");
  return remaining;
}

function sameContextIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function validateExternalId(
  value: unknown,
  operation: OpenNotebookAdapterError["operation"],
  disposition?: OpenNotebookErrorDisposition,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > OPEN_NOTEBOOK_MAX_EXTERNAL_ID_BYTES ||
    !EXTERNAL_ID_PATTERN.test(value)
  ) {
    throw new OpenNotebookAdapterError("invalid_identifier", operation, undefined, disposition);
  }
  return value;
}

function validateNoteId(
  value: unknown,
  operation: OpenNotebookAdapterError["operation"],
  disposition?: OpenNotebookErrorDisposition,
): string {
  const validated = validateExternalId(value, operation, disposition);
  if (!validated.startsWith("note:") || validated.length <= "note:".length) {
    throw new OpenNotebookAdapterError("invalid_identifier", operation, undefined, disposition);
  }
  return validated;
}

function validateSourceListOptions(options: OpenNotebookSourceListOptions): Required<OpenNotebookSourceListOptions> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const sortBy = options.sortBy ?? "updated";
  const sortOrder = options.sortOrder ?? "desc";
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !["type", "title", "created", "updated", "insights_count", "embedded"].includes(sortBy) ||
    !["asc", "desc"].includes(sortOrder)
  ) {
    throw new OpenNotebookAdapterError("invalid_config", "notebook_sources");
  }
  return { limit, offset, sortBy, sortOrder } as Required<OpenNotebookSourceListOptions>;
}

function validateSourceText(
  value: JsonObject,
  key: "title" | "content",
  maxBytes: number,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    throw new OpenNotebookAdapterError("invalid_input", "notebook_source_create", undefined, "rejected");
  }
  if (new TextEncoder().encode(field).byteLength > maxBytes) {
    throw new OpenNotebookAdapterError("invalid_input", "notebook_source_create", undefined, "rejected");
  }
  return field;
}

function validateTextSourceRequest(value: unknown): OpenNotebookTextSourceRequest {
  if (!isJsonObject(value) || !hasExactKeys(value, ["content", "title"])) {
    throw new OpenNotebookAdapterError("invalid_input", "notebook_source_create", undefined, "rejected");
  }
  return Object.freeze({
    title: validateSourceText(value, "title", OPEN_NOTEBOOK_MAX_SOURCE_TITLE_BYTES),
    content: validateSourceText(value, "content", OPEN_NOTEBOOK_MAX_SOURCE_CONTENT_BYTES),
  });
}

function dispositionForStatus(status: number): OpenNotebookErrorDisposition {
  return [400, 401, 403, 404, 413, 422].includes(status) ? "rejected" : "ambiguous";
}

async function readBoundedJson(
  response: Response,
  operation: OpenNotebookAdapterError["operation"],
  maxResponseBytes: number,
): Promise<unknown> {
  if (!response.body) {
    malformed(operation);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OpenNotebookAdapterError("response_too_large", operation);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new OpenNotebookAdapterError("malformed_response", operation);
  }
}

function validateConfig(config: OpenNotebookAdapterConfig): {
  readonly baseUrl: URL;
  readonly token: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly fetchImpl: typeof fetch;
} {
  if (!config || typeof config !== "object") {
    throw new OpenNotebookAdapterError("invalid_config", "health");
  }
  if (typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") {
    throw new OpenNotebookAdapterError("invalid_config", "health");
  }
  if (typeof config.token !== "string" || config.token.trim() === "") {
    throw new OpenNotebookAdapterError("invalid_config", "health");
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(config.baseUrl);
  } catch {
    throw new OpenNotebookAdapterError("invalid_config", "health");
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.pathname !== "/" ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== ""
  ) {
    throw new OpenNotebookAdapterError("invalid_config", "health");
  }
  const timeoutMs = config.timeoutMs ?? OPEN_NOTEBOOK_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? OPEN_NOTEBOOK_DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new OpenNotebookAdapterError("invalid_config", "health");
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_RESPONSE_BYTES
  ) {
    throw new OpenNotebookAdapterError("invalid_config", "health");
  }
  return {
    baseUrl,
    token: config.token,
    timeoutMs,
    maxResponseBytes,
    fetchImpl: config.fetchImpl ?? fetch,
  };
}

export class OpenNotebookAdapter {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenNotebookAdapterConfig) {
    const validated = validateConfig(config);
    this.baseUrl = validated.baseUrl;
    this.token = validated.token;
    this.timeoutMs = validated.timeoutMs;
    this.maxResponseBytes = validated.maxResponseBytes;
    this.fetchImpl = validated.fetchImpl;
  }

  /** Reads the pinned upstream health endpoint; a down peer rejects. */
  async health(): Promise<OpenNotebookHealth> {
    return this.getJson("health", "/health", parseHealth);
  }

  /** Reads the pinned v1.14.0 runtime capability shape. */
  async capabilities(): Promise<OpenNotebookCapabilities> {
    return this.getJson("capabilities", "/api/capabilities", parseCapabilities);
  }

  /**
   * Lists external notebooks for an operator/server-side mapping step.
   *
   * This intentionally accepts no remote notebook id and performs no writes.
   * It is a global upstream inventory probe, not a tenant-facing route or an
   * application authorization decision. Callers must use an already selected
   * Knowledge grant and persist a grant-bound mapping before exposing any
   * notebook to a user/agent.
   */
  async listNotebooks(options: { readonly archived?: boolean } = {}): Promise<readonly OpenNotebookNotebook[]> {
    if (!options || typeof options !== "object" || (options.archived !== undefined && typeof options.archived !== "boolean")) {
      throw new OpenNotebookAdapterError("invalid_config", "notebooks");
    }
    const path = new URL("/api/notebooks", this.baseUrl);
    path.searchParams.set("order_by", "updated desc");
    if (options.archived !== undefined) {
      path.searchParams.set("archived", String(options.archived));
    }
    return this.getJson("notebooks", path, parseNotebooks);
  }

  /**
   * Creates one text source for a trusted mapped notebook using the exact
   * v1.14.0 JSON contract. The response proves only that the upstream write
   * returned a parseable source; callers must follow it with
   * getNotebookSource(notebookId, source.id) to verify notebook membership.
   * Any timeout, network, oversized, malformed, unexpected-status, or other
   * post-dispatch failure is ambiguous because the upstream may have written
   * before the failure was observed. This method never retries.
   */
  async createNotebookTextSource(
    notebookId: string,
    request: OpenNotebookTextSourceRequest,
  ): Promise<OpenNotebookSource> {
    const validatedNotebookId = validateExternalId(notebookId, "notebook_source_create", "rejected");
    const validatedRequest = validateTextSourceRequest(request);
    const body = {
      type: "text",
      notebooks: [validatedNotebookId],
      content: validatedRequest.content,
      title: validatedRequest.title,
      transformations: [],
      embed: false,
      delete_source: false,
      async_processing: false,
    } as const;
    return this.postJson(
      "notebook_source_create",
      "/api/sources/json",
      body,
      parseCreatedSource,
    );
  }

  /** Reads one notebook selected by a trusted server-side mapping. */
  async getNotebook(notebookId: string): Promise<OpenNotebookNotebook> {
    const validatedNotebookId = validateExternalId(notebookId, "notebook");
    const path = new URL(`/api/notebooks/${encodeURIComponent(validatedNotebookId)}`, this.baseUrl);
    return this.getJson("notebook", path, (value) => {
      const notebook = parseNotebookRecord(value, "notebook");
      if (notebook.id !== validatedNotebookId) {
        throw new OpenNotebookAdapterError("identifier_mismatch", "notebook");
      }
      return notebook;
    });
  }

  /**
   * Lists sources through Open Notebook's notebook filter. This is scoped to
   * the trusted notebook mapping and never calls the global source inventory.
   */
  async listNotebookSources(
    notebookId: string,
    options: OpenNotebookSourceListOptions = {},
  ): Promise<readonly OpenNotebookSource[]> {
    const validatedNotebookId = validateExternalId(notebookId, "notebook_sources");
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new OpenNotebookAdapterError("invalid_config", "notebook_sources");
    }
    return this.listNotebookSourcesWithTimeout(validatedNotebookId, options, this.timeoutMs);
  }

  private async listNotebookSourcesWithTimeout(
    validatedNotebookId: string,
    options: OpenNotebookSourceListOptions,
    timeoutMs: number,
  ): Promise<readonly OpenNotebookSource[]> {
    const validatedOptions = validateSourceListOptions(options);
    const path = new URL("/api/sources", this.baseUrl);
    path.searchParams.set("notebook_id", validatedNotebookId);
    path.searchParams.set("limit", String(validatedOptions.limit));
    path.searchParams.set("offset", String(validatedOptions.offset));
    path.searchParams.set("sort_by", validatedOptions.sortBy);
    path.searchParams.set("sort_order", validatedOptions.sortOrder);
    return this.getJson("notebook_sources", path, parseSourceList, timeoutMs);
  }

  /** Lists notes through Open Notebook's notebook filter, never globally. */
  async listNotebookNotes(notebookId: string): Promise<readonly OpenNotebookNote[]> {
    const validatedNotebookId = validateExternalId(notebookId, "notebook_notes");
    return this.listNotebookNotesWithTimeout(validatedNotebookId, this.timeoutMs);
  }

  private async listNotebookNotesWithTimeout(
    validatedNotebookId: string,
    timeoutMs: number,
  ): Promise<readonly OpenNotebookNote[]> {
    const path = new URL("/api/notes", this.baseUrl);
    path.searchParams.set("notebook_id", validatedNotebookId);
    return this.getJson("notebook_notes", path, parseNotes, timeoutMs);
  }

  /**
   * Reads one note only after proving membership in the trusted notebook.
   * Open Notebook's notebook list omits note content by default, so this
   * performs a second, fixed detail read and then rechecks membership before
   * exposing the body. All three reads share one deadline and never retry.
   */
  async getNotebookNote(notebookId: string, noteId: string): Promise<OpenNotebookNote> {
    const validatedNotebookId = validateExternalId(notebookId, "notebook_note");
    const validatedNoteId = validateNoteId(noteId, "notebook_note");
    const deadline = Date.now() + this.timeoutMs;
    try {
      const membership = await this.listNotebookNotesWithTimeout(
        validatedNotebookId,
        notebookNoteRemaining(deadline),
      );
      validateNotebookNoteMembership(membership);
      if (!membership.some((note) => note.id === validatedNoteId)) {
        throw new OpenNotebookAdapterError("notebook_membership_denied", "notebook_note");
      }

      const path = new URL(`/api/notes/${encodeURIComponent(validatedNoteId)}`, this.baseUrl);
      const detail = await this.getJson(
        "notebook_note",
        path,
        (value) => parseNoteDetail(value, validatedNoteId),
        notebookNoteRemaining(deadline),
      );

      const after = await this.listNotebookNotesWithTimeout(
        validatedNotebookId,
        notebookNoteRemaining(deadline),
      );
      validateNotebookNoteMembership(after);
      if (!after.some((note) => note.id === validatedNoteId)) {
        throw new OpenNotebookAdapterError("notebook_membership_denied", "notebook_note");
      }
      return detail;
    } catch (error) {
      if (error instanceof OpenNotebookAdapterError && error.operation !== "notebook_note") {
        throw new OpenNotebookAdapterError(error.code, "notebook_note", error.status, error.disposition);
      }
      throw error;
    }
  }

  /**
   * Builds provider-free full-content context for one trusted mapped notebook.
   * The source and note IDs are always derived from two bounded membership
   * reads; callers cannot supply an inclusion list or upstream context config.
   * The membership is re-read after the upstream build, so this is a bounded
   * consistency check rather than a transaction across the upstream database.
   */
  async getNotebookContext(notebookId: string): Promise<OpenNotebookContext> {
    try {
      const validatedNotebookId = validateExternalId(notebookId, "notebook_context");
      const deadline = Date.now() + this.timeoutMs;
      const membership = await this.enumerateContextMembership(validatedNotebookId, deadline);
      const contextConfig = {
        sources: Object.fromEntries(membership.sourceIds.map((id) => [id, "full content"])),
        notes: Object.fromEntries(membership.noteIds.map((id) => [id, "full content"])),
      };

      let context: OpenNotebookContext;
      try {
        context = await this.postJson(
          "notebook_context",
          "/api/chat/context",
          { notebook_id: validatedNotebookId, context_config: contextConfig },
          parseNotebookContext,
          contextRemaining(deadline),
        );
      } catch (error) {
        if (error instanceof OpenNotebookAdapterError && error.status === 413) {
          throw new OpenNotebookAdapterError("context_limit_exceeded", "notebook_context", 413, error.disposition);
        }
        throw error;
      }

      let after: ContextMembership;
      try {
        after = await this.enumerateContextMembership(validatedNotebookId, deadline);
      } catch (error) {
        if (error instanceof OpenNotebookAdapterError && error.code === "context_limit_exceeded") {
          throw new OpenNotebookAdapterError("context_membership_changed", "notebook_context");
        }
        throw error;
      }
      if (!sameContextIds(membership.sourceIds, after.sourceIds) || !sameContextIds(membership.noteIds, after.noteIds)) {
        throw new OpenNotebookAdapterError("context_membership_changed", "notebook_context");
      }

      this.validateContextProjection(context, membership);
      contextRemaining(deadline);
      return context;
    } catch (error) {
      if (error instanceof OpenNotebookAdapterError && error.operation !== "notebook_context") {
        throw new OpenNotebookAdapterError(error.code, "notebook_context", error.status, error.disposition);
      }
      throw error;
    }
  }

  private async enumerateContextMembership(
    validatedNotebookId: string,
    deadline: number,
  ): Promise<ContextMembership> {
    const sourcePage = await this.listNotebookSourcesWithTimeout(
      validatedNotebookId,
      { limit: MAX_CONTEXT_ITEMS, offset: 0, sortBy: "updated", sortOrder: "desc" },
      contextRemaining(deadline),
    );
    if (sourcePage.length > MAX_CONTEXT_ITEMS) contextFailure("context_limit_exceeded");
    const sourceIds = sourcePage.map((source) => contextRecordId(source.id, "source:"));
    if (new Set(sourceIds).size !== sourceIds.length) contextFailure("incomplete_context");
    if (sourcePage.length === MAX_CONTEXT_ITEMS) {
      const overflow = await this.listNotebookSourcesWithTimeout(
        validatedNotebookId,
        { limit: 1, offset: MAX_CONTEXT_ITEMS, sortBy: "updated", sortOrder: "desc" },
        contextRemaining(deadline),
      );
      if (overflow.length > 0) contextFailure("context_limit_exceeded");
    }

    const noteInventory = await this.listNotebookNotesWithTimeout(
      validatedNotebookId,
      contextRemaining(deadline),
    );
    if (noteInventory.length > MAX_CONTEXT_ITEMS) contextFailure("context_limit_exceeded");
    const noteIds = noteInventory.map((note) => contextRecordId(note.id, "note:"));
    if (new Set(noteIds).size !== noteIds.length) contextFailure("incomplete_context");
    return Object.freeze({
      sourceIds: Object.freeze(sourceIds),
      noteIds: Object.freeze(noteIds),
    });
  }

  private validateContextProjection(
    context: OpenNotebookContext,
    membership: ContextMembership,
  ): void {
    const expectedSources = new Set(membership.sourceIds);
    const returnedSources = new Set<string>();
    const returnedInsights = new Set<string>();
    for (const source of context.sources) {
      const id = contextRecordId(source.id, "source:");
      if (!expectedSources.has(id) || returnedSources.has(id)) contextFailure("incomplete_context");
      returnedSources.add(id);
      for (const insight of source.insights) {
        if (returnedInsights.has(insight.id)) contextFailure("incomplete_context");
        returnedInsights.add(insight.id);
      }
    }
    if (returnedSources.size !== expectedSources.size) contextFailure("incomplete_context");

    const expectedNotes = new Set(membership.noteIds);
    const returnedNotes = new Set<string>();
    for (const note of context.notes) {
      const id = contextRecordId(note.id, "note:");
      if (!expectedNotes.has(id) || returnedNotes.has(id)) contextFailure("incomplete_context");
      returnedNotes.add(id);
    }
    if (returnedNotes.size !== expectedNotes.size) contextFailure("incomplete_context");
  }

  /**
   * Reads a source only after proving that its mapped ID appears in the
   * selected notebook's filtered source inventory. There is intentionally no
   * unscoped getSource(sourceId) method.
   */
  async getNotebookSource(notebookId: string, sourceId: string): Promise<OpenNotebookSource> {
    const validatedNotebookId = validateExternalId(notebookId, "notebook_source");
    const validatedSourceId = validateExternalId(sourceId, "notebook_source");
    const deadline = Date.now() + this.timeoutMs;
    for (let page = 0; page < MAX_NOTEBOOK_SOURCE_MEMBERSHIP_PAGES; page += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1) {
        throw new OpenNotebookAdapterError("timeout", "notebook_source");
      }
      const offset = page * 100;
      let sources: readonly OpenNotebookSource[];
      try {
        sources = await this.listNotebookSourcesWithTimeout(
          validatedNotebookId,
          {
            limit: 100,
            offset,
            sortBy: "updated",
            sortOrder: "desc",
          },
          remainingMs,
        );
      } catch (error) {
        if (error instanceof OpenNotebookAdapterError && error.code === "timeout") {
          throw new OpenNotebookAdapterError("timeout", "notebook_source");
        }
        throw error;
      }
      if (sources.some((source) => source.id === validatedSourceId)) {
        const path = new URL(`/api/sources/${encodeURIComponent(validatedSourceId)}`, this.baseUrl);
        const detailRemainingMs = deadline - Date.now();
        if (detailRemainingMs < 1) {
          throw new OpenNotebookAdapterError("timeout", "notebook_source");
        }
        return this.getJson("notebook_source", path, (value) =>
          parseSourceDetailForNotebook(value, validatedNotebookId, validatedSourceId),
          detailRemainingMs,
        );
      }
      if (sources.length < 100) {
        break;
      }
    }
    throw new OpenNotebookAdapterError("notebook_membership_denied", "notebook_source");
  }

  private async getJson<T>(
    operation: OpenNotebookAdapterError["operation"],
    path: string | URL,
    parse: (value: unknown) => T,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    return this.requestJson(operation, path, parse, {
      method: "GET",
      timeoutMs,
    });
  }

  private async postJson<T>(
    operation: OpenNotebookAdapterError["operation"],
    path: string | URL,
    body: JsonObject,
    parse: (value: unknown) => T,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    return this.requestJson(operation, path, parse, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs,
    });
  }

  private async requestJson<T>(
    operation: OpenNotebookAdapterError["operation"],
    path: string | URL,
    parse: (value: unknown) => T,
    options: {
      readonly method: "GET" | "POST";
      readonly body?: string;
      readonly timeoutMs?: number;
    },
  ): Promise<T> {
    const url = typeof path === "string" ? new URL(path, this.baseUrl) : path;
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      try {
        response = await this.fetchImpl(url, {
          method: options.method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.token}`,
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(options.body === undefined ? {} : { body: options.body }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new OpenNotebookAdapterError(
            "timeout",
            operation,
            undefined,
            options.method === "POST" ? "ambiguous" : undefined,
          );
        }
        throw new OpenNotebookAdapterError(
          "unavailable",
          operation,
          undefined,
          options.method === "POST" ? "ambiguous" : undefined,
        );
      }
      if (!response.ok) {
        await cancelResponse(response);
        throw new OpenNotebookAdapterError(
          "http_error",
          operation,
          response.status,
          options.method === "POST" ? dispositionForStatus(response.status) : undefined,
        );
      }
      if (!hasJsonContentType(response)) {
        await cancelResponse(response);
        throw new OpenNotebookAdapterError(
          "unexpected_content_type",
          operation,
          response.status,
          options.method === "POST" ? "ambiguous" : undefined,
        );
      }
      return parse(await readBoundedJson(response, operation, this.maxResponseBytes));
    } catch (error) {
      if (error instanceof OpenNotebookAdapterError) {
        if (options.method === "POST" && error.disposition === undefined) {
          throw new OpenNotebookAdapterError(
            error.code,
            error.operation,
            error.status,
            "ambiguous",
          );
        }
        throw error;
      }
      if (controller.signal.aborted) {
        throw new OpenNotebookAdapterError(
          "timeout",
          operation,
          undefined,
          options.method === "POST" ? "ambiguous" : undefined,
        );
      }
      throw new OpenNotebookAdapterError(
        "unavailable",
        operation,
        undefined,
        options.method === "POST" ? "ambiguous" : undefined,
      );
    } finally {
      controller.abort();
      await cancelResponse(response);
      clearTimeout(timeout);
    }
  }
}
