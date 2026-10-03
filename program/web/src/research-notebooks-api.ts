import { researchRequest, ResearchRequestError } from "./research-chat-api";

export type ResearchNotebook = Readonly<{ id: string; name: string; description: string }>;
export type ResearchNotebookPage = Readonly<{
  notebooks: readonly ResearchNotebook[];
  pagination: { readonly limit: number; readonly offset: number; readonly hasMore: boolean };
}>;
export const RESEARCH_NOTEBOOK_PAGE_LIMIT = 50;
export const RESEARCH_NOTEBOOK_MAX_MAPPINGS = 200;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, bytes: number): value is string =>
  typeof value === "string" && new TextEncoder().encode(value).byteLength <= bytes;
const invalid = () => new ResearchRequestError(0, "invalid_research_response");

export function parseResearchNotebookPage(value: unknown, offset: number): ResearchNotebookPage {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > RESEARCH_NOTEBOOK_MAX_MAPPINGS ||
    !object(value) || value.provider !== "open_notebook" || !Array.isArray(value.notebooks) ||
    value.notebooks.length > RESEARCH_NOTEBOOK_PAGE_LIMIT || !object(value.pagination) ||
    offset + value.notebooks.length > RESEARCH_NOTEBOOK_MAX_MAPPINGS ||
    value.pagination.limit !== RESEARCH_NOTEBOOK_PAGE_LIMIT || value.pagination.offset !== offset ||
    typeof value.pagination.hasMore !== "boolean" ||
    (value.pagination.hasMore && (value.notebooks.length !== RESEARCH_NOTEBOOK_PAGE_LIMIT ||
      offset + value.notebooks.length >= RESEARCH_NOTEBOOK_MAX_MAPPINGS))) throw invalid();
  const ids = new Set<string>();
  const notebooks = value.notebooks.map(entry => {
    if (!object(entry) || typeof entry.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(entry.id) ||
      !text(entry.name, 4096) || !text(entry.description, 16384) || ids.has(entry.id)) throw invalid();
    ids.add(entry.id);
    return { id: entry.id, name: entry.name, description: entry.description };
  });
  return { notebooks, pagination: { limit: RESEARCH_NOTEBOOK_PAGE_LIMIT, offset, hasMore: value.pagination.hasMore } };
}

export async function listResearchNotebooks(offset = 0, signal?: AbortSignal): Promise<ResearchNotebookPage> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > RESEARCH_NOTEBOOK_MAX_MAPPINGS) {
    throw new ResearchRequestError(0, "invalid_research_request");
  }
  return parseResearchNotebookPage(await researchRequest(
    `/api/research/engine/notebooks?limit=${RESEARCH_NOTEBOOK_PAGE_LIMIT}&offset=${offset}`,
    "GET", undefined, undefined, undefined, signal,
  ), offset);
}
