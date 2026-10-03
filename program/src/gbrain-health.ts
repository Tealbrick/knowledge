export const DEFAULT_GBRAIN_HEALTH_TIMEOUT_MS = 1_500;
export const MAX_GBRAIN_HEALTH_RESPONSE_BYTES = 16 * 1024;

const MAX_GBRAIN_HEALTH_TIMEOUT_MS = 30_000;

export type GBrainHealthUnavailableReason =
  | "invalid_url"
  | "timeout"
  | "redirect_rejected"
  | "http_error"
  | "malformed_response"
  | "response_too_large"
  | "request_failed";

export type GBrainHealthResult =
  | {
      readonly status: "healthy";
      readonly version: string;
      readonly transport: "http";
      readonly db: "ok";
    }
  | {
      readonly status: "unavailable";
      readonly reason: GBrainHealthUnavailableReason;
    };

export type GBrainHealthProbeOptions = {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
};

class ProbeFailure extends Error {
  constructor(readonly reason: GBrainHealthUnavailableReason) {
    super(reason);
  }
}

function unavailable(reason: GBrainHealthUnavailableReason): GBrainHealthResult {
  return { status: "unavailable", reason };
}

function validateBaseUrl(value: string): URL | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function redirectRejected(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const cause = (error as { readonly cause?: unknown }).cause;
  return (
    cause !== null &&
    typeof cause === "object" &&
    typeof (cause as { readonly message?: unknown }).message === "string" &&
    (cause as { readonly message: string }).message.toLowerCase().includes("redirect")
  );
}

function projectHealth(value: unknown): GBrainHealthResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return unavailable("malformed_response");
  }
  const body = value as Record<string, unknown>;
  const version = body.version;
  // `serve --http` uses commands/serve-http.ts: its SELECT-1 liveness
  // contract names the engine, not transport/db. The older HTTP transport
  // remains valid for explicitly configured peers. Never accept bare `ok`.
  const managedHttp = (body.engine === "pglite" || body.engine === "postgres") &&
    body.transport === undefined && body.db === undefined;
  const legacyHttp = body.transport === "http" && body.db === "ok";
  if (
    body.status !== "ok" ||
    typeof version !== "string" ||
    version.trim() === "" ||
    !(managedHttp || legacyHttp)
  ) {
    return unavailable("malformed_response");
  }
  return {
    status: "healthy",
    version: version.trim(),
    transport: "http",
    db: "ok",
  };
}

export async function probeGBrainHealth(
  options: GBrainHealthProbeOptions,
): Promise<GBrainHealthResult> {
  const baseUrl = validateBaseUrl(options?.baseUrl);
  if (!baseUrl) {
    return unavailable("invalid_url");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_GBRAIN_HEALTH_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_GBRAIN_HEALTH_TIMEOUT_MS
  ) {
    return unavailable("request_failed");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const healthUrl = new URL("health", `${baseUrl.toString().replace(/\/$/u, "")}/`);
    const response = await (options.fetchImpl ?? fetch)(healthUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      throw new ProbeFailure("http_error");
    }
    if (!response.body) {
      throw new ProbeFailure("malformed_response");
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_GBRAIN_HEALTH_RESPONSE_BYTES) {
        throw new ProbeFailure("response_too_large");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return unavailable("malformed_response");
    }
    return projectHealth(parsed);
  } catch (error) {
    if (error instanceof ProbeFailure) {
      return unavailable(error.reason);
    }
    if (controller.signal.aborted) {
      return unavailable("timeout");
    }
    if (redirectRejected(error)) {
      return unavailable("redirect_rejected");
    }
    return unavailable("request_failed");
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}
