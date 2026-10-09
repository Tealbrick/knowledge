import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MemoryEngine } from "./memory-engine.js";
import type { ResearchSyncResult } from "./research-model-sync.js";
import { readPinnedEmbedding, resolveEffectiveModelSettings } from "./provider-env-models.js";
import { ModelManifestResolver, clearAppLocalManifest, manifestSummary, parseOwnerManifest, saveAppLocalManifest } from "./model-manifest.js";
import { PICKER_PROVIDERS, PICKER_ROLES, ProviderListingError, ProviderModelCache, availableModels, credentialFor, type ListingError, type PickerRole } from "./model-catalog.js";
import { ModelSettingsUpdateError, ModelSettingsUpdateSchema, readModelSettings, resolveModelSettingsUpdate, saveModelSettings, modelSettingsSummary, testModelSettings, type ModelSettings } from "./model-settings.js";

/** Research (Open Notebook) follows the same saved models; see research-model-sync.ts. */
export interface ModelSettingsResearchSync {
  sync(settings: ModelSettings): Promise<ResearchSyncResult>;
  summary(): Record<string, unknown>;
}

export interface ModelSettingsRoutesInput {
  dataDir: string;
  gbrainHome: string;
  brain: MemoryEngine;
  authority: string | undefined;
  research?: ModelSettingsResearchSync | null;
  testModels?: typeof testModelSettings;
  providerEnv?: Readonly<Record<string, string | undefined>>;
  /** Portal base URL (TEALBRICK_PORTAL_URL): the model manifest is read from its `/.well-known/tealbrick/models`. */
  portalUrl?: string | null;
  /** Network access for the Portal manifest and the provider model lists (tests replace it). */
  fetch?: typeof fetch;
  manifests?: ModelManifestResolver;
  modelLists?: ProviderModelCache;
}

export function registerModelSettingsRoutes(app: FastifyInstance, input: ModelSettingsRoutesInput) {
  const testModels = input.testModels ?? testModelSettings;
  const env = () => input.providerEnv ?? process.env;
  const manifests = input.manifests ?? new ModelManifestResolver({ dataDir: input.dataDir, portalUrl: input.portalUrl ?? null, ...(input.fetch ? { fetch: input.fetch } : {}) });
  const modelLists = input.modelLists ?? new ProviderModelCache(Date.now, input.fetch ?? fetch);
  // Research is configured after the memory save succeeded; it never undoes or fails that save.
  const syncResearch = async (settings: ModelSettings): Promise<ResearchSyncResult> => {
    if (!input.research) return { status: "not-installed" };
    try {
      const result = await input.research.sync(settings);
      return { status: result.status, ...(result.error ? { error: result.error } : {}), ...(result.hint ? { hint: result.hint } : {}) };
    } catch { return { status: "failed", error: "research_sync_failed" }; }
  };
  let busy = false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.split("?", 1)[0]?.startsWith("/api/settings/models")) return;
    reply.header("cache-control", "no-store");
    const supplied = request.headers["x-knowledge-settings-token"];
    if (!input.authority || input.authority.length < 32 || typeof supplied !== "string" || !timingSafeEqual(digest(supplied), digest(input.authority))) return reply.code(403).send({ ok: false, error: "settings_owner_required" });
    // Cookie-bearing clients must use the exact same-origin write surface.
    if (request.headers.origin) {
      try { if (new URL(request.headers.origin).host !== request.headers.host) throw new Error(); }
      catch { return reply.code(403).send({ ok: false, error: "settings_origin_denied" }); }
    }
  });
  app.get("/api/settings/models", async () => {
    const [effective, active, pinned] = await Promise.all([
      resolveEffectiveModelSettings(input.dataDir, input.gbrainHome, env()),
      manifests.active(),
      readPinnedEmbedding(input.gbrainHome),
    ]);
    return {
      ...modelSettingsSummary(effective.settings, effective.source ?? undefined, effective.issue),
      brain: { status: input.brain.status().status },
      research: input.research ? input.research.summary() : { status: "not-installed" },
      // Which model manifest (recommendations) is active: portal, app-local or bundled, and its version.
      manifest: manifestSummary(active),
      // The embedding model an existing brain already holds vectors for; changing it needs a re-index.
      embeddingLock: pinned,
    };
  });
  /**
   * The models the owner may pick for one provider and role. The Program lists them with the key it
   * already holds; the answer carries model ids only, never the key or an upstream error body.
   */
  app.get("/api/settings/models/available", async (request, reply) => {
    const query = request.query as { provider?: unknown; role?: unknown };
    const provider = typeof query.provider === "string" ? query.provider : "";
    const role = typeof query.role === "string" ? query.role : "";
    if (!PICKER_PROVIDERS.includes(provider) || !(PICKER_ROLES as readonly string[]).includes(role)) return reply.code(400).send({ ok: false, error: "invalid_model_query" });
    const [active, saved] = await Promise.all([manifests.active(), readModelSettings(input.dataDir).catch(() => null)]);
    const credential = credentialFor(provider, saved, env());
    let listed: string[] | null = null;
    let error: ListingError | undefined;
    if (credential) {
      try { listed = await modelLists.list(credential); }
      catch (failure) { error = failure instanceof ProviderListingError ? failure.code : "provider_unreachable"; }
    }
    const available = availableModels({ provider, role: role as PickerRole, manifest: active.manifest, listed, keySource: credential?.source ?? "none", ...(error ? { error } : {}) });
    return { ok: true, ...available, manifest: { source: active.source, version: active.version } };
  });
  /** The app-local manifest: JSON the owner pasted. It is validated before it is stored and wins only when its version is highest. */
  app.put("/api/settings/models/manifest", async (request, reply) => {
    const body = request.body as { manifest?: unknown } | null;
    if (!body || typeof body !== "object" || !("manifest" in body)) return reply.code(400).send({ ok: false, error: "model_manifest_invalid", errors: [{ path: "", message: "Send {\"manifest\": ...}" }] });
    const parsed = parseOwnerManifest(body.manifest);
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: "model_manifest_invalid", errors: parsed.errors });
    await saveAppLocalManifest(input.dataDir, parsed.manifest);
    return { ok: true, manifest: manifestSummary(await manifests.active()) };
  });
  app.delete("/api/settings/models/manifest", async () => {
    await clearAppLocalManifest(input.dataDir);
    return { ok: true, manifest: manifestSummary(await manifests.active()) };
  });
  app.put("/api/settings/models", async (request, reply) => {
    if (busy) return reply.code(409).send({ ok: false, error: "settings_update_in_progress" });
    const parsed = ModelSettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_model_settings" });
    let settings: ModelSettings;
    try { settings = resolveModelSettingsUpdate(parsed.data, await readModelSettings(input.dataDir)); }
    catch (error) {
      if (error instanceof ModelSettingsUpdateError) return reply.code(400).send({ ok: false, error: error.code, component: error.component });
      return reply.code(400).send({ ok: false, error: "invalid_model_settings" });
    }
    busy = true;
    try {
      const readiness = await testModels(settings);
      if (!readiness.ok) return reply.code(422).send(readiness);
      await saveModelSettings(input.dataDir, input.gbrainHome, settings);
      await input.brain.close();
      await input.brain.start();
      const research = await syncResearch(settings);
      if (input.brain.status().status !== "online") return reply.code(503).send({ ok: false, error: "brain_start_failed", configured: true, checks: readiness.checks, brain: { status: input.brain.status().status }, research });
      return { ...readiness, ...modelSettingsSummary(settings), brain: { status: input.brain.status().status }, research };
    } catch (error) {
      const migration = error instanceof Error && error.message.startsWith("embedding_migration_required");
      return reply.code(migration ? 409 : 500).send({ ok: false, error: migration ? "embedding_migration_required" : "settings_update_failed" });
    } finally { busy = false; }
  });
}
