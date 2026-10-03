import type {
  KnowledgeCollectionSourceConfig,
  KnowledgeDocumentSourceState,
} from "./types.js";

type RepoBackedSourceConfig = Exclude<
  KnowledgeCollectionSourceConfig,
  { provider: "native" }
>;

export interface ReadDocumentResult {
  readonly body: string;
  readonly source: KnowledgeDocumentSourceState;
}

export interface WriteDocumentResult {
  readonly source: KnowledgeDocumentSourceState;
}

export interface DeleteDocumentResult {
  readonly deleted: boolean;
  readonly missing: boolean;
}

export interface ListDocumentResult {
  readonly htmlUrl?: string | null;
  readonly path: string;
  readonly sha?: string | null;
}

export class KnowledgeSourceSyncError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KnowledgeSourceSyncError";
  }
}

const SOURCE_REQUEST_TIMEOUT_MS = 20_000;

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/gu, "");
}

function validateRepoPath(value: string) {
  // Keep literal filenames, but reject paths whose interpretation could escape
  // the collection after URL parsing or provider-side percent decoding.
  let decoded = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      /[\\\u0000-\u001f\u007f]/u.test(decoded) ||
      decoded.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new KnowledgeSourceSyncError(
        "knowledge_source_path_invalid", 400,
        "Repository paths must stay within the configured collection.",
      );
    }
    const next = decoded.replace(/%([a-f0-9]{2})/giu, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === decoded) return;
    decoded = next;
  }
  throw new KnowledgeSourceSyncError(
    "knowledge_source_path_invalid", 400,
    "Repository paths must not contain excessive nested percent encoding.",
  );
}

function joinRepoPath(rootPath: string, sourcePath: string) {
  validateRepoPath(rootPath);
  validateRepoPath(sourcePath);
  const normalizedRoot = trimSlashes(rootPath);
  const normalizedPath = trimSlashes(sourcePath);
  return normalizedRoot
    ? `${normalizedRoot}/${normalizedPath}`
    : normalizedPath;
}

function parseAllowedForgejoBaseUrls() {
  return [
    process.env.KNOWLEDGE_FORGEJO_ALLOWED_BASE_URLS,
    process.env.FORGEJO_BASE_URL,
    process.env.PRODUCT_FORGEJO_BASE_URL,
  ]
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim().replace(/\/+$/gu, ""))
    .filter(Boolean);
}

function resolveAllowedForgejoApiBaseUrl(rawBaseUrl: string) {
  const parsed = new URL(rawBaseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new KnowledgeSourceSyncError(
      "knowledge_source_base_url_invalid",
      400,
      "Forgejo source apiBaseUrl must use http or https.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new KnowledgeSourceSyncError(
      "knowledge_source_base_url_invalid",
      400,
      "Forgejo source apiBaseUrl must not include userinfo.",
    );
  }

  const normalized = parsed.toString().replace(/\/+$/gu, "");
  const allowed = parseAllowedForgejoBaseUrls();
  if (
    process.env.NODE_ENV !== "test" &&
    allowed.length > 0 &&
    !allowed.includes(normalized)
  ) {
    throw new KnowledgeSourceSyncError(
      "knowledge_source_base_url_not_allowed",
      403,
      "Forgejo source apiBaseUrl is not in KNOWLEDGE_FORGEJO_ALLOWED_BASE_URLS.",
      { apiBaseUrl: normalized },
    );
  }
  if (process.env.NODE_ENV !== "test" && allowed.length === 0) {
    throw new KnowledgeSourceSyncError(
      "knowledge_source_base_url_allowlist_missing",
      500,
      "Forgejo source sync requires KNOWLEDGE_FORGEJO_ALLOWED_BASE_URLS.",
    );
  }
  return normalized;
}

function buildContentsUrl(
  sourceConfig: RepoBackedSourceConfig,
  sourcePath: string,
) {
  const resolvedPath = joinRepoPath(sourceConfig.rootPath, sourcePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (sourceConfig.provider === "github_repo") {
    return `https://api.github.com/repos/${encodeURIComponent(sourceConfig.owner)}/${encodeURIComponent(sourceConfig.repo)}/contents/${resolvedPath}`;
  }
  const baseUrl = resolveAllowedForgejoApiBaseUrl(sourceConfig.apiBaseUrl);
  return `${baseUrl}/api/v1/repos/${encodeURIComponent(sourceConfig.owner)}/${encodeURIComponent(sourceConfig.repo)}/contents/${resolvedPath}`;
}

function resolveSecretValue(secretName: string | undefined): string | null {
  const trimmed = secretName?.trim();
  if (!trimmed) {
    return null;
  }
  const envName = `KNOWLEDGE_SECRET_${trimmed.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`;
  return process.env[envName] ?? null;
}

async function buildHeaders(sourceConfig: RepoBackedSourceConfig) {
  const secretName = sourceConfig.secretName?.trim();
  const tokenEnvVar = sourceConfig.tokenEnvVar?.trim();
  if (tokenEnvVar && !/^KNOWLEDGE_[A-Z0-9_]+_TOKEN$/u.test(tokenEnvVar)) {
    throw new KnowledgeSourceSyncError(
      "knowledge_source_token_env_forbidden",
      400,
      "Knowledge source tokenEnvVar must be a dedicated KNOWLEDGE_*_TOKEN variable.",
      { tokenEnvVar },
    );
  }
  const token =
    resolveSecretValue(secretName) ??
    (tokenEnvVar ? (process.env[tokenEnvVar] ?? null) : null);
  if (!token) {
    throw new KnowledgeSourceSyncError(
      "knowledge_source_token_missing",
      500,
      `Missing token for ${sourceConfig.provider}.`,
      {
        provider: sourceConfig.provider,
        tokenEnvVar: sourceConfig.tokenEnvVar ?? null,
        secretName: sourceConfig.secretName ?? null,
      },
    );
  }
  return {
    accept: "application/json",
    authorization:
      sourceConfig.provider === "github_repo"
        ? `Bearer ${token}`
        : `token ${token}`,
    "content-type": "application/json",
  };
}

async function fetchSource(input: string | URL, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SOURCE_REQUEST_TIMEOUT_MS,
  );
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new KnowledgeSourceSyncError(
        "knowledge_source_request_timeout",
        504,
        "Knowledge source request timed out.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function parseErrorBody(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  try {
    return { message: await response.text() };
  } catch {
    return null;
  }
}

function decodeContent(content: string, encoding: string | null) {
  if (!content) {
    return "";
  }
  if (!encoding || encoding === "base64") {
    return Buffer.from(content.replace(/\n/gu, ""), "base64").toString("utf8");
  }
  return content;
}

function buildHtmlUrl(
  sourceConfig: RepoBackedSourceConfig,
  sourcePath: string,
  explicitHtmlUrl?: string | null,
) {
  if (explicitHtmlUrl) {
    return explicitHtmlUrl;
  }
  const joinedPath = joinRepoPath(sourceConfig.rootPath, sourcePath);
  if (sourceConfig.provider === "github_repo") {
    return `https://github.com/${sourceConfig.owner}/${sourceConfig.repo}/blob/${encodeURIComponent(sourceConfig.branch)}/${joinedPath}`;
  }
  const baseUrl = resolveAllowedForgejoApiBaseUrl(
    sourceConfig.apiBaseUrl,
  ).replace(/\/api\/v1$/iu, "");
  return `${baseUrl}/${sourceConfig.owner}/${sourceConfig.repo}/src/branch/${encodeURIComponent(sourceConfig.branch)}/${joinedPath}`;
}

interface RepoContentsResponse {
  readonly content?: string;
  readonly encoding?: string;
  readonly sha?: string;
  readonly html_url?: string | null;
  readonly path?: string;
}

interface RepoContentsListEntry {
  readonly html_url?: string | null;
  readonly path?: string;
  readonly sha?: string;
  readonly type?: string;
}

export function isRepoBackedSourceConfig(
  sourceConfig: KnowledgeCollectionSourceConfig | null | undefined,
): sourceConfig is RepoBackedSourceConfig {
  return Boolean(sourceConfig && sourceConfig.provider !== "native");
}

export function normalizeSourcePath(title: string, sourcePath?: string | null) {
  const normalized = trimSlashes(sourcePath ?? "");
  if (normalized) {
    return normalized;
  }
  const slug =
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "document";
  return `${slug}.md`;
}

export function normalizeStoredSourcePath(
  sourceConfig: RepoBackedSourceConfig,
  sourcePath: string,
) {
  validateRepoPath(sourceConfig.rootPath);
  validateRepoPath(sourcePath);
  const normalized = trimSlashes(sourcePath);
  const rootPath = trimSlashes(sourceConfig.rootPath);
  if (!rootPath || normalized === rootPath) {
    return normalized;
  }
  return normalized.startsWith(`${rootPath}/`)
    ? normalized.slice(rootPath.length + 1)
    : normalized;
}

function relativeProviderPath(sourceConfig: RepoBackedSourceConfig, path: string) {
  validateRepoPath(path);
  const root = trimSlashes(sourceConfig.rootPath);
  const normalized = trimSlashes(path);
  if (root && normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new KnowledgeSourceSyncError(
      "knowledge_source_path_invalid", 400,
      "Provider returned a path outside the configured collection.",
    );
  }
  return normalized === root ? "" : normalizeStoredSourcePath(sourceConfig, normalized);
}

export class KnowledgeSourceAdapters {
  async listDocuments(
    sourceConfig: RepoBackedSourceConfig,
    sourcePath = "",
  ): Promise<readonly ListDocumentResult[]> {
    const url = new URL(buildContentsUrl(sourceConfig, sourcePath));
    url.searchParams.set("ref", sourceConfig.branch);
    const response = await fetchSource(url, {
      headers: await buildHeaders(sourceConfig),
      method: "GET",
    });
    if (response.status === 404) {
      return [];
    }
    if (!response.ok) {
      throw new KnowledgeSourceSyncError(
        "knowledge_source_list_failed",
        502,
        `Remote document list failed with status ${response.status}.`,
        {
          provider: sourceConfig.provider,
          path: sourcePath,
          response: await parseErrorBody(response),
        },
      );
    }
    const payload = (await response.json()) as
      | RepoContentsResponse
      | RepoContentsListEntry[];
    if (!Array.isArray(payload)) {
      const path = payload.path === undefined
        ? normalizeStoredSourcePath(sourceConfig, sourcePath)
        : relativeProviderPath(sourceConfig, payload.path);
      return path
        ? [
            {
              htmlUrl: buildHtmlUrl(
                sourceConfig,
                payload.path ?? sourcePath,
                payload.html_url ?? null,
              ),
              path,
              sha: payload.sha ?? null,
            },
          ]
        : [];
    }

    const output: ListDocumentResult[] = [];
    for (const entry of payload) {
      const entryPath = relativeProviderPath(
        sourceConfig,
        entry.path ?? "",
      );
      if (!entryPath) {
        continue;
      }
      if (entry.type === "dir") {
        output.push(...(await this.listDocuments(sourceConfig, entryPath)));
        continue;
      }
      if (entry.type === "file" || !entry.type) {
        output.push({
          htmlUrl: buildHtmlUrl(
            sourceConfig,
            entry.path ?? entryPath,
            entry.html_url ?? null,
          ),
          path: entryPath,
          sha: entry.sha ?? null,
        });
      }
    }
    return output;
  }

  private async verifyTimedOutWrite(
    sourceConfig: RepoBackedSourceConfig,
    input: {
      readonly sourcePath: string;
      readonly body: string;
    },
  ): Promise<WriteDocumentResult> {
    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const remote = await this.readDocument(sourceConfig, input.sourcePath);
        if (remote.body === input.body) {
          return { source: remote.source };
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new KnowledgeSourceSyncError(
      "knowledge_source_write_timeout_unverified",
      504,
      "Knowledge source write timed out and could not be verified.",
      {
        path: input.sourcePath,
        reason:
          lastError instanceof Error
            ? lastError.message
            : String(lastError ?? "unknown"),
      },
    );
  }

  async readDocument(
    sourceConfig: RepoBackedSourceConfig,
    sourcePath: string,
  ): Promise<ReadDocumentResult> {
    const url = new URL(buildContentsUrl(sourceConfig, sourcePath));
    url.searchParams.set("ref", sourceConfig.branch);
    const response = await fetchSource(url, {
      headers: await buildHeaders(sourceConfig),
      method: "GET",
    });
    if (response.status === 404) {
      throw new KnowledgeSourceSyncError(
        "knowledge_source_document_missing",
        404,
        `Remote document ${sourcePath} was not found in ${sourceConfig.provider}.`,
        { provider: sourceConfig.provider, path: sourcePath },
      );
    }
    if (!response.ok) {
      throw new KnowledgeSourceSyncError(
        "knowledge_source_read_failed",
        502,
        `Remote document read failed with status ${response.status}.`,
        {
          provider: sourceConfig.provider,
          path: sourcePath,
          response: await parseErrorBody(response),
        },
      );
    }
    const payload = (await response.json()) as RepoContentsResponse;
    return {
      body: decodeContent(payload.content ?? "", payload.encoding ?? null),
      source: {
        provider: sourceConfig.provider,
        path: sourcePath,
        sha: payload.sha ?? null,
        htmlUrl: buildHtmlUrl(
          sourceConfig,
          payload.path ?? sourcePath,
          payload.html_url ?? null,
        ),
        syncedAt: new Date().toISOString(),
      },
    };
  }

  async writeDocument(
    sourceConfig: RepoBackedSourceConfig,
    input: {
      readonly sourcePath: string;
      readonly body: string;
      readonly sha?: string | null;
      readonly title: string;
      readonly operation: "create" | "update";
    },
  ): Promise<WriteDocumentResult> {
    const method =
      sourceConfig.provider === "forgejo_repo" && input.operation === "create"
        ? "POST"
        : "PUT";
    let response: Response;
    try {
      response = await fetchSource(
        buildContentsUrl(sourceConfig, input.sourcePath),
        {
          headers: await buildHeaders(sourceConfig),
          method,
          body: JSON.stringify({
            branch: sourceConfig.branch,
            content: Buffer.from(input.body, "utf8").toString("base64"),
            message:
              input.operation === "create"
                ? `Create ${input.title}`
                : `Update ${input.title}`,
            ...(input.sha ? { sha: input.sha } : {}),
          }),
        },
      );
    } catch (error) {
      if (
        error instanceof KnowledgeSourceSyncError &&
        error.code === "knowledge_source_request_timeout"
      ) {
        return this.verifyTimedOutWrite(sourceConfig, input);
      }
      throw error;
    }
    if (!response.ok) {
      throw new KnowledgeSourceSyncError(
        input.operation === "create"
          ? "knowledge_source_create_failed"
          : "knowledge_source_update_failed",
        response.status === 409 || response.status === 422 ? 409 : 502,
        `Remote document ${input.operation} failed with status ${response.status}.`,
        {
          provider: sourceConfig.provider,
          path: input.sourcePath,
          response: await parseErrorBody(response),
        },
      );
    }
    const payload = (await response.json()) as {
      readonly content?: RepoContentsResponse;
    };
    const content = payload.content ?? {};
    return {
      source: {
        provider: sourceConfig.provider,
        path: input.sourcePath,
        sha: content.sha ?? null,
        htmlUrl: buildHtmlUrl(
          sourceConfig,
          content.path ?? input.sourcePath,
          content.html_url ?? null,
        ),
        syncedAt: new Date().toISOString(),
      },
    };
  }

  async deleteDocument(
    sourceConfig: RepoBackedSourceConfig,
    input: {
      readonly sourcePath: string;
      readonly sha?: string | null;
      readonly title: string;
    },
  ): Promise<DeleteDocumentResult> {
    if (!input.sha) {
      throw new KnowledgeSourceSyncError(
        "knowledge_source_delete_sha_missing",
        409,
        "Remote document delete requires a known source sha.",
        {
          provider: sourceConfig.provider,
          path: input.sourcePath,
        },
      );
    }
    const response = await fetchSource(
      buildContentsUrl(sourceConfig, input.sourcePath),
      {
        headers: await buildHeaders(sourceConfig),
        method: "DELETE",
        body: JSON.stringify({
          branch: sourceConfig.branch,
          message: `Delete ${input.title}`,
          sha: input.sha,
        }),
      },
    );
    if (response.status === 404) {
      return { deleted: false, missing: true };
    }
    if (!response.ok) {
      throw new KnowledgeSourceSyncError(
        "knowledge_source_delete_failed",
        response.status === 409 || response.status === 422 ? 409 : 502,
        `Remote document delete failed with status ${response.status}.`,
        {
          provider: sourceConfig.provider,
          path: input.sourcePath,
          response: await parseErrorBody(response),
        },
      );
    }
    return { deleted: true, missing: false };
  }
}
