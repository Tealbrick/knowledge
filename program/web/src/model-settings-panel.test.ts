import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { PROVIDER_DEFAULTS } from "../../src/model-providers";
import { PRESETS, describeModelSource, describeResearchStatus, describeSaveError, embeddingChoiceFromSaved, modeFromSaved, type ModelSettingsStatus } from "./ModelSettingsPanel";

const base = { configured: true, source: "knowledge-settings", brain: { status: "online" } };
const connection = (provider: string) => ({ provider, baseUrl: "https://models.example/v1", model: "m", keyConfigured: true });

describe("model settings panel helpers", () => {
  it("offers the same OpenAI chat defaults as the server: gpt-6-luna with low reasoning effort", () => {
    expect(PRESETS.openai).toMatchObject({ chatModel: PROVIDER_DEFAULTS.openai.chatModel, reasoningEffort: PROVIDER_DEFAULTS.openai.chatReasoningEffort });
    expect(PRESETS.openai.chatModel).toBe("gpt-6-luna");
    expect(PRESETS.openai.reasoningEffort).toBe("low");
    // Providers without a default effort do not preselect one.
    for (const mode of ["openrouter", "google", "anthropic", "self-hosted"] as const) expect(PRESETS[mode].reasoningEffort).toBeUndefined();
  });

  it("recognises the saved provider setup", () => {
    expect(modeFromSaved(undefined)).toBe("openai");
    expect(modeFromSaved({ ...base, chat: connection("openrouter"), embedding: connection("openrouter") } as ModelSettingsStatus)).toBe("openrouter");
    expect(modeFromSaved({ ...base, chat: connection("ollama"), embedding: connection("llama-server") } as ModelSettingsStatus)).toBe("self-hosted");
    expect(modeFromSaved({ ...base, chat: connection("openai"), embedding: connection("openai") } as ModelSettingsStatus)).toBe("openai");
  });

  it("recognises Google and Anthropic setups and the embedding provider next to Anthropic", () => {
    expect(modeFromSaved({ ...base, chat: connection("google"), embedding: connection("google") } as ModelSettingsStatus)).toBe("google");
    const anthropic = { ...base, chat: connection("anthropic"), embedding: connection("openai") } as ModelSettingsStatus;
    expect(modeFromSaved(anthropic)).toBe("anthropic");
    expect(embeddingChoiceFromSaved(anthropic)).toBe("openai");
    expect(embeddingChoiceFromSaved({ ...anthropic, embedding: connection("google") } as ModelSettingsStatus)).toBe("google");
    expect(embeddingChoiceFromSaved({ ...anthropic, embedding: connection("openrouter") } as ModelSettingsStatus)).toBe("openrouter");
    expect(embeddingChoiceFromSaved({ ...anthropic, embedding: connection("llama-server") } as ModelSettingsStatus)).toBe("self-hosted");
    expect(embeddingChoiceFromSaved(undefined)).toBe("openai");
  });

  it("says where the models come from when an account connection provides them", () => {
    expect(describeModelSource({ ...base, source: "provider-env" } as ModelSettingsStatus)?.text).toMatch(/^These models come from the API keys connected to your account/u);
    expect(describeModelSource({ ...base, source: "knowledge-settings" } as ModelSettingsStatus)).toBeNull();
    expect(describeModelSource({ configured: false, source: "not-configured", issue: "embedding_provider_required", brain: { status: "disabled" } })?.text).toMatch(/Anthropic has no embedding models/u);
    expect(describeModelSource({ configured: false, source: "not-configured", brain: { status: "disabled" } })).toBeNull();
    expect(describeModelSource(undefined)).toBeNull();
  });

  it("tells the owner to pick an embedding provider for Anthropic", () => {
    const [line] = describeSaveError(new ApiError(400, "x", { ok: false, error: "embedding_provider_required", component: "embedding" }));
    expect(line).toMatch(/^Embedding model: Anthropic does not offer embeddings\. Choose a separate embedding provider/u);
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
    expect(describeResearchStatus({ status: "model_conflict", hint: "Research already has a gpt-4.1-mini model on another key; remove it there or pick a different model." }))
      .toEqual({ tone: "warning", text: "Research already has a gpt-4.1-mini model on another key; remove it there or pick a different model." });
    for (const status of ["model_conflict", "pending", "embedding_migration_required", "encryption_not_configured", "provider_unsupported", "failed"]) {
      const line = describeResearchStatus({ status, error: "research_http_500:credential_create" });
      expect(line?.tone).toBe("warning");
      expect(line?.text).not.toMatch(/_/u);
      expect(line?.text).not.toMatch(/Open Notebook|GBrain|embedding_|credential/u);
    }
  });
});
