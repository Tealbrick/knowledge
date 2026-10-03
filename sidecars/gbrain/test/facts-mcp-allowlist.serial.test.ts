/**
 * v0.31 Phase 6 — MCP scope correctness on facts ops.
 *
 * Pins:
 *   - extract_facts → write scope
 *   - recall → read scope
 *   - forget_fact → write scope
 *   - All three present in operations[]
 *   - param shapes match the documented contract
 *
 * Serial test (mutates module-scoped engine state via dispatchToolCall +
 * subsequent reads).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('facts MCP ops registration + scope', () => {
  test('extract_facts is registered with write scope', () => {
    const op = operations.find(o => o.name === 'extract_facts');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('write');
    expect(op!.mutating).toBe(true);
    expect(op!.params.turn_text?.required).toBe(true);
    expect(op!.params.session_id).toBeDefined();
  });

  test('recall is registered with read scope', () => {
    const op = operations.find(o => o.name === 'recall');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('read');
    // recall should not be mutating.
    expect(op!.mutating).toBeFalsy();
    expect(op!.params.entity).toBeDefined();
    expect(op!.params.since).toBeDefined();
    expect(op!.params.session_id).toBeDefined();
  });

  test('forget_fact is registered with write scope', () => {
    const op = operations.find(o => o.name === 'forget_fact');
    expect(op).toBeDefined();
    expect(op!.scope).toBe('write');
    expect(op!.mutating).toBe(true);
    expect(op!.params.id?.required).toBe(true);
  });
});

describe('forget_fact dispatch', () => {
  test('forget_fact errors with fact_not_found on unknown id', async () => {
    const r = await dispatchToolCall(engine, 'forget_fact', { id: 99999 }, {
      remote: true, sourceId: 'default',
    });
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.error).toBe('fact_not_found');
  });

  test('forget_fact succeeds on valid id, then becomes idempotent-as-error', async () => {
    const inserted = await engine.insertFact(
      { fact: 'will be forgotten', kind: 'fact', source: 'test', visibility: 'world' },
      { source_id: 'default' },
    );
    const r1 = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: true, sourceId: 'default',
    });
    expect(r1.isError).toBeFalsy();

    const r2 = await dispatchToolCall(engine, 'forget_fact', { id: inserted.id }, {
      remote: true, sourceId: 'default',
    });
    expect(r2.isError).toBe(true);
    const payload = JSON.parse(r2.content[0].text);
    // v0.32.2: more precise discriminator. The first call expires the fact;
    // the second call sees expired_at IS NOT NULL and surfaces
    // `fact_already_expired` instead of the older opaque `fact_not_found`.
    expect(payload.error).toBe('fact_already_expired');
  });

  test('remote forget rejects private and foreign-source ids while local owner retains private deletion', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other-source', 'other-source') ON CONFLICT (id) DO NOTHING`);
    const privateFact = await engine.insertFact({
      fact: 'PRIVATE_FORGET_GUARD_SENTINEL', kind: 'fact', source: 'test', visibility: 'private',
    }, { source_id: 'default' });
    const foreignFact = await engine.insertFact({
      fact: 'FOREIGN_FORGET_GUARD_SENTINEL', kind: 'fact', source: 'test', visibility: 'world',
    }, { source_id: 'other-source' });

    for (const id of [privateFact.id, foreignFact.id]) {
      const denied = await dispatchToolCall(engine, 'forget_fact', { id }, {
        remote: true, sourceId: 'default',
      });
      expect(denied.isError).toBe(true);
      expect(JSON.parse(denied.content[0].text).error).toBe('fact_not_found');
    }
    const unchanged = await engine.executeRaw<{ expired_at: Date | null }>(
      'SELECT expired_at FROM facts WHERE id = ANY($1::bigint[])', [[privateFact.id, foreignFact.id]],
    );
    expect(unchanged.every(row => row.expired_at === null)).toBe(true);

    const grantedForeign = await dispatchToolCall(engine, 'forget_fact', { id: foreignFact.id }, {
      remote: true, sourceId: 'default',
      auth: { token: 'test', clientId: 'test', scopes: ['write'], allowedSources: ['other-source'] },
    });
    expect(grantedForeign.isError).toBeFalsy();

    const ownerForget = await dispatchToolCall(engine, 'forget_fact', { id: privateFact.id }, { remote: false });
    expect(ownerForget.isError).toBeFalsy();
    const after = await engine.executeRaw<{ expired_at: Date | null }>(
      'SELECT expired_at FROM facts WHERE id = $1', [privateFact.id],
    );
    expect(after[0].expired_at).not.toBeNull();
  });
});

describe('extract_facts dispatch (no API key)', () => {
  test('returns inserted=0 / duplicate=0 / superseded=0 when chat gateway unavailable', async () => {
    const r = await dispatchToolCall(engine, 'extract_facts', {
      turn_text: 'I am flying to Tokyo Tuesday.',
    }, { remote: true, sourceId: 'default' });
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.inserted).toBe(0);
    expect(payload.duplicate).toBe(0);
    expect(payload.superseded).toBe(0);
    expect(Array.isArray(payload.fact_ids)).toBe(true);
  });
});
