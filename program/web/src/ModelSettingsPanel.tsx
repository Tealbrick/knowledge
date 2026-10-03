import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Tag, TextField } from "@doppelganger/ui";
import { api } from "./api";

export function ModelSettingsPanel() {
  const [advanced, setAdvanced] = useState(false);
  const [key, setKey] = useState("");
  const [chatUrl, setChatUrl] = useState("https://api.openai.com/v1");
  const [chatModel, setChatModel] = useState("gpt-4.1-mini");
  const [embedUrl, setEmbedUrl] = useState("https://api.openai.com/v1");
  const [embedModel, setEmbedModel] = useState("text-embedding-3-small");
  const [embedKey, setEmbedKey] = useState("");
  const [dimensions, setDimensions] = useState("1536");
  const [local, setLocal] = useState(false);
  const status = useQuery({ queryKey: ["knowledge-model-settings"], queryFn: () => api<{ configured: boolean; source: string; brain: { status: string } }>("/api/settings/models"), retry: false });
  const save = useMutation({
    mutationFn: () => api<{ ok: boolean; brain: { status: string } }>("/api/settings/models", { method: "PUT", body: JSON.stringify({
      chat: { provider: local ? "ollama" : "openai", baseUrl: chatUrl, model: chatModel, apiKey: key },
      embedding: { provider: local ? "llama-server" : "openai", baseUrl: advanced ? embedUrl : chatUrl, model: embedModel, apiKey: advanced ? embedKey || key : key, dimensions: Number(dimensions) },
    }) }),
    onSuccess: () => { setKey(""); setEmbedKey(""); void status.refetch(); },
  });
  return <div className="settings-stack">
    <div className="settings-intro"><div><h3>Connect your models</h3><p>One key enables extraction and semantic memory. Knowledge manages its internal Brain automatically. Your keys stay on this installation, not in Portal or your agent.</p></div><Tag>{status.data?.brain.status ?? "Owner access required"}</Tag></div>
    {status.error && <div className="notice" role="alert">Open Knowledge as its owner from Portal. For standalone administration, use the instance-authorized settings endpoint. Agent credentials cannot change model keys.</div>}
    {status.data?.configured && <p>Model settings are saved. Keys are never returned to this page. Enter replacement keys only when changing configuration.</p>}
    <TextField label="API key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} />
    <TextField label="Chat / extraction model" value={chatModel} onChange={event => setChatModel(event.target.value)} />
    <Button size="small" onClick={() => setAdvanced(value => !value)}>{advanced ? "Hide advanced settings" : "Custom or self-hosted models"}</Button>
    {advanced && <>
      <label><input type="checkbox" checked={local} onChange={event => setLocal(event.target.checked)} /> Ollama-compatible chat + llama-server embeddings</label>
      <TextField label="Chat API URL" value={chatUrl} onChange={event => setChatUrl(event.target.value)} />
      <TextField label="Embedding API URL" value={embedUrl} onChange={event => setEmbedUrl(event.target.value)} />
      <TextField label="Embedding API key (if different)" type="password" autoComplete="off" value={embedKey} onChange={event => setEmbedKey(event.target.value)} />
      <TextField label="Embedding model" value={embedModel} onChange={event => setEmbedModel(event.target.value)} />
      <TextField label="Embedding dimensions" type="number" value={dimensions} onChange={event => setDimensions(event.target.value)} />
      <p>Use only model servers you trust. Changing vector dimensions requires a deliberate migration, never a silent reset of your memories.</p>
    </>}
    <div><Button disabled={!key || save.isPending || !!status.error} onClick={() => save.mutate()}>{save.isPending ? "Checking models and starting memory…" : "Save and test connection"}</Button></div>
    {save.error && <div className="notice" role="alert">{save.error.message}. Existing settings are retained when a provider check fails.</div>}
    {save.data && <div className="notice" role="status">Model checks passed. Memory is {save.data.brain.status}. Connect your agent using its own scoped Knowledge credential—never this model key.</div>}
  </div>;
}
