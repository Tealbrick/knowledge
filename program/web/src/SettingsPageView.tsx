import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Code2, Copy, Database, GitBranch, Link2, ServerCog } from "lucide-react";
import { Button, Feedback, SettingsPage, Tag, TextField, SectionNavigation } from "@doppelganger/ui";
import { getOpenApi } from "./api";
import type { FrontendBootstrap } from "./types";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { describeCapabilities, describeDependency, describeFeature, describeMemory, type ServiceView } from "./service-status";

export type SettingsSection = "models" | "runtime" | "connections" | "developer";

/** The one section every "Settings" entry point opens. Models is the first-run setup step. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "models";

export function parseSettingsSection(value: string | null): SettingsSection {
  // "version-control" links from earlier releases now open the Developer section.
  if (value === "version-control") return "developer";
  return value === "runtime" || value === "models" || value === "connections" || value === "developer" ? value : DEFAULT_SETTINGS_SECTION;
}

const settingsSections: Array<{ id: SettingsSection; label: string; icon: typeof Database }> = [
  { id: "models", label: "Models", icon: ServerCog },
  { id: "runtime", label: "Runtime", icon: Database },
  { id: "connections", label: "Dependencies", icon: Link2 },
  { id: "developer", label: "Developer", icon: Code2 },
];

function environmentLabel(environment: string) {
  if (environment === "production") return "Production";
  if (environment === "development") return "Development";
  if (environment === "test") return "Test";
  return environment || "Unknown";
}

function extractionLabel(mode: string) {
  if (mode === "same-origin-or-gbrain-or-dedicated-extraction-bearer") return "This app, the memory engine, and agents given an extraction credential";
  return "Configured on the server";
}

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
          <h3>Workspace</h3>
          <p>Choose which workspace this page shows. Switching workspace changes what you see here; it does not give you access to anything new.</p>
        </div>
        <Tag tone={bootstrap.program.status === "online" ? "success" : "warning"}>{bootstrap.program.status === "online" ? "Ready" : "Needs attention"}</Tag>
      </div>
      <div className="settings-scope-form">
        <TextField
          label="Workspace ID"
          description="Kept in this page's address so links and reloads open the same workspace."
          value={scope}
          onChange={(event) => onScopeChange(event.target.value)}
        />
        <Button size="small" disabled={!scope.trim() || scope.trim() === companyId} onClick={onApply}>Switch workspace</Button>
      </div>
      <dl className="contract-list">
        <dt>Version</dt>
        <dd>{bootstrap.program.name} {bootstrap.program.version}</dd>
        <dt>Environment</dt>
        <dd>{environmentLabel(bootstrap.program.environment)}</dd>
        <dt>Agents need their own credential</dt>
        <dd>{bootstrap.authorization.generalDomainBearerRequired ? "Yes — each agent signs in with a scoped Knowledge credential" : "No — this installation accepts requests without an agent credential"}</dd>
        <dt>Who can add facts to memory</dt>
        <dd>{extractionLabel(bootstrap.authorization.brainExtractFacts)}</dd>
        <dt>Keys visible in this browser</dt>
        <dd>Never — model and service keys stay on the server</dd>
      </dl>
    </div>
  );
}

function ServiceRow({ service, onAction }: { service: ServiceView; onAction: (section: SettingsSection) => void }) {
  return (
    <article>
      <span className={`status-light ${service.tone === "warning" ? "is-warning" : ""}`} />
      <div>
        <strong>{service.name}</strong>
        <p>{service.detail}</p>
        {service.nextStep && <p className="service-next-step"><span>Next step:</span> {service.nextStep}</p>}
        {service.action && <Button size="small" onClick={() => onAction(service.action!.section)}>{service.action.label}</Button>}
      </div>
      <Tag tone={service.tone}>{service.state}</Tag>
    </article>
  );
}

function DependenciesSettings({ bootstrap, onSectionChange }: { bootstrap: FrontendBootstrap; onSectionChange: (section: SettingsSection) => void }) {
  const memory = describeMemory(bootstrap.dependencies.gbrain);
  const services = Object.entries(bootstrap.dependencies).map(([id, dependency]) => describeDependency(id, dependency));
  const features = Object.entries(bootstrap.subapps ?? {}).map(([id, subapp]) => describeFeature(id, subapp, memory));
  const capabilities = describeCapabilities(bootstrap.capabilities ?? {});
  const attention = [...services, ...features].filter((entry) => entry.tone === "warning").length;
  return (
    <div className="settings-stack">
      <div className="settings-intro">
        <div>
          <h3>Services</h3>
          <p>The services Knowledge relies on, as reported by this installation.</p>
        </div>
        <Tag tone={attention ? "warning" : "success"}>{attention ? `${attention} need${attention === 1 ? "s" : ""} attention` : "All working"}</Tag>
      </div>
      <div className="dependency-list" aria-label="Services">
        {services.map((service) => <ServiceRow key={service.id} service={service} onAction={onSectionChange} />)}
      </div>
      {features.length > 0 && <>
        <h4 className="settings-subheading">Features</h4>
        <div className="dependency-list" aria-label="Features">
          {features.map((feature) => <ServiceRow key={feature.id} service={feature} onAction={onSectionChange} />)}
        </div>
      </>}
      {capabilities.length > 0 && <>
        <h4 className="settings-subheading">Included in this installation</h4>
        <ul className="capability-list" aria-label="Included in this installation">
          {capabilities.map((capability) => (
            <li key={capability.id}>
              <span>{capability.name}</span>
              <Tag tone={capability.available ? "success" : "default"}>{capability.available ? "Included" : "Not available"}</Tag>
            </li>
          ))}
        </ul>
      </>}
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
  if (openapi.isLoading) return <Feedback state="loading" title="Loading API reference"><span>Reading the list of available API operations.</span></Feedback>;
  if (openapi.error) return <Feedback state="error" title="API reference unavailable" action={<Button size="small" onClick={() => openapi.refetch()}>Retry</Button>}>{openapi.error.message}</Feedback>;
  return (
    <div className="settings-stack">
      <div className="settings-intro">
        <div>
          <h3>API reference</h3>
          <p>Operations available to agents and integrations, from this installation's OpenAPI document.</p>
        </div>
        <div className="dialog-actions">
          <Button size="small" onClick={() => setRaw((value) => !value)}><Code2 size={13} />{raw ? "Operations" : "Raw JSON"}</Button>
          <Button size="small" disabled={!openapi.data} onClick={() => navigator.clipboard.writeText(JSON.stringify(openapi.data, null, 2))}><Copy size={13} />Copy</Button>
          <a className="dg-button dg-button--small" href="/swagger.json" download>Download</a>
        </div>
      </div>
      {raw ? <pre className="code-view">{JSON.stringify(openapi.data, null, 2)}</pre> : <div className="operations-list">{operations.map((operation) => <div key={`${operation.method}-${operation.route}`}><code className={`method method--${operation.method}`}>{operation.method}</code><code>{operation.route}</code><span>{operation.summary}</span></div>)}</div>}
      <DeveloperNotes />
    </div>
  );
}

/** Integration limits that matter to developers, not to day-to-day users. */
function DeveloperNotes() {
  return (
    <div className="settings-stack developer-notes">
      <div className="contract-gap">
        <AlertTriangle size={17} />
        <div>
          <strong>Connections are managed on the server</strong>
          <p>Repository credentials, approval rules and memory-engine keys are configured on the installation, not in this browser. There is no in-browser pairing flow.</p>
        </div>
      </div>
      <div className="contract-gap">
        <GitBranch size={17} />
        <div>
          <strong>Version control</strong>
          <p>Repository-backed collections can import and write documents, but Knowledge does not show repository branches or status. Use your usual Git tools for that.</p>
        </div>
      </div>
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
      ? <DependenciesSettings bootstrap={bootstrap} onSectionChange={onSectionChange} />
      : <DeveloperSettings />;
  return (
    <SettingsPage title="Settings" description="Models, workspace, services, and developer tools." actions={null}>
      <div className="settings-route">
        <div className="settings-route__back"><Button size="small" onClick={onNavigateLibrary}>← Library</Button></div>
        <SectionNavigation items={settingsSections.map(({ id, label, icon: Icon }) => ({ id, label, icon: <Icon /> }))} current={section} onSelect={onSectionChange} />
        <div className="settings-content"><section aria-label={`${section} settings`}>{content}</section></div>
      </div>
    </SettingsPage>
  );
}
