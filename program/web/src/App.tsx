import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Settings } from "lucide-react";
import { BrandMark, Button, Feedback, IconButton, Sidebar, Tag } from "@doppelganger/ui";
import { getBootstrap, getSessionEnded, subscribeSessionEnded } from "./api";
import { SessionEndedBanner, SessionEndedSplash } from "./SessionNotice";
import type { Section } from "./types";
import { ActivityView } from "./ActivityView";
import { BrainView } from "./BrainView";
import { LibraryView } from "./LibraryView";
import { ResearchView } from "./ResearchView";
import { SettingsPageView, type SettingsSection } from "./SettingsPageView";

const nav: Array<{ id: Section; label: string }> = [
  { id: "library", label: "Library" },
  { id: "research", label: "Research" },
  { id: "brain", label: "Brain" },
  { id: "activity", label: "Bindings & activity" },
];

type AppRoute =
  | { kind: "section"; section: Section; companyId: string }
  | { kind: "settings"; section: SettingsSection; companyId: string };

const defaultCompanyId = "default";

function readRoute(): AppRoute {
  const query = new URLSearchParams(window.location.search);
  const companyId = query.get("companyId")?.trim() || defaultCompanyId;
  const view = query.get("view");
  if (view === "settings") {
    const section = query.get("section");
    const settingsSection: SettingsSection = section === "runtime" || section === "models" || section === "connections" || section === "developer" || section === "version-control"
      ? section
      : "models";
    return { kind: "settings", section: settingsSection, companyId };
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
    return <div className="splash"><Feedback state="loading" title="Opening Knowledge">Loading the Program-owned surface.</Feedback></div>;
  if (bootstrap.error)
    return <div className="splash"><Feedback state="error" title="Knowledge is unavailable" action={<Button onClick={() => bootstrap.refetch()}>Retry</Button>}>{bootstrap.error.message}</Feedback></div>;
  if (!bootstrap.data) return null;
  const connected = bootstrap.data.program.status === "online";
  const currentSection = route.kind === "section" ? route.section : null;
  const sidebarItems = [...nav.map((entry) => ({
    id: entry.id,
    label: entry.label,
    href: routeHref({ kind: "section", section: entry.id, companyId }),
    current: currentSection === entry.id,
  })), {
    id: "settings",
    label: "Settings",
    href: routeHref({ kind: "settings", section: "runtime", companyId }),
    current: route.kind === "settings",
  }];
  const settingsToggle = route.kind === "settings"
    ? { kind: "section" as const, section: "library" as const, companyId }
    : { kind: "settings" as const, section: "runtime" as const, companyId };
  return (
    <main className="app-shell">
      <Sidebar
        label="Knowledge navigation"
        brand={<>
          <BrandMark />
          <span>
            <strong>Knowledge</strong>
            <small>Doppelganger</small>
          </span>
        </>}
        items={sidebarItems}
        footer={<>
          <div className="scope-card">
            <p className="eyebrow">Active scope</p>
            <strong>{companyId}</strong>
            <span>
              {bootstrap.data.counts.documents ?? 0} documents ·{" "}
              {bootstrap.data.counts.researchNotebooks ?? 0} notebooks
            </span>
          </div>
          <div className="sidebar-status">
            <span className={`status-light ${connected ? "" : "is-warning"}`} />
            <span>{connected ? "Program online" : "Program degraded"}</span>
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
            <code>{companyId}</code>
          </div>
          <div>
            <Tag
              tone={
                bootstrap.data.dependencies.gbrain?.status === "online"
                  ? "success"
                  : "warning"
              }
            >
              GBrain {bootstrap.data.dependencies.gbrain?.status}
            </Tag>
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
            {route.section === "brain" && <BrainView bootstrap={bootstrap.data} />}
            {route.section === "activity" && <ActivityView />}
          </>
        )}
      </section>
    </main>
  );
}
