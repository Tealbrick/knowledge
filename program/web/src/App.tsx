import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Settings } from "lucide-react";
import { BrandMark, Button, Feedback, IconButton, SelectField, Sidebar, Tag } from "@tealbrick/ui";
import { getBootstrap, getSessionEnded, subscribeSessionEnded } from "./api";
import { SessionEndedBanner, SessionEndedSplash } from "./SessionNotice";
import type { Section } from "./types";
import { ActivityView } from "./ActivityView";
import { BrainView } from "./BrainView";
import { LibraryView } from "./LibraryView";
import { ResearchView } from "./ResearchView";
import { DEFAULT_SETTINGS_SECTION, parseSettingsSection, SettingsPageView, workspaceDisplayName, type SettingsSection } from "./SettingsPageView";
import { describeMemory } from "./service-status";
import { getPartitions, partitionKeyOf, partitionOptions } from "./partitions";

const nav: Array<{ id: Section; label: string }> = [
  { id: "library", label: "Library" },
  { id: "research", label: "Research" },
  { id: "brain", label: "Memory" },
  { id: "activity", label: "Activity" },
];

type AppRoute =
  | { kind: "section"; section: Section; companyId: string }
  | { kind: "settings"; section: SettingsSection; companyId: string };

const defaultCompanyId = "default";

function capabilityFor(section: Section): string | undefined {
  return section === "library" ? "documents" : section === "brain" ? "brain" : section === "research" ? "research" : section === "activity" ? "bindings" : undefined;
}

/** Plain status wording for the memory engine badge. */
/**
 * A memory engine that simply has not been set up yet is a next step, not an error:
 * only a failing engine uses the warning tone.
 */
export function memoryBadgeFor(memory: { state: string }): { label: string; tone: "success" | "default" | "warning"; sidebar?: string } {
  if (memory.state === "Running") return { label: "Memory ready", tone: "success" };
  if (memory.state === "Needs setup" || memory.state === "Off") return { label: "Set up memory", tone: "default", sidebar: "Set up" };
  if (memory.state === "Starting") return { label: "Memory starting", tone: "default", sidebar: "Starting" };
  return { label: "Memory unavailable", tone: "warning", sidebar: "Issue" };
}

export function memoryLabel(status: string | undefined) {
  if (status === "online") return "Memory ready";
  if (status === "starting") return "Memory starting";
  if (status === "disabled") return "Memory off";
  return "Memory unavailable";
}

function readRoute(): AppRoute {
  const query = new URLSearchParams(window.location.search);
  const companyId = query.get("companyId")?.trim() || defaultCompanyId;
  const view = query.get("view");
  if (view === "settings") {
    return { kind: "settings", section: parseSettingsSection(query.get("section")), companyId };
  }
  const section = view === "research" || view === "brain" || view === "activity" ? view : "library";
  return { kind: "section", section, companyId };
}

function routeHref(route: AppRoute) {
  const base = window.location.pathname === "/embed" || window.location.pathname.startsWith("/embed/") ? "/embed" : "/";
  const query = new URLSearchParams({
    view: route.kind === "settings" ? "settings" : route.section,
    companyId: route.companyId,
  });
  if (route.kind === "settings") query.set("section", route.section);
  return `${base}?${query.toString()}`;
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => readRoute());
  const bootstrap = useQuery({
    queryKey: ["knowledge-bootstrap"],
    queryFn: getBootstrap,
  });
  // Owner selector for per-edge memory partitions (workspace default plus partitions in use).
  const workspaceScope = bootstrap.data?.scope.defaultCompanyId?.trim() || defaultCompanyId;
  const partitions = useQuery({
    queryKey: ["knowledge-partitions", workspaceScope],
    queryFn: () => getPartitions(workspaceScope),
    enabled: Boolean(bootstrap.data),
    retry: false,
  });
  const sessionEnded = useSyncExternalStore(subscribeSessionEnded, getSessionEnded, getSessionEnded);
  const reload = () => window.location.reload();
  const companyId = route.companyId;
  useEffect(() => {
    const discovered = bootstrap.data?.scope.defaultCompanyId?.trim();
    const hasExplicitCompanyId = new URLSearchParams(window.location.search).has("companyId");
    if (!discovered || hasExplicitCompanyId || route.companyId !== defaultCompanyId || discovered === defaultCompanyId) return;
    const next = { ...route, companyId: discovered };
    window.history.replaceState({}, "", routeHref(next));
    setRoute(next);
  }, [bootstrap.data?.scope.defaultCompanyId, route]);
  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = (next: AppRoute, replace = false) => {
    window.history[replace ? "replaceState" : "pushState"]({}, "", routeHref(next));
    setRoute(next);
  };
  if (sessionEnded && !bootstrap.data) return <SessionEndedSplash onReload={reload} />;
  if (bootstrap.isLoading)
    return <div className="splash"><Feedback state="loading" title="Opening Knowledge">Loading your documents and memory.</Feedback></div>;
  if (bootstrap.error)
    return <div className="splash"><Feedback state="error" title="Knowledge is unavailable" action={<Button onClick={() => bootstrap.refetch()}>Retry</Button>}>{bootstrap.error.message}</Feedback></div>;
  if (!bootstrap.data) return null;
  const connected = bootstrap.data.program.status === "online";
  const currentSection = route.kind === "section" ? route.section : null;
  const memory = describeMemory(bootstrap.data.dependencies.gbrain);
  const workspaceName = workspaceDisplayName(bootstrap.data, companyId);
  const scopeOptions = partitionOptions(workspaceScope, partitions.data, companyId);
  const selectedPartition = partitionKeyOf(workspaceScope, companyId) ? companyId : undefined;
  const memoryBadge = memoryBadgeFor(memory);
  const capabilities = bootstrap.data.capabilities ?? {};
  const sidebarItems = [...nav.map((entry) => ({
    id: entry.id,
    label: entry.label,
    href: routeHref({ kind: "section", section: entry.id, companyId }),
    current: currentSection === entry.id,
    // A feature the installation reports as not included cannot be opened.
    unavailable: capabilityFor(entry.id) !== undefined && capabilities[capabilityFor(entry.id)!] === false,
    badge: entry.id === "brain" ? memoryBadge.sidebar : undefined,
  })), {
    id: "settings",
    label: "Settings",
    href: routeHref({ kind: "settings", section: DEFAULT_SETTINGS_SECTION, companyId }),
    current: route.kind === "settings",
  }];
  const settingsToggle = route.kind === "settings"
    ? { kind: "section" as const, section: "library" as const, companyId }
    : { kind: "settings" as const, section: DEFAULT_SETTINGS_SECTION, companyId };
  return (
    <main className="app-shell">
      <Sidebar
        label="Knowledge navigation"
        brand={<>
          <BrandMark />
          <span>
            <strong>Knowledge</strong>
            <small>Teal Brick</small>
          </span>
        </>}
        items={sidebarItems}
        footer={<>
          <div className="scope-card">
            <p className="eyebrow">Workspace</p>
            <strong title={companyId}>{workspaceName}</strong>
            <span>
              {bootstrap.data.counts.documents ?? 0} documents ·{" "}
              {bootstrap.data.counts.researchNotebooks ?? 0} notebooks
            </span>
            {scopeOptions.length > 1 && (
              <SelectField
                label="Memory partition"
                value={companyId}
                onChange={(event) => navigate({ ...route, companyId: event.target.value })}
              >
                {scopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </SelectField>
            )}
          </div>
          <div className="sidebar-status">
            <span className={`status-light ${connected ? "" : "is-warning"}`} />
            <span>{connected ? "Knowledge is ready" : "Knowledge needs attention"}</span>
            <IconButton
              aria-label={route.kind === "settings" ? "Back to library" : "Open settings"}
              onClick={() => navigate(settingsToggle)}
            >
              {route.kind === "settings" ? <BookOpen size={16} /> : <Settings size={16} />}
            </IconButton>
          </div>
        </>}
      />
      <section className="application-frame">
        {sessionEnded && <SessionEndedBanner onReload={reload} />}
        <header className="topbar">
          <div>
            <strong>{route.kind === "settings" ? "Settings" : nav.find((entry) => entry.id === route.section)?.label}</strong>
            <span className="slash">/</span>
            <span className="topbar-workspace" title={companyId}>{workspaceName}</span>
          </div>
          <div>
            <button
              type="button"
              className="memory-status"
              title={[memory.detail, memory.nextStep].filter(Boolean).join(" ")}
              onClick={() => navigate({ kind: "settings", section: memory.action?.section ?? "connections", companyId })}
            >
              <Tag tone={memoryBadge.tone}>{memoryBadge.label}</Tag>
            </button>
            <Button size="small" onClick={() => navigate(settingsToggle)}>
              {route.kind === "settings" ? <BookOpen size={14} /> : <Settings size={14} />}
              {route.kind === "settings" ? "Library" : "Settings"}
            </Button>
          </div>
        </header>
        {route.kind === "settings" ? (
          <section className="section-scroll settings-scroll">
            <SettingsPageView
              bootstrap={bootstrap.data}
              companyId={companyId}
              section={route.section}
              onCompanyId={(value) => navigate({ ...route, companyId: value }, true)}
              onSectionChange={(section) => navigate({ ...route, section }, true)}
              onNavigateLibrary={() => navigate({ kind: "section", section: "library", companyId })}
            />
          </section>
        ) : (
          <>
            {route.section === "library" && <LibraryView companyId={companyId} />}
            {route.section === "research" && <ResearchView companyId={companyId} />}
            {route.section === "brain" && <BrainView key={companyId} bootstrap={bootstrap.data} partitionKey={selectedPartition} />}
            {route.section === "activity" && <ActivityView />}
          </>
        )}
      </section>
    </main>
  );
}
