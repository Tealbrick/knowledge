import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const virtualMock = vi.mock as unknown as (
  path: string,
  factory: () => unknown,
  options?: { virtual?: boolean },
) => void;
virtualMock("@doppelganger/ui", () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("button", props as Record<string, unknown>, children),
  Tag: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}), { virtual: true });

import {
  BrainEntityCardDetail,
  BrainEntityRegister,
  BrainView,
} from "./BrainView";
import type {
  BrainEntities,
  BrainEntityDetail,
  FrontendBootstrap,
} from "./types";

const entity = {
  id: "people/alice-example",
  slug: "people/alice-example",
  title: "Alice Example",
  type: "person",
  updatedAt: "2026-09-06T00:00:00.000Z",
};

const list: BrainEntities = {
  ok: true,
  status: "ready",
  degradedReason: null,
  kind: "entities",
  entities: [entity],
  selected: [entity],
  pagination: {
    limit: 50,
    offset: 0,
    returned: 1,
    scanned: 1,
    complete: false,
    hasMore: null,
  },
};

const nativeCard = {
  entity: { slug: entity.slug, title: entity.title, type: entity.type },
  aka: ["Alicia", "AE"],
  summary: "Privacy-safe synopsis",
  last_touched: {
    updated_at: entity.updatedAt,
    last_retrieved_at: null,
    last_timeline_date: null,
  },
  open_threads: [],
  edges: [
    { type: "works_at", direction: "out", slug: "companies/acme-example", context: "Current role" },
  ],
  backlink_count: 1,
  active_fact_count: 1,
};

const detail: BrainEntityDetail = {
  ok: true,
  status: "ready",
  degradedReason: null,
  source: "gbrain-adapter",
  slug: entity.slug,
  entityCard: nativeCard,
  timeline: [{ date: "2026-09-01", summary: "Joined Acme", source: "fixture" }],
  recall: {
    facts: [{
      id: "fact-1",
      fact: "Alice works at Acme.",
      kind: "role",
      entity_slug: entity.slug,
      confidence: 0.9,
      source: "meeting-1",
      created_at: "2026-09-01T00:00:00.000Z",
    }],
  },
  factsVisibility: "world_only",
};

const legacyEnvelopeDetail: BrainEntityDetail = {
  ...detail,
  entityCard: { protocol_version: 1, found: true, card: nativeCard },
};

const nativeLinksDetail: BrainEntityDetail = {
  ...detail,
  entityCard: { ...nativeCard, edges: [] },
  links: [
    {
      from_slug: entity.slug,
      to_slug: "companies/acme-example",
      link_type: "works_at",
      context: "Outgoing native link",
    },
    {
      from_slug: "companies/other-example",
      to_slug: entity.slug,
      link_type: "employs",
      context: "Incoming native link",
    },
  ],
};

const bootstrap: FrontendBootstrap = {
  ok: true,
  program: { id: "knowledge", name: "Knowledge", version: "test", environment: "test", status: "online" },
  subapps: {},
  dependencies: { gbrain: { status: "online", configured: true } },
  counts: {},
  authorization: {
    generalDomainBearerRequired: false,
    brainExtractFacts: "same-origin-or-gbrain-bearer",
    credentialExposedToBrowser: false,
  },
  surfaces: { standalone: "", embed: "", status: "", openapi: "", swagger: "" },
  scope: { defaultCompanyId: "default" },
  capabilities: {},
};

describe("Brain browser surface", () => {
  it("renders native card aliases, typed relationships, timeline, and world-only warning", () => {
    const factsHtml = renderToStaticMarkup(createElement(BrainEntityCardDetail, {
      detail,
      isLoading: false,
      error: null,
      retry: () => undefined,
    }));
    const linksHtml = renderToStaticMarkup(createElement(BrainEntityCardDetail, {
      detail,
      isLoading: false,
      error: null,
      retry: () => undefined,
      initialTab: "relationships",
    }));
    const timelineHtml = renderToStaticMarkup(createElement(BrainEntityCardDetail, {
      detail,
      isLoading: false,
      error: null,
      retry: () => undefined,
      initialTab: "timeline",
    }));
    expect(factsHtml).toContain("Alice Example");
    expect(factsHtml).toContain("Alicia");
    expect(factsHtml).toContain("Alice works at Acme.");
    expect(linksHtml).toContain("works_at");
    expect(timelineHtml).toContain("Joined Acme");
    expect(factsHtml).toContain("Fact visibility is limited");
  });

  it("keeps legacy entity-card envelopes readable while using the native unwrapped response", () => {
    const html = renderToStaticMarkup(createElement(BrainEntityCardDetail, {
      detail: legacyEnvelopeDetail,
      isLoading: false,
      error: null,
      retry: () => undefined,
    }));
    expect(html).toContain("Alicia");
    expect(html).toContain("Privacy-safe synopsis");
  });

  it("derives outgoing and incoming relationship targets from native link rows", () => {
    const html = renderToStaticMarkup(createElement(BrainEntityCardDetail, {
      detail: nativeLinksDetail,
      isLoading: false,
      error: null,
      retry: () => undefined,
      initialTab: "relationships",
    }));
    expect(html).toContain("works_at");
    expect(html).toContain("out → companies/acme-example");
    expect(html).toContain("employs");
    expect(html).toContain("in → companies/other-example");
  });

  it("marks the selected entity and preserves bounded-register truth", () => {
    const html = renderToStaticMarkup(createElement(BrainEntityRegister, {
      entities: list.entities,
      selectedSlug: entity.slug,
      onSelect: () => undefined,
      pagination: { limit: 50, offset: 0, returned: 1, scanned: 50, complete: false, hasMore: true },
      currentOffset: 0,
      onPrevious: () => undefined,
      onNext: () => undefined,
    }));
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Alice Example");
    expect(html).toContain("full register is not proven empty");
    expect(html).toContain("Next");
  });

  it("keeps navigation available for a zero-entity native page window", () => {
    const html = renderToStaticMarkup(createElement(BrainEntityRegister, {
      entities: [],
      selectedSlug: null,
      onSelect: () => undefined,
      empty: createElement("p", null, "No visible entity pages"),
      pagination: { limit: 50, offset: 50, returned: 0, scanned: 50, complete: false, hasMore: true },
      currentOffset: 50,
      onPrevious: () => undefined,
      onNext: () => undefined,
    }));
    expect(html).toContain("No visible entity pages");
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
  });

  it("advances by the native scan window and honors an explicit next offset", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const root = BrainEntityRegister({
      entities: list.entities,
      selectedSlug: entity.slug,
      onSelect: () => undefined,
      pagination: { limit: 50, offset: 100, returned: 1, scanned: 50, complete: false, hasMore: true },
      currentOffset: 100,
      onPrevious,
      onNext,
    }) as ReactElement<{ children?: ReactNode }>;
    const pagination = (root.props.children as ReactNode[])[1] as ReactElement<{ children?: ReactNode }>;
    const navigation = ((pagination.props.children as ReactNode[])[1]) as ReactElement<{
      children?: ReactNode;
    }>;
    const [previous, next] = navigation.props.children as ReactElement<{
      disabled?: boolean;
      onClick?: () => void;
    }>[];
    expect(previous.props.disabled).toBe(false);
    expect(next.props.disabled).toBe(false);
    next.props.onClick?.();
    previous.props.onClick?.();
    expect(onNext).toHaveBeenCalledWith(150);
    expect(onPrevious).toHaveBeenCalledWith(50);

    const explicitRoot = BrainEntityRegister({
      entities: list.entities,
      selectedSlug: entity.slug,
      onSelect: () => undefined,
      pagination: {
        limit: 50,
        offset: 100,
        returned: 1,
        scanned: 50,
        complete: false,
        hasMore: true,
        nextOffset: 175,
      },
      currentOffset: 100,
      onPrevious: () => undefined,
      onNext,
    }) as ReactElement<{ children?: ReactNode }>;
    const explicitPagination = (explicitRoot.props.children as ReactNode[])[1] as ReactElement<{
      children?: ReactNode;
    }>;
    const explicitNavigation = ((explicitPagination.props.children as ReactNode[])[1]) as ReactElement<{
      children?: ReactNode;
    }>;
    const explicitNext = (explicitNavigation.props.children as ReactElement<{
      onClick?: () => void;
    }>[]) [1];
    explicitNext.props.onClick?.();
    expect(onNext).toHaveBeenLastCalledWith(175);
  });

  it("renders unknown extraction and semantic-search status when the backend supplies no evidence", () => {
    const client = new QueryClient();
    client.setQueryData(["brain-entities", 0], list);
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client },
      createElement(BrainView, { bootstrap }),
    ));
    expect(html).toContain("Memory engine running");
    expect(html).toContain("Extraction");
    expect(html).toContain("Semantic search");
    expect(html).toContain("Unknown — not reported");
  });
});
