import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MemoryEngine } from "./memory-engine.js";
import type { ResearchSyncResult } from "./research-model-sync.js";
import { resolveEffectiveModelSettings } from "./provider-env-models.js";
import { ModelSettingsUpdateError, ModelSettingsUpdateSchema, readModelSettings, resolveModelSettingsUpdate, saveModelSettings, modelSettingsSummary, testModelSettings, type ModelSettings } from "./model-settings.js";

/** Research (Open Notebook) follows the same saved models; see research-model-sync.ts. */
export interface ModelSettingsResearchSync {
  sync(settings: ModelSettings): Promise<ResearchSyncResult>;
  summary(): Record<string, unknown>;
}

export function registerModelSettingsRoutes(app: FastifyInstance, input: { dataDir: string; gbrainHome: string; brain: MemoryEngine; authority: string | undefined; research?: ModelSettingsResearchSync | null; testModels?: typeof testModelSettings; providerEnv?: Readonly<Record<string, string | undefined>> }) {
  const testModels = input.testModels ?? testModelSettings;
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
    const effective = await resolveEffectiveModelSettings(input.dataDir, input.gbrainHome, input.providerEnv ?? process.env);
    return { ...modelSettingsSummary(effective.settings, effective.source ?? undefined, effective.issue), brain: { status: input.brain.status().status }, research: input.research ? input.research.summary() : { status: "not-installed" } };
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
