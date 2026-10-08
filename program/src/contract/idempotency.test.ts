import { describe, expect, it } from "vitest";

import { IDEMPOTENCY_KEY, createIdempotencyStore } from "./idempotency.js";

const scope = { agentId: "agent-a", partition: null, operation: "knowledge.documents.create" } as const;
const answer = Buffer.from('{"id":"doc-1"}');

describe("edge idempotency ledger", () => {
  it("replays a successful answer for the same key and body, and conflicts on another body", () => {
    const store = createIdempotencyStore(":memory:");
    const first = store.claim(scope, "key-1", '{"title":"A"}');
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    first.finish(201, { "content-type": "application/json" }, answer);
    expect(store.claim(scope, "key-1", '{"title":"A"}')).toMatchObject({ kind: "replay", status: 201, headers: { "content-type": "application/json" }, body: answer });
    expect(store.claim(scope, "key-1", '{"title":"B"}')).toEqual({ kind: "conflict" });
  });

  it("scopes a key to the agent, the partition and the operation", () => {
    const store = createIdempotencyStore(":memory:");
    const first = store.claim(scope, "key-1", "x");
    if (first.kind === "execute") first.finish(201, {}, answer);
    expect(store.claim({ ...scope, agentId: "agent-b" }, "key-1", "x").kind).toBe("execute");
    expect(store.claim({ ...scope, partition: "personal" }, "key-1", "x").kind).toBe("execute");
    expect(store.claim({ ...scope, operation: "knowledge.collections.create" }, "key-1", "x").kind).toBe("execute");
  });

  it("never runs a request twice while it is pending, and reports an unknown outcome after a crash", () => {
    let clock = 1_000;
    const store = createIdempotencyStore(":memory:", () => clock);
    expect(store.claim(scope, "key-1", "x").kind).toBe("execute");
    expect(store.claim(scope, "key-1", "x")).toEqual({ kind: "in_progress" });
    clock += 6 * 60_000;
    expect(store.claim(scope, "key-1", "x")).toEqual({ kind: "outcome_unknown" });
  });

  it("does not store a failed answer, so a failure may be retried with the same key", () => {
    const store = createIdempotencyStore(":memory:");
    const first = store.claim(scope, "key-1", "x");
    if (first.kind === "execute") first.finish(400, {}, Buffer.from("{}"));
    expect(store.claim(scope, "key-1", "x").kind).toBe("execute");
    const second = store.claim(scope, "key-2", "x");
    if (second.kind === "execute") second.abandon();
    expect(store.claim(scope, "key-2", "x").kind).toBe("execute");
  });

  it("expires entries after a day", () => {
    let clock = 0;
    const store = createIdempotencyStore(":memory:", () => clock);
    const first = store.claim(scope, "key-1", "x");
    if (first.kind === "execute") first.finish(201, {}, answer);
    clock += 25 * 60 * 60_000;
    expect(store.claim(scope, "key-1", "y").kind).toBe("execute");
  });

  it("accepts only sane keys", () => {
    for (const ok of ["a", "abc-123_x.y:z/w", "A".repeat(256)]) expect(IDEMPOTENCY_KEY.test(ok), ok).toBe(true);
    for (const bad of ["", "-lead", "has space", "a".repeat(257), "new\nline", "é"]) expect(IDEMPOTENCY_KEY.test(bad), bad).toBe(false);
  });
});
