import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { describeResearchStatus, describeSaveError, modeFromSaved, type ModelSettingsStatus } from "./ModelSettingsPanel";

const base = { configured: true, source: "knowledge-settings", brain: { status: "online" } };
const connection = (provider: string) => ({ provider, baseUrl: "https://models.example/v1", model: "m", keyConfigured: true });

describe("model settings panel helpers", () => {
  it("recognises the saved provider setup", () => {
    expect(modeFromSaved(undefined)).toBe("openai");
    expect(modeFromSaved({ ...base, chat: connection("openrouter"), embedding: connection("openrouter") } as ModelSettingsStatus)).toBe("openrouter");
    expect(modeFromSaved({ ...base, chat: connection("ollama"), embedding: connection("llama-server") } as ModelSettingsStatus)).toBe("self-hosted");
    expect(modeFromSaved({ ...base, chat: connection("openai"), embedding: connection("openai") } as ModelSettingsStatus)).toBe("openai");
  });

  it("explains each failed provider check without raw codes", () => {
    const error = new ApiError(422, "x", { ok: false, checks: [
      { component: "embedding", ok: false, error: "invalid_embedding_vector" },
      { component: "chat", ok: true },
      { component: "reranker", ok: false, error: "provider_http_404" },
    ] });
    const lines = describeSaveError(error);
    expect(lines).toEqual([
      "Embedding model: The embedding model returned vectors of a different size. Check the embedding dimensions.",
      "Reranker: The model provider does not recognise this URL or model name.",
    ]);
  });

  it("names the component that needs a key", () => {
    expect(describeSaveError(new ApiError(400, "x", { ok: false, error: "model_api_key_required", component: "embedding" }))[0])
      .toMatch(/^Embedding model: enter an API key/u);
  });

  it("explains the Research status in one short customer line", () => {
    expect(describeResearchStatus({ status: "configured" })).toEqual({ tone: "success", text: "Research uses the same models." });
    expect(describeResearchStatus({ status: "not-installed" })).toBeNull();
    expect(describeResearchStatus(undefined)).toBeNull();
    for (const status of ["pending", "embedding_migration_required", "encryption_not_configured", "provider_unsupported", "failed"]) {
      const line = describeResearchStatus({ status, error: "research_http_500:credential_create" });
      expect(line?.tone).toBe("warning");
      expect(line?.text).not.toMatch(/_/u);
      expect(line?.text).not.toMatch(/Open Notebook|GBrain|embedding_|credential/u);
    }
  });
});
