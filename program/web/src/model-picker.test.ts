import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { EmbeddingChangeWarning, ModelPicker, availableModelsPath, describeListing, describeManifest, embeddingChange, pickerOptions, reasoningEffortOptions, reconcilePick, type AvailableModels, type ManifestStatus } from "./ModelPicker";
import { ModelSettingsPanel, describeManifestErrors, type ModelSettingsStatus } from "./ModelSettingsPanel";

const available = (overrides: Partial<AvailableModels> = {}): AvailableModels => ({
  ok: true,
  provider: "openai",
  role: "chat",
  listing: "provider",
  curated: true,
  models: ["gpt-5-mini", "gpt-6-luna", "gpt-6-terra"],
  recommended: "gpt-6-luna",
  recommendedDimensions: null,
  reasoningEffort: { supported: true, options: ["none", "minimal", "low", "medium", "high"], recommended: "low" },
  freeTextOnly: false,
  keySource: "knowledge-settings",
  manifest: { source: "bundled", version: 1 },
  ...overrides,
});
const manifest: ManifestStatus = { source: "bundled", version: 1, effectiveAt: "2026-10-09T00:00:00Z", portal: { status: "absent" }, appLocal: { status: "not-configured" }, bundledVersion: 1 };
const noop = () => undefined;
const selects = (html: string) => [...html.matchAll(/<select\b[\s\S]*?<\/select>/gu)].map(([select]) => select);
const textInputs = (html: string) => [...html.matchAll(/<input\b(?![^>]*type="(?:checkbox|password|number)")[^>]*>/gu)].map(([input]) => input);

describe("model picker helpers", () => {
  it("puts the recommendation first and labels it", () => {
    expect(pickerOptions(available())).toEqual([
      { value: "gpt-6-luna", label: "gpt-6-luna (Recommended)" },
      { value: "gpt-5-mini", label: "gpt-5-mini" },
      { value: "gpt-6-terra", label: "gpt-6-terra" },
    ]);
    expect(pickerOptions(available({ recommended: null })).map((option) => option.label)).toEqual(["gpt-5-mini", "gpt-6-luna", "gpt-6-terra"]);
    expect(pickerOptions(undefined)).toEqual([]);
  });

  it("preselects the recommendation, keeps listed and saved custom values, and goes free text without a list", () => {
    expect(reconcilePick(available(), "", false)).toEqual({ value: "gpt-6-luna", advanced: false, usedRecommendation: true });
    expect(reconcilePick(available(), "gpt-6-terra", false)).toEqual({ value: "gpt-6-terra", advanced: false, usedRecommendation: false });
    // A preset that is not listed (another provider's default) becomes the recommendation.
    expect(reconcilePick(available(), "openai/gpt-4.1-mini", false)).toMatchObject({ value: "gpt-6-luna", advanced: false });
    // The owner's saved custom model stays, in the advanced field.
    expect(reconcilePick(available(), "my-fine-tune", true)).toEqual({ value: "my-fine-tune", advanced: true, usedRecommendation: false });
    expect(reconcilePick(available({ models: [], recommended: null, freeTextOnly: true, listing: "none" }), "x", false)).toMatchObject({ value: "x", advanced: true });
    expect(reconcilePick(available({ recommended: null }), "", false)).toMatchObject({ value: "gpt-5-mini", advanced: false });
    // An uncurated list (for example Ollama) keeps a preset value in the advanced field and never picks a model by itself.
    const uncurated = available({ provider: "ollama", curated: false, recommended: null, models: ["llama3.3:70b", "qwen3:8b"] });
    expect(reconcilePick(uncurated, "my-model", false)).toEqual({ value: "my-model", advanced: true, usedRecommendation: false });
    expect(reconcilePick(uncurated, "", false)).toEqual({ value: "", advanced: false, usedRecommendation: false });
  });

  it("marks the recommended reasoning effort and keeps the engine's five levels", () => {
    expect(reasoningEffortOptions(available()).map((option) => option.label)).toEqual(["None", "Minimal", "Low (Recommended)", "Medium", "High"]);
    expect(reasoningEffortOptions(undefined).map((option) => option.value)).toEqual(["none", "minimal", "low", "medium", "high"]);
  });

  it("names the active manifest source and version", () => {
    expect(describeManifest(manifest)).toBe("Model recommendations: version 1, built into Knowledge.");
    expect(describeManifest({ ...manifest, source: "portal", version: 4, portal: { status: "ok", version: 4 } })).toBe("Model recommendations: version 4, from Teal Brick Portal.");
    expect(describeManifest({ ...manifest, source: "app-local", version: 5, appLocal: { status: "ok", version: 5 } })).toMatch(/version 5, from this installation's owner setting/u);
    expect(describeManifest({ ...manifest, source: "portal", version: 4, appLocal: { status: "ok", version: 2 } })).toMatch(/owner list \(version 2\) is older/u);
    expect(describeManifest({ ...manifest, appLocal: { status: "invalid" } })).toMatch(/not valid and is ignored/u);
    expect(describeManifest(undefined)).toBeNull();
  });

  it("explains a missing live list without raw codes", () => {
    expect(describeListing(available({ error: "provider_key_invalid", listing: "manifest" }))).toMatch(/refused the saved key/u);
    expect(describeListing(available({ error: "provider_unreachable", listing: "manifest" }))).toMatch(/could not reach the provider/u);
    expect(describeListing(available({ listing: "manifest", keySource: "none" }))).toMatch(/^Save a key/u);
    expect(describeListing(available())).toBeNull();
  });

  it("detects an embedding change on an existing memory", () => {
    const lock = { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 };
    expect(embeddingChange(null, { provider: "openai", model: "text-embedding-3-large", dimensions: 3072 })).toBeNull();
    expect(embeddingChange(lock, { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 })).toBeNull();
    expect(embeddingChange(lock, { provider: "openai", model: "text-embedding-3-large", dimensions: 1536 })).toEqual({ current: "text-embedding-3-small (1536 dimensions)", next: "text-embedding-3-large (1536 dimensions)" });
    expect(embeddingChange(lock, { provider: "openai", model: "text-embedding-3-small", dimensions: 512 })).not.toBeNull();
    expect(embeddingChange(lock, { provider: "google", model: "text-embedding-3-small", dimensions: 1536 })).not.toBeNull();
    // An older memory without a recorded size uses 1536.
    expect(embeddingChange({ ...lock, dimensions: null }, { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 })).toBeNull();
  });

  it("shows the field-level errors of a rejected owner list", () => {
    expect(describeManifestErrors(new ApiError(400, "x", { ok: false, error: "model_manifest_invalid", errors: [{ path: "/version", message: "Too small" }, { path: "", message: "Not valid JSON" }] }))).toEqual(["/version: Too small", "Not valid JSON"]);
    expect(describeManifestErrors(new ApiError(403, "x", { ok: false, error: "settings_owner_required" }))[0]).toMatch(/^Only the owner/u);
  });

  it("builds the owner-only list path", () => {
    expect(availableModelsPath("openai", "chat")).toBe("/api/settings/models/available?provider=openai&role=chat");
  });
});

describe("model picker rendering", () => {
  const render = (props: Partial<Parameters<typeof ModelPicker>[0]> = {}) => renderToStaticMarkup(createElement(ModelPicker, {
    label: "Chat model", available: available(), loading: false, value: "gpt-6-luna", advanced: false, onChange: noop, onAdvancedChange: noop, ...props,
  }));

  it("is a dropdown with the recommendation preselected and no free text by default", () => {
    const html = render();
    const [select] = selects(html);
    expect(select).toBeDefined();
    expect(select).toMatch(/<option value="gpt-6-luna" selected="">gpt-6-luna \(Recommended\)<\/option>/u);
    expect(textInputs(html)).toEqual([]);
    expect(html).toContain("Other model (advanced)");
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/u);
  });

  it("reveals a free text field behind the advanced toggle", () => {
    const html = render({ advanced: true, value: "my-fine-tune" });
    expect(selects(html)).toEqual([]);
    expect(textInputs(html)).toHaveLength(1);
    expect(textInputs(html)[0]).toContain('value="my-fine-tune"');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/u);
  });

  it("offers only free text when the provider has no list", () => {
    const html = render({ available: available({ models: [], recommended: null, listing: "none", freeTextOnly: true }), value: "" });
    expect(selects(html)).toEqual([]);
    expect(textInputs(html)).toHaveLength(1);
    expect(html).not.toContain("Other model (advanced)");
    expect(html).toContain("Type the model name");
  });

  it("shows a disabled placeholder while the list loads", () => {
    const html = render({ available: undefined, loading: true });
    expect(html).toContain("Loading models");
    expect(selects(html)[0]).toContain("disabled");
  });

  it("guides the re-index instead of saving an embedding change", () => {
    const html = renderToStaticMarkup(createElement(EmbeddingChangeWarning, { change: { current: "text-embedding-3-small (1536 dimensions)", next: "text-embedding-3-large (3072 dimensions)" }, canKeep: true, onKeep: noop }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("does not save this change");
    expect(html).toContain("re-index your memory first");
    expect(html).toContain("Keep the current embedding model");
  });
});

describe("Settings -> Models panel", () => {
  const status: ModelSettingsStatus = {
    configured: false,
    source: "not-configured",
    brain: { status: "online" },
    manifest: { ...manifest, source: "portal", version: 3, portal: { status: "ok", version: 3 } },
    embeddingLock: null,
  };
  function renderPanel(overrides: Partial<ModelSettingsStatus> = {}) {
    const client = new QueryClient();
    client.setQueryData(["knowledge-model-settings"], { ...status, ...overrides });
    client.setQueryData(["knowledge-model-available", "openai", "chat"], available());
    client.setQueryData(["knowledge-model-available", "openai", "embedding"], available({ role: "embedding", models: ["text-embedding-3-small", "text-embedding-3-large"], recommended: "text-embedding-3-small", recommendedDimensions: 1536, reasoningEffort: { supported: false, options: [], recommended: null } }));
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ModelSettingsPanel)));
  }

  it("offers dropdowns for chat and embedding, the recommendation labelled, and the manifest source", () => {
    const html = renderPanel();
    expect(html).toMatch(/<option value="gpt-6-luna" selected="">gpt-6-luna \(Recommended\)<\/option>/u);
    expect(html).toMatch(/<option value="text-embedding-3-small" selected="">text-embedding-3-small \(Recommended\)<\/option>/u);
    expect(html).toContain("Low (Recommended)");
    expect(html.match(/Other model \(advanced\)/gu)).toHaveLength(2);
    expect(html).toContain("Model recommendations: version 3, from Teal Brick Portal.");
    // No free text model field by default: the only text inputs are keys and the API URL.
    expect(textInputs(html).filter((input) => !/type="password"/u.test(input))).toEqual([]);
    expect(html).not.toContain("does not save this change");
  });

  it("warns and blocks the save when the embedding model differs from the existing memory", () => {
    const html = renderPanel({ embeddingLock: { provider: "openai", model: "text-embedding-3-large", dimensions: 3072 } });
    expect(html).toContain("This changes the embedding model of your existing memory.");
    expect(html).toContain("text-embedding-3-large (3072 dimensions)");
    expect(html).toContain("Keep the current embedding model");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save and test connection<\/button>/u);
  });
});
