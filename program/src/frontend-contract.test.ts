import { describe, expect, it } from "vitest";

import { buildKnowledgeApp } from "./app.js";
import { buildKnowledgeOpenApi } from "./frontend-contract.js";

describe("Knowledge portable frontend contract", () => {
  it("publishes standalone, embed, redacted status, bootstrap, and OpenAPI surfaces", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });
    for (const route of [
      "/",
      "/embed",
      "/status",
      "/bootstrap.json",
      "/openapi.json",
      "/swagger.json",
    ]) {
      const response = await app.inject({ method: "GET", url: route });
      expect(response.statusCode, route).toBe(200);
    }
    const bootstrap = (
      await app.inject({ method: "GET", url: "/bootstrap.json" })
    ).json();
    expect(bootstrap).toMatchObject({
      program: { id: "knowledge", environment: "test" },
      authorization: {
        generalDomainBearerRequired: false,
        brainExtractFacts: "same-origin-or-gbrain-or-dedicated-extraction-bearer",
        credentialExposedToBrowser: false,
      },
      surfaces: { standalone: "/", embed: "/embed", openapi: "/openapi.json" },
    });
    expect(JSON.stringify(bootstrap)).not.toContain("gbrainHome");
    expect(JSON.stringify(bootstrap)).not.toContain("knowledgeDatabasePath");
    expect(JSON.stringify(bootstrap)).not.toContain("gbrainToken");
    await app.close();
  });

  it("documents real domain contracts and excludes retired presentation routes", () => {
    const spec = buildKnowledgeOpenApi() as any;
    const chat = "/api/research/notebooks/{notebookId}/engine/chat";
    for (const [route, method] of [["/sessions", "post"], ["/sessions/{sessionId}", "get"], ["/sessions/{sessionId}/messages", "post"], ["/receipts/{idempotencyKey}", "get"]]) {
      expect(spec.paths[chat + route][method].security).toEqual([{ bearerAuth: [] }, method === "post" ? { researchBrowserCookie: [], researchBrowserCsrf: [] } : { researchBrowserCookie: [] }]);
    }
    const turn = spec.paths[chat + "/sessions/{sessionId}/messages"].post;
    expect(turn.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
    expect(turn.description).toContain("upstream-controlled");
    expect(turn.responses["503"]).toBeTruthy();
    expect(spec.components.securitySchemes.researchBrowserCookie.name).toBe("knowledge_research_session");
    expect(spec.paths["/api/research/browser-session"].post.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
    expect(spec.paths["/api/research/engine/notebooks"].get.security).toEqual([{ bearerAuth: [] }, { researchBrowserCookie: [] }]);
    expect(spec.paths["/api/research/engine/notebooks"].get.description).toContain("does not probe Open Notebook");
    expect(
      spec.paths["/api/companies/{companyId}/knowledge/search"].get.summary,
    ).toContain("Search");
    expect(
      spec.paths["/api/research/outputs/{outputId}/promote"].post,
    ).toBeTruthy();
    expect(spec.paths["/api/brain/extract-facts"].post.description).toContain(
      "same-origin",
    );
    expect(spec.paths["/api/brain/extract-facts"].post.description).toContain(
      "dedicated server extraction bearer",
    );
    expect(Object.keys(spec.paths).some(path => path.includes("boardstate"))).toBe(false);
    expect(
      spec["x-doppelganger"].authorization.credentialExposedToBrowser,
    ).toBe(false);
  });

  it("keeps extract-facts fail closed for a cross-origin browser without a bearer", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/brain/extract-facts",
      headers: {
        origin: "https://hostile.example",
        host: "knowledge.example",
        "content-type": "application/json",
      },
      payload: { text: "This must not reach GBrain." },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({
      ok: false,
      error: "brain_write_forbidden",
    });
    await app.close();
  });
});
