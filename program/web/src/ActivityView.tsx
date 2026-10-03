import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Network, Plus, RefreshCw } from "lucide-react";
import { Button, EmptyState, Tag } from "@doppelganger/ui";
import { ApiError, getBindings, getEvents } from "./api";

function date(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}
function ErrorNotice({ error, retry }: { error: Error; retry?: () => void }) {
  const status = error instanceof ApiError ? error.status : 0;
  const title =
    status === 401
      ? "Authentication required"
      : status === 403
        ? "This operation is forbidden"
        : status === 409
          ? "The record changed"
          : status === 503
            ? "Dependency unavailable"
            : "Knowledge request failed";
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
        eyebrow="Orchestration record"
        title="Bindings & activity"
        actions={
          <Button size="small">
            <Plus size={14} />
            New binding
          </Button>
        }
      >
        Cross-application relationships and recent Program-side events, without
        claiming remote dependency health.
      </SectionHeader>
      <div className="activity-layout">
        <section>
          <div className="subheading">
            <div>
              <p className="eyebrow">Durable relationships</p>
              <h2>Bindings</h2>
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
                      {binding.summary || "No binding summary"} ·{" "}
                      {date(binding.createdAt)}
                    </small>
                  </div>
                  <code>{binding.bindingId}</code>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="No bindings">
              Knowledge has not recorded any generic cross-application
              relationships.
            </EmptyState>
          )}
        </section>
        <section>
          <div className="subheading">
            <div>
              <p className="eyebrow">Volatile ledger</p>
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
              This in-memory event ledger resets when the Program restarts.
            </EmptyState>
          )}
        </section>
      </div>
    </section>
  );
}
