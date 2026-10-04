import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import {
  AlertTriangle,
  BookOpen,
  Brain,
  ChevronRight,
  CircleUserRound,
  Clock3,
  FileText,
  Link2,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Button, Tag } from "@doppelganger/ui";
import {
  ApiError,
  brainContext,
  brainRecall,
  getBrainEntities,
  getBrainEntity,
} from "./api";
import type {
  BrainEntity,
  BrainEntityCard,
  BrainEntityDetail,
  BrainFact,
  BrainNativeEntityCard,
  BrainNativeEntityCardEnvelope,
  BrainProvenance,
  BrainRelationship,
  BrainResult,
  BrainTimelineEvent,
  FrontendBootstrap,
} from "./types";
import { errorTitle } from "./errors";

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

function displayDate(value: string | null | undefined) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString();
}

function entityLabel(entity: BrainEntity) {
  return entity.label || entity.title || entity.slug;
}

function cardLabel(card: BrainEntityCard | null) {
  return card?.title || card?.slug || "Entity";
}

function safeFactSource(fact: BrainFact): string | null {
  return fact.source || fact.sourceSession || null;
}

function factProvenance(facts: BrainFact[]): BrainProvenance[] {
  const seen = new Set<string>();
  return facts.flatMap((fact) => {
    const source = safeFactSource(fact);
    if (!source) return [];
    const key = `${source}:${fact.createdAt ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        source,
        sourceSession: fact.sourceSession ?? null,
        createdAt: fact.createdAt,
      },
    ];
  });
}

function nativeEntityCard(detail: BrainEntityDetail): BrainNativeEntityCard | null {
  const payload = detail.entityCard;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if ("entity" in payload) return payload as BrainNativeEntityCard;
  const envelope = payload as BrainNativeEntityCardEnvelope;
  return envelope.found ? envelope.card ?? null : null;
}

function normalizeEntityCard(detail: BrainEntityDetail): BrainEntityCard | null {
  if (detail.card) return detail.card;
  const native = nativeEntityCard(detail);
  if (!native?.entity) return null;
  return {
    slug: native.entity.slug,
    title: native.entity.title,
    type: native.entity.type,
    aliases: native.aka,
    summary: native.summary,
    updatedAt: native.last_touched.updated_at,
    lastRetrievedAt: native.last_touched.last_retrieved_at,
    lastTimelineDate: native.last_touched.last_timeline_date,
    openThreads: native.open_threads.flatMap((thread) =>
      typeof thread === "string"
        ? [thread]
        : typeof thread.title === "string"
          ? [thread.title]
          : [],
    ),
    backlinkCount: native.backlink_count,
    activeFactCount: native.active_fact_count,
  };
}

function normalizeFact(value: unknown, index: number): BrainFact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const fact = typeof row.fact === "string" ? row.fact : typeof row.gist === "string" ? row.gist : null;
  if (!fact) return null;
  const id = typeof row.id === "string" || typeof row.id === "number" ? row.id : `fact-${index}`;
  const number = (key: string) => typeof row[key] === "number" && Number.isFinite(row[key]) ? row[key] as number : null;
  const stringValue = (keys: string[]) => keys.map((key) => row[key]).find((item): item is string => typeof item === "string") ?? null;
  return {
    id,
    fact,
    kind: stringValue(["kind", "type"]),
    entitySlug: stringValue(["entitySlug", "entity_slug"]),
    confidence: number("confidence"),
    source: stringValue(["source", "source_uri"]),
    sourceSession: stringValue(["sourceSession", "source_session"]),
    createdAt: stringValue(["createdAt", "created_at"]),
    validFrom: stringValue(["validFrom", "valid_from"]),
    validUntil: stringValue(["validUntil", "valid_until"]),
  };
}

function recallRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["facts", "memories", "data", "results"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function normalizeFacts(detail: BrainEntityDetail): BrainFact[] {
  const direct = detail.facts ?? [];
  if (direct.length) return direct;
  return recallRows(detail.recall).map(normalizeFact).filter((item): item is BrainFact => item !== null);
}

function normalizeRelationships(detail: BrainEntityDetail): BrainRelationship[] {
  if (detail.relationships?.length) return detail.relationships;
  const cardEdges = nativeEntityCard(detail)?.edges ?? [];
  if (cardEdges.length) {
    return cardEdges.map((edge, index) => ({
      id: `${edge.type}:${edge.slug}:${index}`,
      type: edge.type,
      direction: edge.direction,
      targetSlug: edge.slug,
      context: edge.context,
    }));
  }
  const rawLinks = Array.isArray(detail.links)
    ? detail.links
    : detail.links && typeof detail.links === "object"
      ? Object.values(detail.links as Record<string, unknown>).find(Array.isArray) ?? []
      : [];
  return rawLinks.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const type = [row.link_type, row.type, row.relationshipType]
      .find((item): item is string => typeof item === "string" && item.length > 0) ?? null;
    const fromSlug = [row.from_slug, row.fromSlug]
      .find((item): item is string => typeof item === "string" && item.length > 0);
    const toSlug = [row.to_slug, row.toSlug]
      .find((item): item is string => typeof item === "string" && item.length > 0);
    const currentIsSource = fromSlug === detail.slug;
    const currentIsTarget = toSlug === detail.slug;
    const direction = currentIsSource && currentIsTarget
      ? "both"
      : currentIsSource
        ? "out"
        : currentIsTarget
          ? "in"
          : typeof row.direction === "string"
            ? row.direction
            : "out";
    const targetSlug = currentIsTarget && !currentIsSource
      ? fromSlug
      : currentIsSource && !currentIsTarget
        ? toSlug
        : [row.slug, row.targetSlug, row.target_slug, row.toSlug, row.to_slug, fromSlug, toSlug]
      .find((item): item is string => typeof item === "string" && item.length > 0);
    if (!type || !targetSlug) return [];
    return [{
      id: typeof row.id === "string" ? row.id : `${type}:${targetSlug}:${index}`,
      type,
      direction,
      targetSlug,
      targetLabel: typeof row.targetLabel === "string" ? row.targetLabel : null,
      context: typeof row.context === "string" ? row.context : null,
    }];
  });
}

function normalizeTimeline(detail: BrainEntityDetail): BrainTimelineEvent[] {
  const rawTimeline = Array.isArray(detail.timeline)
    ? detail.timeline
    : detail.timeline && typeof detail.timeline === "object"
      ? Object.values(detail.timeline as unknown as Record<string, unknown>).find(Array.isArray) ?? []
      : [];
  return rawTimeline.flatMap((event, index) => {
    if (!event || typeof event !== "object") return [];
    const row = event as unknown as Record<string, unknown>;
    const summary = typeof row.summary === "string" ? row.summary : typeof row.description === "string" ? row.description : null;
    if (!summary) return [];
    return [{
      id: typeof row.id === "string" ? row.id : `timeline-${index}`,
      date: typeof row.date === "string" ? row.date : typeof row.timestamp === "string" ? row.timestamp : null,
      summary,
      type: typeof row.type === "string" ? row.type : null,
      source: typeof row.source === "string" ? row.source : null,
    }];
  });
}

function ReadinessDiagnostics({
  status,
  degradedReason,
  source,
}: {
  status: string;
  degradedReason: string | null | undefined;
  source?: string;
}) {
  return (
    <details className="brain-diagnostics">
      <summary>Diagnostics</summary>
      <dl className="contract-list">
        <dt>Surface</dt>
        <dd>{status}</dd>
        {source && (
          <>
            <dt>Source</dt>
            <dd className="mono">{source}</dd>
          </>
        )}
        {degradedReason && (
          <>
            <dt>Reason</dt>
            <dd>{degradedReason}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

function capabilityStatus(
  envelope: { capabilities?: Record<string, { status: string; detail?: string | null }> } | undefined,
  key: string,
) {
  const status = envelope?.capabilities?.[key]?.status;
  if (!status) return "Unknown — not reported";
  if (status === "ready") return "Available";
  if (status === "unavailable") return "Unavailable";
  if (status === "limited") return "Limited";
  return status;
}

function readableMemory(value: unknown): { title: string; body: string; source: string | null } | null {
  if (typeof value === "string") return { title: "Memory", body: value, source: null };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const body = [record.fact, record.text, record.summary, record.content]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (!body) return null;
  const title = [record.title, record.kind, record.entitySlug]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0) ?? "Memory";
  const source = [record.source, record.sourceSession]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0) ?? null;
  return { title, body, source };
}

function QueryResult({ result }: { result: BrainResult }) {
  const envelope = result.memories && typeof result.memories === "object" ? result.memories as Record<string, unknown> : null;
  const rawMemories = Array.isArray(result.memories) ? result.memories : Array.isArray(envelope?.facts) ? envelope.facts : [];
  const contextRows = Array.isArray(result.answer) ? result.answer : [];
  const memories = [...rawMemories, ...contextRows].map(value => {
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      return readableMemory({ ...row, text: row.text ?? row.chunk_text ?? row.chunk ?? row.snippet });
    }
    return readableMemory(value);
  }).filter((item): item is NonNullable<typeof item> => item !== null);
  const answer =
    typeof result.answer === "string"
      ? result.answer
      : result.answer && typeof result.answer === "object"
        ? readableMemory(result.answer)?.body ?? null
        : null;
  const citations = result.citations.filter((citation): citation is Record<string, unknown> =>
    citation !== null && typeof citation === "object" && !Array.isArray(citation),
  );
  return (
    <section className="record-panel" aria-live="polite">
      {answer && (
        <div className="document-summary">
          <p className="eyebrow">Grounded context</p>
          <p>{answer}</p>
        </div>
      )}
      {memories.length > 0 && (
        <div className="timeline">
          {memories.map((memory, index) => (
            <article key={`${memory.title}-${index}`}>
              <span>{index + 1}</span>
              <div>
                <strong>{memory.title}</strong>
                <p>{memory.body}</p>
                {memory.source && <code>{memory.source}</code>}
              </div>
            </article>
          ))}
        </div>
      )}
      {citations.length > 0 && (
        <div className="tag-row">
          {citations.map((citation, index) => {
            const title = typeof citation.title === "string" ? citation.title : `Citation ${index + 1}`;
            const kind = typeof citation.kind === "string" ? citation.kind : "source";
            return <Tag key={`${title}-${index}`}>{kind}: {title}</Tag>;
          })}
        </div>
      )}
      {!answer && memories.length === 0 && citations.length === 0 && (
        <p className="muted-row">The query returned no displayable memories or citations.</p>
      )}
      <ReadinessDiagnostics status={result.status} degradedReason={result.degradedReason} />
    </section>
  );
}

function FactList({ facts }: { facts: BrainFact[] }) {
  if (!facts.length) return <p className="muted-row">No facts are visible for this entity.</p>;
  return (
    <div className="timeline">
      {facts.map((fact) => (
        <article key={String(fact.id)}>
          <span>{fact.kind || "fact"}</span>
          <div>
            <strong>{fact.fact}</strong>
            <p>
              {fact.confidence === null || fact.confidence === undefined
                ? "Confidence not supplied"
                : `Confidence ${Math.round(fact.confidence * 100)}%`}
            </p>
            <time>{displayDate(fact.createdAt)}</time>
          </div>
          <code>{safeFactSource(fact) || "Source not supplied"}</code>
        </article>
      ))}
    </div>
  );
}

function RelationshipList({ relationships }: { relationships: BrainRelationship[] }) {
  if (!relationships.length) return <p className="muted-row">No typed relationships are visible.</p>;
  return (
    <div className="timeline">
      {relationships.map((relationship, index) => (
        <article key={`${relationship.id ?? relationship.targetSlug}-${index}`}>
          <span><Link2 size={14} /></span>
          <div>
            <strong>{relationship.type}</strong>
            <p>
              {relationship.direction} → {relationship.targetLabel || relationship.targetSlug}
            </p>
            {relationship.context && <p>{relationship.context}</p>}
          </div>
          <code>{relationship.targetSlug}</code>
        </article>
      ))}
    </div>
  );
}

function TimelineList({ timeline }: { timeline: BrainTimelineEvent[] }) {
  if (!timeline.length) return <p className="muted-row">No timeline events are visible.</p>;
  return (
    <div className="timeline">
      {timeline.map((event, index) => (
        <article key={`${event.id ?? event.date ?? "event"}-${index}`}>
          <span><Clock3 size={14} /></span>
          <div>
            <strong>{event.type || "Event"}</strong>
            <p>{event.summary}</p>
          </div>
          <time>{displayDate(event.date)}</time>
        </article>
      ))}
    </div>
  );
}

function ProvenanceList({ provenance }: { provenance: BrainProvenance[] }) {
  if (!provenance.length) return <p className="muted-row">No provenance records were supplied.</p>;
  return (
    <div className="timeline">
      {provenance.map((record, index) => (
        <article key={`${record.source}-${record.createdAt ?? index}`}>
          <span><FileText size={14} /></span>
          <div>
            <strong>{record.source}</strong>
            <p>{record.sourceSession ? `Session ${record.sourceSession}` : "Source attribution supplied by the server."}</p>
          </div>
          <time>{displayDate(record.createdAt ?? record.observedAt)}</time>
        </article>
      ))}
    </div>
  );
}

export function BrainEntityRegister({
  entities,
  selectedSlug,
  onSelect,
  pagination,
  currentOffset,
  onPrevious,
  onNext,
  empty,
}: {
  entities: BrainEntity[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  pagination?: {
    limit: number;
    offset: number;
    returned: number;
    scanned: number;
    complete: boolean;
    hasMore: boolean | null;
    nextOffset?: number | null;
  };
  currentOffset: number;
  onPrevious: (offset: number) => void;
  onNext: (offset: number) => void;
  empty?: ReactNode;
}) {
  const nextOffset = pagination?.nextOffset ??
    (pagination && pagination.hasMore !== false && !pagination.complete && pagination.scanned > 0
      ? currentOffset + pagination.scanned
      : null);
  const previousOffset = currentOffset > 0
    ? Math.max(0, currentOffset - (pagination?.limit ?? currentOffset))
    : null;
  return (
    <>
      {entities.length ? <div className="entity-list">
        {entities.map((entity) => (
          <button
            key={entity.id || entity.slug}
            type="button"
            className="document-row"
            aria-current={selectedSlug === entity.slug}
            onClick={() => onSelect(entity.slug)}
          >
            <span className="document-row__icon"><CircleUserRound size={15} /></span>
            <span className="document-row__body">
              <span><strong>{entityLabel(entity)}</strong><time>{displayDate(entity.updatedAt)}</time></span>
              <small>{entity.type || "entity"} · {entity.factCount ?? "—"} facts</small>
              <p className="mono">{entity.slug}</p>
            </span>
            <ChevronRight size={14} />
          </button>
        ))}
      </div> : empty}
      {pagination && (
        <>
          <p className="muted-row">
            Scanned {pagination.scanned} native pages; {pagination.returned} match the entity filter
            {pagination.complete ? "; this window is complete." : "; the full register is not proven empty."}
          </p>
          <div className="dialog-actions" role="navigation" aria-label="Entity page navigation">
            <Button
              size="small"
              tone="ghost"
              disabled={previousOffset === null}
              onClick={() => previousOffset !== null && onPrevious(previousOffset)}
            >
              Previous
            </Button>
            <Button
              size="small"
              tone="ghost"
              disabled={nextOffset === null || nextOffset <= currentOffset}
              onClick={() => nextOffset !== null && nextOffset > currentOffset && onNext(nextOffset)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </>
  );
}

export function BrainEntityCardDetail({
  detail,
  isLoading,
  error,
  retry,
  initialTab = "facts",
}: {
  detail: BrainEntityDetail | undefined;
  isLoading: boolean;
  error: Error | null;
  retry: () => void;
  initialTab?: "facts" | "relationships" | "timeline" | "provenance";
}) {
  const [tab, setTab] = useState<string>(initialTab);
  if (error) return <ErrorNotice error={error} retry={retry} />;
  if (isLoading) return <Loading label="Reading entity card…" />;
  if (!detail) return <p className="muted-row">Select an entity to inspect its card.</p>;

  const facts = normalizeFacts(detail);
  const card = normalizeEntityCard(detail);
  const relationships = normalizeRelationships(detail);
  const timeline = normalizeTimeline(detail);
  const provenance = detail.provenance?.length ? detail.provenance : factProvenance(facts);
  return (
    <div>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Entity card</p>
          <h2>{cardLabel(card)}</h2>
          <span className="mono">{detail.slug}</span>
        </div>
        {card?.type && <Tag>{card.type}</Tag>}
      </div>
      {card ? (
        <div className="document-meta" style={{ padding: "0 17px 17px" }}>
          {card.summary && <p>{card.summary}</p>}
          {card.aliases.length > 0 && (
            <div className="tag-row">
              {card.aliases.map((alias) => <Tag key={alias}>{alias}</Tag>)}
            </div>
          )}
          <dl className="contract-list">
            <dt>Facts</dt><dd>{card.activeFactCount}</dd>
            <dt>Backlinks</dt><dd>{card.backlinkCount}</dd>
            <dt>Updated</dt><dd>{displayDate(card.updatedAt)}</dd>
          </dl>
        </div>
      ) : (
        <p className="muted-row">The server returned no entity card for this slug.</p>
      )}
      {detail.factsVisibility === "world_only" && (
        <div className="contract-gap" style={{ margin: "0 17px 17px" }}>
          <ShieldCheck size={15} />
          <div>
            <strong>Fact visibility is limited</strong>
            <p>Only shared facts are shown here. Private facts may exist even when this tab is empty.</p>
          </div>
        </div>
      )}
      <div className="record-tabs">
        <Tabs.Root value={tab} onValueChange={setTab}>
          <Tabs.List aria-label="Entity details">
            <Tabs.Trigger value="facts"><BookOpen size={14} />Facts <span>{facts.length}</span></Tabs.Trigger>
            <Tabs.Trigger value="relationships"><Link2 size={14} />Links <span>{relationships.length}</span></Tabs.Trigger>
            <Tabs.Trigger value="timeline"><Clock3 size={14} />Timeline <span>{timeline.length}</span></Tabs.Trigger>
            <Tabs.Trigger value="provenance"><FileText size={14} />Provenance <span>{provenance.length}</span></Tabs.Trigger>
          </Tabs.List>
          <div className="record-panel">
            <Tabs.Content value="facts"><FactList facts={facts} /></Tabs.Content>
            <Tabs.Content value="relationships"><RelationshipList relationships={relationships} /></Tabs.Content>
            <Tabs.Content value="timeline"><TimelineList timeline={timeline} /></Tabs.Content>
            <Tabs.Content value="provenance"><ProvenanceList provenance={provenance} /></Tabs.Content>
          </div>
        </Tabs.Root>
      </div>
      <ReadinessDiagnostics status={detail.status} degradedReason={detail.degradedReason} source={detail.source} />
    </div>
  );
}

export function BrainView({ bootstrap }: { bootstrap: FrontendBootstrap }) {
  const entityLimit = 50;
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"recall" | "context">("recall");
  const [result, setResult] = useState<BrainResult | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [entityOffset, setEntityOffset] = useState(0);
  const entities = useQuery({
    queryKey: ["brain-entities", entityOffset],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getBrainEntities({ signal, kind: "entities", limit: entityLimit, offset: entityOffset }),
    retry: false,
  });
  const detail = useQuery({
    queryKey: ["brain-entity", selectedSlug],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getBrainEntity(selectedSlug as string, { signal, depth: 2, direction: "both" }),
    enabled: Boolean(selectedSlug),
    retry: false,
  });
  useEffect(() => {
    setSelectedSlug(null);
  }, [entityOffset]);
  useEffect(() => {
    if (!selectedSlug && entities.data?.entities[0]) {
      setSelectedSlug(entities.data.entities[0].slug);
    }
  }, [entities.data?.entities, selectedSlug]);
  const run = useMutation({
    mutationFn: () =>
      mode === "recall"
        ? brainRecall(query.trim())
        : brainContext(query.trim()),
    onSuccess: setResult,
  });
  const gbrain = bootstrap.dependencies.gbrain ?? { status: "unavailable", configured: false };
  const engineReachable = gbrain.status === "online";
  const entityHeading = entities.error
    ? "Entity pages unavailable"
    : entities.isLoading
      ? "Loading entity pages…"
      : `${entities.data?.entities.length ?? 0} visible entities`;
  const extractionStatus = capabilityStatus(entities.data, "extraction");
  const semanticSearchStatus = capabilityStatus(entities.data, "semanticSearch");
  const entityPagination = entities.data?.pagination;
  const entityEmpty = entities.data?.status === "ready" && entityPagination?.complete === false
    ? "No entity pages are visible in this window. There may be more beyond it."
    : entities.data?.status === "ready"
      ? "The memory engine answered, but this workspace has no entities yet."
      : "The memory engine is running, but entity pages or extraction may not be available yet.";
  return (
    <section className="section-scroll">
      <SectionHeader eyebrow="Memory engine" title="Memory">
        Browse the people, projects, and facts Knowledge has learned from your
        documents. Your documents remain the source of truth.
      </SectionHeader>
      <div className={`dependency-banner ${engineReachable ? "is-online" : "is-degraded"}`}>
        <Brain size={20} />
        <div>
          <strong>{engineReachable ? "Memory engine running" : "Memory engine unavailable"}</strong>
          <p>
            {engineReachable
              ? "Entity pages, extraction, and semantic search report their own availability below."
              : (typeof gbrain.detail === "string" && gbrain.detail) ||
                "Documents and Research remain usable while memory is unavailable."}
          </p>
        </div>
        <Tag tone={engineReachable ? "success" : "warning"}>
          {gbrain.configured ? "Configured" : "Not configured"}
        </Tag>
      </div>
      <div className="posture-row" aria-label="Memory status">
        <div><Brain size={15} /><div><strong>Memory engine</strong><small>{engineReachable ? "Running" : "Unavailable"}</small></div></div>
        <div><CircleUserRound size={15} /><div><strong>Entity pages</strong><small>{capabilityStatus(entities.data, "pageEnumeration")}</small></div></div>
        <div><FileText size={15} /><div><strong>Extraction</strong><small>{extractionStatus}</small></div></div>
        <div><Search size={15} /><div><strong>Semantic search</strong><small>{semanticSearchStatus}</small></div></div>
      </div>
      <div className="brain-layout">
        <main>
          <section className="brain-query">
            <div className="segmented" aria-label="Memory query mode">
              <button className={mode === "recall" ? "is-active" : ""} onClick={() => setMode("recall")}>
                Recall
              </button>
              <button className={mode === "context" ? "is-active" : ""} onClick={() => setMode("context")}>
                Context
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (query.trim()) run.mutate();
              }}
            >
              <textarea
                aria-label="Memory query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search retained concepts, entities, and grounded context…"
              />
              <Button tone="primary" disabled={!query.trim() || run.isPending}>
                <Search size={14} />
                Run {mode}
              </Button>
            </form>
            {run.error && <ErrorNotice error={run.error} />}
            {result && <QueryResult result={result} />}
          </section>
          <section className="entity-panel" style={{ marginTop: 24 }}>
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Entities</p>
                <h2>{entityHeading}</h2>
              </div>
              <Tag>{entities.data?.facts ? `${entities.data.facts.length} facts in response` : "Entity pages"}</Tag>
            </div>
            {entities.error ? (
              <ErrorNotice error={entities.error} retry={() => entities.refetch()} />
            ) : entities.isLoading ? (
              <Loading label="Reading entity pages…" />
            ) : entities.data ? (
              <BrainEntityRegister
                entities={entities.data.entities}
                selectedSlug={selectedSlug}
                onSelect={setSelectedSlug}
                pagination={entityPagination}
                currentOffset={entityOffset}
                onPrevious={setEntityOffset}
                onNext={setEntityOffset}
                empty={
                  <div className="index-empty">
                    <Brain size={22} />
                    <strong>No visible entity pages</strong>
                    <span>{entityEmpty}</span>
                  </div>
                }
              />
            ) : (
              <div className="index-empty"><Brain size={22} /><strong>No entity page response</strong><span>Entity pages have not returned a response yet.</span></div>
            )}
          </section>
        </main>
        <aside className="entity-panel">
          <BrainEntityCardDetail
            key={selectedSlug ?? "empty"}
            detail={detail.data}
            isLoading={detail.isLoading}
            error={detail.error}
            retry={() => detail.refetch()}
          />
        </aside>
      </div>
      <div className="contract-gap">
        <ShieldCheck size={17} />
        <div>
          <strong>Read-only view</strong>
          <p>
            Fact extraction can't be started from this screen, and model keys
            stay on the server. Extraction: {extractionStatus}. Semantic
            search: {semanticSearchStatus}.
          </p>
        </div>
      </div>
    </section>
  );
}
