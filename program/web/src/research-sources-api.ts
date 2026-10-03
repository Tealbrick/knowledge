import { researchRequest, ResearchRequestError } from "./research-chat-api";

export type ResearchSourceSummary = Readonly<{
  id: string;
  title: string | null;
  topics: readonly string[] | null;
  asset: { readonly url: string | null } | null;
  embedded: boolean;
  embeddedChunks: number;
  insightsCount: number | null;
  fileAvailable: boolean | null;
  created: string;
  updated: string;
  commandId: string | null;
  status: string | null;
}>;

export type ResearchSourceDetail = ResearchSourceSummary & Readonly<{
  fullText: string | null;
}>;

export type ResearchSourcePage = Readonly<{
  sources: readonly ResearchSourceSummary[];
  pagination: { readonly limit: number; readonly offset: number };
}>;

export const RESEARCH_SOURCE_PAGE_LIMIT = 50;
const NOTEBOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SOURCE_ID_PATTERN = /^source:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, max = 4096): value is string =>
  typeof value === "string" && new TextEncoder().encode(value).byteLength <= max;
const nullableText = (value: unknown, max = 4096): value is string | null =>
  value === null || boundedText(value, max);
const nonNegativeInteger = (value: unknown, maximum = 10_000_000): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const malformed = () => new ResearchRequestError(0, "invalid_research_response");

function assertNotebookId(value: string): void {
  if (typeof value !== "string" || !NOTEBOOK_ID_PATTERN.test(value)) {
    throw new ResearchRequestError(0, "invalid_research_request");
  }
}

function assertSourceId(value: string): void {
  if (typeof value !== "string" || !SOURCE_ID_PATTERN.test(value)) {
    throw new ResearchRequestError(0, "invalid_research_request");
  }
}

function envelope(value: unknown): value is Record<string, unknown> {
  return object(value) && value.provider === "open_notebook" && object(value.contractBaseline);
}

function source(value: unknown, detail: boolean): ResearchSourceSummary | ResearchSourceDetail {
  if (!object(value) || !SOURCE_ID_PATTERN.test(typeof value.id === "string" ? value.id : "")) throw malformed();
  if (
    !nullableText(value.title) ||
    !(value.topics === null || (Array.isArray(value.topics) && value.topics.length <= 100 && value.topics.every((topic) => boundedText(topic, 512)))) ||
    !(value.asset === null || (object(value.asset) && nullableText(value.asset.url, 4096))) ||
    typeof value.embedded !== "boolean" ||
    !nonNegativeInteger(value.embeddedChunks) ||
    !(value.insightsCount === null || nonNegativeInteger(value.insightsCount)) ||
    !(value.fileAvailable === null || typeof value.fileAvailable === "boolean") ||
    !boundedText(value.created, 128) ||
    !boundedText(value.updated, 128) ||
    !nullableText(value.commandId, 256) ||
    !nullableText(value.status, 256)
  ) throw malformed();
  const sourceId = value.id as string;
  const title = value.title as string | null;
  const topics = value.topics as readonly string[] | null;
  const asset = value.asset as { readonly url: string | null } | null;
  const embedded = value.embedded as boolean;
  const embeddedChunks = value.embeddedChunks as number;
  const insightsCount = value.insightsCount as number | null;
  const fileAvailable = value.fileAvailable as boolean | null;
  const created = value.created as string;
  const updated = value.updated as string;
  const commandId = value.commandId as string | null;
  const status = value.status as string | null;
  const projected: ResearchSourceSummary = {
    id: sourceId,
    title,
    topics,
    asset: asset === null ? null : { url: asset.url },
    embedded,
    embeddedChunks,
    insightsCount,
    fileAvailable,
    created,
    updated,
    commandId,
    status,
  };
  if (!detail) return projected;
  if (!nullableText(value.fullText, MAX_TEXT_BYTES)) throw malformed();
  return { ...projected, fullText: value.fullText as string | null };
}

export function parseResearchSourcePage(value: unknown, expected: { readonly limit: number; readonly offset: number }): ResearchSourcePage {
  if (!envelope(value) || !Array.isArray(value.sources) || !object(value.pagination) ||
    value.sources.length > expected.limit ||
    value.pagination.limit !== expected.limit || value.pagination.offset !== expected.offset ||
    !Number.isSafeInteger(value.pagination.limit) || value.pagination.limit < 1 || value.pagination.limit > 100 ||
    !Number.isSafeInteger(value.pagination.offset) || value.pagination.offset < 0 || value.pagination.offset > 10_000_000) {
    throw malformed();
  }
  const seen = new Set<string>();
  const sources = value.sources.map((item) => {
    const projected = source(item, false);
    if (seen.has(projected.id)) throw malformed();
    seen.add(projected.id);
    return projected;
  });
  return { sources, pagination: { limit: value.pagination.limit, offset: value.pagination.offset } };
}

export function parseResearchSourceDetail(value: unknown, expectedSourceId: string): ResearchSourceDetail {
  if (!envelope(value) || !Object.prototype.hasOwnProperty.call(value, "source")) throw malformed();
  const projected = source(value.source, true) as ResearchSourceDetail;
  if (projected.id !== expectedSourceId) throw malformed();
  return projected;
}

const sourceBase = (notebookId: string) =>
  `/api/research/notebooks/${encodeURIComponent(notebookId)}/engine/sources`;

export async function listResearchSources(
  notebookId: string,
  offset = 0,
  signal?: AbortSignal,
): Promise<ResearchSourcePage> {
  assertNotebookId(notebookId);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) {
    throw new ResearchRequestError(0, "invalid_research_request");
  }
  const value = await researchRequest(
    `${sourceBase(notebookId)}?limit=${RESEARCH_SOURCE_PAGE_LIMIT}&offset=${offset}`,
    "GET",
    undefined,
    undefined,
    undefined,
    signal,
  );
  return parseResearchSourcePage(value, { limit: RESEARCH_SOURCE_PAGE_LIMIT, offset });
}

export async function getResearchSource(
  notebookId: string,
  sourceId: string,
  signal?: AbortSignal,
): Promise<ResearchSourceDetail> {
  assertNotebookId(notebookId);
  assertSourceId(sourceId);
  const value = await researchRequest(
    `${sourceBase(notebookId)}/${encodeURIComponent(sourceId)}`,
    "GET",
    undefined,
    undefined,
    undefined,
    signal,
  );
  return parseResearchSourceDetail(value, sourceId);
}
