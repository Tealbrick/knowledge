/**
 * Knowledge-side enforcement of the GBrain privacy fixes that unmodified upstream
 * (v0.60.127.0) does not yet carry, or carries only partly (A1, A6, A9, A13). Applied to every result a separate GBrain service
 * returns, before it leaves Knowledge. Each rule fails closed: when Knowledge cannot
 * prove a value is world-visible inside the caller's source, it is withheld.
 *
 *   A1/A2/A3 remember never writes private facts (refused at dispatch), so remote
 *            dedupe/supersession can only match world targets (upstream's same-visibility rule).
 *   A4       forget's markdown-fence mirror only runs for sources with a local path;
 *            Knowledge sources are created without one, so the DB-guarded path is used.
 *   A6       pending_consolidation_count is withheld (it counts private facts too).
 *   A7       every facts/takes privacy fence is stripped from returned text; nested,
 *            overlapping or unclosed fences drop everything they could contain.
 *            Upstream has its own strip since v0.60.58; this stays as defence in depth.
 *   A9       link/graph rows naming another source are dropped.
 *   A13      entity-card open_loops are withheld (evidence visibility is not provable here).
 */
const FENCE = /<!---\s*gbrain:(facts|takes):(begin|end)\s*-->/giu;
const WITHHELD_KEYS = new Set(["pending_consolidation_count", "open_loops"]);
const MAX_DEPTH = 64;

/** Remove every privacy fence region in one forward pass (A7). */
export function stripPrivacyFences(text: string): string {
  if (!/gbrain:/iu.test(text)) return text;
  let output = "";
  let depth = 0;
  let cursor = 0;
  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(text); match; match = FENCE.exec(text)) {
    if (depth === 0) output += text.slice(cursor, match.index);
    if (match[2]!.toLowerCase() === "begin") depth++;
    else if (depth > 0) depth--;
    // An end marker with no open fence is dropped; its surrounding text is kept.
    cursor = match.index + match[0].length;
  }
  // An unclosed fence hides everything after it.
  return depth === 0 ? output + text.slice(cursor) : output;
}

function foreignSource(value: Record<string, unknown>, sourceId: string): boolean {
  return Object.entries(value).some(([key, item]) => /(?:^|_)source_id$/u.test(key) && typeof item === "string" && item !== "__all__" && item !== sourceId);
}

/** Deep-sanitize a GBrain service result for the caller's single source. */
export function sanitizeGBrainResult(data: unknown, sourceId: string, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof data === "string") return stripPrivacyFences(data);
  if (Array.isArray(data)) {
    return data
      .filter(item => !(item && typeof item === "object" && !Array.isArray(item) && foreignSource(item as Record<string, unknown>, sourceId)))
      .map(item => sanitizeGBrainResult(item, sourceId, depth + 1));
  }
  if (data && typeof data === "object") {
    return Object.fromEntries(Object.entries(data as Record<string, unknown>)
      .filter(([key]) => !WITHHELD_KEYS.has(key))
      .map(([key, value]) => [key, sanitizeGBrainResult(value, sourceId, depth + 1)]));
  }
  return data;
}
