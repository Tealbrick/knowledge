import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildKnowledgeApp } from "./app.js";

describe("Zod 4-compatible Knowledge payload schemas", () => {
  const bindingSchema = z.object({
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  const sourceSchema = z
    .object({
      apiConfig: z.record(z.string(), z.unknown()).optional().nullable(),
      apiSnapshot: z.record(z.string(), z.unknown()).optional().nullable(),
    })
    .passthrough();

  it("keeps optional records, strips unknown binding keys, and preserves passthrough source keys", () => {
    expect(bindingSchema.parse({})).toEqual({});
    expect(
      bindingSchema.parse({
        metadata: { enabled: true, nested: { source: "test" } },
        unknownBindingKey: "stripped",
      }),
    ).toEqual({
      metadata: { enabled: true, nested: { source: "test" } },
    });
    expect(
      sourceSchema.parse({
        apiConfig: null,
        apiSnapshot: { provider: "fixture" },
        futureSourceKey: "preserved",
      }),
    ).toEqual({
      apiConfig: null,
      apiSnapshot: { provider: "fixture" },
      futureSourceKey: "preserved",
    });
  });

  it("retains null and invalid-record boundaries", () => {
    expect(sourceSchema.parse({ apiConfig: undefined, apiSnapshot: undefined })).toEqual({
      apiConfig: undefined,
      apiSnapshot: undefined,
    });
    expect(() => bindingSchema.parse({ metadata: null })).toThrow();
    expect(() => sourceSchema.parse({ apiConfig: [] })).toThrow();
  });

  it("exercises the actual binding and research HTTP schemas with disposable state", async () => {
    const app = await buildKnowledgeApp({ environment: "test" });
    try {
      const metadata = {
        enabled: true,
        count: 3,
        nested: { owner: "fixture" },
        values: ["one", 2, null],
      };
      const binding = await app.inject({
        method: "POST",
        url: "/api/bindings",
        payload: {
          ownerPlugin: "zod-compat",
          ownerType: "fixture",
          ownerId: "fixture-1",
          artifactType: "document",
          artifactId: "doc-1",
          relationshipType: "context",
          metadata,
          unknownBindingKey: "must-be-stripped",
        },
      });
      expect(binding.statusCode).toBe(201);
      expect(binding.json()).toMatchObject({ metadata });
      expect(binding.json()).not.toHaveProperty("unknownBindingKey");

      const nullMetadata = await app.inject({
        method: "POST",
        url: "/api/bindings",
        payload: {
          ownerPlugin: "zod-compat",
          ownerType: "fixture",
          ownerId: "fixture-null",
          artifactType: "document",
          artifactId: "doc-null",
          relationshipType: "context",
          metadata: null,
        },
      });
      expect(nullMetadata.statusCode).toBe(400);

      const arrayMetadata = await app.inject({
        method: "POST",
        url: "/api/bindings",
        payload: {
          ownerPlugin: "zod-compat",
          ownerType: "fixture",
          ownerId: "fixture-array",
          artifactType: "document",
          artifactId: "doc-array",
          relationshipType: "context",
          metadata: ["not", "a", "record"],
        },
      });
      expect(arrayMetadata.statusCode).toBe(400);

      const notebook = await app.inject({
        method: "POST",
        url: "/api/companies/zod-compat/research/notebooks",
        payload: { title: "Zod compatibility fixture" },
      });
      expect(notebook.statusCode).toBe(201);
      const notebookId = notebook.json().id as string;
      const apiConfig = {
        provider: "fixture",
        enabled: true,
        options: { retries: 2, headers: null },
      };
      const source = await app.inject({
        method: "POST",
        url: "/api/research/sources",
        payload: {
          notebookId,
          title: "Zod source fixture",
          content: "Record fields must survive the HTTP boundary.",
          apiConfig,
          apiSnapshot: null,
          unknownSourceKey: "not persisted by the route model",
        },
      });
      expect(source.statusCode).toBe(201);
      expect(source.json().source).toMatchObject({
        apiConfig,
        apiSnapshot: null,
      });
      expect(source.json().source).not.toHaveProperty("unknownSourceKey");

      const omittedRecords = await app.inject({
        method: "POST",
        url: "/api/research/sources",
        payload: { notebookId, title: "Optional records omitted" },
      });
      expect(omittedRecords.statusCode).toBe(201);
      expect(omittedRecords.json().source).toMatchObject({
        apiConfig: null,
        apiSnapshot: null,
      });

      const arraySource = await app.inject({
        method: "POST",
        url: "/api/research/sources",
        payload: {
          notebookId,
          title: "Invalid record fixture",
          apiConfig: [],
        },
      });
      expect(arraySource.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
