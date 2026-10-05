import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { SettingsPageView, type SettingsSection } from "./SettingsPageView";
import { describeErrorCode } from "./errors";
import type { FrontendBootstrap } from "./types";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Internal component, vendor and implementation names that must not reach customers. */
export const BANNED_COPY: Array<[RegExp, string]> = [
  [/Doppelganger/u, "legacy product name"],
  [/GBrain/u, "memory engine vendor name"],
  [/Open Notebook/u, "research engine vendor name"],
  [/\bProgram(?:-owned|-side)?\b/u, "internal runtime name"],
  [/Governed Knowledge/u, "internal governance jargon"],
  [/Knowledge spine/u, "internal architecture jargon"],
  [/Orchestration record/u, "internal architecture jargon"],
  [/[Cc]anonical/u, "internal data-model jargon"],
  [/\bprincipal\b/iu, "internal authorization jargon"],
  [/\bbearer\b/iu, "internal authorization jargon"],
  [/Micro-app/iu, "internal packaging name"],
];

/** Raw machine codes such as `invalid_model_settings` must be translated before display. */
const MACHINE_CODE = /\b[a-z]+(?:_[a-z0-9]+)+\b/u;

function visibleText(html: string) {
  const attributes = [...html.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]*)"/gu)].map((match) => match[1]);
  const text = html.replace(/<style[\s\S]*?<\/style>/gu, " ").replace(/<[^>]+>/gu, " ");
  return [text, ...attributes].join(" ").replace(/&#x27;|&#39;/gu, "'").replace(/&quot;/gu, '"').replace(/&amp;/gu, "&").replace(/\s+/gu, " ");
}

function expectCustomerCopy(text: string, where: string) {
  for (const [pattern, reason] of BANNED_COPY) {
    expect(text, `${where} contains ${reason}: ${text.match(pattern)?.[0]}`).not.toMatch(pattern);
  }
  expect(text, `${where} shows a raw machine code: ${text.match(MACHINE_CODE)?.[0]}`).not.toMatch(MACHINE_CODE);
}

const bootstrap: FrontendBootstrap = {
  ok: true,
  program: { id: "knowledge", name: "Knowledge", version: "0.1.0", environment: "production", status: "online" },
  subapps: {
    documents: { status: "online" },
    research: { status: "degraded", configured: false },
    brain: { status: "degraded" },
    orchestrator: { status: "online" },
  },
  dependencies: {
    gbrain: { status: "disabled", required: true, configured: false, tokenConfigured: false, detail: "GBrain autostart disabled" },
    rules: { status: "local", detail: "No central Rules binding is configured; standalone Knowledge-owned operations use local app authority." },
    workEthic: { status: "contract-only", detail: "Owner and generic binding contracts are available; remote Work Ethic reachability is not exposed." },
    knowledgeDb: { status: "configured", required: true },
    objectStore: { status: "configured", required: true },
  },
  counts: { documents: 0, researchNotebooks: 0 },
  authorization: { generalDomainBearerRequired: true, brainExtractFacts: "same-origin-or-gbrain-or-dedicated-extraction-bearer", credentialExposedToBrowser: false },
  surfaces: { standalone: "/", embed: "/embed", status: "/status", openapi: "/openapi.json", swagger: "/swagger.json" },
  scope: { defaultCompanyId: "default" },
  capabilities: { documents: true, research: true, brain: true, bindings: true },
};

function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  value.setQueryData(["knowledge-bootstrap"], bootstrap);
  value.setQueryData(["knowledge-openapi"], { paths: { "/api/knowledge/documents/{documentId}": { get: { summary: "Read a document" } } } });
  value.setQueryData(["knowledge-model-settings"], { configured: false, source: "environment-or-not-configured", brain: { status: "disabled" } });
  value.setQueryData(["knowledge-collections", "default"], []);
  value.setQueryData(["knowledge-search", "default", "", null], []);
  value.setQueryData(["knowledge-bindings"], []);
  value.setQueryData(["knowledge-events"], { ok: true, events: [] });
  return value;
}

function renderAt(search: string) {
  vi.stubGlobal("window", {
    location: { search, pathname: "/" },
    history: { replaceState: () => undefined, pushState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: client() }, createElement(App)));
}

afterEach(() => vi.unstubAllGlobals());

describe("customer-facing copy guard", () => {
  it.each(["?view=library", "?view=research", "?view=brain", "?view=activity"])("rendered %s uses customer wording", (search) => {
    const html = renderAt(search);
    expect(html).toContain("Teal Brick");
    expectCustomerCopy(visibleText(html), search);
  });

  it.each<SettingsSection>(["models", "runtime", "connections", "developer"])("rendered %s settings use customer wording", (section) => {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: client() },
      createElement(SettingsPageView, { bootstrap, companyId: "default", section, onCompanyId: () => undefined, onSectionChange: () => undefined, onNavigateLibrary: () => undefined })));
    const text = visibleText(html);
    expectCustomerCopy(text, `settings/${section}`);
    expect(text, "internal dependency ids are not shown").not.toMatch(/\b(?:gbrain|knowledgeDb|objectStore|workEthic|orchestrator)\b/u);
  });

  it("developer settings carry the version-control and server-managed connection notes", () => {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: client() },
      createElement(SettingsPageView, { bootstrap, companyId: "default", section: "developer", onCompanyId: () => undefined, onSectionChange: () => undefined, onNavigateLibrary: () => undefined })));
    expect(html).toContain("Version control");
    expect(html).toContain("Connections are managed on the server");
    expect(html).not.toContain(">Version control</button>");
  });

  it("source copy in components and the HTML shell avoids internal names", () => {
    const files = readdirSync(here).filter((name) => name.endsWith(".tsx") && !name.includes(".test."));
    expect(files.length).toBeGreaterThan(5);
    for (const name of [...files.map((file) => path.join(here, file)), path.join(here, "..", "index.html")]) {
      const source = readFileSync(name, "utf8")
        .split("\n")
        .filter((line) => !/^\s*import\s/u.test(line) && !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
        .join("\n")
        .replace(/@doppelganger\/ui/gu, "");
      for (const [pattern, reason] of BANNED_COPY.filter(([pattern]) => !pattern.source.includes("principal") && !pattern.source.includes("bearer"))) {
        expect(source, `${path.basename(name)} contains ${reason}`).not.toMatch(pattern);
      }
    }
  });

  it("translates raw error codes into sentences", () => {
    for (const code of ["invalid_model_settings", "settings_owner_required", "brain_start_failed", "browser_session_required", "embedding_migration_required", "provider_http_401", "knowledge_collection_not_found"]) {
      const message = describeErrorCode(code, 400);
      expect(message).not.toContain(code);
      expectCustomerCopy(message, code);
    }
    expect(describeErrorCode("brand_new_code", 500)).toMatch(/^Knowledge couldn't complete the request\. Try again shortly\. \(Reference: brand_new_code\)$/u);
    expect(describeErrorCode(null, 409)).toBe("This item changed since you opened it. Refresh and try again.");
  });
});
