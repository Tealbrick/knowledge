import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startFakeGBrainService } from "../scripts/fixtures/fake-engines.mjs";
import { buildKnowledgeApp } from "./app.js";
import { NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL } from "./brain-native-routes.js";
import { loadConfig } from "./config.js";
import { gbrainServiceExposure } from "./engine-exposure.js";
import { GBRAIN_LONG_OPERATIONS, GBrainRuntime, gbrainServiceArgumentRefusal } from "./gbrain.js";
import { GBrainServiceConnection } from "./gbrain-service.js";

const admin = "gbrain-admin-token-fixture-0123456789abcd";
let fake: Awaited<ReturnType<typeof startFakeGBrainService>>;
let dataDir: string;
beforeAll(async () => {
  fake = await startFakeGBrainService({ adminToken: admin, tools: [...gbrainServiceExposure().exposed.keys()] });
  dataDir = mkdtempSync(path.join(os.tmpdir(), "native-guards-"));
});
afterAll(async () => { await fake.close(); rmSync(dataDir, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const REFUSED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["search_by_image", { image_url: "/etc/hosts" }],
  ["search_by_image", { image_url: "file:///etc/hosts" }],
  ["search_by_image", { image_url: "ftp://example.test/a.png" }],
  ["search_by_image", { image_url: "FILE:///etc/hosts" }],
  ["search_by_image", { image_url: "File:///etc/hosts" }],
  ["search_by_image", { image_url: " https://example.test/a.png" }],
  ["search_by_image", { image_url: "https://example.test/a.png\n" }],
  ["search_by_image", { image_url: "\thttps://example.test/a.png" }],
  ["search_by_image", { image_url: "HTTPS://example.test/a.png" }],
  ["search_by_image", { image_url: "~/secret.png" }],
  ["search_by_image", { image_url: "../../etc/hosts" }],
  ["search_by_image", { image_url: "./a.png" }],
  ["search_by_image", { image_url: "https:/etc/hosts" }],
  ["search_by_image", { image_url: "https:///etc/hosts" }],
  ["search_by_image", { image_url: "https:\\\\host\\a.png" }],
  ["search_by_image", { image_url: "%2Fetc%2Fhosts" }],
  ["search_by_image", { image_url: "file%3A%2F%2F%2Fetc%2Fhosts" }],
  ["search_by_image", { image_url: "\\\\host\\share\\a.png" }],
  ["search_by_image", { image_url: "data:image/png;base64,aGk=" }],
  ["search_by_image", { image_url: "javascript:alert(1)" }],
  ["search_by_image", { image_url: "C:\\Windows\\win.ini" }],
  ["search_by_image", { image_url: 42 }],
  ["query", { query: "x", image_url: "/etc/hosts" }],
  ["search_by_image", { image_path: "/etc/hosts" }],
  ["think", { question: "x", model: "claude-cli" }],
  ["synthesize", { question: "x", model: "gpt-5" }],
  ["think", { question: "x", save: true }],
  ["think", { question: "x", take: { claim: "x" } }],
  ["request_tools", { surface: "full" }],
  ["ontology_propose", { entity: "e", dimension: "d", value: "v", visibility: "private" }],
  ["get_calibration_profile", { holder: "people/charlie-example" }],
  ["get_calibration_profile", { holder: "self" }],
  ["extract_facts", { turn_text: "x", visibility: "private" }],
  ["capture", { local_file: "/etc/passwd" }],
  ["put_page", { slug: "knowledge-docs/doc-1", content: "x" }],
  ["query", { query: "x", source_id: "kb-000000000000000000000000" }],
];

describe("GBrain service argument refusals at the Knowledge boundary", () => {
  it("refuses host-file, model-selection, persistence, surface, private and holder arguments", () => {
    for (const [op, args] of REFUSED) expect(gbrainServiceArgumentRefusal(op, args), `${op} ${JSON.stringify(args)}`).not.toBeNull();
    for (const [op, args] of [
      ["search_by_image", { image_url: "https://example.test/a.png" }],
      ["search_by_image", { image_data: "aGk=", image_mime: "image/png" }],
      ["think", { question: "x", save: false, take: false }],
      ["think", { question: "x" }],
      ["synthesize", { question: "x" }],
      ["ontology_propose", { entity: "e", dimension: "d", value: "v", visibility: "world" }],
      ["get_calibration_profile", {}],
      ["put_page", { slug: "notes/agent", content: "x" }],
    ] as const) expect(gbrainServiceArgumentRefusal(op, args as Record<string, unknown>), `${op} ${JSON.stringify(args)}`).toBeNull();
  });

  it("answers argument_refused without contacting upstream", async () => {
    const runtime = new GBrainRuntime(loadConfig({ environment: "test", config: { dataDir, gbrainServiceUrl: fake.baseUrl, gbrainServiceAdminToken: admin } }));
    await runtime.start();
    const before = fake.calls.length;
    for (const [op, args] of REFUSED) {
      if (!runtime.nativeOperationPolicy(op)) continue; // request_tools stays excluded
      expect(await runtime.nativeOperation(op, args, "fixture-a", "agent"), op).toMatchObject({ ok: false, error: { error: "argument_refused" } });
    }
    expect(runtime.nativeOperationPolicy("request_tools")).toBeNull();
    expect(fake.calls.length).toBe(before);
    expect((await runtime.nativeOperation("search_by_image", { image_url: "https://example.test/a.png" }, "fixture-a", "agent")).ok).toBe(true);
  });

  it("bounds upstream time: 60 s for ordinary operations, 300 s only for documented long ones", async () => {
    const runtime = new GBrainRuntime(loadConfig({ environment: "test", config: { dataDir, gbrainServiceUrl: fake.baseUrl, gbrainServiceAdminToken: admin } }));
    await runtime.start();
    const call = vi.spyOn(GBrainServiceConnection.prototype, "call");
    await runtime.nativeOperation("get_tags", {}, "fixture-a", "agent");
    await runtime.nativeOperation("think", { question: "x" }, "fixture-a", "agent");
    expect(call.mock.calls.map(args => args[3]?.timeoutMs)).toEqual([60_000, 300_000]);
    expect([...GBRAIN_LONG_OPERATIONS].every(name => runtime.nativeOperationPolicy(name))).toBe(true);
  });
});

describe("native route resource bounds", () => {
  it(`caps each principal at ${NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL} operations in flight (429 beyond)`, async () => {
    const releases: Array<() => void> = [];
    vi.spyOn(GBrainRuntime.prototype, "nativeOperation").mockImplementation(() => new Promise(resolve => releases.push(() => resolve({ ok: true, data: {} }))));
    const app = await buildKnowledgeApp({ environment: "test", config: { gbrainAutoStart: false, knowledgeServicePrincipals: [
      { token: "fixture-reader", principalId: "reader", companyId: "fixture-a", capabilities: ["brain:read"] },
      { token: "fixture-other", principalId: "other", companyId: "fixture-a", capabilities: ["brain:read"] },
    ] } });
    try {
      const recall = (token: string) => app.inject({ method: "POST", url: "/api/brain/native/recall", headers: { authorization: `Bearer ${token}` }, payload: { partitionKey: "fixture-a", arguments: {} } });
      const running = Array.from({ length: NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL }, () => recall("fixture-reader"));
      await vi.waitFor(() => expect(releases).toHaveLength(NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL));
      const over = await recall("fixture-reader");
      expect(over.statusCode).toBe(429);
      expect(over.json()).toMatchObject({ ok: false, error: "too_many_requests" });
      // Another principal is not starved by the first one.
      const other = recall("fixture-other");
      await vi.waitFor(() => expect(releases).toHaveLength(NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL + 1));
      releases.forEach(release => release());
      expect((await Promise.all([...running, other])).map(response => response.statusCode)).toEqual(Array(NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL + 1).fill(200));
      // Slots are released once operations finish.
      const after = recall("fixture-reader");
      await vi.waitFor(() => expect(releases).toHaveLength(NATIVE_MAX_IN_FLIGHT_PER_PRINCIPAL + 2));
      releases.at(-1)!();
      expect((await after).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});

describe("GBrain image errors never reach agents raw", () => {
  it("replaces upstream image-loader errors (file bytes, size, existence) with a generic code", async () => {
    const runtime = new GBrainRuntime(loadConfig({ environment: "test", config: { dataDir, gbrainServiceUrl: fake.baseUrl, gbrainServiceAdminToken: admin } }));
    await runtime.start();
    const result = await runtime.nativeOperation("search_by_image", { image_url: "https://example.test/leak.png" }, "fixture-a", "agent");
    expect(result).toMatchObject({ ok: false, error: { error: "image_input_rejected" } });
    const text = JSON.stringify(result);
    for (const fragment of ["23230a23", "Magic bytes", "1234", "/etc/hosts", "not found"]) expect(text).not.toContain(fragment);
  });
});
