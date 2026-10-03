import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Code2, Copy, Database, GitBranch, Link2, ServerCog } from "lucide-react";
import { Button, Feedback, SettingsPage, Tag, TextField, SectionNavigation } from "@doppelganger/ui";
import { getOpenApi } from "./api";
import type { FrontendBootstrap } from "./types";
import { ModelSettingsPanel } from "./ModelSettingsPanel";

export type SettingsSection = "models" | "runtime" | "connections" | "developer" | "version-control";

const settingsSections: Array<{ id: SettingsSection; label: string; icon: typeof Database }> = [
  { id: "models", label: "Models", icon: ServerCog },
  { id: "runtime", label: "Runtime", icon: Database },
  { id: "connections", label: "Dependencies", icon: Link2 },
  { id: "developer", label: "Developer", icon: Code2 },
  { id: "version-control", label: "Version control", icon: GitBranch },
];

function RuntimeSettings({ bootstrap, companyId, scope, onScopeChange, onApply }: {
  bootstrap: FrontendBootstrap;
  companyId: string;
  scope: string;
  onScopeChange: (value: string) => void;
  onApply: () => void;
}) {
  return (
    <div className="settings-stack">
      <div className="settings-intro">
        <div>
          <h3>Program scope</h3>
          <p>Company scope changes relative Program reads. It does not grant access or switch an external runtime.</p>
        </div>
        <Tag tone={bootstrap.program.status === "online" ? "success" : "warning"}>{bootstrap.program.status}</Tag>
      </div>
      <div className="settings-scope-form">
        <TextField
          label="Company ID"
          description="Applied to the current route and preserved in the URL. This is a scope request, not an authorization grant."
          value={scope}
          onChange={(event) => onScopeChange(event.target.value)}
        />
        <Button size="small" disabled={!scope.trim() || scope.trim() === companyId} onClick={onApply}>Apply scope</Button>
      </div>
      <dl className="contract-list">
        <dt>Program</dt>
        <dd>{bootstrap.program.name} v{bootstrap.program.version}</dd>
        <dt>Environment</dt>
        <dd>{bootstrap.program.environment}</dd>
        <dt>General bearer required</dt>
        <dd>{bootstrap.authorization.generalDomainBearerRequired ? "Yes" : "No"}</dd>
        <dt>Fact extraction</dt>
        <dd>{bootstrap.authorization.brainExtractFacts}</dd>
        <dt>Credential exposed</dt>
        <dd>No</dd>
      </dl>
    </div>
  );
}

function DependenciesSettings({ bootstrap }: { bootstrap: FrontendBootstrap }) {
  return (
    <div className="settings-stack">
      <div className="settings-intro">
        <div>
          <h3>Program dependencies</h3>
          <p>These are status statements from Knowledge, not a browser-owned connection manager.</p>
        </div>
        <ServerCog />
      </div>
      <div className="dependency-list">
        {Object.entries(bootstrap.dependencies).map(([id, dependency]) => (
          <article key={id}>
            <span className={`status-light ${dependency.status === "online" || dependency.status === "configured" ? "" : "is-warning"}`} />
            <div>
              <strong>{id}</strong>
              <p>{dependency.detail || (dependency.configured ? "Configured by the Program runtime." : "No additional detail exposed.")}</p>
            </div>
            <Tag tone={dependency.status === "online" || dependency.status === "configured" ? "success" : "warning"}>{dependency.status}</Tag>
          </article>
        ))}
      </div>
      <div className="contract-gap">
        <AlertTriangle size={17} />
        <div>
          <strong>No browser pairing contract</strong>
          <p>Source credentials, Rules connections, Work Ethic reachability, and GBrain tokens remain server-side. Knowledge exposes no safe browser-managed pairing endpoint.</p>
        </div>
      </div>
    </div>
  );
}

function DeveloperSettings() {
  const [raw, setRaw] = useState(false);
  const openapi = useQuery({ queryKey: ["knowledge-openapi"], queryFn: getOpenApi, retry: false });
  const operations = useMemo(() => {
    const paths = (openapi.data?.paths ?? {}) as Record<string, Record<string, { summary?: string }>>;
    return Object.entries(paths).flatMap(([route, methods]) =>
      Object.entries(methods)
        .filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method))
        .map(([method, value]) => ({ method, route, summary: value.summary })),
    );
  }, [openapi.data]);
  if (openapi.isLoading) return <Feedback state="loading" title="Loading OpenAPI contract"><span>Reading the Program-owned developer surface.</span></Feedback>;
  if (openapi.error) return <Feedback state="error" title="Developer contract unavailable" action={<Button size="small" onClick={() => openapi.refetch()}>Retry</Button>}>{openapi.error.message}</Feedback>;
  return (
    <div className="settings-stack">
      <div className="settings-intro">
        <div>
          <h3>Developer contract</h3>
          <p>Available operations are derived from the Program-owned OpenAPI document.</p>
        </div>
        <div className="dialog-actions">
          <Button size="small" onClick={() => setRaw((value) => !value)}><Code2 size={13} />{raw ? "Operations" : "Raw JSON"}</Button>
          <Button size="small" disabled={!openapi.data} onClick={() => navigator.clipboard.writeText(JSON.stringify(openapi.data, null, 2))}><Copy size={13} />Copy</Button>
          <a className="dg-button dg-button--small" href="/swagger.json" download>Download</a>
        </div>
      </div>
      {raw ? <pre className="code-view">{JSON.stringify(openapi.data, null, 2)}</pre> : <div className="operations-list">{operations.map((operation) => <div key={`${operation.method}-${operation.route}`}><code className={`method method--${operation.method}`}>{operation.method}</code><code>{operation.route}</code><span>{operation.summary}</span></div>)}</div>}
    </div>
  );
}

function VersionControlSettings() {
  return (
    <div className="empty-settings">
      <GitBranch />
      <h3>No version-control endpoint</h3>
      <p>Knowledge exposes repository-backed document operations, but no repository status, branch, or worktree inspection contract. Those remain with the owning development workflow.</p>
      <Tag>Read surface unavailable</Tag>
    </div>
  );
}

export function SettingsPageView({ bootstrap, companyId, section, onCompanyId, onSectionChange, onNavigateLibrary }: {
  bootstrap: FrontendBootstrap;
  companyId: string;
  section: SettingsSection;
  onCompanyId: (value: string) => void;
  onSectionChange: (section: SettingsSection) => void;
  onNavigateLibrary: () => void;
}) {
  const [scope, setScope] = useState(companyId);
  useEffect(() => setScope(companyId), [companyId]);
  const content = section === "models" ? <ModelSettingsPanel /> : section === "runtime"
    ? <RuntimeSettings bootstrap={bootstrap} companyId={companyId} scope={scope} onScopeChange={setScope} onApply={() => onCompanyId(scope.trim())} />
    : section === "connections"
      ? <DependenciesSettings bootstrap={bootstrap} />
      : section === "developer"
        ? <DeveloperSettings />
        : <VersionControlSettings />;
  return (
    <SettingsPage title="Settings" description="Models, scope, dependencies, and agent access." actions={null}>
      <div className="settings-route">
        <div className="settings-route__back"><Button size="small" onClick={onNavigateLibrary}>← Library</Button></div>
        <SectionNavigation items={settingsSections.map(({ id, label, icon: Icon }) => ({ id, label, icon: <Icon /> }))} current={section} onSelect={onSectionChange} />
        <div className="settings-content"><section aria-label={`${section} settings`}>{content}</section></div>
      </div>
    </SettingsPage>
  );
}
