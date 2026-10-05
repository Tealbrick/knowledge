import type { FrontendBootstrap } from "./types";

export type Tone = "success" | "warning" | "default";
export type ServiceAction = { label: string; section: "models" } | null;

/** A dependency or feature described for customers: name, state, and what to do next. */
export type ServiceView = {
  id: string;
  name: string;
  state: string;
  tone: Tone;
  detail: string;
  nextStep: string | null;
  action: ServiceAction;
};

type Dependency = FrontendBootstrap["dependencies"][string];

const humanize = (id: string) =>
  id.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").replace(/^./u, (first) => first.toUpperCase());

/** Memory engine (bundled GBrain) status in plain words, including setup guidance. */
export function describeMemory(dependency: Dependency | undefined): ServiceView {
  const status = dependency?.status ?? "unavailable";
  const detail = typeof dependency?.detail === "string" ? dependency.detail : "";
  const base = { id: "gbrain", name: "Memory engine", action: null as ServiceAction };
  if (status === "online") return { ...base, state: "Running", tone: "success", detail: "Learns from your documents and answers memory searches.", nextStep: null };
  if (status === "starting") return { ...base, state: "Starting", tone: "warning", detail: "The memory engine is starting up.", nextStep: "Wait a minute, then reload this page." };
  if (detail.startsWith("setup_required"))
    return { ...base, state: "Needs setup", tone: "warning", detail: "Memory needs a chat model and an embedding model before it can start.", nextStep: "Add your model keys in Settings → Models.", action: { label: "Open Models", section: "models" } };
  if (status === "disabled")
    return { ...base, state: "Off", tone: "warning", detail: "The memory engine is turned off on this installation. Documents and Research still work.", nextStep: "Connect your models in Settings → Models. If memory stays off, ask whoever deployed Knowledge to enable the memory engine.", action: { label: "Open Models", section: "models" } };
  return { ...base, state: "Not working", tone: "warning", detail: "The memory engine is not responding. Documents and Research still work.", nextStep: "Check your model settings, then the installation's logs if the problem continues.", action: { label: "Open Models", section: "models" } };
}

export function describeDependency(id: string, dependency: Dependency): ServiceView {
  const status = dependency.status;
  const ready = status === "online" || status === "configured";
  if (id === "gbrain") return describeMemory(dependency);
  if (id === "knowledgeDb")
    return ready
      ? { id, name: "Document database", state: "Ready", tone: "success", detail: "Stores your collections, documents and their history.", nextStep: null, action: null }
      : { id, name: "Document database", state: "Not set up", tone: "warning", detail: "Knowledge has no database configured, so documents cannot be saved.", nextStep: "Set a database path or URL in the deployment configuration, then restart Knowledge.", action: null };
  if (id === "objectStore")
    return ready
      ? { id, name: "File storage", state: "Ready", tone: "success", detail: "Stores attachments and imported files on this installation.", nextStep: null, action: null }
      : { id, name: "File storage", state: "Not working", tone: "warning", detail: "Attachments and imported files cannot be stored.", nextStep: "Check that the data volume is mounted and writable.", action: null };
  if (id === "rules") {
    if (status === "configured") return { id, name: "Approval rules", state: "Connected", tone: "success", detail: "Protected changes are checked against your organisation's approval rules.", nextStep: null, action: null };
    if (status === "unavailable") return { id, name: "Approval rules", state: "Not working", tone: "warning", detail: "Approval rules are required but not reachable, so protected changes are blocked.", nextStep: "Ask whoever deployed Knowledge to fix the approval rules connection.", action: null };
    return { id, name: "Approval rules", state: "Not used", tone: "default", detail: "This installation approves its own changes; no central approval rules are connected.", nextStep: null, action: null };
  }
  if (id === "workEthic")
    return { id, name: "Work item links", state: "Available", tone: "default", detail: "Other apps can link their work items to Knowledge records through the API.", nextStep: null, action: null };
  return {
    id,
    name: humanize(id),
    state: ready ? "Ready" : "Needs attention",
    tone: ready ? "success" : "warning",
    detail: dependency.configured ? "Set up on this installation." : "No further detail reported.",
    nextStep: null,
    action: null,
  };
}

const FEATURE_NAMES: Record<string, string> = {
  documents: "Library",
  research: "Research",
  brain: "Memory",
  orchestrator: "Activity and linked records",
};

/** Customer view of bootstrap.subapps; "degraded" becomes a reason and a next step. */
export function describeFeature(id: string, subapp: FrontendBootstrap["subapps"][string], memory: ServiceView): ServiceView {
  const name = FEATURE_NAMES[id] ?? humanize(id);
  if (subapp.status === "online") return { id, name, state: "Available", tone: "success", detail: "Working normally.", nextStep: null, action: null };
  if (id === "research")
    return subapp.configured
      ? { id, name, state: "Connected", tone: "default", detail: "Your Research sign-in decides which notebooks you can open.", nextStep: null, action: null }
      : { id, name, state: "Not connected", tone: "warning", detail: "The Research workspace is not connected to this installation. Older local research records are still readable.", nextStep: "Ask whoever deployed Knowledge to connect the Research workspace.", action: null };
  if (id === "brain")
    return { id, name, state: "Limited", tone: "warning", detail: `Memory search and fact extraction are unavailable: the memory engine is ${memory.state.toLowerCase()}.`, nextStep: memory.nextStep, action: memory.action };
  return { id, name, state: "Limited", tone: "warning", detail: "Some actions may be unavailable.", nextStep: null, action: null };
}

const CAPABILITY_NAMES: Array<[string, string]> = [
  ["documents", "Documents and collections"],
  ["fileIngest", "Import files"],
  ["repositoryIngest", "Sync documents from a repository"],
  ["research", "Research workspace"],
  ["brain", "Memory"],
  ["bindings", "Linked records from other apps"],
  ["revisionRestore", "Restore earlier document versions"],
];

export function describeCapabilities(capabilities: FrontendBootstrap["capabilities"]) {
  return CAPABILITY_NAMES.filter(([id]) => id in capabilities).map(([id, name]) => ({ id, name, available: capabilities[id] === true }));
}
