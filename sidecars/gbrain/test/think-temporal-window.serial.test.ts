import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runGather } from '../src/core/think/gather.ts';
import {
  filterPagesToWindow,
  parseTemporalWindow,
  resolvePageDateMs,
  TemporalWindowError,
} from '../src/core/think/temporal-window.ts';
import { __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import type { ChunkInput, SearchResult } from '../src/core/types.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;

async function seed(slug: string, body: string, effective?: string, type = 'note') {
  await engine.putPage(slug, {
    title: slug,
    type,
    compiled_truth: body,
    ...(effective ? { effective_date: new Date(effective), effective_date_source: 'date' as const } : {}),
  });
  const chunks: ChunkInput[] = [{
    chunk_index: 0,
    chunk_text: body,
    chunk_source: 'compiled_truth',
    token_count: 10,
  }];
  await engine.upsertChunks(slug, chunks);
}

beforeAll(async () => {
  __setEmbedTransportForTests(() => { throw new Error('keyword-only test'); });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seed('brain/ops/2026-07-18', 'operations update release green', '2026-07-18T09:00:00Z');
  await seed('brain/ops/2026-06-01', 'operations update old rollback', '2026-06-01T09:00:00Z', 'meeting');
  await seed('brain/ops/2026-07-17', 'xyzzy vocabulary absent from query', '2026-07-17T12:00:00Z', 'idea');
  await seed('brain/ops/undated', 'operations update timeless guidance');
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  await engine.disconnect();
});

describe('temporal-window parsing', () => {
  test('date bounds are inclusive UTC days', () => {
    const window = parseTemporalWindow('2026-07-17', '2026-07-18')!;
    expect(new Date(window.startMs!).toISOString()).toBe('2026-07-17T00:00:00.000Z');
    expect(new Date(window.endMs!).toISOString()).toBe('2026-07-18T23:59:59.999Z');
  });

  test('month bounds expand to the whole month', () => {
    const window = parseTemporalWindow('2026-02', '2026-02')!;
    expect(new Date(window.endMs!).toISOString()).toBe('2026-02-28T23:59:59.999Z');
  });

  test('open and absent bounds remain distinct', () => {
    expect(parseTemporalWindow('2026-07-17')!.endMs).toBeNull();
    expect(parseTemporalWindow(undefined, '2026-07-18')!.startMs).toBeNull();
    expect(parseTemporalWindow()).toBeNull();
  });

  test('invalid and inverted ranges fail clearly', () => {
    expect(() => parseTemporalWindow('2026-02-30')).toThrow(TemporalWindowError);
    expect(() => parseTemporalWindow('2026-07-18', '2026-07-17')).toThrow(/since.*after.*until/);
  });
});

describe('effective-date policy', () => {
  const result = (slug: string, effective_date: string | null): SearchResult => ({
    slug, effective_date, page_id: 1, title: slug, type: 'note', chunk_text: '',
    chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0, score: 1, stale: false,
  });

  test('effective date wins, then slug date; truly undated evidence is counted and kept', () => {
    const window = parseTemporalWindow('2026-07-17', '2026-07-18')!;
    const filtered = filterPagesToWindow([
      result('in', '2026-07-18'),
      result('brain/ops/2026-06-01', null),
      result('undated', null),
    ], window);
    expect(filtered.kept.map(page => page.slug)).toEqual(['in', 'undated']);
    expect(filtered.droppedOutOfWindow).toBe(1);
    expect(filtered.undatedKept).toBe(1);
    expect(resolvePageDateMs({ slug: 'brain/ops/2026-07-17' })).not.toBeNull();
  });
});

describe('engine and gather enforcement', () => {
  const window = parseTemporalWindow('2026-07-17', '2026-07-18')!;

  test('bounded listPages is inclusive and excludes NULL effective dates', async () => {
    const pages = await engine.listPages({
      effective_after: new Date(window.startMs!).toISOString(),
      effective_before: new Date(window.endMs!).toISOString(),
      slugPrefix: 'brain/ops/',
    });
    expect(pages.map(page => page.slug).sort()).toEqual([
      'brain/ops/2026-07-17',
      'brain/ops/2026-07-18',
    ]);
  });

  test('bounded gather excludes old relevance and supplies a nonmatching in-window page', async () => {
    const gathered = await runGather(engine, { question: 'operations update', window });
    const slugs = gathered.pages.map(page => page.slug);
    expect(slugs).toContain('brain/ops/2026-07-18');
    expect(slugs).toContain('brain/ops/2026-07-17');
    expect(slugs).not.toContain('brain/ops/2026-06-01');
    expect(gathered.diagnostics.window?.dropped).toBeGreaterThan(0);
  });

  test('no bounds preserves ordinary relevance behavior', async () => {
    const gathered = await runGather(engine, { question: 'operations update' });
    expect(gathered.pages.map(page => page.slug)).toContain('brain/ops/2026-06-01');
    expect(gathered.diagnostics.window).toBeUndefined();
  });

  test('remote gather hides a private anchor even when the same slug is public in another granted source', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('shared', 'shared', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    const privatePage = await engine.putPage('notes/anchor-collision', {
      type: 'note',
      title: 'Private collision', frontmatter: { visibility: 'private' },
      compiled_truth: 'PRIVATE_ANCHOR_COLLISION_SENTINEL',
    }, { sourceId: 'default' });
    await engine.putPage('notes/anchor-collision', {
      type: 'note',
      title: 'World collision', frontmatter: { visibility: 'world' },
      compiled_truth: 'Public content unrelated to the private question.',
    }, { sourceId: 'shared' });

    const originalGetPage = engine.getPage.bind(engine);
    engine.getPage = (async (slug, opts) => slug === 'notes/anchor-collision'
      ? originalGetPage(slug, { sourceId: 'default' })
      : originalGetPage(slug, opts)) as typeof engine.getPage;
    try {
      const remote = await runGather(engine, {
        question: 'PRIVATE_ANCHOR_COLLISION_SENTINEL',
        anchor: 'notes/anchor-collision',
        sourceIds: ['default', 'shared'],
        excludePrivate: true,
      });
      expect(remote.pages.map(page => page.chunk_text).join('\n')).not.toContain('PRIVATE_ANCHOR_COLLISION_SENTINEL');
      const localPage = await engine.getPage('notes/anchor-collision', { sourceId: 'default' });
      expect(localPage?.compiled_truth).toContain('PRIVATE_ANCHOR_COLLISION_SENTINEL');
    } finally {
      engine.getPage = originalGetPage;
      await engine.executeRaw('DELETE FROM pages WHERE id = $1', [privatePage.id]);
    }
  });

  test('remote gather strips private facts and all takes from an otherwise world page before prompt or fallback use', async () => {
    const body = [
      'Public summary for the anchor.',
      FACTS_FENCE_BEGIN,
      '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
      '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
      '| 1 | WORLD_FACT_CONTROL | fact | 1.0 | world | high | 2026-01-01 |  | test |  |',
      '| 2 | PRIVATE_FACT_SENTINEL | fact | 1.0 | private | high | 2026-01-01 |  | test |  |',
      FACTS_FENCE_END,
      TAKES_FENCE_BEGIN,
      '| # | claim | kind | who | weight | since | source |',
      '| 1 | PRIVATE_TAKE_SENTINEL | take | garry | 0.9 | 2026-01 | test |',
      TAKES_FENCE_END,
    ].join('\n');
    await engine.putPage('notes/fenced-anchor', {
      type: 'note',
      title: 'Fenced anchor', frontmatter: { visibility: 'world' }, compiled_truth: body,
    });
    const gatheredRemote = await runGather(engine, {
      question: 'PRIVATE_FACT_SENTINEL', anchor: 'notes/fenced-anchor', excludePrivate: true,
    });
    const remoteText = gatheredRemote.pages.map(page => page.chunk_text).join('\n');
    expect(remoteText).toContain('WORLD_FACT_CONTROL');
    expect(remoteText).not.toContain('PRIVATE_FACT_SENTINEL');
    expect(remoteText).not.toContain('PRIVATE_TAKE_SENTINEL');

    const gatheredLocal = await runGather(engine, {
      question: 'PRIVATE_FACT_SENTINEL', anchor: 'notes/fenced-anchor', sourceId: 'default', remote: false,
    });
    const localText = gatheredLocal.pages.map(page => page.chunk_text).join('\n');
    expect(localText).toContain('PRIVATE_FACT_SENTINEL');
    expect(localText).toContain('PRIVATE_TAKE_SENTINEL');

    const optedOutOfPrivatePages = await runGather(engine, {
      question: 'PRIVATE_FACT_SENTINEL', anchor: 'notes/fenced-anchor', sourceId: 'default',
      remote: true, excludePrivate: false,
    });
    const optedOutText = optedOutOfPrivatePages.pages.map(page => page.chunk_text).join('\n');
    expect(optedOutText).toContain('WORLD_FACT_CONTROL');
    expect(optedOutText).not.toContain('PRIVATE_FACT_SENTINEL');
    expect(optedOutText).not.toContain('PRIVATE_TAKE_SENTINEL');
  });

  test('remote gather sanitizes every facts/takes fence and fails closed on unclosed fences', async () => {
    const factsFence = (row: number, claim: string, visibility: string) => [
      FACTS_FENCE_BEGIN,
      '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
      '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
      `| ${row} | ${claim} | fact | 1.0 | ${visibility} | high | 2026-01-01 |  | test |  |`,
      FACTS_FENCE_END,
    ].join('\n');
    const multiFence = [
      '# Ordinary heading before fences',
      factsFence(1, 'MULTI_WORLD_CONTROL', 'world'),
      factsFence(2, 'MULTI_PRIVATE_FACT_SENTINEL', 'private'),
      TAKES_FENCE_BEGIN, '| private take sentinel |', TAKES_FENCE_END,
      TAKES_FENCE_BEGIN, '| second private take sentinel |', TAKES_FENCE_END,
      '# Ordinary heading after fences',
    ].join('\n');
    await engine.putPage('notes/multi-fence-anchor', {
      type: 'note', title: 'Multi fence anchor', frontmatter: { visibility: 'world' }, compiled_truth: multiFence,
    });
    expect((await engine.getPage('notes/multi-fence-anchor', { sourceId: 'default' }))?.compiled_truth).toContain('MULTI_WORLD_CONTROL');
    const multi = await runGather(engine, {
      question: 'MULTI_PRIVATE_FACT_SENTINEL', anchor: 'notes/multi-fence-anchor',
      sourceId: 'default', remote: true, excludePrivate: true,
    });
    const safe = multi.pages.map(page => page.chunk_text).join('\n');
    expect(safe).toContain('# Ordinary heading before fences');
    expect(safe).toContain('# Ordinary heading after fences');
    expect(safe).toContain('MULTI_WORLD_CONTROL');
    expect(safe).not.toContain('MULTI_PRIVATE_FACT_SENTINEL');
    expect(safe).not.toContain('private take sentinel');
    expect(safe).not.toContain('second private take sentinel');

    await engine.putPage('notes/unclosed-fence-anchor', {
      type: 'note', title: 'Unclosed fence anchor', frontmatter: { visibility: 'world' },
      compiled_truth: `# Public heading before malformed fence\n${FACTS_FENCE_BEGIN}\nPRIVATE_UNCLOSED_SENTINEL`,
    });
    const unclosed = await runGather(engine, {
      question: 'PRIVATE_UNCLOSED_SENTINEL', anchor: 'notes/unclosed-fence-anchor',
      sourceId: 'default', remote: true, excludePrivate: true,
    });
    const unclosedText = unclosed.pages.map(page => page.chunk_text).join('\n');
    expect(unclosedText).toContain('# Public heading before malformed fence');
    expect(unclosedText).not.toContain('PRIVATE_UNCLOSED_SENTINEL');
    expect(unclosedText).not.toContain(FACTS_FENCE_BEGIN);
  });
});
