/**
 * v0.32.2 — forget-as-fence path (Codex R2-#3).
 *
 * Before v0.32.2 `gbrain forget` and the MCP `forget_fact` op called
 * `engine.expireFact(id)` directly, which UPDATEs `facts.expired_at`
 * in the DB. After `gbrain rebuild` (v0.32.3) that DB-only mutation
 * would evaporate because the canonical markdown fence is unchanged
 * — the forget would un-happen.
 *
 * The fix: forget becomes a fence rewrite. Strike through the target
 * row's `claim` cell, set its `valid_until` to today, append
 * `forgotten: <reason>` to its `context` cell. The DB's existing
 * `expired_at = valid_until + now()` rule reconstructs the forget
 * state on every rebuild because the fence is canonical.
 *
 * Strikethrough parse contract (extends commit 2's two-mode design):
 *   `~~claim~~` + `context: superseded by #N`    → supersededBy=N
 *   `~~claim~~` + `context: forgotten: <reason>` → forgotten=true
 *   `~~claim~~` + anything else                  → active=false; the
 *      mapper treats this as forgotten for DB-derivation purposes.
 *
 * Two-tier fallback for cross-state safety:
 *   1. If the target row has v51 columns (row_num + source_markdown_slug
 *      + sources.local_path), do the fence rewrite. The forget survives
 *      rebuild.
 *   2. If any of those is missing (pre-v51 legacy row, NULL entity_slug,
 *      no local_path on the source), fall through to the legacy
 *      `engine.expireFact(id)` direct-DB path. A once-per-process
 *      stderr warning names the case so operators see the degraded
 *      mode. These forgets DO NOT survive rebuild — the architecture
 *      doc names this as the explicit DB-only exception for legacy
 *      / thin-client state.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

import type { BrainEngine } from '../engine.ts';
import { withPageLock } from '../page-lock.ts';
import { resolvePageWriteTarget } from '../write-through.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../facts-fence.ts';

export interface ForgetFactResult {
  /** True iff the row was found AND a forget was applied (fence or DB). */
  ok: boolean;
  /** Discriminator on the path that handled the forget. */
  path: 'fence' | 'legacy_db' | 'not_found' | 'already_expired';
  /** Human-readable reason captured in `context`; mirrors back what was written. */
  reason: string;
}

interface FactDbRow {
  id: string;
  source_id: string;
  entity_slug: string | null;
  row_num: number | null;
  source_markdown_slug: string | null;
  expired_at: Date | null;
  visibility: string;
}

interface SourceRow {
  id: string;
  local_path: string | null;
}

/** Format today's date as 'YYYY-MM-DD' UTC. Matches extract-from-fence's helper. */
function todayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString().slice(0, 10);
}

/**
 * Forget a fact by id. Routes through the fence when the row carries
 * v51 columns + the source has a local_path; falls through to legacy
 * `expireFact` otherwise. Idempotent: returns `already_expired` when
 * the row's `expired_at` is already non-null.
 *
 * Reason defaults to `'forgotten'` when the caller doesn't provide one
 * (matches the existing `gbrain forget` CLI which takes no reason
 * argument). MCP `forget_fact` op can pass a more specific reason
 * when the user provides it.
 */
export async function forgetFactInFence(
  engine: BrainEngine,
  factId: number,
  opts: {
    reason?: string;
    /**
     * MEMORY_VERBS v1 trust boundary [ship P1.1]: when set, the fact must
     * belong to this source or the call returns `not_found` (indistinguishable
     * from a truly-missing id — no cross-source existence leak). The `forget`
     * verb passes ctx.sourceId so a remote caller scoped to source A cannot
     * expire facts in source B by guessing global ids.
     */
    sourceId?: string;
    /** Federated remote grant; takes precedence over sourceId when non-empty. */
    sourceIds?: string[];
    /**
     * When true (remote callers), the fact must be visibility='world' or the
     * call returns `not_found` — a remote caller can't expire private facts it
     * could never read (mirrors recall's remote posture).
     */
    worldOnly?: boolean;
    /** Link a successfully expired row to the fact that superseded it. */
    supersededBy?: number;
  } = {},
): Promise<ForgetFactResult> {
  const reason = opts.reason ?? 'forgotten';
  const scopedExpire = (sourceId = opts.sourceId) => engine.expireFact(factId, { // gbrain-allow-direct-insert: source/world-scoped legacy fallback when canonical fence rewrite is unavailable
    ...(sourceId !== undefined ? { sourceId } : {}),
    ...(opts.worldOnly === true ? { worldOnly: true } : {}),
    ...(opts.supersededBy !== undefined ? { supersededBy: opts.supersededBy } : {}),
  });

  const rows = await engine.executeRaw<FactDbRow>(
    `SELECT id, source_id, entity_slug, row_num, source_markdown_slug, expired_at, visibility
       FROM facts WHERE id = $1
         AND (($2::text[] IS NOT NULL AND source_id = ANY($2::text[]))
           OR ($2::text[] IS NULL AND ($3::boolean = true OR source_id = $4)))
         AND ($5::boolean = false OR visibility = 'world')`,
    [factId, opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : null,
      opts.sourceId === undefined, opts.sourceId ?? null, opts.worldOnly === true],
  );
  // Trust-boundary scope check BEFORE any state inspection: a row outside the
  // caller's source (or private, for remote callers) is reported as not_found,
  // never distinguished from a missing id.
  if (rows.length === 0) {
    return { ok: false, path: 'not_found', reason };
  }
  const row = rows[0];

  if (row.expired_at !== null) {
    return { ok: false, path: 'already_expired', reason };
  }

  // Fence path requires: v51 columns set + source.local_path set.
  const canFence =
    row.row_num !== null &&
    row.source_markdown_slug !== null &&
    row.entity_slug !== null;

  if (!canFence) {
    // Legacy path — DB-only forget. Doesn't survive `gbrain rebuild`.
    const ok = await scopedExpire(row.source_id); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
    return { ok, path: 'legacy_db', reason };
  }

  // Look up source.local_path.
  const sources = await engine.executeRaw<SourceRow>(
    `SELECT id, local_path FROM sources WHERE id = $1 LIMIT 1`,
    [row.source_id],
  );
  const localPath = sources[0]?.local_path ?? null;
  if (!localPath) {
    const ok = await scopedExpire(row.source_id); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
    return { ok, path: 'legacy_db', reason };
  }

  const slug = row.source_markdown_slug!;
  const targetRowNum = row.row_num!;
  // #4204: resolve the fence file the same way writeFactsToFence /
  // writePageThrough do (recorded source_path preference, own-local_path
  // root). A bare `join(localPath, slug.md)` misses fences that live in a
  // human-named vault file, degrading forget to a DB-only expire while the
  // fence keeps the live row for the next absorb to resurrect.
  const resolved = await resolvePageWriteTarget(engine, slug, row.source_id);
  if (!resolved.ok) {
    const ok = await scopedExpire(row.source_id); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
    return { ok, path: 'legacy_db', reason };
  }
  const filePath = resolved.filePath;
  const tmpPath = `${filePath}.tmp`;

  if (!existsSync(filePath)) {
    // File deleted out from under us — only the DB has the row.
    // Legacy path is the safe behavior; the operator can fix the
    // tree mismatch separately.
    const ok = await scopedExpire(row.source_id); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
    return { ok, path: 'legacy_db', reason };
  }

  return withPageLock(slug, async () => {
    // Re-read under the page lock: the row may have changed source, fence
    // identity, state, or visibility since target selection above.
    const currentRows = await engine.executeRaw<FactDbRow>(
      `SELECT id, source_id, entity_slug, row_num, source_markdown_slug, expired_at, visibility
         FROM facts WHERE id = $1
           AND (($2::text[] IS NOT NULL AND source_id = ANY($2::text[]))
             OR ($2::text[] IS NULL AND ($3::boolean = true OR source_id = $4)))
           AND ($5::boolean = false OR visibility = 'world')`,
      [factId, opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : null,
        opts.sourceId === undefined, opts.sourceId ?? null, opts.worldOnly === true],
    );
    if (currentRows.length === 0) return { ok: false, path: 'not_found', reason };
    const current = currentRows[0];
    if (current.expired_at !== null) return { ok: false, path: 'already_expired', reason };
    if (
      current.source_id !== row.source_id ||
      current.entity_slug !== row.entity_slug ||
      current.row_num !== row.row_num ||
      current.source_markdown_slug !== row.source_markdown_slug ||
      current.visibility !== row.visibility
    ) return { ok: false, path: 'not_found', reason };
    const currentSources = await engine.executeRaw<SourceRow>(
      'SELECT id, local_path FROM sources WHERE id = $1 LIMIT 1',
      [current.source_id],
    );
    if ((currentSources[0]?.local_path ?? null) !== localPath) {
      return { ok: false, path: 'not_found', reason };
    }

    const body = readFileSync(filePath, 'utf-8');
    const parsed = parseFactsFence(body);

    // Find the target row in the fence by row_num.
    const target = parsed.facts.find(f => f.rowNum === targetRowNum);
    if (!target) {
      // Fence is missing the row — DB drifted from markdown. Fall
      // through to legacy expire so the user's intent succeeds; doctor
      // surfaces the drift separately.
      const ok = await scopedExpire(row.source_id); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
      return { ok, path: 'legacy_db', reason };
    }

    // Markdown is canonical: an owner may have made this row private before
    // the database projection catches up. Remote authority must hold in both.
    if (opts.worldOnly === true && target.visibility !== 'world') {
      return { ok: false, path: 'not_found', reason };
    }

    // Mutate: strike out claim (already-strikethrough rows stay
    // strikethrough), set valid_until = today, append "forgotten:
    // <reason>" to context (preserving any existing context).
    const today = todayUtc();
    const existingContext = target.context?.trim() ?? '';
    const newContext = existingContext
      ? `${existingContext} | forgotten: ${reason}`
      : `forgotten: ${reason}`;

    const updated: ParsedFact[] = parsed.facts.map(f =>
      f.rowNum === targetRowNum
        ? {
            ...f,
            active: false,        // strikethrough on render
            validUntil: today,
            context: newContext,
            forgotten: true,
          }
        : f,
    );

    // Render + atomic .tmp + parse-validate + rename.
    const newFence = renderFactsTable(updated);
    const begin = body.indexOf('<!--- gbrain:facts:begin -->');
    const end   = body.indexOf('<!--- gbrain:facts:end -->', begin + 1);
    if (begin === -1 || end === -1) {
      // Race / corruption: fence disappeared between parse and render.
      // Legacy fallback.
      const ok = await scopedExpire(row.source_id); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
      return { ok, path: 'legacy_db', reason };
    }
    const newBody = body.slice(0, begin) + newFence + body.slice(end + '<!--- gbrain:facts:end -->'.length);

    writeFileSync(tmpPath, newBody, 'utf-8');
    const tmpBody = readFileSync(tmpPath, 'utf-8');
    const validate = parseFactsFence(tmpBody);
    if (validate.warnings.length > 0) {
      // Quarantine .tmp; leave the canonical file alone; fall back to
      // DB expire so the user's forget intent still succeeds.
      const ok = await scopedExpire(row.source_id); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
      return { ok, path: 'legacy_db', reason };
    }
    // Guard the actual DB mutation with source + visibility + fence identity.
    // Do it before replacing the canonical file so a failed scope check cannot
    // leave a private or moved row struck through on disk.
    const updatedRows = await engine.executeRaw<{ id: string }>(
      `UPDATE facts SET valid_until = $1, expired_at = now(),
         superseded_by = COALESCE($2, superseded_by)
       WHERE id = $3 AND source_id = $4 AND expired_at IS NULL
         AND entity_slug = $5 AND row_num = $6 AND source_markdown_slug = $7
         AND ($8::boolean = false OR visibility = 'world')
       RETURNING id`,
      [today, opts.supersededBy ?? null, factId, row.source_id, row.entity_slug, targetRowNum, slug, opts.worldOnly === true],
    );
    if (updatedRows.length === 0) {
      try { unlinkSync(tmpPath); } catch { /* temp cleanup is best-effort */ }
      return { ok: false, path: 'not_found', reason };
    }

    renameSync(tmpPath, filePath);

    return { ok: true, path: 'fence', reason };
  }, { timeoutMs: 5_000 });
}
