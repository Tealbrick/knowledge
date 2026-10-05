import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BuildKnowledgeAppOptions,
  KnowledgeCollectionSourceConfig,
  KnowledgeConfig,
  KnowledgeEnvironment,
  KnowledgeGBrainPartitionToken,
} from "./types.js";
import { normalizeKnowledgePartitionKey } from "./partition-authority.js";
import { resolveDefaultKnowledgeDataDir } from "./legacy-ids.js";

const programSrcDir = path.dirname(fileURLToPath(import.meta.url));
const microappRoot = path.resolve(programSrcDir, "..", "..");
const defaultGbrainRepoPath = path.join(microappRoot, "sidecars", "gbrain");

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function environmentFromEnv(value: string | undefined): KnowledgeEnvironment {
  if (value === "production" || value === "test") {
    return value;
  }
  return "development";
}

function optionalEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function browserSessionValue(
  configured: string | null | undefined,
  envName: string,
): string | null {
  if (configured !== undefined) return configured;
  if (Object.prototype.hasOwnProperty.call(process.env, envName)) {
    // Preserve an explicitly empty value so startup validation can fail
    // closed instead of silently disabling a partial browser configuration.
    return process.env[envName]?.trim() ?? "";
  }
  return null;
}

function configuredArray<T>(name: string): readonly T[] {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as T[];
  } catch {
    // Do not include the configured JSON: principal bindings contain secrets.
  }
  throw new Error(`${name} must be a JSON array`);
}

function configuredGbrainPartitionTokens(): readonly KnowledgeGBrainPartitionToken[] {
  const value = process.env.KNOWLEDGE_GBRAIN_PARTITION_TOKENS;
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("KNOWLEDGE_GBRAIN_PARTITION_TOKENS must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KNOWLEDGE_GBRAIN_PARTITION_TOKENS must be a JSON object");
  }
  const entries: KnowledgeGBrainPartitionToken[] = [];
  for (const [rawKey, rawToken] of Object.entries(parsed)) {
    const partitionKey = normalizeKnowledgePartitionKey(rawKey);
    if (!partitionKey || typeof rawToken !== "string" || !rawToken.trim()) {
      throw new Error("KNOWLEDGE_GBRAIN_PARTITION_TOKENS contains an invalid partition or token");
    }
    entries.push({ partitionKey, token: rawToken.trim() });
  }
  return Object.freeze(entries);
}

function booleanFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function sqlitePathFromDatabaseUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (value.startsWith("sqlite://")) {
    return path.resolve(value.slice("sqlite://".length));
  }
  if (value.startsWith("file:")) {
    return path.resolve(value.slice("file:".length));
  }
  return null;
}

function defaultDocsSourceConfigFromEnv(): KnowledgeCollectionSourceConfig | null {
  const provider =
    optionalEnv(process.env.KNOWLEDGE_DEFAULT_DOCS_PROVIDER) ??
    (optionalEnv(process.env.KNOWLEDGE_DEFAULT_DOCS_API_BASE_URL) ||
    optionalEnv(process.env.FORGEJO_BASE_URL) ||
    optionalEnv(process.env.PRODUCT_FORGEJO_BASE_URL)
      ? "forgejo_repo"
      : null);
  if (provider !== "forgejo_repo" && provider !== "github_repo") {
    return null;
  }
  const owner = optionalEnv(process.env.KNOWLEDGE_DEFAULT_DOCS_OWNER);
  const repo = optionalEnv(process.env.KNOWLEDGE_DEFAULT_DOCS_REPO);
  if (!owner || !repo) {
    return null;
  }
  const branch = optionalEnv(process.env.KNOWLEDGE_DEFAULT_DOCS_BRANCH) ?? "main";
  const rootPath = optionalEnv(process.env.KNOWLEDGE_DEFAULT_DOCS_ROOT_PATH) ?? "";
  const tokenEnvVar = optionalEnv(process.env.KNOWLEDGE_DEFAULT_DOCS_TOKEN_ENV_VAR);
  const secretName = optionalEnv(process.env.KNOWLEDGE_DEFAULT_DOCS_SECRET_NAME);
  if (provider === "github_repo") {
    return {
      branch,
      owner,
      provider: "github_repo",
      repo,
      rootPath,
      ...(secretName ? { secretName } : {}),
      ...(tokenEnvVar ? { tokenEnvVar } : {}),
    };
  }
  const apiBaseUrl =
    optionalEnv(process.env.KNOWLEDGE_DEFAULT_DOCS_API_BASE_URL) ??
    optionalEnv(process.env.FORGEJO_BASE_URL) ??
    optionalEnv(process.env.PRODUCT_FORGEJO_BASE_URL);
  if (!apiBaseUrl) {
    return null;
  }
  return {
    apiBaseUrl,
    branch,
    owner,
    provider: "forgejo_repo",
    repo,
    rootPath,
    ...(secretName ? { secretName } : {}),
    ...(tokenEnvVar ? { tokenEnvVar } : {}),
  };
}

export function loadConfig(options: BuildKnowledgeAppOptions = {}): KnowledgeConfig {
  const environment = options.environment ?? environmentFromEnv(process.env.NODE_ENV);
  const dataDir =
    options.config?.dataDir ??
    path.resolve(process.env.KNOWLEDGE_DATA_DIR ?? resolveDefaultKnowledgeDataDir());
  const knowledgeDatabaseUrl =
    options.config?.knowledgeDatabaseUrl ??
    optionalEnv(process.env.KNOWLEDGE_DATABASE_URL ?? process.env.DATABASE_URL);
  const explicitDatabasePath =
    options.config?.knowledgeDatabasePath ??
    optionalEnv(process.env.KNOWLEDGE_DATABASE_PATH) ??
    sqlitePathFromDatabaseUrl(knowledgeDatabaseUrl);
  return {
    host: options.config?.host ?? process.env.HOST ?? "127.0.0.1",
    port: options.config?.port ?? numberFromEnv(process.env.PORT, 0),
    environment,
    dataDir,
    defaultDocsSourceConfig:
      options.config?.defaultDocsSourceConfig ?? defaultDocsSourceConfigFromEnv(),
    gbrainBaseUrl: options.config?.gbrainBaseUrl ?? optionalEnv(process.env.GBRAIN_BASE_URL),
    gbrainToken: options.config?.gbrainToken ?? optionalEnv(process.env.GBRAIN_TOKEN),
    gbrainServiceUrl: options.config?.gbrainServiceUrl ?? optionalEnv(process.env.KNOWLEDGE_GBRAIN_URL),
    gbrainServiceAdminToken: options.config?.gbrainServiceAdminToken ?? optionalEnv(process.env.KNOWLEDGE_GBRAIN_ADMIN_TOKEN),
    gbrainPartitionTokens: options.config?.gbrainPartitionTokens ?? configuredGbrainPartitionTokens(),
    brainExtractionToken:
      options.config?.brainExtractionToken !== undefined
        ? optionalEnv(options.config.brainExtractionToken ?? undefined)
        : optionalEnv(process.env.KNOWLEDGE_BRAIN_EXTRACTION_TOKEN),
    gbrainHome:
      options.config?.gbrainHome ??
      path.resolve(process.env.KNOWLEDGE_GBRAIN_HOME ?? path.join(dataDir, "gbrain-home")),
    gbrainRepoPath:
      options.config?.gbrainRepoPath ??
      optionalEnv(process.env.KNOWLEDGE_GBRAIN_REPO_PATH) ??
      defaultGbrainRepoPath,
    gbrainAutoStart:
      options.config?.gbrainAutoStart ??
      (environment === "test" ? false : booleanFromEnv(process.env.KNOWLEDGE_GBRAIN_AUTOSTART, true)),
    openNotebookBaseUrl:
      options.config?.openNotebookBaseUrl !== undefined
        ? options.config.openNotebookBaseUrl
        : optionalEnv(process.env.KNOWLEDGE_OPEN_NOTEBOOK_BASE_URL),
    openNotebookToken:
      options.config?.openNotebookToken !== undefined
        ? options.config.openNotebookToken
        : optionalEnv(process.env.KNOWLEDGE_OPEN_NOTEBOOK_TOKEN),
    knowledgeServicePrincipals:
      options.config?.knowledgeServicePrincipals ?? configuredArray("KNOWLEDGE_SERVICE_PRINCIPALS"),
    partitionAuthorizationRequired:
      options.config?.partitionAuthorizationRequired ??
      booleanFromEnv(process.env.KNOWLEDGE_PARTITION_AUTH_REQUIRED, false),
    browserOperatorSecret: browserSessionValue(options.config?.browserOperatorSecret, "KNOWLEDGE_BROWSER_OPERATOR_SECRET"),
    browserPrincipalId: browserSessionValue(options.config?.browserPrincipalId, "KNOWLEDGE_BROWSER_PRINCIPAL_ID"),
    browserOrigin: browserSessionValue(options.config?.browserOrigin, "KNOWLEDGE_BROWSER_ORIGIN"),
    researchWriteLedgerPath:
      options.config?.researchWriteLedgerPath !== undefined
        ? options.config.researchWriteLedgerPath
        : optionalEnv(process.env.KNOWLEDGE_RESEARCH_WRITE_LEDGER_PATH) ??
          (environment === "test" ? null : path.join(dataDir, "research-writes.sqlite")),
    researchChatLedgerPath:
      options.config?.researchChatLedgerPath !== undefined ? options.config.researchChatLedgerPath :
        optionalEnv(process.env.KNOWLEDGE_RESEARCH_CHAT_LEDGER_PATH) ??
        (environment === "test" ? null : path.join(dataDir, "research-chat.sqlite")),
    openNotebookChatModelId:
      options.config?.openNotebookChatModelId !== undefined ? options.config.openNotebookChatModelId :
        optionalEnv(process.env.KNOWLEDGE_OPEN_NOTEBOOK_CHAT_MODEL_ID),
    openNotebookBindings:
      options.config?.openNotebookBindings ?? configuredArray("KNOWLEDGE_OPEN_NOTEBOOK_BINDINGS"),
    rulesBaseUrl:
      options.config?.rulesBaseUrl ??
      optionalEnv(process.env.KNOWLEDGE_RULES_BASE_URL ?? process.env.RULES_BASE_URL),
    rulesAuthToken:
      options.config?.rulesAuthToken ??
      optionalEnv(process.env.KNOWLEDGE_RULES_AUTH_TOKEN ?? process.env.RULES_INTERNAL_AUTH_TOKEN),
    rulesWorkspaceSlug:
      options.config?.rulesWorkspaceSlug ??
      optionalEnv(process.env.KNOWLEDGE_RULES_WORKSPACE_SLUG ?? process.env.WORKSPACE_SLUG) ??
      "default",
    rulesActorId:
      options.config?.rulesActorId ??
      optionalEnv(process.env.KNOWLEDGE_RULES_ACTOR_ID) ??
      "knowledge-program",
    rulesTimeoutMs:
      options.config?.rulesTimeoutMs ??
      numberFromEnv(process.env.KNOWLEDGE_RULES_TIMEOUT_MS, 5000),
    knowledgeDatabaseUrl,
    knowledgeDatabasePath:
      explicitDatabasePath ?? (environment === "test" ? null : path.join(dataDir, "knowledge.sqlite")),
  };
}
