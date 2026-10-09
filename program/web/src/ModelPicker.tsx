import { Button, CheckboxField, SelectField, TextField } from "@tealbrick/ui";

export type PickerRole = "chat" | "embedding" | "rerank";
export type EngineReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

/** GET /api/settings/models/available: model ids only, never a key. */
export type AvailableModels = {
  ok: true;
  provider: string;
  role: PickerRole;
  listing: "provider" | "manifest" | "none";
  curated: boolean;
  models: string[];
  recommended: string | null;
  recommendedDimensions: number | null;
  reasoningEffort: { supported: boolean; options: EngineReasoningEffort[]; recommended: EngineReasoningEffort | null };
  freeTextOnly: boolean;
  keySource: "knowledge-settings" | "provider-env" | "none";
  error?: "provider_unreachable" | "provider_key_invalid";
  manifest: { source: ManifestSource; version: number };
};

export type ManifestSource = "portal" | "app-local" | "bundled";
/** The `manifest` block of GET /api/settings/models. */
export type ManifestStatus = {
  source: ManifestSource;
  version: number;
  effectiveAt: string;
  portal: { status: "not-configured" | "absent" | "invalid" | "ok"; version?: number };
  appLocal: { status: "not-configured" | "invalid" | "ok"; version?: number };
  bundledVersion: number;
};
/** The embedding model an existing memory already holds vectors for (GET /api/settings/models `embeddingLock`). */
export type EmbeddingLock = { provider: string; model: string; dimensions: number | null };

export const availableModelsPath = (provider: string, role: PickerRole) =>
  `/api/settings/models/available?provider=${encodeURIComponent(provider)}&role=${encodeURIComponent(role)}`;

const SOURCE_LABELS: Record<ManifestSource, string> = {
  portal: "from Teal Brick Portal",
  "app-local": "from this installation's owner setting",
  bundled: "built into Knowledge",
};

/** One line naming the active recommendation list and its version. */
export function describeManifest(manifest: ManifestStatus | undefined): string | null {
  if (!manifest) return null;
  const notes: string[] = [];
  if (manifest.appLocal.status === "invalid") notes.push("The saved owner list is not valid and is ignored.");
  else if (manifest.appLocal.status === "ok" && manifest.source !== "app-local") notes.push(`Your owner list (version ${manifest.appLocal.version}) is older, so it is not used.`);
  return [`Model recommendations: version ${manifest.version}, ${SOURCE_LABELS[manifest.source]}.`, ...notes].join(" ");
}

/** Why the live model list is missing; null when it loaded. */
export function describeListing(available: AvailableModels | undefined): string | null {
  if (!available) return null;
  if (available.error === "provider_key_invalid") return "The provider refused the saved key, so the recommended models are shown. Check the key.";
  if (available.error === "provider_unreachable") return "Knowledge could not reach the provider to list its models, so the recommended models are shown.";
  if (available.freeTextOnly) return "This provider has no model list here. Type the model name.";
  if (available.listing === "manifest") return "Save a key for this provider to see every model it offers you. The recommended models are shown.";
  return null;
}

/** Dropdown options: the recommendation first and labelled, then the rest in listed order. */
export function pickerOptions(available: AvailableModels | undefined): { value: string; label: string }[] {
  if (!available) return [];
  const rest = available.models.filter((id) => id !== available.recommended);
  return [
    ...(available.recommended ? [{ value: available.recommended, label: `${available.recommended} (Recommended)` }] : []),
    ...rest.map((id) => ({ value: id, label: id })),
  ];
}

/**
 * Fit the current value to the list. A listed value stays. A saved custom value (or any value next to an
 * uncurated list) stays in the advanced (free text) field. Anything else becomes the recommendation, or the
 * first model of a curated list; an uncurated list without a value waits for the owner to choose.
 */
export function reconcilePick(available: AvailableModels, value: string, keepCustom: boolean): { value: string; advanced: boolean; usedRecommendation: boolean } {
  const trimmed = value.trim();
  if (available.freeTextOnly) return { value, advanced: true, usedRecommendation: false };
  if (available.models.includes(trimmed)) return { value: trimmed, advanced: false, usedRecommendation: false };
  // An uncurated list (Ollama, llama-server, OpenRouter chat) has no recommendation: keep what is there.
  if ((keepCustom || !available.curated) && trimmed) return { value, advanced: true, usedRecommendation: false };
  const next = available.recommended ?? (available.curated ? available.models[0] : undefined);
  if (!next) return { value, advanced: false, usedRecommendation: false };
  return { value: next, advanced: false, usedRecommendation: next === available.recommended };
}

/** Labels for the reasoning effort select; the recommended level is marked. */
export function reasoningEffortOptions(available: AvailableModels | undefined): { value: EngineReasoningEffort; label: string }[] {
  const options: EngineReasoningEffort[] = available?.reasoningEffort.options.length ? available.reasoningEffort.options : ["none", "minimal", "low", "medium", "high"];
  const recommended = available?.reasoningEffort.recommended ?? null;
  return options.map((value) => {
    const label = value[0]!.toUpperCase() + value.slice(1);
    return { value, label: value === recommended ? `${label} (Recommended)` : label };
  });
}

/**
 * Whether a save would change the vector space of an existing memory: a different embedding
 * provider, model or vector size. Such a change needs a re-index first; it is never saved silently.
 */
export function embeddingChange(lock: EmbeddingLock | null | undefined, next: { provider: string; model: string; dimensions: number }): { current: string; next: string } | null {
  if (!lock) return null;
  const currentDimensions = lock.dimensions ?? 1536;
  if (lock.provider === next.provider && lock.model === next.model.trim() && currentDimensions === next.dimensions) return null;
  return { current: `${lock.model} (${currentDimensions} dimensions)`, next: `${next.model.trim() || "no model"} (${next.dimensions} dimensions)` };
}

export function ModelPicker(props: {
  label: string;
  description?: string;
  available: AvailableModels | undefined;
  loading: boolean;
  value: string;
  advanced: boolean;
  onChange: (value: string) => void;
  onAdvancedChange: (advanced: boolean) => void;
}) {
  const { available, loading, value, advanced } = props;
  const options = pickerOptions(available);
  const listing = describeListing(available);
  // No list (still loading, failed, or the provider has none): the free text field is the only way.
  const freeText = !available || available.freeTextOnly || options.length === 0;
  if (loading && !available) return <SelectField label={props.label} value="" disabled onChange={() => undefined}><option value="">Loading models…</option></SelectField>;
  if (freeText) return <TextField label={props.label} value={value} description={listing ?? props.description} onChange={(event) => props.onChange(event.target.value)} />;
  return <div className="model-picker">
    {advanced
      ? <TextField label={`${props.label} (other model)`} value={value} description="Type the exact model name. Saving tests it first." onChange={(event) => props.onChange(event.target.value)} />
      : <SelectField label={props.label} value={options.some((option) => option.value === value) ? value : ""} description={listing ?? props.description} onChange={(event) => props.onChange(event.target.value)}>
          {!options.some((option) => option.value === value) && <option value="">Choose a model</option>}
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </SelectField>}
    <CheckboxField label="Other model (advanced)" description="Use a model that is not in the list." checked={advanced}
      onChange={(event) => {
        const next = event.target.checked;
        props.onAdvancedChange(next);
        // Back to the list: a typed name that is not listed becomes the recommendation.
        if (!next && available && !available.models.includes(value.trim())) props.onChange(available.recommended ?? options[0]?.value ?? "");
      }} />
  </div>;
}

/** The guided re-index step shown instead of saving a vector-space change. */
export function EmbeddingChangeWarning(props: { change: { current: string; next: string }; canKeep: boolean; onKeep: () => void }) {
  return <div className="model-settings__embedding-warning" role="alert">
    <p><strong>This changes the embedding model of your existing memory.</strong> Saved memories were indexed with {props.change.current}. New searches with {props.change.next} would not match them, so Knowledge does not save this change.</p>
    <ol>
      <li>To keep your memory working, keep the current embedding model. You can still change the chat model and the other settings.</li>
      <li>To switch the embedding model, re-index your memory first. The server operator runs the re-index on the installation; see "Changing the embedding model" in the memory operation guide.</li>
      <li>When the re-index is done, open this page again. The new embedding model is then the current one.</li>
    </ol>
    {props.canKeep && <Button size="small" type="button" onClick={props.onKeep}>Keep the current embedding model</Button>}
  </div>;
}
