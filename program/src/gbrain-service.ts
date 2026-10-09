import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { callGBrainTool, listGBrainTools } from "./gbrain-transport.js";

/**
 * Connection to a separate, unmodified upstream GBrain service
 * (`gbrain serve --http`, MCP Streamable HTTP + OAuth 2.1).
 *
 * Knowledge holds only GBrain's own bootstrap (owner) credential and uses
 * upstream's admin API to register OAuth clients. Every MCP call carries an
 * access token from a client bound to exactly ONE GBrain source (one
 * Knowledge partition), so upstream itself enforces source isolation; there
 * is no Knowledge code inside the GBrain process.
 *
 * - Program calls use one client per source.
 * - Native memory calls use one client per (source, principal), so upstream
 *   ownership (forget) and session/delta cursors stay per principal.
 *
 * Sources are created by the GBrain service's owner-CLI entrypoint (upstream
 * refuses `sources_add` over MCP); an unprovisioned source is reported as
 * `brain_partition_binding_required`, never silently mapped to `default`.
 */
export interface GBrainServiceOptions {
  /** Private service origin, e.g. http://gbrain.railway.internal:3131 */
  readonly baseUrl: string;
  /** GBRAIN_ADMIN_BOOTSTRAP_TOKEN shared with the GBrain service. */
  readonly adminToken: string;
  /** Knowledge data dir; client credentials persist here (mode 0600). */
  readonly dataDir: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

interface StoredClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sourceId: string;
  readonly principal: string | null;
}

interface ClientFile {
  readonly version: 1;
  readonly baseUrl: string;
  clients: Record<string, StoredClient>;
}

export class GBrainServiceError extends Error {
  constructor(readonly code: "brain_partition_binding_required" | "gbrain_admin_unavailable" | "gbrain_client_registration_failed" | "gbrain_token_unavailable", message?: string) {
    super(message ?? code);
  }
}

const SOURCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const CLIENT_FILE = "gbrain-service-clients.json";

export const principalClientKey = (principalId: string) => `kc-${createHash("sha256").update(principalId).digest("hex").slice(0, 24)}`;

/** Deterministic UUID-shaped request id: identical intent replays, new intent never collides. */
export function deterministicRequestId(...parts: readonly string[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

export class GBrainServiceConnection {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private adminCookie: { value: string; expires: number } | null = null;
  private file: ClientFile | null = null;
  private readonly tokens = new Map<string, { token: string; expires: number }>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly options: GBrainServiceOptions) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("KNOWLEDGE_GBRAIN_URL must be a bare http(s) origin");
    }
    if (typeof options.adminToken !== "string" || !/^[\x21-\x7e]{32,1024}$/u.test(options.adminToken)) {
      throw new Error("KNOWLEDGE_GBRAIN_ADMIN_TOKEN must be 32-1024 printable characters");
    }
    this.baseUrl = url.origin;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private get filePath() { return path.join(this.options.dataDir, CLIENT_FILE); }

  private async loadFile(): Promise<ClientFile> {
    if (this.file) return this.file;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as ClientFile;
      // Credentials minted for another GBrain service are never reused.
      this.file = parsed?.version === 1 && parsed.baseUrl === this.baseUrl && parsed.clients && typeof parsed.clients === "object"
        ? parsed : { version: 1, baseUrl: this.baseUrl, clients: {} };
    } catch { this.file = { version: 1, baseUrl: this.baseUrl, clients: {} }; }
    return this.file;
  }

  private async saveFile(file: ClientFile) {
    await fs.mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temp, JSON.stringify(file), { mode: 0o600 });
    await fs.rename(temp, this.filePath);
  }

  private async admin(): Promise<string> {
    if (this.adminCookie && this.adminCookie.expires > this.now()) return this.adminCookie.value;
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/admin/login`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json" }, body: JSON.stringify({ token: this.options.adminToken }),
      });
    } catch { throw new GBrainServiceError("gbrain_admin_unavailable"); }
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    await response.body?.cancel();
    if (!response.ok || !cookie?.startsWith("gbrain_admin=")) throw new GBrainServiceError("gbrain_admin_unavailable");
    // Upstream sessions last 24 h; renew well before.
    this.adminCookie = { value: cookie, expires: this.now() + 12 * 3_600_000 };
    return cookie;
  }

  private async register(sourceId: string, principal: string | null): Promise<StoredClient> {
    const name = `knowledge-${sourceId}${principal ? `-${principal}` : ""}-${randomBytes(4).toString("hex")}`;
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/admin/api/register-client`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", cookie: await this.admin() },
        body: JSON.stringify({ name, source: sourceId, scopes: "read write", grantTypes: ["client_credentials"] }),
      });
    } catch (error) {
      if (error instanceof GBrainServiceError) throw error;
      throw new GBrainServiceError("gbrain_client_registration_failed");
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.status === 401) this.adminCookie = null;
    if (!response.ok) {
      if (body?.error === "unknown_source" || body?.error === "archived_source") throw new GBrainServiceError("brain_partition_binding_required", "GBrain source is not provisioned for this partition");
      throw new GBrainServiceError("gbrain_client_registration_failed");
    }
    if (typeof body?.clientId !== "string" || typeof body.clientSecret !== "string") throw new GBrainServiceError("gbrain_client_registration_failed");
    return { clientId: body.clientId, clientSecret: body.clientSecret, sourceId, principal };
  }

  private async client(sourceId: string, principal: string | null): Promise<StoredClient> {
    const key = `${sourceId}|${principal ?? ""}`;
    const file = await this.loadFile();
    const existing = file.clients[key];
    if (existing && existing.sourceId === sourceId && existing.principal === principal) return existing;
    const registered = await this.register(sourceId, principal);
    file.clients[key] = registered;
    await this.saveFile(file);
    return registered;
  }

  private async mint(stored: StoredClient): Promise<{ token: string; expiresIn: number } | null> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/token`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: stored.clientId, client_secret: stored.clientSecret, scope: "read write" }),
      });
    } catch { throw new GBrainServiceError("gbrain_token_unavailable"); }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.status === 400 || response.status === 401) return null; // revoked/unknown client: re-register
    if (!response.ok || typeof body?.access_token !== "string") throw new GBrainServiceError("gbrain_token_unavailable");
    return { token: body.access_token, expiresIn: typeof body.expires_in === "number" ? body.expires_in : 300 };
  }

  /** Access token for a source (and optionally a principal), cached until shortly before expiry. */
  async token(sourceId: string, principalId?: string): Promise<string> {
    if (!SOURCE_ID.test(sourceId)) throw new GBrainServiceError("brain_partition_binding_required");
    const principal = principalId ? principalClientKey(principalId) : null;
    const key = `${sourceId}|${principal ?? ""}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expires > this.now()) return cached.token;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const request = (async () => {
      let stored = await this.client(sourceId, principal);
      let minted = await this.mint(stored);
      if (!minted) {
        const file = await this.loadFile();
        delete file.clients[key];
        await this.saveFile(file);
        stored = await this.client(sourceId, principal);
        minted = await this.mint(stored);
        if (!minted) throw new GBrainServiceError("gbrain_token_unavailable");
      }
      this.tokens.set(key, { token: minted.token, expires: this.now() + Math.max(30, minted.expiresIn - 60) * 1000 });
      return minted.token;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  /** Drop a cached token after upstream rejects it (expired or revoked). */
  invalidate(sourceId: string, principalId?: string) {
    this.tokens.delete(`${sourceId}|${principalId ? principalClientKey(principalId) : ""}`);
  }

  async call(sourceId: string, name: string, args: Record<string, unknown>, options: {
    readonly principalId?: string; readonly timeoutMs?: number;
    readonly onMeta?: (meta: Record<string, unknown>) => void; readonly onToolError?: (payload: unknown) => unknown;
  } = {}): Promise<unknown> {
    const invoke = async () => callGBrainTool({ baseUrl: this.baseUrl, token: await this.token(sourceId, options.principalId), name, args,
      timeoutMs: options.timeoutMs, onMeta: options.onMeta, onToolError: options.onToolError });
    try { return await invoke(); }
    catch (error) {
      // A 401 is rejected before dispatch, so one retry with a fresh token cannot double-execute.
      if (error instanceof Error && error.message === "GBrain HTTP 401") { this.invalidate(sourceId, options.principalId); return invoke(); }
      throw error;
    }
  }

  async tools(sourceId: string, principalId?: string) {
    return listGBrainTools({ baseUrl: this.baseUrl, token: await this.token(sourceId, principalId) });
  }

  /**
   * Knowledge is the canonical owner of its projected pages: read the current
   * revision, write with it (create when absent), and use a deterministic
   * request id so an uncertain retry replays rather than duplicates.
   */
  async putCanonicalPage(sourceId: string, slug: string, content: string) {
    const contentHash = createHash("sha256").update(content).digest("hex");
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = await this.pageRevision(sourceId, slug);
      try {
        return await this.replayIfOutcomeUnknown(sourceId, "put_page", {
          // The Knowledge document is canonical: a projection that no longer has a Timeline
          // section must remove its dated rows (upstream v0.60.105+ refuses that remotely
          // with timeline_rows_would_be_removed unless drop_timeline is set).
          slug, content, drop_timeline: true, ...(revision ? { expected_revision: revision } : {}),
          request_id: deterministicRequestId("put_page", sourceId, slug, contentHash, revision ?? "create"),
        });
      } catch (error) {
        if (attempt === 0 && error instanceof Error && error.message.endsWith(": revision_conflict")) continue;
        throw error;
      }
    }
    throw new Error("GBrain tool execution failed: revision_conflict");
  }

  async deleteCanonicalPage(sourceId: string, slug: string) {
    const revision = await this.pageRevision(sourceId, slug);
    if (!revision) return { status: "absent" };
    return this.replayIfOutcomeUnknown(sourceId, "delete_page", { slug, expected_revision: revision, request_id: deterministicRequestId("delete_page", sourceId, slug, revision) });
  }

  /**
   * Upstream (v0.60.123+) answers `write_outcome_unknown` when its database session kept dropping
   * during admission. Replaying the SAME request_id is a read of the retained request upstream,
   * never a second admission: it returns the accepted write, or admits it when nothing was
   * recorded. So one identical replay is safe; a new request_id never is.
   */
  private async replayIfOutcomeUnknown(sourceId: string, name: string, args: Record<string, unknown> & { request_id: string }) {
    try { return await this.call(sourceId, name, args); }
    catch (error) {
      if (error instanceof Error && error.message.endsWith(": write_outcome_unknown")) return this.call(sourceId, name, args);
      throw error;
    }
  }

  private async pageRevision(sourceId: string, slug: string): Promise<string | null> {
    try {
      const page = await this.call(sourceId, "get_page", { slug, include_content: true }) as Record<string, unknown> | null;
      return page && typeof page.revision === "string" ? page.revision : null;
    } catch (error) {
      if (error instanceof Error && error.message.endsWith(": page_not_found")) return null;
      throw error;
    }
  }
}
