import {
  researchRequest,
  researchRequestWithStatus,
  ResearchRequestError,
} from "./research-chat-api";

export type ResearchSourceWriteState = "pending" | "succeeded" | "uncertain" | "rejected";

export type ResearchSourceWriteReceipt = Readonly<{
  idempotencyKey: string;
  state: ResearchSourceWriteState;
  sourceId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ResearchSourceWriteResult = Readonly<{
  receipt: ResearchSourceWriteReceipt;
  replayed: boolean;
}>;

export const RESEARCH_SOURCE_TITLE_MAX_BYTES = 4 * 1024;
export const RESEARCH_SOURCE_CONTENT_MAX_BYTES = 512 * 1024;

const NOTEBOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SOURCE_ID_PATTERN = /^source:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;
const ERROR_CODE_PATTERN = /^[a-z_]{1,80}$/u;
const RECEIPT_KEYS = new Set(["idempotencyKey", "state", "sourceId", "errorCode", "createdAt", "updatedAt"]);
const WRITE_ERROR_CODES = new Set([
  "invalid_request",
  "scope_denied",
  "policy_denied",
  "upstream_unavailable",
  "upstream_rejected",
  "ambiguous_response",
  "reconciliation_required",
]);

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, maxBytes: number, nonEmpty = false): value is string =>
  typeof value === "string" && (!nonEmpty || Boolean(value.trim())) && new TextEncoder().encode(value).byteLength <= maxBytes;
const malformed = () => new ResearchRequestError(0, "invalid_research_response");

function assertNotebookId(value: string): void {
  if (typeof value !== "string" || !NOTEBOOK_ID_PATTERN.test(value)) throw new ResearchRequestError(0, "invalid_research_request");
}

function assertIdempotencyKey(value: string): void {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) throw new ResearchRequestError(0, "invalid_research_request");
}

function validateWriteText(title: string, content: string): void {
  if (!boundedText(title, RESEARCH_SOURCE_TITLE_MAX_BYTES, true) || !boundedText(content, RESEARCH_SOURCE_CONTENT_MAX_BYTES, true)) {
    throw new ResearchRequestError(0, "invalid_research_request");
  }
}

function envelope(value: unknown): value is Record<string, unknown> {
  return object(value) && value.provider === "open_notebook" && object(value.contractBaseline);
}

export function parseResearchSourceWriteReceipt(value: unknown, expectedKey: string): ResearchSourceWriteReceipt {
  if (!object(value) || Object.keys(value).length !== RECEIPT_KEYS.size || Object.keys(value).some((key) => !RECEIPT_KEYS.has(key))) throw malformed();
  const state = value.state;
  const sourceId = value.sourceId;
  const errorCode = value.errorCode;
  if (
    typeof value.idempotencyKey !== "string" || value.idempotencyKey !== expectedKey || !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    !["pending", "succeeded", "uncertain", "rejected"].includes(String(state)) ||
    !(sourceId === null || (typeof sourceId === "string" && SOURCE_ID_PATTERN.test(sourceId))) ||
    !(errorCode === null || (typeof errorCode === "string" && ERROR_CODE_PATTERN.test(errorCode) && WRITE_ERROR_CODES.has(errorCode))) ||
    !boundedText(value.createdAt, 128, true) || !boundedText(value.updatedAt, 128, true)
  ) throw malformed();
  if (state === "succeeded" && (sourceId === null || errorCode !== null)) throw malformed();
  if (state === "rejected" && (sourceId !== null || errorCode === null)) throw malformed();
  if ((state === "pending" || state === "uncertain") && sourceId !== null) throw malformed();
  if (state === "pending" && errorCode !== null) throw malformed();
  if (state === "uncertain" && errorCode === null) throw malformed();
  return {
    idempotencyKey: value.idempotencyKey,
    state: state as ResearchSourceWriteState,
    sourceId,
    errorCode,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function parseResearchSourceWriteResult(value: unknown, expectedKey: string): ResearchSourceWriteResult {
  if (!envelope(value) || !Object.prototype.hasOwnProperty.call(value, "receipt") ||
    (Object.prototype.hasOwnProperty.call(value, "replayed") && typeof value.replayed !== "boolean")) throw malformed();
  return {
    receipt: parseResearchSourceWriteReceipt(value.receipt, expectedKey),
    replayed: value.replayed === true,
  };
}

function responseError(value: unknown): string {
  return object(value) && typeof value.error === "string" && ERROR_CODE_PATTERN.test(value.error)
    ? value.error : "research_request_failed";
}

const sourceWriteBase = (notebookId: string) =>
  `/api/research/notebooks/${encodeURIComponent(notebookId)}/engine/sources`;
const sourceWriteReceiptBase = (notebookId: string) =>
  `/api/research/notebooks/${encodeURIComponent(notebookId)}/engine/write-receipts`;

export async function createResearchSource(
  notebookId: string,
  title: string,
  content: string,
  csrf: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ResearchSourceWriteResult> {
  assertNotebookId(notebookId);
  assertIdempotencyKey(idempotencyKey);
  if (typeof csrf !== "string" || !csrf) throw new ResearchRequestError(0, "invalid_research_request");
  validateWriteText(title, content);
  const result = await researchRequestWithStatus(
    sourceWriteBase(notebookId),
    "POST",
    { title, content },
    csrf,
    idempotencyKey,
    signal,
  );
  if (result.status === 200 || result.status === 201) {
    const parsed = parseResearchSourceWriteResult(result.body, idempotencyKey);
    if (parsed.receipt.state !== "succeeded" || (result.status === 200 && !parsed.replayed) || (result.status === 201 && parsed.replayed)) throw malformed();
    return parsed;
  }
  if (result.status === 409 || result.status === 502 || result.status === 503) {
    if (object(result.body) && Object.prototype.hasOwnProperty.call(result.body, "receipt")) {
      const parsed = parseResearchSourceWriteResult(result.body, idempotencyKey);
      if (parsed.receipt.state === "succeeded") throw malformed();
      if (result.status === 502 && (parsed.receipt.state !== "rejected" || parsed.replayed)) throw malformed();
      if (result.status === 503 && (!["pending", "uncertain"].includes(parsed.receipt.state) || parsed.replayed)) throw malformed();
      if (result.status === 409 && parsed.receipt.state === "rejected" && !parsed.replayed) throw malformed();
      if (result.status === 409 && parsed.receipt.state !== "rejected" && parsed.replayed) throw malformed();
      return parsed;
    }
  }
  throw new ResearchRequestError(result.status, responseError(result.body));
}

export async function getResearchSourceWriteReceipt(
  notebookId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ResearchSourceWriteReceipt> {
  assertNotebookId(notebookId);
  assertIdempotencyKey(idempotencyKey);
  const value = await researchRequest(
    `${sourceWriteReceiptBase(notebookId)}/${encodeURIComponent(idempotencyKey)}`,
    "GET",
    undefined,
    undefined,
    undefined,
    signal,
  );
  if (!envelope(value) || !Object.prototype.hasOwnProperty.call(value, "receipt")) throw malformed();
  return parseResearchSourceWriteReceipt(value.receipt, idempotencyKey);
}
