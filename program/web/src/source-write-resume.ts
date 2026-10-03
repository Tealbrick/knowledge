const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;

export type SourceWriteResume = Readonly<{ pendingKey: string | null }>;
export type SourceWriteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function validKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function loadSourceWriteResume(storage: Pick<Storage, "getItem">, storageKey: string): SourceWriteResume {
  const raw = storage.getItem(storageKey);
  if (raw === null) return { pendingKey: null };
  if (raw.length > 1024 || raw.length === 0) throw new Error("invalid_source_write_resume");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid_source_write_resume");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_source_write_resume");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.prototype.hasOwnProperty.call(record, "pendingKey") ||
    (record.pendingKey !== null && !validKey(record.pendingKey))) throw new Error("invalid_source_write_resume");
  return { pendingKey: record.pendingKey as string | null };
}

export function saveSourceWriteResume(storage: Pick<Storage, "setItem">, storageKey: string, pendingKey: string): void {
  if (!validKey(pendingKey)) throw new Error("invalid_source_write_resume");
  storage.setItem(storageKey, JSON.stringify({ pendingKey }));
}

export function clearSourceWriteResume(storage: Pick<Storage, "removeItem">, storageKey: string): void {
  storage.removeItem(storageKey);
}
