import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, CheckboxField, Feedback, SelectField, Tag, TextField } from "@tealbrick/ui";
import { api, ApiError } from "./api";
import { describeErrorCode } from "./errors";

type ChatProvider = "openai" | "ollama" | "openrouter" | "anthropic" | "google";
type EmbeddingProvider = "openai" | "llama-server" | "openrouter" | "google";
type RerankerProvider = "llama-server-reranker" | "openrouter";
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

/** Public (key-free) connection as returned by GET /api/settings/models. */
type PublicConnection = {
  provider?: string;
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  /** "provider-env": the key comes from the account connection, not from this page. */
  keySource?: string;
  dimensions?: number;
  reasoningEffort?: ReasoningEffort;
};
export type ModelSettingsStatus = {
  configured: boolean;
  /** "knowledge-settings" (saved here), "provider-env" (account connection) or "not-configured". */
  source: string;
  /** Why the account connection did not make a configuration, e.g. "embedding_provider_required". */
  issue?: string;
  chat?: PublicConnection;
  embedding?: PublicConnection;
  reranker?: PublicConnection | null;
  brain: { status: string };
  research?: ResearchStatus;
};
/** Key-free Research status returned with model settings. */
export type ResearchStatus = { status: string; error?: string; hint?: string };
type Check = { component: string; ok: boolean; error?: string };

/** One setup per chat provider; each maps onto providers accepted by the server schema. */
export type ProviderMode = "openai" | "openrouter" | "google" | "anthropic" | "self-hosted";
/** Anthropic has no embeddings API, so its setup asks for a separate embedding provider. */
export type EmbeddingChoice = "openai" | "openrouter" | "google" | "self-hosted";

/** Providers with one official address; the API URL is not editable. */
const FIXED_URL_MODES: ReadonlySet<ProviderMode> = new Set<ProviderMode>(["google", "anthropic"]);
const GOOGLE_URL = "https://generativelanguage.googleapis.com";
const ANTHROPIC_URL = "https://api.anthropic.com";

export const PRESETS: Record<ProviderMode, { label: string; url: string; chatModel: string; reasoningEffort?: ReasoningEffort; embeddingModel: string; dimensions: number; rerankerModel: string }> = {
  openai: { label: "OpenAI", url: "https://api.openai.com/v1", chatModel: "gpt-6-luna", reasoningEffort: "low", embeddingModel: "text-embedding-3-small", dimensions: 1536, rerankerModel: "" },
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/v1", chatModel: "openai/gpt-4.1-mini", embeddingModel: "openai/text-embedding-3-small", dimensions: 1536, rerankerModel: "cohere/rerank-v3.5" },
  google: { label: "Google (Gemini)", url: GOOGLE_URL, chatModel: "gemini-2.5-flash", embeddingModel: "gemini-embedding-2", dimensions: 768, rerankerModel: "" },
  anthropic: { label: "Anthropic (Claude)", url: ANTHROPIC_URL, chatModel: "claude-sonnet-5", embeddingModel: "text-embedding-3-small", dimensions: 1536, rerankerModel: "" },
  "self-hosted": { label: "Self-hosted (Ollama and llama-server)", url: "http://127.0.0.1:11434/v1", chatModel: "", embeddingModel: "", dimensions: 768, rerankerModel: "" },
};

/** Embedding providers offered next to Anthropic chat. */
const EMBEDDING_CHOICES: Record<EmbeddingChoice, { label: string; provider: EmbeddingProvider; url: string; model: string; dimensions: number }> = {
  openai: { label: "OpenAI", provider: "openai", url: "https://api.openai.com/v1", model: "text-embedding-3-small", dimensions: 1536 },
  openrouter: { label: "OpenRouter", provider: "openrouter", url: "https://openrouter.ai/api/v1", model: "openai/text-embedding-3-small", dimensions: 1536 },
  google: { label: "Google (Gemini)", provider: "google", url: GOOGLE_URL, model: "gemini-embedding-2", dimensions: 768 },
  "self-hosted": { label: "Self-hosted (llama-server)", provider: "llama-server", url: "http://127.0.0.1:8080/v1", model: "", dimensions: 768 },
};

const PROVIDERS: Record<ProviderMode, { chat: ChatProvider; embedding: EmbeddingProvider; reranker: RerankerProvider | null }> = {
  openai: { chat: "openai", embedding: "openai", reranker: null },
  openrouter: { chat: "openrouter", embedding: "openrouter", reranker: "openrouter" },
  google: { chat: "google", embedding: "google", reranker: null },
  anthropic: { chat: "anthropic", embedding: "openai", reranker: null }, // embedding is chosen separately
  "self-hosted": { chat: "ollama", embedding: "llama-server", reranker: "llama-server-reranker" },
};

/** Which embedding provider the saved Anthropic setup uses. */
export function embeddingChoiceFromSaved(status: ModelSettingsStatus | undefined): EmbeddingChoice {
  const provider = status?.embedding?.provider;
  if (provider === "openrouter" || provider === "google") return provider;
  if (provider === "llama-server") return "self-hosted";
  return "openai";
}

export function modeFromSaved(status: ModelSettingsStatus | undefined): ProviderMode {
  const chat = status?.chat?.provider;
  if (chat === "openrouter") return "openrouter";
  if (chat === "google") return "google";
  if (chat === "anthropic") return "anthropic";
  if (chat === "ollama" || status?.embedding?.provider === "llama-server") return "self-hosted";
  return "openai";
}

const COMPONENT_LABELS: Record<string, string> = { chat: "Chat model", embedding: "Embedding model", reranker: "Reranker", settings: "Settings" };

/** Human description of a failed save, including each failed provider check. */
export function describeSaveError(error: Error): string[] {
  if (!(error instanceof ApiError)) return [error.message];
  const body = error.body && typeof error.body === "object" ? (error.body as { checks?: Check[]; component?: string }) : {};
  if (error.status === 422 && Array.isArray(body.checks)) {
    const failed = body.checks.filter((check) => !check.ok);
    if (failed.length) return failed.map((check) => `${COMPONENT_LABELS[check.component] ?? "Model"}: ${describeErrorCode(check.error ?? null, 422)}`);
  }
  if (error.code === "embedding_provider_required") return ["Embedding model: Anthropic does not offer embeddings. Choose a separate embedding provider, such as OpenAI, Google, OpenRouter or a self-hosted server."];
  if (error.code === "model_api_key_required") return [`${COMPONENT_LABELS[body.component ?? ""] ?? "Model"}: enter an API key. A saved key is only reused for the same provider and URL.`];
  return [error.message];
}

/** One short line about where the models come from; null when saved here or nothing is connected. */
export function describeModelSource(status: ModelSettingsStatus | undefined): { tone: "default" | "warning"; text: string } | null {
  if (status?.configured && status.source === "provider-env") return { tone: "default", text: "These models come from the API keys connected to your account. Saving here replaces them with the keys you enter." };
  if (!status?.configured && status?.issue === "embedding_provider_required") return { tone: "warning", text: "An Anthropic key is connected to your account, but Anthropic has no embedding models. Connect an OpenAI or Google key, or set the models up below." };
  if (!status?.configured && status?.issue === "embedding_key_missing") return { tone: "warning", text: "Your memory already uses an embedding model whose account key is not connected. Connect that key, or set the models up below." };
  return null;
}

/** One short line about Research after a save; null when Research is not installed. */
export function describeResearchStatus(research: ResearchStatus | undefined): { tone: "success" | "warning"; text: string } | null {
  switch (research?.status) {
    case "configured": return { tone: "success", text: "Research uses the same models." };
    case "pending": return { tone: "warning", text: "Research will pick up these models shortly." };
    case "embedding_migration_required": return { tone: "warning", text: "Research chat uses these models. Research search keeps its current embedding model because it already holds sources." };
    case "encryption_not_configured": return { tone: "warning", text: "Research can't store this key yet: its server needs an encryption key. Memory is set up." };
    case "provider_unsupported": return { tone: "warning", text: "Research can't use this provider yet. Memory is set up." };
    case "model_conflict": return { tone: "warning", text: research.hint?.trim() || "Research already has a model with this name on another key. Remove it there or pick a different model." };
    case "failed": return { tone: "warning", text: "Research couldn't be updated. Memory is set up, and Knowledge will try again when it next starts." };
    default: return null;
  }
}

function savedKeyFor(status: ModelSettingsStatus | undefined, provider: string, url: string) {
  return [status?.chat, status?.embedding, status?.reranker ? { ...status.reranker, provider: status.reranker.provider ?? "llama-server-reranker" } : null]
    .some((entry) => entry?.keyConfigured && entry.keySource !== "provider-env" && entry.provider === provider && entry.baseUrl === url.trim());
}

export function ModelSettingsPanel() {
  const status = useQuery({
    queryKey: ["knowledge-model-settings"],
    queryFn: () => api<ModelSettingsStatus>("/api/settings/models"),
    retry: false,
  });
  const [mode, setMode] = useState<ProviderMode>("openai");
  const [url, setUrl] = useState(PRESETS.openai.url);
  const [key, setKey] = useState("");
  const [chatModel, setChatModel] = useState(PRESETS.openai.chatModel);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(PRESETS.openai.reasoningEffort ?? "");
  const [embeddingChoice, setEmbeddingChoice] = useState<EmbeddingChoice>("openai");
  const [embeddingUrl, setEmbeddingUrl] = useState("http://127.0.0.1:8080/v1");
  const [embeddingKey, setEmbeddingKey] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState(PRESETS.openai.embeddingModel);
  const [dimensions, setDimensions] = useState(String(PRESETS.openai.dimensions));
  const [useReranker, setUseReranker] = useState(false);
  const [rerankerUrl, setRerankerUrl] = useState("http://127.0.0.1:8081/v1");
  const [rerankerKey, setRerankerKey] = useState("");
  const [rerankerModel, setRerankerModel] = useState("");
  const [showUrl, setShowUrl] = useState(false);

  // Prefill from saved, key-free settings once they load (or after a save).
  useEffect(() => {
    const saved = status.data;
    if (!saved?.configured || !saved.chat || !saved.embedding) return;
    const savedMode = modeFromSaved(saved);
    setMode(savedMode);
    setUrl(saved.chat.baseUrl);
    setChatModel(saved.chat.model);
    setReasoningEffort(saved.chat.reasoningEffort ?? "");
    setEmbeddingModel(saved.embedding.model);
    setDimensions(String(saved.embedding.dimensions ?? PRESETS[savedMode].dimensions));
    const savedChoice = embeddingChoiceFromSaved(saved);
    setEmbeddingChoice(savedChoice);
    if (savedMode === "self-hosted" || savedChoice === "self-hosted") setEmbeddingUrl(saved.embedding.baseUrl);
    setShowUrl(!FIXED_URL_MODES.has(savedMode) && saved.chat.baseUrl !== PRESETS[savedMode].url);
    setUseReranker(Boolean(saved.reranker));
    if (saved.reranker) {
      setRerankerModel(saved.reranker.model);
      setRerankerUrl(saved.reranker.baseUrl);
    }
    setKey("");
    setEmbeddingKey("");
    setRerankerKey("");
  }, [status.data]);

  const chooseMode = (next: ProviderMode) => {
    setMode(next);
    const preset = PRESETS[next];
    setUrl(preset.url);
    setChatModel(preset.chatModel);
    setReasoningEffort(preset.reasoningEffort ?? "");
    setEmbeddingModel(preset.embeddingModel);
    setDimensions(String(preset.dimensions));
    setRerankerModel(preset.rerankerModel);
    if (!PROVIDERS[next].reranker) setUseReranker(false);
    setShowUrl(next === "self-hosted");
    if (next === "anthropic") chooseEmbeddingChoice(embeddingChoice);
  };
  const chooseEmbeddingChoice = (next: EmbeddingChoice) => {
    setEmbeddingChoice(next);
    const choice = EMBEDDING_CHOICES[next];
    setEmbeddingModel(choice.model);
    setDimensions(String(choice.dimensions));
    if (next === "self-hosted") setEmbeddingUrl(choice.url);
  };

  const providers = PROVIDERS[mode];
  const selfHosted = mode === "self-hosted";
  const anthropic = mode === "anthropic";
  const fixedUrl = FIXED_URL_MODES.has(mode);
  // Self-hosted and Anthropic setups carry their own embedding connection (URL and key).
  const separateEmbedding = selfHosted || anthropic;
  const embeddingProvider: EmbeddingProvider = anthropic ? EMBEDDING_CHOICES[embeddingChoice].provider : providers.embedding;
  const embeddingUrlEditable = selfHosted || (anthropic && embeddingChoice === "self-hosted");
  const effectiveEmbeddingUrl = anthropic ? (embeddingUrlEditable ? embeddingUrl : EMBEDDING_CHOICES[embeddingChoice].url) : selfHosted ? embeddingUrl : url;
  const effectiveRerankerUrl = selfHosted ? rerankerUrl : url;
  const keys = useMemo(() => ({
    chat: key.trim() || savedKeyFor(status.data, providers.chat, url),
    embedding: separateEmbedding ? embeddingKey.trim() || savedKeyFor(status.data, embeddingProvider, effectiveEmbeddingUrl) : Boolean(key.trim()) || savedKeyFor(status.data, providers.embedding, url),
    reranker: !useReranker || !providers.reranker ? true : selfHosted ? rerankerKey.trim() || savedKeyFor(status.data, providers.reranker, effectiveRerankerUrl) : Boolean(key.trim()) || savedKeyFor(status.data, providers.reranker, url),
  }), [key, embeddingKey, rerankerKey, status.data, providers, url, embeddingProvider, effectiveEmbeddingUrl, effectiveRerankerUrl, selfHosted, separateEmbedding, useReranker]);

  const dimensionValue = Number(dimensions);
  const complete = Boolean(url.trim() && chatModel.trim() && embeddingModel.trim() && effectiveEmbeddingUrl.trim())
    && Number.isInteger(dimensionValue) && dimensionValue >= 64 && dimensionValue <= 8192
    && (!useReranker || Boolean(rerankerModel.trim() && effectiveRerankerUrl.trim()))
    && Boolean(keys.chat && keys.embedding && keys.reranker);

  const save = useMutation({
    mutationFn: () => {
      const sharedKey = key.trim() || undefined;
      const body = {
        chat: { provider: providers.chat, baseUrl: url.trim(), model: chatModel.trim(), ...(sharedKey ? { apiKey: sharedKey } : {}), ...(reasoningEffort && !fixedUrl ? { reasoningEffort } : {}) },
        embedding: {
          provider: embeddingProvider,
          baseUrl: effectiveEmbeddingUrl.trim(),
          model: embeddingModel.trim(),
          dimensions: dimensionValue,
          ...((separateEmbedding ? embeddingKey.trim() : sharedKey) ? { apiKey: separateEmbedding ? embeddingKey.trim() : sharedKey } : {}),
        },
        ...(useReranker && providers.reranker
          ? { reranker: {
              provider: providers.reranker,
              baseUrl: effectiveRerankerUrl.trim(),
              model: rerankerModel.trim(),
              ...((selfHosted ? rerankerKey.trim() : sharedKey) ? { apiKey: selfHosted ? rerankerKey.trim() : sharedKey } : {}),
            } }
          : {}),
      };
      return api<{ ok: boolean; brain: { status: string }; research?: ResearchStatus }>("/api/settings/models", { method: "PUT", body: JSON.stringify(body) });
    },
    onSuccess: () => void status.refetch(),
    // A memory-engine start failure happens after the settings were saved.
    onError: (error) => { if (error instanceof ApiError && error.code === "brain_start_failed") void status.refetch(); },
  });

  const ownerError = status.error;
  const saved = status.data?.configured;
  const keyHint = (available: boolean) => available ? "A key is saved for this provider and URL. Leave blank to keep it." : undefined;
  const sharedKeySaved = savedKeyFor(status.data, providers.chat, url);
  const modelSource = describeModelSource(status.data);
  const research = describeResearchStatus(save.data?.research ?? (saved ? status.data?.research : undefined));

  return <div className="settings-stack model-settings">
    <div className="settings-intro">
      <div>
        <h3>Connect your models</h3>
        <p>Knowledge uses a chat model to extract facts and an embedding model for semantic memory. Knowledge runs its memory engine for you. Keys stay on this installation — never in Portal, this browser, or your agents.</p>
      </div>
      <Tag tone={saved ? "success" : "default"}>{status.isLoading ? "Loading" : ownerError ? "Owner only" : saved ? (status.data?.source === "provider-env" ? "From your account" : "Saved") : "Not set up"}</Tag>
    </div>
    {ownerError && <Feedback state="forbidden" title="Model settings are owner-only">{ownerError.message}</Feedback>}
    {modelSource && <p className={`settings-note${modelSource.tone === "warning" ? " model-settings__research--warning" : ""}`} role="status">{modelSource.text}</p>}
    {saved && status.data?.source !== "provider-env" && <p className="settings-note">Your saved settings are shown below. Keys are never sent back to this page; leave a key blank to keep the saved one.</p>}
    <fieldset className="model-settings__form" disabled={Boolean(ownerError) || save.isPending}>
      <SelectField label="Provider" value={mode} onChange={(event) => chooseMode(event.target.value as ProviderMode)}>
        {(Object.keys(PRESETS) as ProviderMode[]).map((id) => <option key={id} value={id}>{PRESETS[id].label}</option>)}
      </SelectField>
      {(showUrl || selfHosted) && !fixedUrl && <TextField label={selfHosted ? "Chat model URL (Ollama-compatible)" : "API URL"} value={url} onChange={(event) => setUrl(event.target.value)} />}
      <TextField label={selfHosted ? "Chat model API key" : anthropic ? "Anthropic API key" : mode === "google" ? "Google AI API key" : "API key"} type="password" autoComplete="off" value={key}
        placeholder={sharedKeySaved ? "Saved — leave blank to keep" : undefined}
        description={keyHint(sharedKeySaved) ?? (selfHosted ? "If your server does not check keys, enter any value." : undefined)}
        onChange={(event) => setKey(event.target.value)} />
      <TextField label="Chat model" value={chatModel} onChange={(event) => setChatModel(event.target.value)} />
      {!fixedUrl && <SelectField label="Reasoning effort" description="How much the chat model reasons before answering. Leave on default unless your model needs it." value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort | "")}>
        <option value="">Model default</option>
        <option value="none">None</option>
        <option value="minimal">Minimal</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </SelectField>}
      {anthropic && <SelectField label="Embedding provider" description="Anthropic does not offer embeddings. Choose another provider for the embedding model." value={embeddingChoice} onChange={(event) => chooseEmbeddingChoice(event.target.value as EmbeddingChoice)}>
        {(Object.keys(EMBEDDING_CHOICES) as EmbeddingChoice[]).map((id) => <option key={id} value={id}>{EMBEDDING_CHOICES[id].label}</option>)}
      </SelectField>}
      {separateEmbedding && <>
        {embeddingUrlEditable && <TextField label="Embedding model URL (llama-server)" value={embeddingUrl} onChange={(event) => setEmbeddingUrl(event.target.value)} />}
        <TextField label="Embedding model API key" type="password" autoComplete="off" value={embeddingKey}
          placeholder={savedKeyFor(status.data, embeddingProvider, effectiveEmbeddingUrl) ? "Saved — leave blank to keep" : undefined}
          onChange={(event) => setEmbeddingKey(event.target.value)} />
      </>}
      <TextField label="Embedding model" value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} />
      <TextField label="Embedding dimensions" type="number" min={64} max={8192} value={dimensions}
        description="Must match the embedding model. Changing it later requires migrating existing memory."
        onChange={(event) => setDimensions(event.target.value)} />
      {providers.reranker && <CheckboxField label="Use a reranker" description="Reorders search results for better relevance. Optional." checked={useReranker} onChange={(event) => setUseReranker(event.target.checked)} />}
      {useReranker && providers.reranker && <>
        {selfHosted && <TextField label="Reranker URL (llama-server)" value={rerankerUrl} onChange={(event) => setRerankerUrl(event.target.value)} />}
        {selfHosted && <TextField label="Reranker API key" type="password" autoComplete="off" value={rerankerKey}
          placeholder={savedKeyFor(status.data, providers.reranker, rerankerUrl) ? "Saved — leave blank to keep" : undefined}
          onChange={(event) => setRerankerKey(event.target.value)} />}
        <TextField label="Reranker model" value={rerankerModel} onChange={(event) => setRerankerModel(event.target.value)} />
      </>}
      {!selfHosted && !fixedUrl && <div><Button size="small" type="button" onClick={() => { if (showUrl) setUrl(PRESETS[mode].url); setShowUrl(!showUrl); }}>{showUrl ? "Use the standard API URL" : "Use a different API URL"}</Button></div>}
      <p className="settings-note">Use only model servers you trust. Saving sends a short test request to each model; provider charges may apply.</p>
    </fieldset>
    <div>
      <Button tone="primary" disabled={!complete || save.isPending || Boolean(ownerError)} onClick={() => save.mutate()}>
        {save.isPending ? "Checking models and starting memory…" : "Save and test connection"}
      </Button>
    </div>
    {save.error && <Feedback state="error" title="Model settings were not applied">
      <ul className="model-settings__errors">{describeSaveError(save.error).map((line) => <li key={line}>{line}</li>)}</ul>
    </Feedback>}
    {save.data && <Feedback state="success" title="Models connected">All model checks passed and memory is running. Connect each agent with its own Knowledge credential — never this model key.</Feedback>}
    {research && <p className={`settings-note model-settings__research model-settings__research--${research.tone}`} role="status">{research.text}</p>}
  </div>;
}
