import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, CheckboxField, Feedback, SelectField, Tag, TextField } from "@tealbrick/ui";
import { api, ApiError } from "./api";
import { describeErrorCode } from "./errors";

type ChatProvider = "openai" | "ollama" | "openrouter";
type EmbeddingProvider = "openai" | "llama-server" | "openrouter";
type RerankerProvider = "llama-server-reranker" | "openrouter";
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

/** Public (key-free) connection as returned by GET /api/settings/models. */
type PublicConnection = {
  provider?: string;
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  dimensions?: number;
  reasoningEffort?: ReasoningEffort;
};
export type ModelSettingsStatus = {
  configured: boolean;
  source: string;
  chat?: PublicConnection;
  embedding?: PublicConnection;
  reranker?: PublicConnection | null;
  brain: { status: string };
};
type Check = { component: string; ok: boolean; error?: string };

/** One of three setups; each maps onto providers accepted by the server schema. */
export type ProviderMode = "openai" | "openrouter" | "self-hosted";

const PRESETS: Record<ProviderMode, { label: string; url: string; chatModel: string; embeddingModel: string; dimensions: number; rerankerModel: string }> = {
  openai: { label: "OpenAI", url: "https://api.openai.com/v1", chatModel: "gpt-4.1-mini", embeddingModel: "text-embedding-3-small", dimensions: 1536, rerankerModel: "" },
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/v1", chatModel: "openai/gpt-4.1-mini", embeddingModel: "openai/text-embedding-3-small", dimensions: 1536, rerankerModel: "cohere/rerank-v3.5" },
  "self-hosted": { label: "Self-hosted (Ollama and llama-server)", url: "http://127.0.0.1:11434/v1", chatModel: "", embeddingModel: "", dimensions: 768, rerankerModel: "" },
};

const PROVIDERS: Record<ProviderMode, { chat: ChatProvider; embedding: EmbeddingProvider; reranker: RerankerProvider | null }> = {
  openai: { chat: "openai", embedding: "openai", reranker: null },
  openrouter: { chat: "openrouter", embedding: "openrouter", reranker: "openrouter" },
  "self-hosted": { chat: "ollama", embedding: "llama-server", reranker: "llama-server-reranker" },
};

export function modeFromSaved(status: ModelSettingsStatus | undefined): ProviderMode {
  const chat = status?.chat?.provider;
  if (chat === "openrouter") return "openrouter";
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
  if (error.code === "model_api_key_required") return [`${COMPONENT_LABELS[body.component ?? ""] ?? "Model"}: enter an API key. A saved key is only reused for the same provider and URL.`];
  return [error.message];
}

function savedKeyFor(status: ModelSettingsStatus | undefined, provider: string, url: string) {
  return [status?.chat, status?.embedding, status?.reranker ? { ...status.reranker, provider: status.reranker.provider ?? "llama-server-reranker" } : null]
    .some((entry) => entry?.keyConfigured && entry.provider === provider && entry.baseUrl === url.trim());
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
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
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
    if (savedMode === "self-hosted") setEmbeddingUrl(saved.embedding.baseUrl);
    setShowUrl(saved.chat.baseUrl !== PRESETS[savedMode].url);
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
    setEmbeddingModel(preset.embeddingModel);
    setDimensions(String(preset.dimensions));
    setRerankerModel(preset.rerankerModel);
    if (!PROVIDERS[next].reranker) setUseReranker(false);
    setShowUrl(next === "self-hosted");
  };

  const providers = PROVIDERS[mode];
  const selfHosted = mode === "self-hosted";
  const effectiveEmbeddingUrl = selfHosted ? embeddingUrl : url;
  const effectiveRerankerUrl = selfHosted ? rerankerUrl : url;
  const keys = useMemo(() => ({
    chat: key.trim() || savedKeyFor(status.data, providers.chat, url),
    embedding: selfHosted ? embeddingKey.trim() || savedKeyFor(status.data, providers.embedding, effectiveEmbeddingUrl) : Boolean(key.trim()) || savedKeyFor(status.data, providers.embedding, url),
    reranker: !useReranker || !providers.reranker ? true : selfHosted ? rerankerKey.trim() || savedKeyFor(status.data, providers.reranker, effectiveRerankerUrl) : Boolean(key.trim()) || savedKeyFor(status.data, providers.reranker, url),
  }), [key, embeddingKey, rerankerKey, status.data, providers, url, effectiveEmbeddingUrl, effectiveRerankerUrl, selfHosted, useReranker]);

  const dimensionValue = Number(dimensions);
  const complete = Boolean(url.trim() && chatModel.trim() && embeddingModel.trim() && effectiveEmbeddingUrl.trim())
    && Number.isInteger(dimensionValue) && dimensionValue >= 64 && dimensionValue <= 8192
    && (!useReranker || Boolean(rerankerModel.trim() && effectiveRerankerUrl.trim()))
    && Boolean(keys.chat && keys.embedding && keys.reranker);

  const save = useMutation({
    mutationFn: () => {
      const sharedKey = key.trim() || undefined;
      const body = {
        chat: { provider: providers.chat, baseUrl: url.trim(), model: chatModel.trim(), ...(sharedKey ? { apiKey: sharedKey } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) },
        embedding: {
          provider: providers.embedding,
          baseUrl: effectiveEmbeddingUrl.trim(),
          model: embeddingModel.trim(),
          dimensions: dimensionValue,
          ...((selfHosted ? embeddingKey.trim() : sharedKey) ? { apiKey: selfHosted ? embeddingKey.trim() : sharedKey } : {}),
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
      return api<{ ok: boolean; brain: { status: string } }>("/api/settings/models", { method: "PUT", body: JSON.stringify(body) });
    },
    onSuccess: () => void status.refetch(),
    // A memory-engine start failure happens after the settings were saved.
    onError: (error) => { if (error instanceof ApiError && error.code === "brain_start_failed") void status.refetch(); },
  });

  const ownerError = status.error;
  const saved = status.data?.configured;
  const keyHint = (available: boolean) => available ? "A key is saved for this provider and URL. Leave blank to keep it." : undefined;
  const sharedKeySaved = savedKeyFor(status.data, providers.chat, url);

  return <div className="settings-stack model-settings">
    <div className="settings-intro">
      <div>
        <h3>Connect your models</h3>
        <p>Knowledge uses a chat model to extract facts and an embedding model for semantic memory. Knowledge runs its memory engine for you. Keys stay on this installation — never in Portal, this browser, or your agents.</p>
      </div>
      <Tag tone={saved ? "success" : "default"}>{status.isLoading ? "Loading" : ownerError ? "Owner only" : saved ? "Saved" : "Not set up"}</Tag>
    </div>
    {ownerError && <Feedback state="forbidden" title="Model settings are owner-only">{ownerError.message}</Feedback>}
    {saved && <p className="settings-note">Your saved settings are shown below. Keys are never sent back to this page; leave a key blank to keep the saved one.</p>}
    <fieldset className="model-settings__form" disabled={Boolean(ownerError) || save.isPending}>
      <SelectField label="Provider" value={mode} onChange={(event) => chooseMode(event.target.value as ProviderMode)}>
        {(Object.keys(PRESETS) as ProviderMode[]).map((id) => <option key={id} value={id}>{PRESETS[id].label}</option>)}
      </SelectField>
      {(showUrl || selfHosted) && <TextField label={selfHosted ? "Chat model URL (Ollama-compatible)" : "API URL"} value={url} onChange={(event) => setUrl(event.target.value)} />}
      <TextField label={selfHosted ? "Chat model API key" : "API key"} type="password" autoComplete="off" value={key}
        placeholder={sharedKeySaved ? "Saved — leave blank to keep" : undefined}
        description={keyHint(sharedKeySaved) ?? (selfHosted ? "If your server does not check keys, enter any value." : undefined)}
        onChange={(event) => setKey(event.target.value)} />
      <TextField label="Chat model" value={chatModel} onChange={(event) => setChatModel(event.target.value)} />
      <SelectField label="Reasoning effort" description="How much the chat model reasons before answering. Leave on default unless your model needs it." value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort | "")}>
        <option value="">Model default</option>
        <option value="none">None</option>
        <option value="minimal">Minimal</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </SelectField>
      {selfHosted && <>
        <TextField label="Embedding model URL (llama-server)" value={embeddingUrl} onChange={(event) => setEmbeddingUrl(event.target.value)} />
        <TextField label="Embedding model API key" type="password" autoComplete="off" value={embeddingKey}
          placeholder={savedKeyFor(status.data, providers.embedding, embeddingUrl) ? "Saved — leave blank to keep" : undefined}
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
      {!selfHosted && <div><Button size="small" type="button" onClick={() => { if (showUrl) setUrl(PRESETS[mode].url); setShowUrl(!showUrl); }}>{showUrl ? "Use the standard API URL" : "Use a different API URL"}</Button></div>}
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
  </div>;
}
