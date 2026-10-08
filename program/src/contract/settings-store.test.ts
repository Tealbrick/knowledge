import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsApplyError, buildModelSettingsUpdate, createModelSettingsStore, settingsFailures, snapshotOf } from "./settings-store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const dataDir = () => { const directory = mkdtempSync(path.join(tmpdir(), "knowledge-settings-")); directories.push(directory); return directory; };

const saved = {
  chat: { provider: "openai", baseUrl: "https://models.fixture.invalid/v1", model: "chat-1", apiKey: "sk-saved-chat-key" },
  embedding: { provider: "openai", baseUrl: "https://models.fixture.invalid/v1", model: "embed-1", dimensions: 1536, apiKey: "sk-saved-chat-key" },
} as const;
const values = (entries: Record<string, string | number>) => ({ values: entries, secrets: {} });
const COMPLETE = {
  "chat.provider": "openai", "chat.baseUrl": "https://models.fixture.invalid/v1", "chat.model": "chat-1",
  "embedding.provider": "openai", "embedding.baseUrl": "https://models.fixture.invalid/v1", "embedding.model": "embed-1", "embedding.dimensions": 1536,
};

describe("model settings through the contract endpoint", () => {
  it("reports values and key presence, never a key", () => {
    const snapshot = snapshotOf(saved as never, "2026-10-08T10:00:00.000Z");
    expect(snapshot.values).toMatchObject({ "chat.provider": "openai", "chat.model": "chat-1", "embedding.dimensions": 1536 });
    expect(snapshot.secrets).toEqual({ "chat.apiKey": { set: true, updatedAt: "2026-10-08T10:00:00.000Z" }, "embedding.apiKey": { set: true, updatedAt: "2026-10-08T10:00:00.000Z" } });
    expect(JSON.stringify(snapshot)).not.toContain("sk-saved");
    expect(snapshotOf(null, null)).toEqual({ revision: "0", values: {}, secrets: {} });
  });

  it("overlays supplied fields on the saved settings and keeps the saved key unless one is given", () => {
    const body = buildModelSettingsUpdate(saved as never, null, values({ "chat.model": "chat-2" }));
    expect(body.chat).toEqual({ provider: "openai", baseUrl: "https://models.fixture.invalid/v1", model: "chat-2" });
    expect(JSON.stringify(body)).not.toContain("sk-saved");
    const rotated = buildModelSettingsUpdate(saved as never, null, { values: {}, secrets: { "chat.apiKey": "sk-new" } });
    expect(rotated.chat!.apiKey).toBe("sk-new");
    // Clearing every reranker field removes the optional reranker.
    const withReranker = { ...saved, reranker: { provider: "openrouter", baseUrl: "https://r.fixture.invalid/v1", model: "r", apiKey: "k" } };
    const cleared = buildModelSettingsUpdate(withReranker as never, null, values({}));
    expect(cleared.reranker).toBeDefined();
    const gone = buildModelSettingsUpdate(withReranker as never, null, { values: { "reranker.provider": null, "reranker.baseUrl": null, "reranker.model": null } as never, secrets: { "reranker.apiKey": null } });
    expect(gone.reranker).toBeUndefined();
  });

  it("stages an incomplete configuration and applies it the moment it is complete", async () => {
    const dir = dataDir();
    const applied: unknown[] = [];
    const store = createModelSettingsStore({ dataDir: dir, apply: async (body) => { applied.push(body); return { statusCode: 200, json: { ok: true } }; } });
    // One secret alone cannot make a configuration: it is staged, not applied, and shows as set.
    await store.write({ values: {}, secrets: { "chat.apiKey": "sk-shared-key" } });
    expect(applied).toHaveLength(0);
    expect(statSync(path.join(dir, "model-settings.pending.json")).mode & 0o077).toBe(0);
    const staged = await store.read();
    expect(staged.secrets["chat.apiKey"]).toMatchObject({ set: true });
    expect(JSON.stringify(staged)).not.toContain("sk-shared");
    const before = staged.revision;
    await store.write(values({ "chat.provider": "openai", "chat.baseUrl": COMPLETE["chat.baseUrl"], "chat.model": "chat-1" }));
    expect(applied).toHaveLength(0);
    expect((await store.read()).revision).not.toBe(before);
    await store.write({ values: { ...COMPLETE }, secrets: { "embedding.apiKey": "sk-shared-key" } });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ chat: { provider: "openai", model: "chat-1", apiKey: "sk-shared-key" }, embedding: { model: "embed-1", dimensions: 1536, apiKey: "sk-shared-key" } });
    expect(existsSync(path.join(dir, "model-settings.pending.json"))).toBe(false);
  });

  it("refuses a wrong value at once instead of staging it", async () => {
    const store = createModelSettingsStore({ dataDir: dataDir(), apply: async () => ({ statusCode: 200, json: {} }) });
    await settingsFailures.run({}, async () => {
      await expect(store.write(values({ "chat.provider": "openai", "chat.baseUrl": "http://169.254.169.254/v1", "chat.model": "m" }))).rejects.toMatchObject({ status: 400, code: "invalid_settings" });
      expect(settingsFailures.getStore()?.failure).toBeInstanceOf(SettingsApplyError);
    });
  });

  it("reports a provider readiness failure with the component, changes nothing and stages nothing", async () => {
    const dir = dataDir();
    writeFileSync(path.join(dir, "model-settings.json"), JSON.stringify(saved), { mode: 0o600 });
    const store = createModelSettingsStore({ dataDir: dir, apply: async () => ({ statusCode: 422, json: { ok: false, checks: [{ component: "chat", ok: false, error: "provider_http_401" }, { component: "embedding", ok: true }] } }) });
    await settingsFailures.run({}, async () => {
      await expect(store.write(values({ "chat.model": "broken" }))).rejects.toMatchObject({
        status: 422, code: "settings_update_failed",
        details: { checks: [{ component: "chat", ok: false, error: "provider_http_401" }, { component: "embedding", ok: true }] },
      });
    });
    expect(existsSync(path.join(dir, "model-settings.pending.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, "model-settings.json"), "utf8")).chat.model).toBe("chat-1");
  });

  it("maps the Program's refusals to stable statuses", async () => {
    const dir = dataDir();
    writeFileSync(path.join(dir, "model-settings.json"), JSON.stringify(saved), { mode: 0o600 });
    for (const [statusCode, code, status] of [[409, "embedding_migration_required", 409], [503, "brain_start_failed", 503], [500, "settings_update_failed", 500]] as const) {
      const store = createModelSettingsStore({ dataDir: dir, apply: async () => ({ statusCode, json: { ok: false, error: code } }) });
      await settingsFailures.run({}, async () => {
        await expect(store.write(values({ "chat.model": "next" }))).rejects.toMatchObject({ status, code });
      });
    }
  });
});
