import { createHash } from "node:crypto";

import * as kit from "@tealbrick/contract";
import type { GrantResult } from "@tealbrick/contract";

/**
 * Contract 2 read sets (`readPartitionKeys`) on the app-grant (`tbag_`) path.
 *
 * `@tealbrick/contract` 0.1.0-alpha.5 parses `readPartitionKeys` in the app-grant introspection answer, exposes it as
 * `GrantResult.readPartitionKeys` and adds `effectiveReadPartitions(result)`. Knowledge codes against that API. Until
 * the alpha.5 pin lands (it is not on npm yet), the pinned alpha.4 kit refuses an answer that carries the field (an
 * unknown key). This module isolates that gap and nothing else:
 *
 * - `effectiveReadPartitions` is the kit helper when the installed kit has it, else a line-for-line mirror of it;
 * - `readSetIntrospection` wraps the fetch the kit verifier uses. On a kit with read sets it is the plain fetch. On
 *   alpha.4 it validates the field like alpha.5 does (1..64 unique entries, each null or a 1..256 character key with
 *   no control characters, containing `partitionKey` when that is present; anything else turns the answer into an
 *   invalid one, so the kit denies), records it per grant token and hands the kit the answer without it.
 *
 * Remove the alpha.4 branch with the pin bump to 0.1.0-alpha.5.
 */

/** Mirror of alpha.5 `GrantResult.readPartitionKeys`: string keys, `null` = the workspace default scope. */
export type ReadPartitionKeys = readonly (string | null)[];
type WithReadSet = { readonly ok: boolean; readonly partitionKey?: string | null; readonly readPartitionKeys?: ReadPartitionKeys };

const MAX_PARTITION_KEY_LENGTH = 256;
const MAX_READ_PARTITIONS = 64;
const kitHelper = (kit as unknown as Record<string, unknown>).effectiveReadPartitions as ((result: GrantResult) => ReadPartitionKeys | undefined) | undefined;

/** True when the installed `@tealbrick/contract` parses read sets itself (0.1.0-alpha.5 and later). */
export const KIT_READ_PARTITIONS = typeof kitHelper === "function";

/** `readPartitionKeys`, else `[partitionKey]` (contract 1), else undefined; the kit helper when installed. */
export function effectiveReadPartitions(result: GrantResult | WithReadSet): ReadPartitionKeys | undefined {
  if (kitHelper) return kitHelper(result as GrantResult);
  if (!result.ok) return undefined;
  const value = result as WithReadSet;
  if (value.readPartitionKeys !== undefined) return value.readPartitionKeys;
  if (value.partitionKey !== undefined) return Object.freeze([value.partitionKey]);
  return undefined;
}

const isPartitionValue = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length >= 1 && value.length <= MAX_PARTITION_KEY_LENGTH && !/[\x00-\x1f\x7f]/u.test(value));

/** alpha.5 `readPartitionList` plus its "contains partitionKey" rule; null = refuse the answer. */
function kitReadPartitionList(value: unknown, partitionKey: unknown, hasPartitionKey: boolean): ReadPartitionKeys | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_READ_PARTITIONS) return null;
  if (!value.every(isPartitionValue) || new Set(value).size !== value.length) return null;
  if (hasPartitionKey && !value.includes(partitionKey as string | null)) return null;
  return Object.freeze([...value] as (string | null)[]);
}

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const MAX_TRACKED = 1_000;

export interface ReadSetIntrospection {
  readonly fetch: typeof fetch;
  /** The read set Portal sent with this grant's latest answer (alpha.4 only); undefined when it sent none. */
  readPartitionKeysFor(token: string): ReadPartitionKeys | undefined;
}

export function readSetIntrospection(base: typeof fetch, introspectUrl: string): ReadSetIntrospection {
  if (KIT_READ_PARTITIONS) return { fetch: base, readPartitionKeysFor: () => undefined };
  const seen = new Map<string, ReadPartitionKeys>();
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await base(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== introspectUrl || !response.ok) return response;
    let token: unknown;
    try { token = JSON.parse(String(init?.body ?? "")).token; } catch { token = undefined; }
    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { return new Response(text, { status: response.status, headers: response.headers }); }
    if (typeof token !== "string" || !data || typeof data !== "object" || Array.isArray(data)) {
      return new Response(text, { status: response.status, headers: response.headers });
    }
    const key = digest(token);
    const record = data as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, "readPartitionKeys")) {
      seen.delete(key);
      return new Response(text, { status: response.status, headers: response.headers });
    }
    const list = kitReadPartitionList(record.readPartitionKeys, record.partitionKey, Object.prototype.hasOwnProperty.call(record, "partitionKey"));
    // A malformed read set makes the whole answer invalid: the kit then denies the grant (fail closed).
    if (!list) { seen.delete(key); return Response.json({}, { status: response.status }); }
    const { readPartitionKeys: _omitted, ...rest } = record;
    if (seen.size >= MAX_TRACKED && !seen.has(key)) seen.delete(seen.keys().next().value!);
    seen.set(key, list);
    return Response.json(rest, { status: response.status });
  }) as typeof fetch;
  return { fetch: wrapped, readPartitionKeysFor: (token) => seen.get(digest(token)) };
}

/** The grant's read set as Portal sent it (kit field on alpha.5, the recorded answer on alpha.4); undefined = contract 1. */
export function grantReadPartitionKeys(grant: GrantResult, token: string | null, shim: ReadSetIntrospection): ReadPartitionKeys | undefined {
  if (!grant.ok) return undefined;
  if (KIT_READ_PARTITIONS) return (grant as WithReadSet).readPartitionKeys;
  return token ? shim.readPartitionKeysFor(token) : undefined;
}

export function samePartitionSet(left: ReadPartitionKeys | undefined, right: ReadPartitionKeys | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value) => right.includes(value));
}
