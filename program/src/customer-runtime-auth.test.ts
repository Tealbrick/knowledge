import { describe, expect, it } from "vitest";
import { buildKnowledgeApp } from "./app.js";

const actions = ["create", "read", "update", "delete"];
const headers = { authorization: "Bearer fixture-admin" };
const principal = (capabilities: string[], token = "fixture-agent") => ({ token, principalId: "aura", companyId: "fixture-a", capabilities });
const admin = { token: "fixture-admin", principalId: "operator", companyId: "fixture-a", capabilities: ["knowledge:write", "knowledge:read"],
  partitionGrants: ["fixture-a", "fixture-b"].map(partitionKey => ({ partitionKey, breadth: "exact" as const, maxDepth: 0 })) };

describe.each([false, true])("customer CRUD ceiling (general bearer required=%s)", required => {
  it.each(Array.from({ length: 16 }, (_, mask) => mask))("independently enforces subset %i, including mutation result confidentiality", async mask => {
    const capabilities = actions.filter((_, index) => mask & (1 << index)).map(action => `knowledge:${action}`);
    const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false, partitionAuthorizationRequired: required,
      knowledgeServicePrincipals: [admin, principal(capabilities)] } });
    try {
      const collection = (await app.inject({ method: "POST", url: "/api/companies/fixture-a/knowledge/collections", headers, payload: { name: "Fixture" } })).json();
      const seed = (await app.inject({ method: "POST", url: `/api/knowledge/collections/${collection.id}/documents`, headers,
        payload: { title: "Private existing", body: "existing-secret-body" } })).json();
      const agentHeaders = { authorization: "Bearer fixture-agent" };
      const create = await app.inject({ method: "POST", url: `/api/knowledge/collections/${collection.id}/documents`, headers: agentHeaders,
        payload: { title: "Created", actor: { kind: "agent", id: "forged-agent" } } });
      expect(create.statusCode).toBe(mask & 1 ? 201 : 403);
      if (mask & 1) expect(create.json().createdByAgentId).toBe("aura");
      const read = await app.inject({ method: "GET", url: `/api/knowledge/documents/${seed.id}`, headers: agentHeaders });
      expect(read.statusCode).toBe(mask & 2 ? 200 : 403);
      const update = await app.inject({ method: "PATCH", url: `/api/knowledge/documents/${seed.id}`, headers: agentHeaders,
        payload: { title: "Changed", actor: { kind: "agent", id: "forged-agent" } } });
      expect(update.statusCode).toBe(mask & 4 ? 200 : 403);
      if (!(mask & 2)) expect(update.body).not.toContain("existing-secret-body");
      if (mask & 4) {
        const revisions = (await app.inject({ method: "GET", url: `/api/knowledge/documents/${seed.id}/revisions`, headers })).json();
        expect(revisions[0].createdByAgentId).toBe("aura");
      }
      const deleted = await app.inject({ method: "DELETE", url: `/api/knowledge/documents/${seed.id}`, headers: agentHeaders });
      expect(deleted.statusCode).toBe(mask & 8 ? 200 : 403);
      if (!(mask & 2)) expect(deleted.body).not.toContain("existing-secret-body");
      const collectionDeleted = await app.inject({ method: "DELETE", url: `/api/knowledge/collections/${collection.id}`, headers: agentHeaders });
      expect(collectionDeleted.statusCode).toBe(mask & 8 ? 200 : 403);
      if (mask & 8) {
        if (mask & 2) expect(collectionDeleted.json().name).toBe("Fixture");
        else expect(collectionDeleted.json()).toEqual({ id: collection.id, deleted: true });
      }
    } finally { await app.close(); }
  });
});

it.each([false, true])("explicit object scope narrows a two-partition principal (general bearer required=%s)", async required => {
  const broad = { ...admin, token: "fixture-broad", principalId: "broad-agent", capabilities: actions.map(action => `knowledge:${action}`) };
  const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false,
    partitionAuthorizationRequired: required, knowledgeServicePrincipals: [admin, broad] } });
  const broadHeaders = { authorization: "Bearer fixture-broad" };
  try {
    for (const companyId of ["fixture-a", "fixture-b"]) {
      const other = companyId === "fixture-a" ? "fixture-b" : "fixture-a";
      const collection = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/knowledge/collections`, headers,
        payload: { name: companyId } })).json();
      const document = (await app.inject({ method: "POST", url: `/api/knowledge/collections/${collection.id}/documents`, headers,
        payload: { title: "Original", body: "private-body" } })).json();
      for (const method of ["GET", "PATCH", "DELETE"] as const) {
        const denied = await app.inject({ method, url: `/api/knowledge/documents/${document.id}?companyId=${other}`, headers: broadHeaders,
          ...(method === "PATCH" ? { payload: { title: "Should not change" } } : {}) });
        expect(denied.statusCode).toBe(400);
        expect(denied.json().error).toBe("partition_key_required");
        expect(denied.body).not.toContain("private-body");
      }
      expect((await app.inject({ method: "POST", url: `/api/knowledge/collections/${collection.id}/documents?companyId=${other}`,
        headers: broadHeaders, payload: { title: "Should not create" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "DELETE", url: `/api/knowledge/collections/${collection.id}?companyId=${other}`,
        headers: broadHeaders })).statusCode).toBe(400);
      const allowed = await app.inject({ method: "GET", url: `/api/knowledge/documents/${document.id}?companyId=${companyId}`, headers: broadHeaders });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().title).toBe("Original");
      expect((await app.inject({ method: "PATCH", url: `/api/knowledge/documents/${document.id}?companyId=${companyId}`, headers: broadHeaders,
        payload: { title: "Allowed" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "DELETE", url: `/api/knowledge/documents/${document.id}?companyId=${companyId}`, headers: broadHeaders })).statusCode).toBe(200);
    }
  } finally { await app.close(); }
});

it("denies foreign objects, conflicting/parent scopes, forged tokens and repository credential configuration", async () => {
  const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false,
    knowledgeServicePrincipals: [admin, principal(actions.map(action => `knowledge:${action}`))] } });
  try {
    const collections = [];
    for (const scope of ["fixture-a", "fixture-b"]) collections.push((await app.inject({ method: "POST",
      url: `/api/companies/${scope}/knowledge/collections`, headers, payload: { name: scope } })).json());
    const foreign = (await app.inject({ method: "POST", url: `/api/knowledge/collections/${collections[1].id}/documents`, headers, payload: { title: "Foreign" } })).json();
    const agentHeaders = { authorization: "Bearer fixture-agent" };
    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      const r = await app.inject({ method, url: `/api/knowledge/documents/${foreign.id}`, headers: agentHeaders,
        ...(method === "PATCH" ? { payload: { title: "Forged" } } : {}) });
      // Uniform not-found: a foreign ID answers exactly like a missing one.
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: "not_found" });
    }
    // A foreign parent ID is hidden like a missing one; a foreign scope selector conflicts with the collection (400).
    for (const [payload, status] of [[{ title: "Bad parent", parentDocumentId: foreign.id }, 404], [{ title: "Bad scope", companyId: "fixture-b" }, 400]] as const) {
      expect((await app.inject({ method: "POST", url: `/api/knowledge/collections/${collections[0].id}/documents`, headers: agentHeaders, payload })).statusCode).toBe(status);
    }
    expect((await app.inject({ method: "GET", url: "/api/companies/fixture-a/knowledge/collections", headers: { authorization: "Bearer forged" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/companies/fixture-a/knowledge/collections", headers: agentHeaders,
      payload: { name: "credential-confused", sourceConfig: { provider: "github_repo", owner: "x", repo: "y", tokenEnvVar: "KNOWLEDGE_SECRET" } } })).statusCode).toBe(403);
  } finally { await app.close(); }
});

it("legacy write explicitly admits mutations but cannot override a narrowed partition ceiling or imply read", async () => {
  const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false, knowledgeServicePrincipals: [admin,
    { ...principal(["knowledge:write"]), partitionGrants: [{ partitionKey: "fixture-a", breadth: "exact", maxDepth: 0, capabilities: ["knowledge:create"] }] }] } });
  try {
    const collection = (await app.inject({ method: "POST", url: "/api/companies/fixture-a/knowledge/collections", headers, payload: { name: "Fixture" } })).json();
    const agentHeaders = { authorization: "Bearer fixture-agent" };
    const document = await app.inject({ method: "POST", url: `/api/knowledge/collections/${collection.id}/documents`, headers: agentHeaders, payload: { title: "New" } });
    expect(document.statusCode).toBe(201);
    expect((await app.inject({ method: "PATCH", url: `/api/knowledge/documents/${document.json().id}`, headers: agentHeaders, payload: { title: "No" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/knowledge/documents/${document.json().id}`, headers: agentHeaders })).statusCode).toBe(403);
  } finally { await app.close(); }
});

it("a scoped collection read does not provision a default collection", async () => {
  const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false,
    knowledgeServicePrincipals: [principal(["knowledge:read"])] } });
  try {
    const response = await app.inject({ method: "GET", url: "/api/companies/fixture-a/knowledge/collections",
      headers: { authorization: "Bearer fixture-agent" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(app.getDecorator<(companyId: string) => boolean>("knowledgeHasPartition")("fixture-a")).toBe(false);
  } finally { await app.close(); }
});

describe.each(["project", "goal", "issue"])("internal %s routes retain independent no-read response boundaries", owner => {
  it.each(["no-read", "grant-no-read", "read", "operator"])("preserves mutation and returns only authorized fields for %s", async mode => {
    const canRead = mode === "read" || mode === "operator";
    const mutationCaps = ["knowledge:create", "knowledge:update"];
    const agent = { ...principal(mode === "no-read" ? mutationCaps : [...mutationCaps, "knowledge:read"]),
      partitionGrants: [{ partitionKey: "fixture-a", breadth: "exact" as const, maxDepth: 0,
        capabilities: mode === "grant-no-read" ? mutationCaps : [...mutationCaps, "knowledge:read"] }] };
    const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false,
      partitionAuthorizationRequired: false, knowledgeServicePrincipals: [admin, agent] } });
    const mutationHeaders = mode === "operator" ? {} : { authorization: "Bearer fixture-agent" };
    try {
      const collection = (await app.inject({ method: "POST", url: "/api/companies/fixture-a/knowledge/collections", headers,
        payload: { name: "private-collection-name", description: "private-collection-description" } })).json();
      const document = (await app.inject({ method: "POST", url: `/api/knowledge/collections/${collection.id}/documents`, headers,
        payload: { title: "Private", body: "private-existing-document-body" } })).json();
      await app.inject({ method: "PUT", url: `/api/knowledge/documents/${document.id}/access`, headers,
        payload: { grants: [{ principalType: "agent", principalId: "private-existing-grantee", role: "reader" }] } });
      const policy = await app.inject({ method: "PUT", url: `/api/knowledge/documents/${document.id}/access`, headers: mutationHeaders,
        payload: { accessMode: "restricted" } });
      expect(policy.statusCode).toBe(200);
      if (canRead) expect(policy.json().grants[0].principalId).toBe("private-existing-grantee");
      else expect(policy.json()).toEqual({ documentId: document.id, updated: true });
      const persisted = (await app.inject({ method: "GET", url: `/api/knowledge/documents/${document.id}/access`, headers })).json();
      expect(persisted.accessMode).toBe("restricted");
      expect(persisted.grants[0].principalId).toBe("private-existing-grantee");
      const ownerPath = `/api/${owner}s/fixture-owner/knowledge`;
      for (let repeat = 0; repeat < 2; repeat++) {
        const linkedDocument = await app.inject({ method: "POST", url: `${ownerPath}/documents`, headers: mutationHeaders,
          payload: { documentId: document.id } });
        expect(linkedDocument.statusCode).toBe(201);
        if (canRead) expect(linkedDocument.json().document.body).toBe("private-existing-document-body");
        else expect(linkedDocument.json()).toEqual({ id: expect.any(String), documentId: document.id, bound: true });
        const linkedCollection = await app.inject({ method: "POST", url: `${ownerPath}/collections`, headers: mutationHeaders,
          payload: { collectionId: collection.id } });
        expect(linkedCollection.statusCode).toBe(201);
        if (canRead) expect(linkedCollection.json().collection.description).toBe("private-collection-description");
        else expect(linkedCollection.json()).toEqual({ id: expect.any(String), collectionId: collection.id, bound: true });
      }
      const created = await app.inject({ method: "POST", url: `${ownerPath}/documents`, headers: mutationHeaders,
        payload: { collectionId: collection.id, title: "New owner document", body: "Own content" } });
      expect(created.statusCode).toBe(201);
      const newDocumentId = canRead ? created.json().document.id : created.json().documentId;
      if (!canRead) expect(created.json()).toEqual({ id: expect.any(String), documentId: expect.any(String), bound: true });
      expect((await app.inject({ method: "GET", url: `/api/knowledge/documents/${newDocumentId}`, headers })).json().body).toBe("Own content");
    } finally { await app.close(); }
  });
});
