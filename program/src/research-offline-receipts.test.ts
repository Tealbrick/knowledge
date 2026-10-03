import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgePrincipalResolver } from "./knowledge-principal.js";
import {
  registerOpenNotebookRoutes,
  type OpenNotebookNotebookBinding,
  type OpenNotebookRouteAdapter,
} from "./open-notebook-routes.js";
import type { OpenNotebookChatAdapter } from "./open-notebook-chat.js";
import { ResearchChatLedger, type ResearchChatScope } from "./research-chat-ledger.js";
import { ResearchWriteLedger, type ResearchWriteScope } from "./research-write-ledger.js";

const binding: OpenNotebookNotebookBinding = {
  knowledgeNotebookId: "notebook:local-a",
  companyId: "company-alpha",
  externalNotebookId: "notebook:external-a",
};

const alpha = {
  token: "offline-alpha",
  principalId: "principal-alpha",
  companyId: "company-alpha",
  capabilities: ["research:read", "research:write"],
};

const sameCompanyOtherPrincipal = {
  token: "offline-alpha-other",
  principalId: "principal-alpha-other",
  companyId: "company-alpha",
  capabilities: ["research:read", "research:write"],
};

const writeScope: ResearchWriteScope = {
  principalId: alpha.principalId,
  companyId: binding.companyId,
  knowledgeNotebookId: binding.knowledgeNotebookId,
  externalNotebookId: binding.externalNotebookId,
};

const chatScope: ResearchChatScope = {
  ...writeScope,
  modelId: "model:fixture",
};

const apps: FastifyInstance[] = [];
const writeLedgers: ResearchWriteLedger[] = [];
const chatLedgers: ResearchChatLedger[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const ledger of writeLedgers.splice(0)) ledger.close();
  for (const ledger of chatLedgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function failingAdapter(calls: { count: number }): OpenNotebookRouteAdapter {
  const fail = async (): Promise<never> => {
    calls.count += 1;
    throw new Error("upstream must not be called while reading a local receipt");
  };
  return {
    getNotebook: fail,
    listNotebookSources: fail,
    listNotebookNotes: fail,
    getNotebookSource: fail,
    createNotebookTextSource: fail,
    getNotebookContext: fail,
  };
}

function writeReceiptUrl(key: string): string {
  return `/api/research/notebooks/${encodeURIComponent(binding.knowledgeNotebookId)}/engine/write-receipts/${encodeURIComponent(key)}`;
}

function chatReceiptUrl(key: string): string {
  return `/api/research/notebooks/${encodeURIComponent(binding.knowledgeNotebookId)}/engine/chat/receipts/${encodeURIComponent(key)}`;
}

async function buildFixture(): Promise<{ app: FastifyInstance; calls: { count: number } }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-offline-receipts-"));
  roots.push(root);
  const writeLedger = new ResearchWriteLedger(path.join(root, "writes.sqlite"));
  const chatLedger = new ResearchChatLedger(path.join(root, "chat.sqlite"));
  writeLedgers.push(writeLedger);
  chatLedgers.push(chatLedger);

  const writeClaim = writeLedger.begin(writeScope, "write-offline-001", { title: "Fixture", content: "Durable receipt" });
  if (writeClaim.kind !== "claimed") throw new Error("write fixture did not claim");
  writeLedger.succeed(writeScope, "write-offline-001", writeClaim.claimToken, "source:offline-001");

  const sessionClaim = chatLedger.beginSession(chatScope, "chat-offline-001", "Fixture chat");
  if (sessionClaim.kind !== "claimed") throw new Error("chat fixture did not claim");
  chatLedger.completeSession(chatScope, "chat-offline-001", sessionClaim.claimToken, "chat_session:offline-001");

  const app = Fastify();
  const calls = { count: 0 };
  const adapter = failingAdapter(calls);
  registerOpenNotebookRoutes(app, {
    adapter,
    chatAdapter: adapter as unknown as OpenNotebookChatAdapter,
    chatLedger,
    chatModelId: chatScope.modelId,
    ledger: writeLedger,
    principals: createKnowledgePrincipalResolver([alpha, sameCompanyOtherPrincipal]),
    bindings: [binding],
    resolveNotebookCompany: (notebookId) => notebookId === binding.knowledgeNotebookId ? binding.companyId : null,
  });
  await app.ready();
  apps.push(app);
  return { app, calls };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("offline durable Research receipt reads", () => {
  it("reads configured local write and chat receipts without invoking an unavailable upstream adapter", async () => {
    const fixture = await buildFixture();

    const write = await fixture.app.inject({ method: "GET", url: writeReceiptUrl("write-offline-001"), headers: auth(alpha.token) });
    expect(write.statusCode).toBe(200);
    expect(write.json().receipt).toMatchObject({ idempotencyKey: "write-offline-001", state: "succeeded", sourceId: "source:offline-001" });

    const chat = await fixture.app.inject({ method: "GET", url: chatReceiptUrl("chat-offline-001"), headers: auth(alpha.token) });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().receipt).toMatchObject({ operation: "session", idempotencyKey: "chat-offline-001", state: "succeeded" });
    expect(fixture.calls.count).toBe(0);
  });

  it("does not disclose either receipt to another principal in the same company", async () => {
    const fixture = await buildFixture();

    const write = await fixture.app.inject({ method: "GET", url: writeReceiptUrl("write-offline-001"), headers: auth(sameCompanyOtherPrincipal.token) });
    expect(write.statusCode).toBe(404);

    const chat = await fixture.app.inject({ method: "GET", url: chatReceiptUrl("chat-offline-001"), headers: auth(sameCompanyOtherPrincipal.token) });
    expect(chat.statusCode).toBe(404);
    expect(fixture.calls.count).toBe(0);
  });
});
