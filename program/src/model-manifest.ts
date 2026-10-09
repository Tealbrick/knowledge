import fs from "node:fs/promises";
import path from "node:path";
import { defaultModelManifest, parseModelManifest, selectModelManifest, type ModelManifest, type ModelManifestIssue } from "@tealbrick/contract/models";

/**
 * Which model-recommendation manifest (`tealbrick.models/1`) Knowledge uses.
 *
 * Three sources compete through `selectModelManifest([portal, appLocal])`:
 *
 *   1. the Portal-served copy, `GET ${TEALBRICK_PORTAL_URL}/.well-known/tealbrick/models`
 *      (public, no credentials; a 404, a timeout or an invalid body counts as absent);
 *   2. the app-local owner setting (`model-manifest.json` in the data directory);
 *   3. the bundled `defaultModelManifest` of the pinned contract kit.
 *
 * The highest valid `version` wins; on a tie the earlier source wins. The Portal copy
 * is cached for ten minutes and never blocks a settings request for long: a request
 * waits at most `PORTAL_WAIT_MS` for a first fetch, then answers from what it has.
 */

export type ModelManifestSource = "portal" | "app-local" | "bundled";
export const MODEL_MANIFEST_FILE = "model-manifest.json";
export const PORTAL_MANIFEST_PATH = "/.well-known/tealbrick/models";
const CACHE_MS = 10 * 60_000;
const PORTAL_TIMEOUT_MS = 3_000;
const PORTAL_WAIT_MS = 1_500;
const MAX_MANIFEST_BYTES = 256 * 1024;

export type PortalManifestState =
  | { readonly status: "not-configured" }
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "ok"; readonly manifest: ModelManifest };

export type AppLocalManifestState =
  | { readonly status: "not-configured" }
  | { readonly status: "invalid" }
  | { readonly status: "ok"; readonly manifest: ModelManifest };

export interface ActiveModelManifest {
  readonly manifest: ModelManifest;
  readonly source: ModelManifestSource;
  readonly version: number;
  readonly effectiveAt: string;
  readonly portal: { readonly status: PortalManifestState["status"]; readonly version?: number };
  readonly appLocal: { readonly status: AppLocalManifestState["status"]; readonly version?: number };
  readonly bundledVersion: number;
}

/** Which candidate `selectModelManifest` picked (it returns one of the objects it was given, or the bundled copy). */
export function describeSelection(portal: PortalManifestState, appLocal: AppLocalManifestState, bundled: ModelManifest = defaultModelManifest): ActiveModelManifest {
  const portalManifest = portal.status === "ok" ? portal.manifest : null;
  const localManifest = appLocal.status === "ok" ? appLocal.manifest : null;
  const manifest = selectModelManifest([portalManifest, localManifest], bundled);
  // The same rule selectModelManifest applies: the highest version wins, earlier on a tie, bundled only when nothing beats it.
  let best: { source: ModelManifestSource; version: number } | null = null;
  for (const [candidateSource, candidate] of [["portal", portalManifest], ["app-local", localManifest]] as const) {
    if (candidate && (!best || candidate.version > best.version)) best = { source: candidateSource, version: candidate.version };
  }
  const source: ModelManifestSource = best && best.version >= bundled.version && best.version === manifest.version ? best.source : "bundled";
  return {
    manifest,
    source,
    version: manifest.version,
    effectiveAt: manifest.effectiveAt,
    portal: { status: portal.status, ...(portal.status === "ok" ? { version: portal.manifest.version } : {}) },
    appLocal: { status: appLocal.status, ...(appLocal.status === "ok" ? { version: appLocal.manifest.version } : {}) },
    bundledVersion: bundled.version,
  };
}

/** Parse a manifest the owner pasted: a JSON string or an already-parsed value. Never throws. */
export function parseOwnerManifest(input: unknown): { ok: true; manifest: ModelManifest } | { ok: false; errors: readonly ModelManifestIssue[] } {
  let value = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input) > MAX_MANIFEST_BYTES) return { ok: false, errors: [{ path: "", message: "The manifest is too large" }] };
    try { value = JSON.parse(input); } catch { return { ok: false, errors: [{ path: "", message: "Not valid JSON" }] }; }
  }
  const parsed = parseModelManifest(value);
  // Paths and messages describe the owner's own JSON; cap them so a huge paste cannot flood the answer.
  return parsed.ok ? { ok: true, manifest: parsed.manifest } : { ok: false, errors: parsed.errors.slice(0, 20) };
}

export async function readAppLocalManifest(dataDir: string): Promise<AppLocalManifestState> {
  let text: string;
  try { text = await fs.readFile(path.join(dataDir, MODEL_MANIFEST_FILE), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "not-configured" }; return { status: "invalid" }; }
  const parsed = parseOwnerManifest(text);
  return parsed.ok ? { status: "ok", manifest: parsed.manifest } : { status: "invalid" };
}

export async function saveAppLocalManifest(dataDir: string, manifest: ModelManifest): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, MODEL_MANIFEST_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function clearAppLocalManifest(dataDir: string): Promise<void> {
  await fs.rm(path.join(dataDir, MODEL_MANIFEST_FILE), { force: true });
}

/** The Portal manifest URL, or null when no usable Portal URL is configured. */
export function portalManifestUrl(portalUrl: string | undefined | null): string | null {
  const raw = portalUrl?.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  return new URL(PORTAL_MANIFEST_PATH, url.origin).toString();
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MANIFEST_BYTES) throw new Error("oversized_manifest");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); }
}

/** One fetch of the Portal-served manifest. Any failure is "absent" or "invalid"; it never throws. */
export async function fetchPortalManifest(url: string | null, fetchImpl: typeof fetch = fetch): Promise<PortalManifestState> {
  if (!url) return { status: "not-configured" };
  let response: Response;
  try { response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS) }); }
  catch { return { status: "absent" }; }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { status: "absent" }; }
  try {
    const parsed = parseModelManifest(JSON.parse(await readCapped(response)));
    return parsed.ok ? { status: "ok", manifest: parsed.manifest } : { status: "invalid" };
  } catch { return { status: "invalid" }; }
}

export interface ModelManifestResolverOptions {
  readonly dataDir: string;
  readonly portalUrl?: string | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Replaces the bundled copy (tests). */
  readonly bundled?: ModelManifest;
  /** How long a request waits for a first Portal answer (tests). */
  readonly portalWaitMs?: number;
}

export class ModelManifestResolver {
  private portal: { state: PortalManifestState; at: number } | null = null;
  private inflight: Promise<PortalManifestState> | null = null;
  private readonly url: string | null;
  private readonly now: () => number;

  constructor(private readonly options: ModelManifestResolverOptions) {
    this.url = portalManifestUrl(options.portalUrl);
    this.now = options.now ?? Date.now;
  }

  /** Start (or join) a Portal refresh. The result is cached for ten minutes, whatever it was. */
  private refresh(): Promise<PortalManifestState> {
    if (this.inflight) return this.inflight;
    this.inflight = fetchPortalManifest(this.url, this.options.fetch ?? fetch)
      .then((state) => { this.portal = { state, at: this.now() }; return state; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async portalState(): Promise<PortalManifestState> {
    if (!this.url) return { status: "not-configured" };
    const cached = this.portal;
    if (cached && this.now() - cached.at < CACHE_MS) return cached.state;
    const pending = this.refresh();
    // Stale: answer with the previous copy while the refresh runs.
    if (cached) return cached.state;
    // First fetch: wait briefly, then answer without it (the fetch still fills the cache).
    const wait = this.options.portalWaitMs ?? PORTAL_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<PortalManifestState>((resolve) => { timer = setTimeout(() => resolve({ status: "absent" }), wait); timer.unref?.(); });
    try { return await Promise.race([pending, timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }

  async active(): Promise<ActiveModelManifest> {
    const [portal, appLocal] = await Promise.all([this.portalState(), readAppLocalManifest(this.options.dataDir)]);
    return describeSelection(portal, appLocal, this.options.bundled ?? defaultModelManifest);
  }
}

/** The key-free description of the active manifest for the settings API. */
export function manifestSummary(active: ActiveModelManifest) {
  return { source: active.source, version: active.version, effectiveAt: active.effectiveAt, portal: active.portal, appLocal: active.appLocal, bundledVersion: active.bundledVersion };
}
