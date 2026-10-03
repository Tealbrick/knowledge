/** Public memory surface, not the engine's host-administration surface.
 * Schemas/descriptions/results come from upstream operations, never copies here.
 */
export const MEMORY_VERBS = ["remember", "recall", "entity", "synthesize", "forget", "context_pack", "delta"] as const;
export const NATIVE_MEMORY_OPERATIONS = [...MEMORY_VERBS,
  "query", "search", "think", "get_page", "list_pages", "get_chunks", "resolve_slugs",
  "get_links", "get_backlinks", "traverse_graph", "get_timeline", "find_trajectory", "takes_list", "takes_search",
] as const;
export type NativeMemoryOperation = typeof NATIVE_MEMORY_OPERATIONS[number];
export function nativeMemoryOperation(name: string): name is NativeMemoryOperation {
  return (NATIVE_MEMORY_OPERATIONS as readonly string[]).includes(name);
}
export function nativeMemoryCapabilities(name: string): readonly string[] {
  // remember may deduplicate/supersede existing facts; do not disguise it as create-only.
  if (name === "remember") return ["knowledge:create", "knowledge:update"];
  if (name === "forget") return ["knowledge:delete"];
  return ["brain:read"];
}
export function nativeMemoryWrites(name: string): boolean { return name === "remember" || name === "forget"; }
export const NATIVE_MEMORY_GUIDANCE = `Knowledge contains memory (GBrain) and research (Open Notebook), not one substitute search tool.
Discover this catalog before calling native memory operations. Pass native snake_case arguments unchanged inside arguments; partitionKey is the authorized Knowledge partition, not a GBrain source selector.
Use recall for facts/snippets, entity for a known card, query/search to locate evidence, then get_page/get_chunks to read the answer-bearing source. A matching session or high score is not an answer.
Use synthesize for a cited answer across evidence, or think for the native richer synthesis result. These cost model tokens and may take minutes; inspect synthesis_status, warnings and gaps, never present extractive fallback as successful model synthesis.
Use remember with provenance and entity for durable facts; forget expires an owned fact with an audit trail. Both require an Idempotency-Key; retry the same request/key only, never invent a fresh key after an uncertain outcome.
Use context_pack at session start/after compaction; delta for changes since a cursor. Session cursors are isolated by authenticated principal, partition and session_id. A delta cursor is delivery state, not an exactly-once guarantee.
This surface follows native REMOTE semantics: world-visible facts within your partition only; private is native local-owner-only. include_private does not widen access. Legacy Knowledge private-memory endpoints remain separate. No host SQL, filesystem, credentials, source management or local-only administration is delegated.
Research tools retain their own notebook/source/chat contracts. Use them for research, and deliberately promote verified findings to documents/memory. Never claim missing or unconfigured capabilities succeeded.`;
