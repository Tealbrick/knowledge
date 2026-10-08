import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonWebKey, KeyObject } from "node:crypto";

import {
  CLAIM_PATHS,
  createEmergencyLogin,
  createInstanceTokenVerifier,
  createNodeHandler,
  createSettingsSessions,
  verifyAny,
  type CredentialVerifier,
  type EmergencyAuditEvent,
  type EmergencyLogin,
  type EmergencyLoginOptions,
  type Manifest,
  type SettingsSessions,
  type SettingsStore,
  type StatusReport,
} from "@tealbrick/contract";

import type { AppGrantAuthority } from "./app-grants.js";
import type { ContractAudit } from "./audit.js";
import { createFileClaimStore } from "./claim-store.js";
import { GUIDANCE_MARKDOWN, GUIDANCE_VERSION } from "./guidance.js";
import { settingsFailures } from "./settings-store.js";

/** The header Portal Core has always sent the instance token in for Knowledge. The kit's default is a Bearer token; both are accepted. */
export const LEGACY_INSTANCE_HEADER = "x-knowledge-instance-token";
export const GUIDANCE_PATH = `/.well-known/tealbrick/guidance/${GUIDANCE_VERSION}`;

export interface KnowledgeContractOptions {
  readonly manifest: Manifest;
  readonly env: NodeJS.ProcessEnv;
  readonly dataDir: string;
  readonly instanceToken: string;
  /** TEALBRICK_TENANT_ID (the workspace). Without it the claim endpoint stays with the legacy handler. */
  readonly tenantId: string | null;
  readonly portalOrigin: string | null;
  readonly identity: { readonly instanceId: string; readonly publicJwk: JsonWebKey; readonly privateKey: KeyObject };
  readonly setup: () => Promise<StatusReport>;
  readonly settings: SettingsStore;
  readonly grants: AppGrantAuthority;
  readonly audit: ContractAudit;
  readonly unlocks?: () => readonly string[];
  readonly companions?: () => Record<string, { bound: boolean; major?: number; status?: "ok" | "unreachable" | "unauthorized" | "unknown" }>;
  /** Tests tighten the emergency limits and clock; production uses the kit defaults. */
  readonly emergency?: Partial<Pick<EmergencyLoginOptions, "rateLimit" | "sessionTtlMs" | "now">>;
  readonly now?: () => number;
}

export interface KnowledgeContract {
  /** Kit endpoints (manifest, claim, status, settings, companions), the emergency login and the guidance. True = answered. */
  control(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  readonly settingsSessions: SettingsSessions;
  readonly emergency: EmergencyLogin;
  /** True when the kit answers the claim paths (a tenant is configured). */
  readonly claimsHandled: boolean;
  /** The instance token verifier (Bearer or the legacy header), for tests and the edge. */
  readonly instance: CredentialVerifier;
}

const composite = (verifiers: readonly CredentialVerifier[], kind: string): CredentialVerifier => ({
  kind,
  verify: (request) => verifyAny(verifiers, request),
}) as CredentialVerifier;

/** A response shim for the kit's Node adapter, so a settings apply failure can be answered with its real status. */
class CapturedResponse {
  statusCode = 200;
  headers: Record<string, string | string[]> = {};
  body: string | Buffer | undefined;
  writeHead(status: number, headers?: Record<string, string | string[]>) { this.statusCode = status; this.headers = { ...headers }; return this; }
  end(body?: string | Buffer) { this.body = body; return this; }
}

export function createKnowledgeContract(options: KnowledgeContractOptions): KnowledgeContract {
  const { manifest, env } = options;

  const settingsSessions = createSettingsSessions(options.now ? { now: options.now } : {});
  const instance = composite([
    createInstanceTokenVerifier({ token: options.instanceToken, header: LEGACY_INSTANCE_HEADER }),
    createInstanceTokenVerifier({ token: options.instanceToken }),
  ], "instance");

  const publicOrigin = env.TEALBRICK_PUBLIC_ORIGIN?.trim();
  const secureCookie = !(publicOrigin?.startsWith("http://") ?? false);
  const emergency = createEmergencyLogin({
    code: env.TEALBRICK_EMERGENCY_CODE,
    redirect: options.tenantId ? `/?companyId=${encodeURIComponent(options.tenantId)}` : "/",
    cookie: { secure: secureCookie },
    ...options.emergency,
    audit: (event: EmergencyAuditEvent) => {
      options.audit.record({
        kind: "emergency", operation: event.type, actor: event.client, outcome: event.outcome,
        code: "reason" in event && typeof event.reason === "string" ? event.reason : null,
      });
    },
  });

  const settingsVerifier = composite([settingsSessions.verifier, emergency.verifier], "settings");
  const claimsHandled = options.tenantId !== null;
  const kit = createNodeHandler({
    manifest,
    health: () => true,
    ...(claimsHandled
      ? {
          identity: { instanceId: options.identity.instanceId, publicJwk: options.identity.publicJwk },
          claim: { privateKey: options.identity.privateKey, tenantId: options.tenantId!, store: createFileClaimStore(options.dataDir), ...(options.now ? { now: options.now } : {}) },
          claimPaths: [...CLAIM_PATHS],
        }
      : {}),
    status: async () => options.setup(),
    settings: {
      read: () => options.settings.read(),
      write: (update, who) => options.settings.write(update, who),
    },
    effectiveUnlocks: () => options.unlocks?.() ?? [],
    companions: () => options.companions?.() ?? {},
    auth: { instance, settings: settingsVerifier },
    ...(options.portalOrigin ? { cors: { origins: [options.portalOrigin] } } : {}),
    audit: (event) => {
      options.audit.record({
        kind: "control", operation: `${event.method} ${event.endpoint}`, actor: event.credential ?? null, outcome: event.outcome,
        code: event.keys && event.keys.length ? `keys:${event.keys.join(",")}`.slice(0, 96) : null,
      });
    },
  });

  const emergencyHandler = emergency.nodeHandler({ trustProxy: true });
  const json = (res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
    res.end(JSON.stringify(payload));
  };

  async function control(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = (req.url ?? "/").split("?", 1)[0]!.replace(/(.)\/+$/u, "$1");
    if (pathname === emergency.paths.login || pathname === emergency.paths.logout || pathname === emergency.paths.session) {
      return emergencyHandler(req, res);
    }
    if (pathname === GUIDANCE_PATH) {
      if (req.method !== "GET") { json(res, 405, { error: "method_not_allowed" }, { allow: "GET" }); return true; }
      const verdict = await options.grants.verifyAny({ headers: req.headers });
      if (!verdict.ok) {
        json(res, verdict.status, { error: verdict.error }, verdict.status === 401 ? { "www-authenticate": 'Bearer error="invalid_token"' } : {});
        return true;
      }
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(GUIDANCE_MARKDOWN);
      return true;
    }
    // The kit also answers the legacy claim path; without a configured workspace it stays with the legacy handler.
    if (!pathname.startsWith("/.well-known/tealbrick/") && !(claimsHandled && (CLAIM_PATHS as readonly string[]).includes(pathname))) return false;
    return settingsFailures.run({}, async () => {
      const captured = new CapturedResponse();
      const handled = await kit(req as IncomingMessage & { body?: unknown }, captured as unknown as ServerResponse);
      if (!handled) return false;
      const failure = settingsFailures.getStore()?.failure;
      if (failure && captured.statusCode === 500) {
        json(res, failure.status, { error: failure.code, ...failure.details });
      } else {
        res.writeHead(captured.statusCode, captured.headers);
        res.end(captured.statusCode === 204 ? undefined : captured.body);
      }
      return true;
    });
  }

  return { control, settingsSessions, emergency, claimsHandled, instance };
}
