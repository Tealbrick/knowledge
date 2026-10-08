import path from "node:path";
import type { JsonWebKey, KeyObject } from "node:crypto";

import { matchesFrontendRoute, type Manifest, type StatusReport } from "@tealbrick/contract";

import { EDGE_PARTITION_SUPPORT } from "../partition-authority.js";
import { readModelSettings } from "../model-settings.js";
import type { KnowledgeConfig } from "../types.js";
import { createAppGrantAuthority, type AppGrantAuthority } from "./app-grants.js";
import { createContractAudit, type ContractAudit } from "./audit.js";
import { createKnowledgeContract, type KnowledgeContract } from "./control.js";
import { createIdempotencyStore, type IdempotencyStore } from "./idempotency.js";
import { createModelSettingsStore, snapshotOf, type ApplyModelSettings } from "./settings-store.js";
import { loadKnowledgeManifest } from "./manifest.js";

export { applyEnvAliases } from "./env-aliases.js";
export { loadKnowledgeManifest } from "./manifest.js";
export { IDEMPOTENCY_KEY } from "./idempotency.js";

/** A launch `route` must be one of the manifest frontend routes (or the default home), never an arbitrary path. */
export function launchRouteAllowed(manifest: Manifest): (route: string) => boolean {
  return (route) => typeof route === "string" && matchesFrontendRoute(manifest, route);
}
export type { AdmittedGrant, AppGrantAuthority } from "./app-grants.js";
export type { IdempotencyStore } from "./idempotency.js";

export interface KnowledgeContractWiring {
  readonly manifest: Manifest;
  readonly contract: KnowledgeContract;
  readonly grants: AppGrantAuthority;
  readonly audit: ContractAudit;
  readonly idempotency: IdempotencyStore;
  /** The public `/healthz` answer: the contract's {ok, app, version, major} plus the fields Portal's partition gate reads. */
  health(): Record<string, unknown>;
  close(): void;
}

export interface WireInput {
  readonly env: NodeJS.ProcessEnv;
  readonly config: Pick<KnowledgeConfig, "dataDir" | "memoryEngine" | "rulesBaseUrl" | "rulesAuthToken">;
  /** The Program, in process: used to apply model settings through the owner route and to read engine status. */
  readonly program: { inject(options: { method: "GET" | "PUT"; url: string; headers?: Record<string, string>; payload?: unknown }): Promise<{ statusCode: number; json(): unknown }> };
  readonly settingsAuthority: string;
  readonly instanceToken: string;
  readonly identity: { readonly instanceId: string; readonly publicJwk: JsonWebKey; readonly privateKey: KeyObject };
  readonly manifest?: Manifest;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly emergency?: Parameters<typeof createKnowledgeContract>[0]["emergency"];
}

export function wireKnowledgeContract(input: WireInput): KnowledgeContractWiring {
  const { env, config } = input;
  const manifest = input.manifest ?? loadKnowledgeManifest();
  const audit = createContractAudit(path.join(config.dataDir, "contract-audit.sqlite"));
  const idempotency = createIdempotencyStore(path.join(config.dataDir, "edge-idempotency.sqlite"), input.now);

  const tenantId = env.TEALBRICK_TENANT_ID?.trim() || null;
  const portalUrl = env.TEALBRICK_PORTAL_URL?.trim() || null;
  const deploymentId = env.TEALBRICK_DEPLOYMENT_ID?.trim() || null;
  const orgId = env.TEALBRICK_PORTAL_ORG_ID?.trim() || null;
  const portalOrigin = portalUrl ? new URL(portalUrl).origin : null;
  // Portal's proof for this instance: a separate one when the deployment has it, else the instance token (as Knowledge always did).
  const instanceProof = env.TEALBRICK_PORTAL_INSTANCE_PROOF?.trim() || input.instanceToken;
  const grants = createAppGrantAuthority({
    manifest,
    audit,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {}),
    portal: portalUrl && deploymentId && orgId && tenantId
      ? { url: portalUrl, deploymentId, orgId, tenantId, instanceProof }
      : null,
  });

  const apply: ApplyModelSettings = async (body) => {
    const response = await input.program.inject({
      method: "PUT", url: "/api/settings/models", payload: body,
      headers: { "x-knowledge-settings-token": input.settingsAuthority, "content-type": "application/json" },
    });
    let json: unknown = null;
    try { json = response.json(); } catch { json = null; }
    return { statusCode: response.statusCode, json };
  };
  const settings = createModelSettingsStore({ dataDir: config.dataDir, apply });

  const setup = async (): Promise<StatusReport> => {
    let saved = null;
    try { saved = await readModelSettings(config.dataDir); } catch { saved = null; }
    const snapshot = await settings.read().catch(() => snapshotOf(null, null));
    let engine = "disabled";
    try {
      const status = (await input.program.inject({ method: "GET", url: "/api/status" })).json() as { sidecars?: { gbrain?: { status?: string } } };
      engine = status.sidecars?.gbrain?.status ?? "disabled";
    } catch { engine = "disabled"; }
    const modelsConfigured = saved !== null || config.memoryEngine === "hindsight" || Boolean(env.GBRAIN_EMBEDDING_MODEL?.trim() || env.OPENAI_API_KEY?.trim());
    const setupState = engine === "starting" ? "starting" : !modelsConfigured ? "needs-settings" : engine === "online" ? "configured" : "unavailable";
    return { setup: setupState, settingsRevision: snapshot.revision };
  };

  const rulesBound = Boolean(config.rulesBaseUrl && config.rulesAuthToken);
  const contract = createKnowledgeContract({
    manifest, env, dataDir: config.dataDir, instanceToken: input.instanceToken, tenantId, portalOrigin,
    identity: input.identity, setup, settings, grants, audit,
    companions: () => ({ "rules-approvals": { bound: rulesBound, status: "unknown" as const } }),
    ...(input.now ? { now: input.now } : {}),
    ...(input.emergency ? { emergency: input.emergency } : {}),
  });

  return {
    manifest, contract, grants, audit, idempotency,
    health: () => ({ ok: true, app: manifest.app.id, version: manifest.app.version, major: manifest.app.major, service: "knowledge", ...EDGE_PARTITION_SUPPORT }),
    close() { audit.close(); idempotency.close(); },
  };
}
