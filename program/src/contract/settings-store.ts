import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { accountPresenceFromEnv, type Manifest, type SettingsSnapshot, type SettingsUpdate } from "@tealbrick/contract";

import { ModelSettingsUpdateError, ModelSettingsUpdateSchema, readModelSettings, resolveModelSettingsUpdate, type ModelSettings } from "../model-settings.js";

/**
 * `/.well-known/tealbrick/settings` for Knowledge: the Settings → Models form, expressed as manifest fields.
 *
 * The owner UI saves models through `PUT /api/settings/models` (readiness probes against the provider, the memory
 * engine restart, the Research sync). The contract endpoint writes through the very same route, in process, so there
 * is one place where models change and one set of checks. API keys are write-only: reads report presence only.
 *
 * A model configuration is only valid whole (provider, endpoint, model and key for chat and embedding). A generic
 * settings form may write one field at a time, so a write that does not yet make a complete configuration is staged
 * (`model-settings.pending.json`, mode 0600, beside the saved settings) and applied the moment the configuration is
 * complete. A write that is complete but fails the provider readiness check changes nothing and is reported.
 */

export const COMPONENTS = ["chat", "embedding", "reranker"] as const;
type Component = (typeof COMPONENTS)[number];

const EXTRA: Readonly<Record<Component, readonly string[]>> = {
  chat: ["reasoningEffort"],
  embedding: ["dimensions"],
  reranker: [],
};
const BASE = ["provider", "baseUrl", "model"] as const;
const fieldsOf = (component: Component) => [...BASE, ...EXTRA[component]];

export class SettingsApplyError extends Error {
  constructor(readonly status: 400 | 409 | 422 | 500 | 503, readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}

/** Carries an apply failure from the settings store to the response of the request that caused it (the kit answers 500 for a throw). */
export const settingsFailures = new AsyncLocalStorage<{ failure?: SettingsApplyError }>();

export type ApplyModelSettings = (body: unknown) => Promise<{ statusCode: number; json: unknown }>;
type Body = Record<string, Record<string, unknown>>;

function revisionOf(values: Record<string, unknown>, secretKeys: readonly string[], savedAt: string | null): string {
  if (savedAt === null) return "0";
  return createHash("sha256").update(JSON.stringify([values, [...secretKeys].sort(), savedAt])).digest("hex").slice(0, 16);
}

/** The settings as the form shows them: non-secret values and which secrets are set. */
function present(body: Body, savedKeys: ReadonlySet<string>, savedAt: string | null) {
  const values: Record<string, unknown> = {};
  const secrets: Record<string, { set: boolean; updatedAt: string | null }> = {};
  for (const component of COMPONENTS) {
    const entry = body[component];
    if (!entry) continue;
    for (const field of fieldsOf(component)) if (entry[field] !== undefined && entry[field] !== null) values[`${component}.${field}`] = entry[field];
    const key = `${component}.apiKey`;
    const set = (typeof entry.apiKey === "string" && entry.apiKey.length > 0) || savedKeys.has(key);
    if (set) secrets[key] = { set, updatedAt: savedAt };
  }
  return { values, secrets };
}

export function snapshotOf(settings: ModelSettings | null, savedAt: string | null): SettingsSnapshot {
  if (!settings) return { revision: "0", values: {}, secrets: {} };
  const body: Body = {};
  const keys = new Set<string>();
  for (const component of COMPONENTS) {
    const entry = settings[component] as Record<string, unknown> | undefined;
    if (!entry) continue;
    body[component] = entry;
    if (typeof entry.apiKey === "string" && entry.apiKey) keys.add(`${component}.apiKey`);
  }
  const { values, secrets } = present(body, keys, savedAt);
  return { revision: revisionOf(values, Object.keys(secrets), savedAt), values, secrets };
}

/**
 * Overlay the supplied fields on the saved settings and the staged ones. An API key left out stays with the saved key
 * (the Program reuses it for the same provider and endpoint); a staged key travels with the staged fields.
 */
export function buildModelSettingsUpdate(saved: ModelSettings | null, pending: Body | null, update: SettingsUpdate): Body {
  const body: Body = {};
  for (const component of COMPONENTS) {
    const base = (saved?.[component] ?? {}) as Record<string, unknown>;
    const staged = pending?.[component] ?? {};
    const next: Record<string, unknown> = {};
    for (const field of fieldsOf(component)) if (staged[field] !== undefined) next[field] = staged[field]; else if (base[field] !== undefined) next[field] = base[field];
    if (typeof staged.apiKey === "string") next.apiKey = staged.apiKey;
    let touched = false;
    for (const field of fieldsOf(component)) {
      const key = `${component}.${field}`;
      if (!Object.hasOwn(update.values, key)) continue;
      touched = true;
      const value = update.values[key];
      if (value === null) delete next[field];
      else next[field] = value;
    }
    const keyName = `${component}.apiKey`;
    if (Object.hasOwn(update.secrets, keyName)) {
      touched = true;
      const secret = update.secrets[keyName];
      if (typeof secret === "string") next.apiKey = secret;
      else delete next.apiKey;
    }
    if (saved?.[component] || pending?.[component] || touched) {
      // Clearing every field of the optional reranker removes it.
      if (component === "reranker" && Object.keys(next).length === 0) continue;
      body[component] = next;
    }
  }
  return body;
}

/** "Not complete yet" versus "wrong": only a missing field or a missing key may be staged. */
function completeness(body: Body, saved: ModelSettings | null): "complete" | "incomplete" | "invalid" {
  const parsed = ModelSettingsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    // An issue about a value that is simply absent means "not complete yet"; any issue about a value that is there is wrong.
    const absent = (path: readonly PropertyKey[]) => {
      let node: unknown = body;
      for (const key of path) {
        if (node === null || typeof node !== "object") return true;
        node = (node as Record<PropertyKey, unknown>)[key];
      }
      return node === undefined;
    };
    return parsed.error.issues.every((issue) => absent(issue.path)) ? "incomplete" : "invalid";
  }
  try {
    resolveModelSettingsUpdate(parsed.data, saved);
  } catch (error) {
    if (error instanceof ModelSettingsUpdateError) return error.code === "model_api_key_required" ? "incomplete" : "invalid";
    return "invalid";
  }
  return "complete";
}

/**
 * `manifest` and `env` give the account-sourced provider keys (`provider-env` fields, §12.4): Portal Connections writes
 * them as hosting-provider variables, so a read reports only whether each variable is present, never its value, and
 * a write to one is refused by the contract kit (the owner changes them in Portal Connections).
 */
export function createModelSettingsStore(options: { readonly dataDir: string; readonly apply: ApplyModelSettings; readonly manifest?: Pick<Manifest, "settings">; readonly env?: Readonly<Record<string, string | undefined>> }) {
  const accountPresence = () => options.manifest ? { account: accountPresenceFromEnv(options.manifest, options.env ?? process.env) } : {};
  const file = path.join(options.dataDir, "model-settings.json");
  const pendingFile = path.join(options.dataDir, "model-settings.pending.json");
  const mtime = async (target: string) => stat(target).then((s) => s.mtime.toISOString(), () => null);
  const readPending = async (): Promise<Body | null> => {
    try {
      const parsed = JSON.parse(await readFile(pendingFile, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Body) : null;
    } catch { return null; }
  };
  const writePending = async (body: Body) => {
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${pendingFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(body), { mode: 0o600 });
    await rename(temporary, pendingFile);
    await chmod(pendingFile, 0o600).catch(() => undefined);
  };
  return {
    async read(): Promise<SettingsSnapshot> {
      const saved = await readModelSettings(options.dataDir);
      const pending = await readPending();
      if (!pending) return { ...snapshotOf(saved, await mtime(file)), ...accountPresence() };
      // Staged fields show as the form's current values; a secret is "set" when staged or saved.
      const savedKeys = new Set<string>();
      for (const component of COMPONENTS) if (saved?.[component]?.apiKey) savedKeys.add(`${component}.apiKey`);
      const body = buildModelSettingsUpdate(saved, pending, { values: {}, secrets: {} });
      const stamp = `${await mtime(file)}|${await mtime(pendingFile)}`;
      const { values, secrets } = present(body, savedKeys, await mtime(pendingFile));
      return { revision: revisionOf(values, Object.keys(secrets), stamp), values, secrets, ...accountPresence() };
    },
    async write(update: SettingsUpdate): Promise<void> {
      const fail = (failure: SettingsApplyError): never => {
        const context = settingsFailures.getStore();
        if (context) context.failure = failure;
        throw failure;
      };
      let saved: ModelSettings | null;
      try { saved = await readModelSettings(options.dataDir); }
      catch { return fail(new SettingsApplyError(500, "settings_unreadable")); }
      const body = buildModelSettingsUpdate(saved, await readPending(), update);
      const state = completeness(body, saved);
      if (state === "invalid") return fail(new SettingsApplyError(400, "invalid_settings"));
      if (state === "incomplete") { await writePending(body); return; }
      const result = await options.apply(body);
      if (result.statusCode >= 200 && result.statusCode < 300) { await rm(pendingFile, { force: true }); return; }
      const answer = (result.json && typeof result.json === "object" ? result.json : {}) as Record<string, unknown>;
      const code = typeof answer.error === "string" ? answer.error : "settings_update_failed";
      // Provider readiness checks name the failing component, never a key or a response body.
      const details: Record<string, unknown> = {};
      if (typeof answer.component === "string") details.component = answer.component;
      if (Array.isArray(answer.checks)) details.checks = answer.checks.filter((c) => c && typeof c === "object").map((c) => {
        const check = c as Record<string, unknown>;
        return { component: check.component, ok: check.ok === true, ...(typeof check.error === "string" ? { error: check.error } : {}) };
      });
      const status = result.statusCode === 400 ? 400 : result.statusCode === 409 ? 409 : result.statusCode === 422 ? 422 : result.statusCode === 503 ? 503 : 500;
      return fail(new SettingsApplyError(status, code, details));
    },
  };
}
