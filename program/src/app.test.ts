import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildKnowledgeApp } from "./app.js";
import { loadConfig } from "./config.js";

interface FakeForgejoContentsEntry {
  readonly html_url?: string;
  readonly name: string;
  readonly path: string;
  readonly sha?: string;
  readonly type: "dir" | "file";
}

async function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]] as const),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withFakeGBrain<T>(
  fn: (input: {
    readonly baseUrl: string;
    readonly calls: Array<Record<string, unknown>>;
  }) => Promise<T>,
  options: {
    readonly recallFacts?: readonly Record<string, unknown>[];
    readonly pendingConsolidationCount?: number;
    readonly queryResults?: readonly Record<string, unknown>[];
    readonly pageRows?: readonly Record<string, unknown>[];
    readonly entityCard?: Record<string, unknown>;
    readonly timeline?: readonly Record<string, unknown>[];
    readonly links?: readonly Record<string, unknown>[];
    readonly graph?: readonly Record<string, unknown>[];
    readonly failingTools?: readonly string[];
  } = {},
): Promise<T> {
  const calls: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", version: "0.48.2.0", engine: "pglite" }));
      return;
    }
    if (request.url === "/mcp" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as {
          id?: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        calls.push({
          authorization: request.headers.authorization,
          name: parsed.params?.name,
          arguments: parsed.params?.arguments,
        });
        if (options.failingTools?.includes(parsed.params?.name ?? "")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                isError: true,
                content: [{ type: "text", text: JSON.stringify({ error: "synthetic_failure" }) }],
              },
            }),
          );
          return;
        }
        const responseBody =
          parsed.params?.name === "recall"
          ? {
              facts: options.recallFacts ?? [],
              pending_consolidation_count:
                options.pendingConsolidationCount ?? 0,
              }
            : parsed.params?.name === "list_pages" && options.pageRows
              ? options.pageRows
            : parsed.params?.name === "entity" && options.entityCard
              ? options.entityCard
            : parsed.params?.name === "get_timeline" && options.timeline
              ? options.timeline
            : parsed.params?.name === "get_links" && options.links
              ? options.links
            : parsed.params?.name === "traverse_graph" && options.graph
              ? options.graph
            : parsed.params?.name === "query" && options.queryResults
              ? options.queryResults
            : {
                tool: parsed.params?.name,
                args: parsed.params?.arguments,
              };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(responseBody),
                },
              ],
            },
          }),
        );
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn({ baseUrl: `http://127.0.0.1:${address.port}`, calls });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withFakeForgejo<T>(
  fn: (input: {
    readonly baseUrl: string;
    readonly calls: Array<Record<string, unknown>>;
    readonly setRemoteBody: (path: string, body: string) => void;
  }) => Promise<T>,
): Promise<T> {
  const calls: Array<Record<string, unknown>> = [];
  const files = new Map<string, { body: string; sha: string }>();
  const previousToken = process.env.KNOWLEDGE_TEST_TOKEN;
  const previousAllowlist = process.env.KNOWLEDGE_FORGEJO_ALLOWED_BASE_URLS;
  let baseUrl = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const repoPath = decodeURIComponent(
      url.pathname.replace(/^\/api\/v1\/repos\/team\/docs\/contents\//u, ""),
    );
    if (!url.pathname.startsWith("/api/v1/repos/team/docs/contents/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    request.on("end", () => {
      const parsedBody = rawBody
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : null;
      calls.push({
        method: request.method,
        path: repoPath,
        authorization: request.headers.authorization,
        body: parsedBody,
      });
      if (request.headers.authorization !== "token forgejo_token") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "bad token" }));
        return;
      }
      if (request.method === "GET") {
        const file = files.get(repoPath);
        if (file) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              content: Buffer.from(file.body, "utf8").toString("base64"),
              encoding: "base64",
              sha: file.sha,
              path: repoPath,
              html_url: `${baseUrl}/team/docs/src/branch/main/${repoPath}`,
            }),
          );
          return;
        }
        const directoryPrefix = repoPath
          ? `${repoPath.replace(/\/+$/u, "")}/`
          : "";
        const directoryEntries: FakeForgejoContentsEntry[] = [];
        for (const [filePath, entry] of files.entries()) {
          if (!filePath.startsWith(directoryPrefix)) {
            continue;
          }
          const relativePath = filePath.slice(directoryPrefix.length);
          const [segment] = relativePath.split("/");
          if (!segment) {
            continue;
          }
          const childPath = `${directoryPrefix}${segment}`;
          directoryEntries.push(
            relativePath.includes("/")
              ? {
                  name: segment,
                  path: childPath,
                  type: "dir",
                }
              : {
                  html_url: `${baseUrl}/team/docs/src/branch/main/${filePath}`,
                  name: segment,
                  path: filePath,
                  sha: entry.sha,
                  type: "file",
                },
          );
        }
        const dedupedEntries = Array.from(
          new Map(
            directoryEntries.map((entry) => [entry.path, entry]),
          ).values(),
        );
        if (dedupedEntries.length === 0) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "missing" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(dedupedEntries));
        return;
      }
      if (request.method === "POST" || request.method === "PUT") {
        const content =
          typeof parsedBody?.content === "string"
            ? Buffer.from(parsedBody.content, "base64").toString("utf8")
            : "";
        const sha = request.method === "POST" ? "sha-create" : "sha-update";
        files.set(repoPath, { body: content, sha });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            content: {
              sha,
              path: repoPath,
              html_url: `${baseUrl}/team/docs/src/branch/main/${repoPath}`,
            },
          }),
        );
        return;
      }
      if (request.method === "DELETE") {
        files.delete(repoPath);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: null }));
        return;
      }
      response.writeHead(405);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.KNOWLEDGE_TEST_TOKEN = "forgejo_token";
  process.env.KNOWLEDGE_FORGEJO_ALLOWED_BASE_URLS = baseUrl;
  try {
    return await fn({
      baseUrl,
      calls,
      setRemoteBody: (repoPath, body) =>
        files.set(repoPath, { body, sha: "sha-remote" }),
    });
  } finally {
    if (previousToken === undefined) {
      delete process.env.KNOWLEDGE_TEST_TOKEN;
    } else {
      process.env.KNOWLEDGE_TEST_TOKEN = previousToken;
    }
    if (previousAllowlist === undefined) {
      delete process.env.KNOWLEDGE_FORGEJO_ALLOWED_BASE_URLS;
    } else {
      process.env.KNOWLEDGE_FORGEJO_ALLOWED_BASE_URLS = previousAllowlist;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function multipartBody(input: {
  readonly fields?: Record<string, string>;
  readonly files: Array<{
    readonly name: string;
    readonly filename: string;
    readonly contentType: string;
    readonly body: string;
  }>;
}) {
  const boundary = "knowledge-test-boundary";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  for (const file of input.files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n${file.body}\r\n`,
        "utf8",
      ),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("Knowledge Program", () => {
  it("defaults standalone persistence to the Knowledge hidden home", () => {
    const previousDataDir = process.env.KNOWLEDGE_DATA_DIR;
    const previousDatabasePath = process.env.KNOWLEDGE_DATABASE_PATH;
    const previousDatabaseUrl = process.env.KNOWLEDGE_DATABASE_URL;
    const previousDatabaseUrlFallback = process.env.DATABASE_URL;
    delete process.env.KNOWLEDGE_DATA_DIR;
    delete process.env.KNOWLEDGE_DATABASE_PATH;
    delete process.env.KNOWLEDGE_DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const config = loadConfig({ environment: "development" });
      expect(config.dataDir).toBe(
        path.join(os.homedir(), ".doppelganger-knowledge"),
      );
      expect(config.knowledgeDatabasePath).toBe(
        path.join(os.homedir(), ".doppelganger-knowledge", "knowledge.sqlite"),
      );
      expect(config.gbrainHome).toBe(
        path.join(os.homedir(), ".doppelganger-knowledge", "gbrain-home"),
      );
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.KNOWLEDGE_DATA_DIR;
      } else {
        process.env.KNOWLEDGE_DATA_DIR = previousDataDir;
      }
      if (previousDatabasePath === undefined) {
        delete process.env.KNOWLEDGE_DATABASE_PATH;
      } else {
        process.env.KNOWLEDGE_DATABASE_PATH = previousDatabasePath;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.KNOWLEDGE_DATABASE_URL;
      } else {
        process.env.KNOWLEDGE_DATABASE_URL = previousDatabaseUrl;
      }
      if (previousDatabaseUrlFallback === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrlFallback;
      }
    }
  });

  it("reports the four internal sub-apps and sidecar readiness", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });

    const response = await app.inject({ method: "GET", url: "/api/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      microappId: "knowledge",
      subapps: {
        documents: { status: "online" },
        research: { status: "degraded", runtime: "open_notebook", runtimeVerified: false },
        brain: { status: "degraded" },
        orchestrator: { status: "online" },
      },
      sidecars: {
        gbrain: {
          required: true,
          schemaPack: { name: "doppelganger", status: "not-managed" },
        },
        knowledgeDb: { required: true },
      },
    });

    await app.close();
  });

  it("can default the canonical docs collection to a Forgejo source from environment", async () => {
    await withEnv(
      {
        KNOWLEDGE_DEFAULT_DOCS_API_BASE_URL: "https://forge.example.test",
        KNOWLEDGE_DEFAULT_DOCS_BRANCH: "main",
        KNOWLEDGE_DEFAULT_DOCS_OWNER: "team",
        KNOWLEDGE_DEFAULT_DOCS_REPO: "docs",
        KNOWLEDGE_DEFAULT_DOCS_ROOT_PATH: "projects/doppelganger/knowledge",
        KNOWLEDGE_DEFAULT_DOCS_TOKEN_ENV_VAR: "KNOWLEDGE_FORGEJO_DOCS_TOKEN",
      },
      async () => {
        const app = await buildKnowledgeApp({ environment: "test" });

        const response = await app.inject({
          method: "GET",
          url: "/api/companies/company-1/knowledge/collections",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()[0]).toMatchObject({
          name: "Default",
          sourceConfig: {
            apiBaseUrl: "https://forge.example.test",
            branch: "main",
            owner: "team",
            provider: "forgejo_repo",
            repo: "docs",
            rootPath: "projects/doppelganger/knowledge",
            tokenEnvVar: "KNOWLEDGE_FORGEJO_DOCS_TOKEN",
          },
        });

        await app.close();
      },
    );
  });

  it("serves the primitive observer UI for smoke testing", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    if (response.body.includes('<div id="root">')) {
      // After `build:web`, "/" serves the built customer shell instead.
      expect(response.body).toContain("<title>Knowledge · Teal Brick</title>");
      expect(response.body).not.toContain("Doppelganger");
    } else {
      expect(response.body).toContain("Knowledge Micro-app");
      expect(response.body).toContain("Documents");
      expect(response.body).toContain("GBrain");
    }

    await app.close();
  });

  it("allows loopback App fetches from the desktop web shell", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });

    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { origin: "http://localhost:5733" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["access-control-allow-methods"]).toContain(
      "OPTIONS",
    );

    const options = await app.inject({
      method: "OPTIONS",
      url: "/api/status",
      headers: {
        origin: "http://localhost:5733",
        "access-control-request-method": "GET",
      },
    });
    expect(options.statusCode).toBe(204);

    await app.close();
  });

  it("creates and resolves Work Ethic bindings without owning work state", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });

    const create = await app.inject({
      method: "POST",
      url: "/api/bindings",
      payload: {
        ownerPlugin: "work-ethic-kanban",
        ownerType: "task",
        ownerId: "task-123",
        artifactType: "document",
        artifactId: "doc-456",
        relationshipType: "supporting-context",
        summary: "Design system brief",
      },
    });

    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created).toMatchObject({
      ownerPlugin: "work-ethic-kanban",
      ownerType: "task",
      ownerId: "task-123",
      artifactType: "document",
      artifactId: "doc-456",
      relationshipType: "supporting-context",
    });
    expect(created.bindingId).toMatch(/^binding_/);

    const list = await app.inject({
      method: "GET",
      url: "/api/bindings?ownerPlugin=work-ethic-kanban&ownerType=task&ownerId=task-123",
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([created]);

    await app.close();
  });

  it("exposes first-grade brain context without pretending it is document search", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });

    const response = await app.inject({
      method: "POST",
      url: "/api/brain/context",
      payload: {
        scopeRef: "workspace:test",
        purpose: "task",
        query: "Who is Ian Borders to me?",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      source: "gbrain-adapter",
      mode: "context",
      status: "degraded",
      answer: null,
      citations: [],
    });

    await app.close();
  });

  it("enforces server-attested partition grants across the general Knowledge API", async () => {
    const app = await buildKnowledgeApp({
      environment: "test",
      config: {
        gbrainAutoStart: false,
        partitionAuthorizationRequired: true,
        knowledgeServicePrincipals: [{
          token: "fleet-alpha-token",
          principalId: "fleet-alpha",
          companyId: "WorkspaceAlpha",
          capabilities: ["knowledge:read", "knowledge:write"],
          partitionGrants: [{
            partitionKey: "WorkspaceAlpha",
            breadth: "descendants",
            maxDepth: 1,
            capabilities: ["knowledge:read", "knowledge:write"],
          }],
        }],
      },
    });

    const unauthorized = await app.inject({ method: "GET", url: "/api/knowledge/partitions" });
    expect(unauthorized.statusCode).toBe(401);

    const partitions = await app.inject({
      method: "GET",
      url: "/api/knowledge/partitions",
      headers: { authorization: "Bearer fleet-alpha-token" },
    });
    expect(partitions.statusCode).toBe(200);
    expect(partitions.json().partitions).toEqual([
      expect.objectContaining({ partitionKey: "workspacealpha", breadth: "descendants", maxDepth: 1 }),
    ]);

    const created = await app.inject({
      method: "POST",
      url: "/api/companies/WorkspaceAlpha/knowledge/collections",
      headers: { authorization: "Bearer fleet-alpha-token" },
      payload: { name: "Workspace alpha knowledge" },
    });
    expect(created.statusCode).toBe(201);

    const binding = await app.inject({
      method: "POST",
      url: "/api/bindings",
      headers: { authorization: "Bearer fleet-alpha-token" },
      payload: {
        ownerPlugin: "work-ethic-kanban",
        ownerType: "task",
        ownerId: "task-alpha",
        artifactType: "document",
        artifactId: created.json().id,
        relationshipType: "supporting-context",
        partitionKey: "WorkspaceAlpha",
      },
    });
    expect(binding.statusCode).toBe(201);
    const bindings = await app.inject({
      method: "GET",
      url: "/api/bindings?partitionKey=WorkspaceAlpha",
      headers: { authorization: "Bearer fleet-alpha-token" },
    });
    expect(bindings.statusCode).toBe(200);
    expect(bindings.json()).toEqual([expect.objectContaining({ partitionKey: "WorkspaceAlpha" })]);

    const ownerBinding = await app.inject({
      method: "POST",
      url: "/api/projects/project-alpha/knowledge/collections",
      headers: { authorization: "Bearer fleet-alpha-token" },
      payload: { collectionId: created.json().id, bindingType: "project-context" },
    });
    expect(ownerBinding.statusCode).toBe(201);
    expect(ownerBinding.json()).toMatchObject({ partitionKey: "WorkspaceAlpha" });
    const ownerListing = await app.inject({
      method: "GET",
      url: "/api/projects/project-alpha/knowledge/collections?partitionKey=WorkspaceAlpha",
      headers: { authorization: "Bearer fleet-alpha-token" },
    });
    expect(ownerListing.statusCode).toBe(200);
    expect(ownerListing.json()).toEqual([expect.objectContaining({ partitionKey: "WorkspaceAlpha" })]);

    const denied = await app.inject({
      method: "GET",
      url: "/api/companies/WorkspaceBeta/knowledge/search?q=private",
      headers: { authorization: "Bearer fleet-alpha-token" },
    });
    expect(denied.statusCode).toBe(403);
    const ownerDenied = await app.inject({
      method: "GET",
      url: "/api/projects/project-alpha/knowledge/collections?partitionKey=WorkspaceBeta",
      headers: { authorization: "Bearer fleet-alpha-token" },
    });
    expect(ownerDenied.statusCode).toBe(403);

    await app.close();
  });

  it("projects GBrain query provenance into first-grade context citations", async () => {
    await withFakeGBrain(
      async ({ baseUrl }) => {
        const app = await buildKnowledgeApp({
          environment: "test",
          config: {
            gbrainBaseUrl: baseUrl,
            gbrainToken: "gbrain_test",
          },
        });

        const response = await app.inject({
          method: "POST",
          url: "/api/brain/context",
          payload: {
            scopeRef: "task:KYB-287",
            purpose: "task",
            query: "HDDA acceptance fixtures",
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          status: "ready",
          citations: [
            {
              sourceId: "default",
              pageId: 1,
              slug: "knowledge-docs/kdoc_0001",
              title: "KYB-287 Acceptance Fixture Preference",
              kind: "knowledge_document",
              citation: "[knowledge-docs/kdoc_0001]",
              excerpt: "Fixtures should be safe and reversible.",
              chunkSource: "compiled_truth",
              score: 0.99,
            },
          ],
        });

        await app.close();
      },
      {
        queryResults: [
          {
            slug: "knowledge-docs/kdoc_0001",
            page_id: 1,
            title: "KYB-287 Acceptance Fixture Preference",
            type: "knowledge_document",
            chunk_text: "Fixtures should be safe and reversible.",
            chunk_source: "compiled_truth",
            score: 0.99,
            source_id: "default",
          },
        ],
      },
    );
  });

  it("enumerates native GBrain pages and filters entity types without fact recall", async () => {
    await withFakeGBrain(
      async ({ baseUrl, calls }) => {
        const app = await buildKnowledgeApp({
          environment: "test",
          config: {
            gbrainBaseUrl: baseUrl,
            gbrainToken: "gbrain_test",
          },
        });

        const response = await app.inject({
          method: "GET",
          url: "/api/brain/entities",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          ok: true,
          source: "gbrain-adapter",
          status: "ready",
          kind: "entities",
          entities: [
            {
              slug: "people/ian-borders",
              title: "Ian Borders",
              type: "person",
            },
          ],
          pages: [],
          capabilities: {
            pageEnumeration: { operation: "list_pages", status: "ready" },
            entityCard: { operation: "entity", status: "unknown" },
          },
          pagination: {
            limit: 50,
            offset: 0,
            returned: 1,
            complete: true,
            hasMore: false,
          },
        });
        expect(calls).toContainEqual(
          expect.objectContaining({
            authorization: "Bearer gbrain_test",
            name: "list_pages",
            arguments: expect.objectContaining({
              limit: 51,
              offset: 0,
              sort: "updated_desc",
            }),
          }),
        );
        expect(calls.some((call) => call.name === "recall")).toBe(false);

        await app.close();
      },
      {
        pageRows: [
          {
            slug: "people/ian-borders",
            title: "Ian Borders",
            type: "person",
            source_id: "default",
            updated_at: "2026-07-07T00:00:00.000Z",
          },
          {
            slug: "knowledge-docs/kdoc_0001",
            title: "A document",
            type: "knowledge_document",
            source_id: "default",
            updated_at: "2026-07-06T00:00:00.000Z",
          },
        ],
      },
    );
  });

  it("keeps all native pages separate from entity projections and reports bounded pagination", async () => {
    await withFakeGBrain(
      async ({ baseUrl, calls }) => {
        const app = await buildKnowledgeApp({
          environment: "test",
          config: {
            gbrainBaseUrl: baseUrl,
            gbrainToken: "gbrain_test",
          },
        });

        const pages = await app.inject({
          method: "GET",
          url: "/api/brain/entities?kind=pages&limit=2&offset=4",
        });
        expect(pages.statusCode).toBe(200);
        expect(pages.json()).toMatchObject({
          ok: true,
          kind: "pages",
          entities: [],
          pages: [
            { slug: "people/ian-borders", type: "person" },
            { slug: "knowledge-docs/kdoc_0001", type: "knowledge_document" },
          ],
          selected: [
            { slug: "people/ian-borders" },
            { slug: "knowledge-docs/kdoc_0001" },
          ],
          pagination: {
            limit: 2,
            offset: 4,
            returned: 2,
            scanned: 2,
            complete: false,
            hasMore: true,
          },
        });

        const all = await app.inject({
          method: "GET",
          url: "/api/brain/entities?kind=all&limit=10",
        });
        expect(all.statusCode).toBe(200);
        expect(all.json()).toMatchObject({
          kind: "all",
          entities: [
            { slug: "people/ian-borders", type: "person" },
            { slug: "companies/acme", type: "company" },
          ],
          pages: [
            { slug: "people/ian-borders" },
            { slug: "knowledge-docs/kdoc_0001" },
            { slug: "companies/acme", type: "company" },
          ],
          pagination: { returned: 3, complete: true, hasMore: false },
        });
        expect(calls.map((call) => call.name)).toEqual(["list_pages", "list_pages"]);
        expect(calls[0]?.arguments).toMatchObject({ limit: 3, offset: 4 });
        expect(calls[1]?.arguments).toMatchObject({ limit: 11, offset: 0 });

        await app.close();
      },
      {
        pageRows: [
          {
            slug: "people/ian-borders",
            title: "Ian Borders",
            type: "person",
            source_id: "default",
          },
          {
            slug: "knowledge-docs/kdoc_0001",
            title: "A document",
            type: "knowledge_document",
            source_id: "default",
          },
          {
            slug: "companies/acme",
            title: "Acme",
            type: "company",
            source_id: "default",
          },
        ],
      },
    );
  });

  it("projects canonical documents into a configured GBrain endpoint", async () => {
    await withFakeGBrain(async ({ baseUrl, calls }) => {
      const app = await buildKnowledgeApp({
        environment: "test",
        config: {
          gbrainBaseUrl: baseUrl,
          gbrainToken: "gbrain_test",
          gbrainPartitionTokens: [{ partitionKey: "company-brain", token: "gbrain_test" }],
        },
      });

      const collection = (
        await app.inject({
          method: "POST",
          url: "/api/companies/company-brain/knowledge/collections",
          payload: { name: "Brain Docs" },
        })
      ).json();
      const document = await app.inject({
        method: "POST",
        url: `/api/knowledge/collections/${collection.id}/documents`,
        payload: {
          title: "Ian Borders",
          summary: "Canonical entity note",
          body: "Ian is connected to the launch blocker project.",
        },
      });
      expect(document.statusCode).toBe(201);
      expect(calls).toContainEqual(
        expect.objectContaining({
          authorization: "Bearer gbrain_test",
          name: "put_page",
          arguments: expect.objectContaining({
            slug: expect.stringMatching(/^knowledge-docs\/kdoc_/),
          }),
        }),
      );

      const context = await app.inject({
        method: "POST",
        url: "/api/brain/context",
        payload: {
          scopeRef: "workspace:test",
          purpose: "entity",
          query: "Who is Ian Borders to me?",
        },
      });
      expect(context.statusCode).toBe(200);
      expect(context.json()).toMatchObject({
        status: "ready",
        answer: { tool: "query" },
      });

      const events = await app.inject({ method: "GET", url: "/api/events" });
      expect(events.json().events).toEqual([
        expect.objectContaining({
          type: "brain.projection.document",
          ok: true,
        }),
      ]);

      await app.close();
    });
  });

  it("composes real GBrain entity profile data for /api/brain/entities", async () => {
    await withFakeGBrain(async ({ baseUrl, calls }) => {
      const app = await buildKnowledgeApp({
        environment: "test",
        config: {
          gbrainBaseUrl: baseUrl,
          gbrainToken: "gbrain_test",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/brain/entities?slug=people/ian-borders&depth=2&direction=both",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        source: "gbrain-adapter",
        status: "ready",
        slug: "people/ian-borders",
        profile: { tool: "get_page" },
        entityCard: { entity: { slug: "people/ian-borders" }, aka: ["ian"] },
        timeline: [{ summary: "Synthetic timeline marker" }],
        links: { tool: "get_links" },
        graph: { tool: "traverse_graph" },
        recall: { facts: [] },
        factsVisibility: "world_only",
        capabilities: {
          entityCard: { status: "ready" },
          timeline: { status: "ready" },
          typedRelationships: { status: "ready" },
          pageEnumeration: { status: "unknown" },
        },
      });
      expect(calls.map((call) => call.name).sort()).toEqual([
        "entity",
        "get_links",
        "get_page",
        "get_timeline",
        "recall",
        "traverse_graph",
      ].sort());
      expect(calls).toContainEqual(
        expect.objectContaining({
          name: "traverse_graph",
          arguments: expect.objectContaining({
            slug: "people/ian-borders",
            depth: 2,
            direction: "both",
          }),
        }),
      );
      expect(calls).toContainEqual(
        expect.objectContaining({
          name: "recall",
          arguments: expect.objectContaining({
            entity: "people/ian-borders",
            include_pending: true,
          }),
        }),
      );

      await app.close();
    }, {
      entityCard: {
        found: true,
        card: {
          entity: { slug: "people/ian-borders", title: "Ian Borders", type: "person" },
          aka: ["ian"],
          summary: "Synthetic entity card",
          last_touched: { updated_at: "2026-09-06T00:00:00.000Z", last_retrieved_at: null, last_timeline_date: null },
          open_threads: [],
          edges: [{ type: "works_at", direction: "out", slug: "companies/acme", context: null }],
          backlink_count: 1,
          active_fact_count: 2,
        },
      },
      timeline: [{ summary: "Synthetic timeline marker" }],
    });
  });

  it("reports native detail capability gaps without claiming readiness", async () => {
    await withFakeGBrain(
      async ({ baseUrl }) => {
        const app = await buildKnowledgeApp({
          environment: "test",
          config: { gbrainBaseUrl: baseUrl, gbrainToken: "gbrain_test" },
        });
        const response = await app.inject({
          method: "GET",
          url: "/api/brain/entities?slug=people/ian-borders",
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          ok: false,
          status: "degraded",
          capabilities: {
            entityCard: { status: "unavailable" },
            timeline: { status: "ready" },
            typedRelationships: { status: "ready" },
            pageEnumeration: { status: "unknown" },
          },
          capabilityGaps: [
            expect.objectContaining({ code: "native_operation_unavailable", operation: "entity" }),
          ],
        });
        await app.close();
      },
      { failingTools: ["entity"] },
    );
  });

  it("exposes a GBrain extract-facts endpoint for Hermes turn-end hooks", async () => {
    await withFakeGBrain(async ({ baseUrl, calls }) => {
      const app = await buildKnowledgeApp({
        environment: "test",
        config: {
          gbrainBaseUrl: baseUrl,
          gbrainToken: "gbrain_test",
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/brain/extract-facts",
        payload: {
          text: "User: remember that GBrain owns Product memory.",
          sessionId: "stored-hermes-session",
          entityHints: ["GBrain", "Product memory"],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        source: "gbrain-adapter",
        status: "ready",
        result: { tool: "extract_facts" },
      });
      expect(calls).toContainEqual(
        expect.objectContaining({
          name: "extract_facts",
          arguments: expect.objectContaining({
            turn_text: "User: remember that GBrain owns Product memory.",
            session_id: "stored-hermes-session",
            entity_hints: ["GBrain", "Product memory"],
            visibility: "private",
          }),
        }),
      );

      await app.close();
    });
  });

  it("rejects unauthenticated cross-origin writes to the GBrain extract-facts endpoint", async () => {
    await withFakeGBrain(async ({ baseUrl, calls }) => {
      const app = await buildKnowledgeApp({
        environment: "test",
        config: {
          gbrainBaseUrl: baseUrl,
          gbrainToken: "gbrain_test",
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/brain/extract-facts",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        payload: {
          text: "User: poison private memory.",
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        ok: false,
        error: "brain_write_forbidden",
      });
      expect(calls).toEqual([]);

      await app.close();
    });
  });

  it("accepts only the dedicated extraction bearer for cross-origin broker writes", async () => {
    await withFakeGBrain(async ({ baseUrl, calls }) => {
      const extractionToken = "knowledge-extraction-token-for-disposable-tests-32";
      const app = await buildKnowledgeApp({
        environment: "test",
        config: {
          gbrainBaseUrl: baseUrl,
          gbrainToken: "gbrain_test",
          brainExtractionToken: extractionToken,
        },
      });

      const request = {
        method: "POST" as const,
        url: "/api/brain/extract-facts",
        headers: {
          origin: "https://broker.example",
          host: "knowledge.example",
          "content-type": "application/json",
        },
        payload: { text: "Synthetic extraction input." },
      };
      const rejected = await app.inject({
        ...request,
        headers: { ...request.headers, authorization: "Bearer wrong-extraction-token" },
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toEqual({ ok: false, error: "brain_write_forbidden" });
      expect(calls).toEqual([]);

      const accepted = await app.inject({
        ...request,
        headers: { ...request.headers, authorization: `Bearer ${extractionToken}` },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({
        ok: true,
        mode: "extract_facts",
        result: { tool: "extract_facts" },
      });
      expect(calls).toContainEqual(expect.objectContaining({ name: "extract_facts" }));
      expect(JSON.stringify(accepted.json())).not.toContain(extractionToken);

      await app.close();
    });
  });

  it("rejects short or reused GBrain master extraction credentials at startup", async () => {
    await expect(buildKnowledgeApp({
      environment: "test",
      config: { brainExtractionToken: "too-short" },
    })).rejects.toThrow("Invalid Knowledge brain extraction token configuration");
    await expect(buildKnowledgeApp({
      environment: "test",
      config: { brainExtractionToken: "x".repeat(1025) },
    })).rejects.toThrow("Invalid Knowledge brain extraction token configuration");
    await expect(buildKnowledgeApp({
      environment: "test",
      config: { brainExtractionToken: `valid-token-${"x".repeat(24)}é` },
    })).rejects.toThrow("Invalid Knowledge brain extraction token configuration");
    await expect(buildKnowledgeApp({
      environment: "test",
      config: {
        gbrainToken: "shared-gbrain-master-token",
        brainExtractionToken: "shared-gbrain-master-token",
      },
    })).rejects.toThrow("Invalid Knowledge brain extraction token configuration");
  });

  it("preserves App-created versus Agent-created document provenance", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });
    const collectionResponse = await app.inject({
      method: "POST",
      url: "/api/companies/company-1/knowledge/collections",
      payload: { name: "Provenance docs" },
    });
    const collection = collectionResponse.json() as { id: string };
    const createResponse = await app.inject({
      method: "POST",
      url: `/api/knowledge/collections/${collection.id}/documents`,
      payload: {
        title: "Operator decision",
        body: "Created in the HDDA App.",
        actor: { kind: "app", id: "operator-1" },
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const document = createResponse.json() as { id: string };
    expect(createResponse.json()).toMatchObject({
      createdByAgentId: null,
      createdByUserId: "app:operator-1",
    });

    const agentCreateResponse = await app.inject({
      method: "POST",
      url: `/api/knowledge/collections/${collection.id}/documents`,
      payload: {
        title: "Agent observation",
        body: "Created by the agent.",
        actor: { kind: "agent", id: "hermes-session-1" },
      },
    });
    expect(agentCreateResponse.statusCode).toBe(201);
    const agentDocument = agentCreateResponse.json() as { id: string };
    expect(agentCreateResponse.json()).toMatchObject({
      createdByAgentId: "hermes-session-1",
      createdByUserId: null,
    });
    const agentRevisions = await app.inject({
      method: "GET",
      url: `/api/knowledge/documents/${agentDocument.id}/revisions`,
    });
    expect(agentRevisions.json()).toMatchObject([
      { version: 1, createdByAgentId: "hermes-session-1", createdByUserId: null },
    ]);

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/knowledge/documents/${document.id}`,
      payload: {
        body: "Expanded by the Agent.",
        actor: { kind: "agent", id: "hermes-session-1" },
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      createdByAgentId: null,
      createdByUserId: "app:operator-1",
    });
    const revisions = await app.inject({
      method: "GET",
      url: `/api/knowledge/documents/${document.id}/revisions`,
    });
    expect(revisions.json()).toMatchObject([
      { version: 2, createdByAgentId: "hermes-session-1", createdByUserId: null },
      { version: 1, createdByAgentId: null, createdByUserId: "app:operator-1" },
    ]);
    await app.close();
  });

  it("preserves donor-shaped Documents collection and uses Forgejo as the canonical document store", async () => {
    await withFakeForgejo(async ({ baseUrl, calls, setRemoteBody }) => {
      const app = await buildKnowledgeApp({ environment: "test" });

      const collectionResponse = await app.inject({
        method: "POST",
        url: "/api/companies/company-1/knowledge/collections",
        payload: {
          name: "Project Docs",
          description: "Canonical work docs",
          sourceConfig: {
            provider: "forgejo_repo",
            apiBaseUrl: baseUrl,
            owner: "team",
            repo: "docs",
            branch: "main",
            rootPath: "docs",
            tokenEnvVar: "KNOWLEDGE_TEST_TOKEN",
          },
        },
      });

      expect(collectionResponse.statusCode).toBe(201);
      const collection = collectionResponse.json();
      expect(collection).toMatchObject({
        companyId: "company-1",
        name: "Project Docs",
        documentCount: 0,
      });

      const documentResponse = await app.inject({
        method: "POST",
        url: `/api/knowledge/collections/${collection.id}/documents`,
        payload: {
          title: "Design System",
          summary: "Visual and interaction rules",
          body: "# Design System",
          sourcePath: "docs/design-system.md",
        },
      });

      expect(documentResponse.statusCode).toBe(201);
      const document = documentResponse.json();
      expect(document).toMatchObject({
        companyId: "company-1",
        collectionId: collection.id,
        title: "Design System",
        slug: "design-system",
        body: "# Design System",
        source: {
          provider: "forgejo_repo",
          path: "design-system.md",
          sha: "sha-create",
          htmlUrl: `${baseUrl}/team/docs/src/branch/main/docs/design-system.md`,
        },
      });
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: "docs/design-system.md",
          authorization: "token forgejo_token",
          body: expect.objectContaining({
            branch: "main",
            message: "Create Design System",
          }),
        }),
      );

      const updateResponse = await app.inject({
        method: "PATCH",
        url: `/api/knowledge/documents/${document.id}`,
        payload: {
          body: "# Design System\n\nButtons use icons where possible.",
          status: "published",
        },
      });

      expect(updateResponse.statusCode).toBe(200);
      expect(updateResponse.json()).toMatchObject({
        id: document.id,
        status: "published",
        source: { sha: "sha-update" },
      });
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "PUT",
          path: "docs/design-system.md",
          body: expect.objectContaining({
            branch: "main",
            sha: "sha-create",
            message: "Update Design System",
          }),
        }),
      );

      setRemoteBody(
        "docs/design-system.md",
        "# Remote Canonical Design System",
      );
      const remoteRead = await app.inject({
        method: "GET",
        url: `/api/knowledge/documents/${document.id}`,
      });
      expect(remoteRead.statusCode).toBe(200);
      expect(remoteRead.json()).toMatchObject({
        id: document.id,
        body: "# Remote Canonical Design System",
        source: { sha: "sha-remote" },
      });

      const revisionsResponse = await app.inject({
        method: "GET",
        url: `/api/knowledge/documents/${document.id}/revisions`,
      });
      expect(revisionsResponse.statusCode).toBe(200);
      expect(
        revisionsResponse
          .json()
          .map((revision: { version: number }) => revision.version),
      ).toEqual([2, 1]);

      const searchResponse = await app.inject({
        method: "GET",
        url: "/api/companies/company-1/knowledge/search?q=buttons",
      });
      expect(searchResponse.statusCode).toBe(200);
      expect(searchResponse.json()).toEqual([
        expect.objectContaining({
          id: document.id,
          collectionName: "Project Docs",
        }),
      ]);

      const commentResponse = await app.inject({
        method: "POST",
        url: `/api/knowledge/documents/${document.id}/comments`,
        payload: { body: "Needs mobile examples." },
      });
      expect(commentResponse.statusCode).toBe(201);
      expect(commentResponse.json()).toMatchObject({
        documentId: document.id,
        body: "Needs mobile examples.",
        bodyFormat: "markdown",
      });

      const accessResponse = await app.inject({
        method: "PUT",
        url: `/api/knowledge/documents/${document.id}/access`,
        payload: {
          accessMode: "restricted",
          inheritFromParent: false,
          grants: [
            {
              principalType: "agent",
              principalId: "doppelganger",
              role: "reader",
            },
          ],
        },
      });
      expect(accessResponse.statusCode).toBe(200);
      expect(accessResponse.json()).toMatchObject({
        documentId: document.id,
        accessMode: "restricted",
        inheritFromParent: false,
        grants: [
          expect.objectContaining({
            principalType: "agent",
            principalId: "doppelganger",
            role: "reader",
          }),
        ],
      });

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/knowledge/documents/${document.id}`,
      });
      expect(deleteResponse.statusCode).toBe(200);
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "DELETE",
          path: "docs/design-system.md",
          body: expect.objectContaining({
            branch: "main",
            sha: "sha-update",
            message: "Delete Design System",
          }),
        }),
      );

      await app.close();
    });
  });

  it("runs an active ingest over a Forgejo-backed collection and projects documents", async () => {
    await withFakeGBrain(
      async ({ baseUrl: gbrainBaseUrl, calls: gbrainCalls }) => {
        await withFakeForgejo(async ({ baseUrl, setRemoteBody }) => {
          setRemoteBody(
            "docs/runbook.md",
            "# Runbook\n\nShip the Knowledge ingest lane.",
          );
          setRemoteBody(
            "docs/decisions/source-truth.txt",
            "Decision: source truth lives in Knowledge.",
          );
          setRemoteBody("docs/assets/logo.png", "not text");

          const app = await buildKnowledgeApp({
            environment: "test",
            config: {
              gbrainBaseUrl,
              gbrainToken: "gbrain_test",
              gbrainPartitionTokens: [{ partitionKey: "company-1", token: "gbrain_test" }],
            },
          });
          const collection = (
            await app.inject({
              method: "POST",
              url: "/api/companies/company-1/knowledge/collections",
              payload: {
                name: "Project Docs",
                sourceConfig: {
                  provider: "forgejo_repo",
                  apiBaseUrl: baseUrl,
                  owner: "team",
                  repo: "docs",
                  branch: "main",
                  rootPath: "docs",
                  tokenEnvVar: "KNOWLEDGE_TEST_TOKEN",
                },
              },
            })
          ).json();

          const firstRun = await app.inject({
            method: "POST",
            url: "/api/companies/company-1/knowledge/ingest-runs",
            payload: { collectionId: collection.id },
          });

          expect(firstRun.statusCode).toBe(201);
          expect(firstRun.json()).toMatchObject({
            ok: true,
            status: "completed",
            summary: {
              created: 2,
              failed: 0,
              skipped: 1,
              unchanged: 0,
              updated: 0,
            },
            documents: expect.arrayContaining([
              expect.objectContaining({
                action: "created",
                sourcePath: "runbook.md",
                title: "Runbook",
              }),
              expect.objectContaining({
                action: "created",
                sourcePath: "decisions/source-truth.txt",
                title: "Source Truth",
              }),
            ]),
          });
          expect(
            gbrainCalls.filter((call) => call.name === "put_page"),
          ).toHaveLength(2);

          setRemoteBody(
            "docs/runbook.md",
            "# Runbook\n\nShip the final Knowledge ingest lane.",
          );
          const secondRun = await app.inject({
            method: "POST",
            url: "/api/companies/company-1/knowledge/ingest-runs",
            payload: { collectionId: collection.id },
          });

          expect(secondRun.statusCode).toBe(201);
          expect(secondRun.json()).toMatchObject({
            ok: true,
            summary: {
              created: 0,
              failed: 0,
              skipped: 1,
              unchanged: 1,
              updated: 1,
            },
          });

          const searchResponse = await app.inject({
            method: "GET",
            url: "/api/companies/company-1/knowledge/search?q=final",
          });
          expect(searchResponse.json()).toEqual([
            expect.objectContaining({
              collectionName: "Project Docs",
              source: expect.objectContaining({ path: "runbook.md" }),
              title: "Runbook",
            }),
          ]);

          await app.close();
        });
      },
    );
  });

  it("imports uploaded files into real Knowledge documents", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });
    const upload = multipartBody({
      files: [
        {
          name: "files",
          filename: "truth.md",
          contentType: "text/markdown",
          body: "# Truth\n\nKnowledge ingest writes actual documents.",
        },
        {
          name: "files",
          filename: "data.json",
          contentType: "application/json",
          body: '{"system":"knowledge","active":true}',
        },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/companies/company-files/knowledge/ingest-files",
      headers: { "content-type": upload.contentType },
      payload: upload.body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "completed",
      summary: {
        created: 2,
        failed: 0,
        skipped: 0,
        unchanged: 0,
        updated: 0,
      },
      documents: expect.arrayContaining([
        expect.objectContaining({ action: "created", title: "Truth" }),
        expect.objectContaining({ action: "created", title: "Data" }),
      ]),
    });

    const searchResponse = await app.inject({
      method: "GET",
      url: "/api/companies/company-files/knowledge/search?q=actual",
    });
    expect(searchResponse.json()).toEqual([
      expect.objectContaining({
        title: "Truth",
      }),
    ]);

    await app.close();
  });

  it("preserves document links and Work-owned binding routes without owning Work state", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });

    const collection = (
      await app.inject({
        method: "POST",
        url: "/api/companies/company-2/knowledge/collections",
        payload: { name: "Implementation Docs" },
      })
    ).json();
    const sourceDocument = (
      await app.inject({
        method: "POST",
        url: `/api/knowledge/collections/${collection.id}/documents`,
        payload: {
          title: "Build Plan",
          body: "Use the Knowledge Program as source of truth.",
        },
      })
    ).json();
    const targetDocument = (
      await app.inject({
        method: "POST",
        url: `/api/knowledge/collections/${collection.id}/documents`,
        payload: {
          title: "Design System",
          body: "Buttons, surfaces, and typography.",
        },
      })
    ).json();

    const linkResponse = await app.inject({
      method: "POST",
      url: `/api/knowledge/documents/${sourceDocument.id}/links`,
      payload: { targetDocumentId: targetDocument.id, linkType: "references" },
    });
    expect(linkResponse.statusCode).toBe(201);
    const linksResponse = await app.inject({
      method: "GET",
      url: `/api/knowledge/documents/${sourceDocument.id}/links`,
    });
    expect(linksResponse.json()).toMatchObject({
      outbound: [
        {
          sourceDocumentId: sourceDocument.id,
          targetDocumentId: targetDocument.id,
          document: { title: "Design System" },
        },
      ],
      backlinks: [],
    });

    const projectBinding = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/knowledge/documents",
      payload: {
        documentId: sourceDocument.id,
        bindingType: "supporting_context",
      },
    });
    expect(projectBinding.statusCode).toBe(201);
    expect(projectBinding.json()).toMatchObject({
      ownerType: "project",
      ownerId: "project-1",
      bindingType: "supporting_context",
      document: { id: sourceDocument.id, title: "Build Plan" },
    });

    const projectDocs = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/knowledge/documents",
    });
    expect(projectDocs.json()).toHaveLength(1);

    await app.close();
  });

  it("persists Documents and Research state across Program restarts", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "knowledge-program-"),
    );
    const config = {
      dataDir,
      knowledgeDatabasePath: path.join(dataDir, "knowledge.sqlite"),
    };
    const first = await buildKnowledgeApp({ environment: "test", config });

    const collection = (
      await first.inject({
        method: "POST",
        url: "/api/companies/company-persist/knowledge/collections",
        payload: { name: "Persistent Docs" },
      })
    ).json();
    const document = (
      await first.inject({
        method: "POST",
        url: `/api/knowledge/collections/${collection.id}/documents`,
        payload: {
          title: "Restart Contract",
          body: "State must survive process teardown.",
        },
      })
    ).json();
    const notebook = (
      await first.inject({
        method: "POST",
        url: "/api/companies/company-persist/research/notebooks",
        payload: { title: "Persistent Research" },
      })
    ).json();
    await first.inject({
      method: "POST",
      url: "/api/research/sources",
      payload: {
        notebookId: notebook.id,
        title: "Restart note",
        content: "The SQLite-backed store reloads this source.",
      },
    });
    await first.close();

    const second = await buildKnowledgeApp({ environment: "test", config });
    const search = await second.inject({
      method: "GET",
      url: "/api/companies/company-persist/knowledge/search?q=teardown",
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual([
      expect.objectContaining({ id: document.id, title: "Restart Contract" }),
    ]);

    const workspace = await second.inject({
      method: "GET",
      url: `/api/research/notebook?notebookId=${notebook.id}`,
    });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json()).toMatchObject({
      notebook: { id: notebook.id, title: "Persistent Research" },
      sources: [expect.objectContaining({ title: "Restart note" })],
    });

    await second.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("preserves Research notebook/source/ask/output promotion into canonical Documents", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });

    const notebookResponse = await app.inject({
      method: "POST",
      url: "/api/companies/company-3/research/notebooks",
      payload: {
        title: "Social ingest research",
        focusPrompt: "Normalize relationship context",
      },
    });
    expect(notebookResponse.statusCode).toBe(201);
    const notebook = notebookResponse.json();

    const sourceResponse = await app.inject({
      method: "POST",
      url: "/api/research/sources",
      payload: {
        notebookId: notebook.id,
        title: "WhatsApp observation",
        sourceType: "message",
        summary: "Ian mentioned the launch blockers.",
        content:
          "Ian Borders asked about launch blockers on the mobile design system.",
        citation: "whatsapp:thread-1",
      },
    });
    expect(sourceResponse.statusCode).toBe(201);
    expect(sourceResponse.json()).toMatchObject({
      source: {
        notebookId: notebook.id,
        title: "WhatsApp observation",
        sourceType: "message",
      },
      ingest: { mode: "standalone_ingest" },
    });

    const askResponse = await app.inject({
      method: "POST",
      url: "/api/research/ask",
      payload: {
        notebookId: notebook.id,
        prompt: "What did Ian say about launch blockers?",
      },
    });
    expect(askResponse.statusCode).toBe(200);
    expect(askResponse.json()).toMatchObject({
      mode: "ask",
      notebookId: notebook.id,
      citations: [expect.objectContaining({ title: "WhatsApp observation" })],
      strategy: { retrievalMode: "ranked_fallback" },
    });

    const outputResponse = await app.inject({
      method: "POST",
      url: `/api/research/notebooks/${notebook.id}/outputs`,
      payload: {
        title: "Launch blocker memo",
        summary: "Mobile design system blockers.",
        body: "Ian flagged mobile design system launch blockers.",
      },
    });
    expect(outputResponse.statusCode).toBe(201);
    const output = outputResponse.json();

    const promoteResponse = await app.inject({
      method: "POST",
      url: `/api/research/outputs/${output.id}/promote`,
      payload: {
        mode: "new_document",
        title: "Canonical launch blocker memo",
      },
    });
    expect(promoteResponse.statusCode).toBe(200);
    const promoted = promoteResponse.json();
    expect(promoted).toMatchObject({
      id: output.id,
      status: "published",
      promotionState: "promoted",
    });
    expect(promoted.promotedDocumentId).toMatch(/^kdoc_/);

    const promotedDocument = await app.inject({
      method: "GET",
      url: `/api/knowledge/documents/${promoted.promotedDocumentId}`,
    });
    expect(promotedDocument.statusCode).toBe(200);
    expect(promotedDocument.json()).toMatchObject({
      title: "Canonical launch blocker memo",
      status: "published",
      body: "Ian flagged mobile design system launch blockers.",
    });

    await app.close();
  });
});
