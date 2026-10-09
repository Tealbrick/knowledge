import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildKnowledgeApp } from "./app.js";
import type { KnowledgeConfig } from "./types.js";

const apps: Array<Awaited<ReturnType<typeof buildKnowledgeApp>>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-auth-boundaries-"));
  dirs.push(dir);
  return dir;
}

async function appFor(dir: string, extra: Partial<KnowledgeConfig> = {}) {
  const app = await buildKnowledgeApp({ environment: "test", config: {
    gbrainAutoStart: false,
    dataDir: dir,
    knowledgeDatabasePath: path.join(dir, "knowledge.sqlite"),
    ...extra,
  } });
  apps.push(app);
  return app;
}

describe("Program authorization finding regressions", () => {
  it("serves imported active content only as an inert download while preserving the bytes", async () => {
    const app = await appFor(await directory());
    const notebook = await app.inject({ method: "POST", url: "/api/companies/alpha/research/notebooks", payload: { title: "Alpha" } });
    expect(notebook.statusCode).toBe(201);
    const boundary = "fixture-boundary";
    const html = "<!doctype html><script>window.__fixture = true</script>";
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.html"\r\nContent-Type: text/html\r\n\r\n${html}\r\n--${boundary}--\r\n`);
    const imported = await app.inject({ method: "POST", url: `/api/research/notebooks/${notebook.json().id}/imports`, payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect(imported.statusCode).toBe(201);
    const content = await app.inject({ url: imported.json().source.url });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("application/octet-stream");
    expect(content.headers["content-disposition"]).toBe('attachment; filename="note.html"');
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    expect(content.body).toBe(html);

    const collection = await app.inject({ method: "POST", url: "/api/companies/alpha/knowledge/collections", payload: { name: "Alpha" } });
    const document = await app.inject({ method: "POST", url: `/api/knowledge/collections/${collection.json().id}/documents`, payload: { title: "Attachment host", body: "fixture" } });
    expect(collection.statusCode).toBe(201); expect(document.statusCode).toBe(201);
    const attachmentPayload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="unsafe.html"\r\nContent-Type: text/html\r\n\r\n${html}\r\n--${boundary}--\r\n`);
    const attachment = await app.inject({ method: "POST", url: `/api/companies/alpha/knowledge/documents/${document.json().id}/attachments`, payload: attachmentPayload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect(attachment.statusCode).toBe(201);
    const attachmentContent = await app.inject({ url: attachment.json().contentPath });
    expect(attachmentContent.headers["content-type"]).toBe("application/octet-stream");
    expect(attachmentContent.headers["content-disposition"]).toBe('attachment; filename="unsafe.html"');
    expect(attachmentContent.headers["x-content-type-options"]).toBe("nosniff");
    expect(attachmentContent.body).toBe(html);
  });

  it("uses every Research selector for partition authorization and preserves same-partition graph reads", async () => {
    const dir = await directory();
    const seed = await appFor(dir);
    const alpha = await seed.inject({ method: "POST", url: "/api/companies/alpha/research/notebooks", payload: { title: "Alpha private notebook" } });
    const beta = await seed.inject({ method: "POST", url: "/api/companies/beta/research/notebooks", payload: { title: "Beta private notebook" } });
    expect(alpha.statusCode).toBe(201);
    expect(beta.statusCode).toBe(201);
    await seed.close(); apps.splice(apps.indexOf(seed), 1);

    const restricted = await appFor(dir, { partitionAuthorizationRequired: true, knowledgeServicePrincipals: [
      { token: "alpha-reader", principalId: "alpha-reader", companyId: "alpha", capabilities: ["research:read"],
        partitionGrants: [{ partitionKey: "alpha", breadth: "exact", maxDepth: 0, capabilities: ["research:read"] }] },
    ] });
    const headers = { authorization: "Bearer alpha-reader" };
    const denied = await restricted.inject({ method: "POST", url: "/api/research/graph/query", headers,
      payload: { query: "*", companyId: "alpha", scope: { notebookId: beta.json().id } } });
    // A notebook outside the principal's partitions answers like a missing one (uniform not-found).
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ error: "not_found" });
    const allowed = await restricted.inject({ method: "POST", url: "/api/research/graph/query", headers,
      payload: { query: "Alpha", companyId: "alpha", scope: { notebookId: alpha.json().id } } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().nodes[0]).toMatchObject({ id: alpha.json().id, label: "Alpha private notebook" });
  });

  it("limits binding metadata to the server-authorized partition and rejects a conflicting filter", async () => {
    const dir = await directory();
    const seed = await appFor(dir);
    for (const partitionKey of ["alpha", "beta"]) {
      const result = await seed.inject({ method: "POST", url: "/api/bindings", payload: {
        ownerPlugin: "fixture", ownerType: "task", ownerId: `${partitionKey}-task`, artifactType: "document",
        artifactId: `${partitionKey}-document`, relationshipType: "context", partitionKey,
        summary: `${partitionKey} summary`, metadata: { tenantMarker: partitionKey },
      } });
      expect(result.statusCode).toBe(201);
    }
    await seed.close(); apps.splice(apps.indexOf(seed), 1);
    const restricted = await appFor(dir, { partitionAuthorizationRequired: true, knowledgeServicePrincipals: [
      { token: "alpha-reader", principalId: "alpha-reader", companyId: "alpha", capabilities: ["knowledge:read"],
        partitionGrants: [{ partitionKey: "alpha", breadth: "exact", maxDepth: 0, capabilities: ["knowledge:read"] }] },
    ] });
    const headers = { authorization: "Bearer alpha-reader" };
    const visible = await restricted.inject({ url: "/api/bindings?companyId=alpha", headers });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toHaveLength(1);
    expect(JSON.stringify(visible.json())).toContain("alpha summary");
    expect(JSON.stringify(visible.json())).not.toContain("beta");
    const mismatch = await restricted.inject({ url: "/api/bindings?companyId=alpha&partitionKey=beta", headers });
    expect([400, 403]).toContain(mismatch.statusCode);
  });

  it("requires independent read grants for Research mutations that copy or return existing content", async () => {
    const dir = await directory();
    const seed = await appFor(dir);
    const notebook = await seed.inject({ method: "POST", url: "/api/companies/alpha/research/notebooks", payload: { title: "Alpha" } });
    const source = await seed.inject({ method: "POST", url: "/api/research/sources", payload: { notebookId: notebook.json().id, title: "Private source", content: "PRIVATE_SOURCE_MARKER" } });
    expect(notebook.statusCode).toBe(201); expect(source.statusCode).toBe(201);
    await seed.close(); apps.splice(apps.indexOf(seed), 1);
    const restricted = await appFor(dir, { partitionAuthorizationRequired: true, knowledgeServicePrincipals: [
      { token: "writer", principalId: "writer", companyId: "alpha", capabilities: ["research:write"],
        partitionGrants: [{ partitionKey: "alpha", breadth: "exact", maxDepth: 0, capabilities: ["research:write"] }] },
      { token: "reader-writer", principalId: "reader-writer", companyId: "alpha", capabilities: ["research:read", "research:write"],
        partitionGrants: [{ partitionKey: "alpha", breadth: "exact", maxDepth: 0, capabilities: ["research:read", "research:write"] }] },
    ] });
    const deniedChat = await restricted.inject({ method: "POST", url: "/api/research/chat", headers: { authorization: "Bearer writer" },
      payload: { notebookId: notebook.json().id, message: "PRIVATE_SOURCE_MARKER" } });
    expect(deniedChat.statusCode).toBe(403);
    for (const url of ["/api/research/%63hat", "/api/%72esearch/chat", "/%61pi/research/chat"]) {
      const writerResult = await restricted.inject({ method: "POST", url, headers: { authorization: "Bearer writer" },
        payload: { notebookId: notebook.json().id, message: "PRIVATE_SOURCE_MARKER" } });
      expect(writerResult.statusCode).toBe(403);
      expect(writerResult.body).not.toContain("PRIVATE_SOURCE_MARKER");
      const anonymousResult = await restricted.inject({ method: "POST", url,
        payload: { notebookId: notebook.json().id, message: "PRIVATE_SOURCE_MARKER" } });
      expect(anonymousResult.statusCode).toBe(401);
      expect(anonymousResult.body).not.toContain("PRIVATE_SOURCE_MARKER");
    }
    const deniedCopy = await restricted.inject({ method: "POST", url: `/api/research/notebooks/${notebook.json().id}/entries`, headers: { authorization: "Bearer writer" },
      payload: { sourceId: source.json().source.id, entryKind: "source" } });
    expect(deniedCopy.statusCode).toBe(403);
    const legitimate = await restricted.inject({ method: "POST", url: "/api/research/chat", headers: { authorization: "Bearer reader-writer" },
      payload: { notebookId: notebook.json().id, message: "PRIVATE_SOURCE_MARKER" } });
    expect(legitimate.statusCode).toBe(200);
    expect(legitimate.body).toContain("PRIVATE_SOURCE_MARKER");
  });

  it("creates owner-bound documents in native storage without implicitly inheriting repository defaults", async () => {
    const dir = await directory();
    const repositoryDefault = { provider: "forgejo_repo" as const, apiBaseUrl: "https://forge.invalid/api", owner: "owner", repo: "docs", branch: "main", rootPath: "docs" };
    const seed = await appFor(dir, { defaultDocsSourceConfig: repositoryDefault });
    expect((await seed.inject({ url: "/api/companies/alpha/knowledge/collections" })).statusCode).toBe(200);
    await seed.close(); apps.splice(apps.indexOf(seed), 1);
    const app = await appFor(dir, { partitionAuthorizationRequired: true,
      defaultDocsSourceConfig: repositoryDefault,
      knowledgeServicePrincipals: [{ token: "owner-writer", principalId: "owner-writer", companyId: "alpha", capabilities: ["knowledge:create", "knowledge:read"],
        partitionGrants: [{ partitionKey: "alpha", breadth: "exact", maxDepth: 0, capabilities: ["knowledge:create", "knowledge:read"] }] }],
    });
    const created = await app.inject({ method: "POST", url: "/api/projects/project-a/knowledge/documents", headers: { authorization: "Bearer owner-writer" },
      payload: { companyId: "alpha", title: "Owner document" } });
    expect(created.statusCode).toBe(201);
    const collections = await app.inject({ url: "/api/companies/alpha/knowledge/collections", headers: { authorization: "Bearer owner-writer" } });
    expect(collections.statusCode).toBe(200);
    expect(collections.json()).toEqual(expect.arrayContaining([expect.objectContaining({ sourceConfig: { provider: "native" } }),
      expect.objectContaining({ sourceConfig: expect.objectContaining({ provider: "forgejo_repo" }) })]));
  });
});
