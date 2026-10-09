import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { startFreshProgram } from "./fresh-program";

// Disposable OpenAI-compatible structural fixture: checks wiring only, never model quality.
const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../deploy/container/model-provider-fixture.mjs");
const fixtureKey = `fixture-${randomBytes(12).toString("hex")}`;
const settingsToken = randomBytes(32).toString("hex");
let fixture: ChildProcess;
let fixtureUrl: string;
let program: Awaited<ReturnType<typeof startFreshProgram>>;

test.describe.configure({ mode: "serial" });

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function evidence() {
  return (await fetch(`${fixtureUrl.replace(/\/v1$/u, "")}/__fixture/evidence`)).json() as Promise<{ chatReadinessRequests: number; embeddingCanaryRequests: number }>;
}

test.beforeAll(async () => {
  const port = await freePort();
  fixture = spawn(process.execPath, [fixturePath], {
    env: { PATH: process.env.PATH, KNOWLEDGE_FIXTURE_KEY: fixtureKey, KNOWLEDGE_FIXTURE_PORT: String(port), KNOWLEDGE_FIXTURE_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  fixtureUrl = `http://127.0.0.1:${port}/v1`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The instance edge normally attests owner authority with this header; the
  // fresh loopback Program reads the expected value once at startup.
  process.env.KNOWLEDGE_SETTINGS_TOKEN = settingsToken;
  try { program = await startFreshProgram(); } finally { delete process.env.KNOWLEDGE_SETTINGS_TOKEN; }
});

test.afterAll(async () => {
  await program?.close();
  fixture?.kill("SIGTERM");
});

async function openModels(page: Page, owner = true) {
  if (owner) await page.setExtraHTTPHeaders({ "x-knowledge-settings-token": settingsToken });
  await page.goto(`${program.baseUrl}/?view=settings&section=models`);
  return page.locator(".model-settings");
}

test("without owner authority the panel explains it is owner-only and cannot save", async ({ page }) => {
  const panel = await openModels(page, false);
  await expect(panel.getByText("Model settings are owner-only")).toBeVisible();
  await expect(panel).toContainText("Only the owner of this Knowledge installation can change model settings");
  await expect(panel).not.toContainText("settings_owner_required");
  await expect(panel.getByRole("button", { name: "Save and test connection" })).toBeDisabled();
});

test("a rejected key is reported per model in plain words", async ({ page }) => {
  const panel = await openModels(page);
  await expect(panel.getByText("Not set up")).toBeVisible();
  // OpenAI defaults: GPT-6 Luna with low reasoning effort.
  await expect(panel.getByLabel("Chat model")).toHaveValue("gpt-6-luna");
  await expect(panel.getByLabel("Reasoning effort")).toHaveValue("low");
  await expect(panel.getByRole("button", { name: "Save and test connection" })).toBeDisabled();
  await panel.getByRole("button", { name: "Use a different API URL" }).click();
  await panel.getByLabel("API URL").fill(fixtureUrl);
  await panel.getByLabel("API key", { exact: true }).fill("wrong-key");
  await panel.getByLabel("Chat model").fill("knowledge-structural-fixture-chat");
  await panel.getByLabel("Embedding model").fill("knowledge-structural-fixture-embedding");
  await panel.getByLabel("Embedding dimensions").fill("1536");
  await panel.getByRole("button", { name: "Save and test connection" }).click();
  const error = panel.getByRole("alert");
  await expect(error).toContainText("Embedding model: The model provider rejected the API key.");
  await expect(error).toContainText("Chat model: The model provider rejected the API key.");
  await expect(error).not.toContainText("provider_http_401");
  await expect(panel.getByText("Not set up")).toBeVisible();
});

test("valid models are checked and saved; a memory-engine start failure is explained", async ({ page }) => {
  const before = await evidence();
  const panel = await openModels(page);
  await panel.getByRole("button", { name: "Use a different API URL" }).click();
  await panel.getByLabel("API URL").fill(fixtureUrl);
  await panel.getByLabel("API key", { exact: true }).fill(fixtureKey);
  await panel.getByLabel("Chat model").fill("knowledge-structural-fixture-chat");
  await panel.getByLabel("Reasoning effort").selectOption("low");
  await panel.getByLabel("Embedding model").fill("knowledge-structural-fixture-embedding");
  await panel.getByLabel("Embedding dimensions").fill("1536");
  await panel.getByRole("button", { name: "Save and test connection" }).click();
  // This fixture instance runs without the bundled memory engine, so the save
  // succeeds but memory cannot start: the customer sees what happened.
  await expect(panel.getByRole("alert")).toContainText("Your models passed their checks and were saved, but the memory engine did not start.");
  await expect(panel.getByText("Saved", { exact: true })).toBeVisible();
  const after = await evidence();
  expect(after.chatReadinessRequests).toBe(before.chatReadinessRequests + 1);
  expect(after.embeddingCanaryRequests).toBe(before.embeddingCanaryRequests + 1);
});

test("saved non-secret values are prefilled and the key is optional when unchanged", async ({ page }) => {
  const panel = await openModels(page);
  await expect(panel.getByText("Saved", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("Provider")).toHaveValue("openai");
  await expect(panel.getByLabel("API URL")).toHaveValue(fixtureUrl);
  await expect(panel.getByLabel("Chat model")).toHaveValue("knowledge-structural-fixture-chat");
  await expect(panel.getByLabel("Reasoning effort")).toHaveValue("low");
  await expect(panel.getByLabel("Embedding model")).toHaveValue("knowledge-structural-fixture-embedding");
  await expect(panel.getByLabel("Embedding dimensions")).toHaveValue("1536");
  const keyField = panel.getByLabel("API key", { exact: true });
  await expect(keyField).toHaveValue("");
  await expect(keyField).toHaveAttribute("placeholder", "Saved — leave blank to keep");
  expect(await page.content()).not.toContain(fixtureKey);

  await panel.getByLabel("Reasoning effort").selectOption("medium");
  const before = await evidence();
  const request = page.waitForRequest((candidate) => candidate.url().endsWith("/api/settings/models") && candidate.method() === "PUT");
  await panel.getByRole("button", { name: "Save and test connection" }).click();
  const body = (await request).postDataJSON() as { chat: Record<string, unknown>; embedding: Record<string, unknown> };
  expect(body.chat.apiKey).toBeUndefined();
  expect(body.embedding.apiKey).toBeUndefined();
  expect(body.chat.reasoningEffort).toBe("medium");
  await expect(panel.getByRole("alert")).toContainText("were saved, but the memory engine did not start");
  // The fixture only answers with the real key, so a passing check proves the saved key was reused server-side.
  expect((await evidence()).chatReadinessRequests).toBe(before.chatReadinessRequests + 1);

  // Pointing the saved key at a different URL requires entering a key again.
  await panel.getByLabel("API URL").fill(fixtureUrl.replace("127.0.0.1", "localhost"));
  await expect(panel.getByRole("button", { name: "Save and test connection" })).toBeDisabled();
});

test("OpenRouter offers a reranker; switching provider resets to its defaults", async ({ page }) => {
  const panel = await openModels(page);
  await panel.getByLabel("Provider").selectOption("openrouter");
  await expect(panel.getByLabel("Chat model")).toHaveValue("openai/gpt-4.1-mini");
  await expect(panel.getByLabel("Embedding model")).toHaveValue("openai/text-embedding-3-small");
  await panel.getByLabel("Use a reranker").check();
  await expect(panel.getByLabel("Reranker model")).toHaveValue("cohere/rerank-v3.5");
  // The saved OpenAI-compatible key is never offered to a different provider.
  await expect(panel.getByLabel("API key", { exact: true })).not.toHaveAttribute("placeholder", "Saved — leave blank to keep");
  await expect(panel.getByRole("button", { name: "Save and test connection" })).toBeDisabled();
});
