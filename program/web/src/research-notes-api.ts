import { researchRequest, ResearchRequestError } from "./research-chat-api";

/**
 * A server-projected Open Notebook note. The fields are display/content data
 * only; the browser never receives an upstream credential or an authority
 * selector from this transport.
 */
export type ResearchNote = Readonly<{
  id: string;
  title: string | null;
  content: string | null;
  noteType: string | null;
  created: string;
  updated: string;
  commandId: string | null;
}>;

export const RESEARCH_NOTE_MAX_COUNT = 500;

const NOTEBOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const NOTE_ID_PATTERN = /^note:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MAX_TITLE_BYTES = 4 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_NOTE_TYPE_BYTES = 128;
const MAX_DATE_BYTES = 128;
const MAX_COMMAND_ID_BYTES = 256;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const boundedText = (value: unknown, maxBytes: number): value is string =>
  typeof value === "string" && new TextEncoder().encode(value).byteLength <= maxBytes;

const nullableText = (value: unknown, maxBytes: number): value is string | null =>
  value === null || boundedText(value, maxBytes);

const malformed = () => new ResearchRequestError(0, "invalid_research_response");

function assertNotebookId(value: string): void {
  if (typeof value !== "string" || !NOTEBOOK_ID_PATTERN.test(value)) {
    throw new ResearchRequestError(0, "invalid_research_request");
  }
}

function envelope(value: unknown): value is Record<string, unknown> {
  return object(value) && value.provider === "open_notebook" && object(value.contractBaseline);
}

function parseNote(value: unknown): ResearchNote {
  if (!object(value)) throw malformed();
  const id = typeof value.id === "string" ? value.id : null;
  if (id === null || !NOTE_ID_PATTERN.test(id) ||
    !nullableText(value.title, MAX_TITLE_BYTES) ||
    !nullableText(value.content, MAX_CONTENT_BYTES) ||
    !nullableText(value.noteType, MAX_NOTE_TYPE_BYTES) ||
    !boundedText(value.created, MAX_DATE_BYTES) || value.created.length === 0 ||
    !boundedText(value.updated, MAX_DATE_BYTES) || value.updated.length === 0 ||
    !nullableText(value.commandId, MAX_COMMAND_ID_BYTES)) {
    throw malformed();
  }
  return {
    id,
    title: value.title as string | null,
    content: value.content as string | null,
    noteType: value.noteType as string | null,
    created: value.created as string,
    updated: value.updated as string,
    commandId: value.commandId as string | null,
  };
}

/**
 * Parses the server's mapped-notebook notes envelope and projects only the
 * fields needed by the browser. Unknown additive upstream fields are ignored;
 * malformed, foreign, duplicate, or over-limit notes fail the whole page.
 */
export function parseResearchNotes(value: unknown): readonly ResearchNote[] {
  if (!envelope(value) || !Array.isArray(value.notes) || value.notes.length > RESEARCH_NOTE_MAX_COUNT) {
    throw malformed();
  }
  const seen = new Set<string>();
  const notes = value.notes.map((entry) => {
    const note = parseNote(entry);
    if (seen.has(note.id)) throw malformed();
    seen.add(note.id);
    return note;
  });
  return Object.freeze(notes);
}

export async function listResearchNotes(
  notebookId: string,
  signal?: AbortSignal,
): Promise<readonly ResearchNote[]> {
  assertNotebookId(notebookId);
  const value = await researchRequest(
    `/api/research/notebooks/${encodeURIComponent(notebookId)}/engine/notes`,
    "GET",
    undefined,
    undefined,
    undefined,
    signal,
  );
  return parseResearchNotes(value);
}

export async function getResearchNote(
  notebookId: string,
  noteId: string,
  signal?: AbortSignal,
): Promise<ResearchNote> {
  assertNotebookId(notebookId);
  if (typeof noteId !== "string" || !NOTE_ID_PATTERN.test(noteId)) {
    throw new ResearchRequestError(0, "invalid_research_request");
  }
  const value = await researchRequest(
    `/api/research/notebooks/${encodeURIComponent(notebookId)}/engine/notes/${encodeURIComponent(noteId)}`,
    "GET",
    undefined,
    undefined,
    undefined,
    signal,
  );
  if (!envelope(value) || !object(value.note)) throw malformed();
  const note = parseNote(value.note);
  if (note.id !== noteId) throw malformed();
  return note;
}
