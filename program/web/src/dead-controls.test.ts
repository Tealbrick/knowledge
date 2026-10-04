import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { ActivityView } from "./ActivityView";
import { LocalResearchView } from "./ResearchView";

const render = (client: QueryClient, element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, element));

function buttons(html: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)].map(([, attributes, body]) => ({
    disabled: /\sdisabled=""/u.test(attributes),
    label: body.replace(/<[^>]+>/gu, "").trim(),
  }));
}

describe("no dead controls", () => {
  it("Activity offers no binding button without a working form", () => {
    const client = new QueryClient();
    client.setQueryData(["knowledge-bindings"], []);
    client.setQueryData(["knowledge-events"], { ok: true, events: [] });
    const html = render(client, createElement(ActivityView));
    expect(buttons(html).map((button) => button.label)).not.toContain("New binding");
    expect(html).toContain("No linked records");
  });

  it("local research records have no permanently disabled Import or Draft actions", () => {
    const client = new QueryClient();
    const notebook = { id: "nb-1", companyId: "default", title: "Local notes", slug: null, summary: null, focusPrompt: null, status: "active", createdAt: "", updatedAt: "" };
    client.setQueryData(["research-summary", "default"], { companyId: "default", notebooks: [notebook], counts: { notebooks: 1, sources: 0 }, activeNotebookId: "nb-1", posture: {} });
    client.setQueryData(["research-notebooks", "default"], [notebook]);
    client.setQueryData(["research-workspace", "nb-1"], { ...notebook, sources: [], entries: [], outputs: [], linkedDocuments: [] });
    const html = render(client, createElement(LocalResearchView, { companyId: "default" }));
    expect(html).toContain("Local sources");
    expect(html).toContain("Outputs");
    const labels = buttons(html);
    expect(labels.some((button) => /Import|Draft/u.test(button.label))).toBe(false);
    expect(labels.filter((button) => button.disabled && !/Ask/u.test(button.label))).toEqual([]);
  });

  it("an empty local research list does not tell people to create something it cannot create", () => {
    const client = new QueryClient();
    client.setQueryData(["research-summary", "default"], { companyId: "default", notebooks: [], counts: { notebooks: 0, sources: 0 }, activeNotebookId: null, posture: {} });
    client.setQueryData(["research-notebooks", "default"], []);
    const html = render(client, createElement(LocalResearchView, { companyId: "default" }));
    expect(html).not.toMatch(/Create (one|a notebook)/u);
    expect(html).toContain("Research workspace above");
  });
});
