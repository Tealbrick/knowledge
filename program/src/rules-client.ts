export interface KnowledgeRulesEvaluationInput {
  readonly operation: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly companyId: string | null;
  readonly payload: Record<string, unknown>;
  readonly actor: {
    readonly id: string;
    readonly roles: readonly string[];
    readonly source: string;
    readonly companyId: string | null;
  };
}

export type KnowledgeRulesEffect = "allow" | "deny" | "review" | "unavailable";

export interface KnowledgeRulesDecision {
  readonly allowed: boolean;
  readonly effect: KnowledgeRulesEffect;
  readonly reason: string | null;
  readonly code: string | null;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RULES_RESPONSE_BYTES = 64 * 1024;
const KNOWN_DECISION_CODES = new Set(["invalid_request", "unavailable", "review_required"]);

function boundedTimeout(value: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? value : DEFAULT_TIMEOUT_MS, 1), 30_000);
}

function safeReason(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.slice(0, 500) : null;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_RULES_RESPONSE_BYTES) {
      throw new Error("Rules response exceeded the response byte limit.");
    }
  }
  if (!response.body) {
    throw new Error("Rules response had no body.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RULES_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Rules response exceeded the response byte limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export class KnowledgeRulesClient {
  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly authToken: string;
      readonly workspaceSlug: string;
      readonly timeoutMs: number;
    },
  ) {}

  async evaluate(input: KnowledgeRulesEvaluationInput): Promise<KnowledgeRulesDecision> {
    const endpoint = `${this.options.baseUrl.replace(/\/+$/u, "")}/api/rules/gateway/evaluate`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), boundedTimeout(this.options.timeoutMs));
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.authToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({
          method: "doppelganger.rules.evaluate",
          params: {
            ruleKey: "knowledge",
            operation: input.operation,
            actor: input.actor,
            target: {
              kind: input.targetKind,
              id: input.targetId,
              ...(input.companyId ? { companyId: input.companyId } : {}),
            },
            payload: input.payload,
            runtimeContext: {
              app: "knowledge",
              workspaceSlug: this.options.workspaceSlug,
            },
          },
          client: null,
        }),
      });
      if (!response.ok) {
        return {
          allowed: false,
          effect: response.status === 401 || response.status === 403 ? "deny" : "unavailable",
          reason: response.status === 401 || response.status === 403 ? "Rules authorization was rejected." : "Rules Approvals is unavailable.",
          code: response.status === 401 || response.status === 403 ? "forbidden" : "unavailable",
        };
      }
      const body: unknown = await readResponseJson(response);
      if (
        !body ||
        typeof body !== "object" ||
        typeof (body as { allowed?: unknown }).allowed !== "boolean" ||
        typeof (body as { reason?: unknown }).reason !== "string" ||
        !Object.prototype.hasOwnProperty.call(body, "method") ||
        !Object.prototype.hasOwnProperty.call(body, "details") ||
        (body as { method?: unknown }).method !== "doppelganger.rules.evaluate" ||
        typeof (body as { details?: unknown }).details !== "object" ||
        (body as { details?: unknown }).details === null ||
        Array.isArray((body as { details?: unknown }).details)
      ) {
        return { allowed: false, effect: "unavailable", reason: "Rules returned an invalid decision.", code: "invalid_response" };
      }
      const result = body as {
        allowed: boolean;
        reason: string;
        code?: unknown;
        effect?: unknown;
        method: string | null;
        details: Record<string, unknown>;
      };
      const reason = safeReason(result.reason);
      const code = typeof result.code === "string" ? result.code : null;
      if (!reason) {
        return { allowed: false, effect: "unavailable", reason: "Rules returned an invalid decision.", code: "invalid_response" };
      }
      if (result.code !== undefined && (typeof result.code !== "string" || !KNOWN_DECISION_CODES.has(result.code))) {
        return { allowed: false, effect: "unavailable", reason: "Rules returned an unknown decision code.", code: "invalid_response" };
      }
      if (result.effect !== undefined) {
        if (
          typeof result.effect !== "string" ||
          !["allow", "deny", "review"].includes(result.effect) ||
          (result.allowed && result.effect !== "allow") ||
          (!result.allowed && result.effect === "allow") ||
          (result.effect === "review" && code !== "review_required")
        ) {
          return { allowed: false, effect: "unavailable", reason: "Rules returned a contradictory decision.", code: "invalid_response" };
        }
      }
      if (code === "review_required") {
        if (result.allowed) {
          return { allowed: false, effect: "unavailable", reason: "Rules returned a contradictory decision.", code: "invalid_response" };
        }
        return { allowed: false, effect: "review", reason, code };
      }
      if (code === "unavailable" || code === "invalid_request") {
        if (result.allowed) {
          return { allowed: false, effect: "unavailable", reason: "Rules returned a contradictory decision.", code: "invalid_response" };
        }
        return { allowed: false, effect: "unavailable", reason, code };
      }
      return {
        allowed: result.allowed,
        effect: result.allowed ? "allow" : "deny",
        reason,
        code,
      };
    } catch {
      return { allowed: false, effect: "unavailable", reason: "Rules Approvals is unavailable.", code: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
