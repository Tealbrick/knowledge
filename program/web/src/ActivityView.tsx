import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Network, RefreshCw } from "lucide-react";
import { Button, EmptyState, Tag } from "@doppelganger/ui";
import { ApiError, getBindings, getEvents } from "./api";
import { errorTitle } from "./errors";

function date(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}
function ErrorNotice({ error, retry }: { error: Error; retry?: () => void }) {
  const status = error instanceof ApiError ? error.status : 0;
  const title = errorTitle(status);
  return (
    <div className="notice" role="alert">
      <AlertTriangle size={17} />
      <div>
        <strong>{title}</strong>
        <p>{error.message}</p>
      </div>
      {retry && (
        <Button size="small" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
function Loading({ label }: { label: string }) {
  return (
    <div className="loading-state">
      <RefreshCw className="spin" size={18} />
      <span>{label}</span>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  children: string;
  actions?: ReactNode;
}) {
  return (
    <header className="section-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

export function ActivityView() {
  const bindings = useQuery({
    queryKey: ["knowledge-bindings"],
    queryFn: getBindings,
    retry: false,
  });
  const events = useQuery({
    queryKey: ["knowledge-events"],
    queryFn: getEvents,
    refetchInterval: 10_000,
    retry: false,
  });
  return (
    <section className="section-scroll">
      <SectionHeader
        eyebrow="History"
        title="Activity"
      >
        Links between Knowledge records and other apps, and recent activity on
        this installation.
      </SectionHeader>
      <div className="activity-layout">
        <section>
          <div className="subheading">
            <div>
              <p className="eyebrow">Saved links</p>
              <h2>Linked records</h2>
            </div>
            <Tag>{bindings.data?.length ?? 0}</Tag>
          </div>
          {bindings.error ? (
            <ErrorNotice
              error={bindings.error}
              retry={() => bindings.refetch()}
            />
          ) : bindings.data?.length ? (
            <div className="binding-list">
              {bindings.data.map((binding) => (
                <article key={binding.bindingId}>
                  <Network size={16} />
                  <div>
                    <strong>
                      {binding.ownerPlugin} · {binding.ownerType}:
                      {binding.ownerId}
                    </strong>
                    <p>
                      {binding.relationshipType} → {binding.artifactType}:
                      {binding.artifactId}
                    </p>
                    <small>
                      {binding.summary || "No description"} ·{" "}
                      {date(binding.createdAt)}
                    </small>
                  </div>
                  <code>{binding.bindingId}</code>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="No linked records">
              No other app has linked a record to Knowledge yet. Connected apps
              and agents create these links through the Knowledge API.
            </EmptyState>
          )}
        </section>
        <section>
          <div className="subheading">
            <div>
              <p className="eyebrow">Since last restart</p>
              <h2>Recent events</h2>
            </div>
            <Tag>{events.data?.events.length ?? 0}</Tag>
          </div>
          {events.error ? (
            <ErrorNotice error={events.error} retry={() => events.refetch()} />
          ) : events.data?.events.length ? (
            <div className="event-list">
              {events.data.events.map((event) => (
                <article key={event.id}>
                  <span className="status-light" />
                  <div>
                    <strong>{event.type}</strong>
                    <time>{date(event.createdAt)}</time>
                  </div>
                  <pre>{JSON.stringify(event, null, 2)}</pre>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="No recent events">
              Recent activity is kept in memory and clears when Knowledge restarts.
            </EmptyState>
          )}
        </section>
      </div>
    </section>
  );
}
