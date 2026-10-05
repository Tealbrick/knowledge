import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OpenNotebookChatError, type OpenNotebookChatAdapter } from "./open-notebook-chat.js";
import { ResearchChatLedgerError, type ResearchChatLedger, type ResearchChatScope, type ResearchChatReceipt } from "./research-chat-ledger.js";
import type { KnowledgeServicePrincipal } from "./knowledge-principal.js";
import type { OpenNotebookNotebookBinding, OpenNotebookRouteAdapter } from "./open-notebook-routes.js";
import { OPEN_NOTEBOOK_CONTRACT_BASELINE } from "./open-notebook.js";

type Params = { notebookId: string; sessionId?: string; idempotencyKey?: string };
type Request = FastifyRequest<{ Params: Params }>;
export interface NotebookChatAccess {
  authorize(request: Request, reply: FastifyReply, capability: string): Promise<void>;
  run(request: Request, reply: FastifyReply, capability: string,
    action: (engine: OpenNotebookRouteAdapter, binding: OpenNotebookNotebookBinding, principal: KnowledgeServicePrincipal) => Promise<unknown>): Promise<unknown>;
}
export interface OpenNotebookChatRouteOptions {
  adapter: OpenNotebookChatAdapter | null;
  ledger: ResearchChatLedger | null;
  /** Fixed model id, or a resolver read at request time so settings changes apply without restart. */
  modelId: string | null | (() => string | null);
  access: NotebookChatAccess;
}

const errorResponse = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error });
const envelope = { provider: "open_notebook", contractBaseline: OPEN_NOTEBOOK_CONTRACT_BASELINE, observedVersion: null };
function projectReceipt(receipt: ResearchChatReceipt) {
  return { operation: receipt.operation, idempotencyKey: receipt.idempotencyKey, state: receipt.state,
    sessionId: receipt.localSessionId, answer: receipt.answer, errorCode: receipt.errorCode,
    createdAt: receipt.createdAt, updatedAt: receipt.updatedAt };
}
function objectBody(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}
function ledgerFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof ResearchChatLedgerError && error.code === "invalid_input") return errorResponse(reply, 400, "invalid_chat_request");
  if (error instanceof ResearchChatLedgerError && error.code === "not_found") return errorResponse(reply, 404, "chat_session_not_found");
  return errorResponse(reply, 503, "research_chat_unavailable");
}

export function registerOpenNotebookChatRoutes(app: FastifyInstance, options: OpenNotebookChatRouteOptions): void {
  const { access } = options;
  const currentModelId = (): string | null => {
    try { return typeof options.modelId === "function" ? options.modelId() : options.modelId; }
    catch { return null; }
  };
  const authorize = (capability: string, alsoRead = false) => async (request: Request, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    await access.authorize(request, reply, capability);
    if (alsoRead && !reply.sent) await access.authorize(request, reply, "research:read");
  };
  const scopeFor = (binding: OpenNotebookNotebookBinding, principal: KnowledgeServicePrincipal): ResearchChatScope => ({
    principalId: principal.principalId, companyId: binding.companyId,
    knowledgeNotebookId: binding.knowledgeNotebookId, externalNotebookId: binding.externalNotebookId,
    modelId: currentModelId()!,
  });
  const ready = (reply: FastifyReply) => {
    if (options.adapter && options.ledger && currentModelId()) return true;
    errorResponse(reply, 503, "research_chat_unavailable");
    return false;
  };
  const currentRead = async (request: Request, reply: FastifyReply) => {
    await access.authorize(request, reply, "research:read");
    return !reply.sent;
  };

  app.post<{ Params: Params }>("/api/research/notebooks/:notebookId/engine/chat/sessions", { onRequest: authorize("research:write") }, async (request, reply) =>
    access.run(request, reply, "research:write", async (_engine, binding, principal) => {
      if (!ready(reply)) return;
      if (!objectBody(request.body, ["title"]) || (request.body.title !== undefined && typeof request.body.title !== "string")) return errorResponse(reply, 400, "invalid_chat_request");
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") return errorResponse(reply, 400, "idempotency_key_required");
      const scope = scopeFor(binding, principal);
      const title = request.body.title as string | undefined ?? "Research chat";
      const ledger = options.ledger!;
      let claim;
      try { claim = ledger.beginSession(scope, key, title); } catch (error) { return ledgerFailure(reply, error); }
      if (claim.kind === "conflict") return errorResponse(reply, 409, claim.code);
      if (claim.kind !== "claimed") {
        return reply.code(claim.kind === "replay" && claim.receipt.state === "succeeded" ? 200 : 409)
          .send({ ...envelope, receipt: projectReceipt(claim.receipt), replayed: claim.kind === "replay" });
      }
      let createdUpstream = false;
      try {
        const created = await options.adapter!.createChatSession(binding.externalNotebookId, { title, modelId: scope.modelId });
        createdUpstream = true;
        const verified = await options.adapter!.getChatSession(binding.externalNotebookId, created.id);
        if (verified.modelId !== scope.modelId || verified.messages.length !== 0) throw new Error("new_session_verification_failed");
        const receipt = ledger.completeSession(scope, key, claim.claimToken, created.id);
        await access.authorize(request, reply, "research:write");
        if (reply.sent) return;
        return reply.code(201).send({ ...envelope, receipt: projectReceipt(receipt), replayed: false });
      } catch (error) {
        // A verification or local receipt failure after creation is ambiguous,
        // even if a later read returns a known rejection.
        const rejected = !createdUpstream && error instanceof OpenNotebookChatError && error.disposition === "rejected";
        try {
          const receipt = rejected ? ledger.reject(scope, key, claim.claimToken, "upstream_rejected") : ledger.markUncertain(scope, key, claim.claimToken, "ambiguous_response");
          return reply.code(rejected ? 502 : 503).send({ ...envelope, receipt: projectReceipt(receipt), error: rejected ? "research_chat_rejected" : "reconciliation_required" });
        } catch { return errorResponse(reply, 503, "reconciliation_required"); }
      }
    }),
  );

  app.get<{ Params: Params }>("/api/research/notebooks/:notebookId/engine/chat/sessions/:sessionId", { onRequest: authorize("research:read") }, async (request, reply) =>
    access.run(request, reply, "research:read", async (_engine, binding, principal) => {
      if (!ready(reply)) return;
      let session;
      try { session = options.ledger!.getSession(scopeFor(binding, principal), request.params.sessionId!); }
      catch (error) { return ledgerFailure(reply, error); }
      if (!session) return errorResponse(reply, 404, "chat_session_not_found");
      try {
        const remote = await options.adapter!.getChatSession(binding.externalNotebookId, session.externalSessionId);
        if (remote.modelId !== currentModelId()) return errorResponse(reply, 409, "chat_model_policy_changed");
        if (!await currentRead(request, reply)) return;
        return { ...envelope, session: { id: session.localSessionId, title: session.title, notebookId: binding.knowledgeNotebookId, createdAt: session.createdAt, updatedAt: session.updatedAt }, messages: remote.messages };
      } catch { return errorResponse(reply, 503, "research_chat_unavailable"); }
    }),
  );

  app.post<{ Params: Params }>("/api/research/notebooks/:notebookId/engine/chat/sessions/:sessionId/messages", { onRequest: authorize("research:write", true) }, async (request, reply) =>
    access.run(request, reply, "research:write", async (engine, binding, principal) => {
      if (!principal.capabilities.includes("research:read")) return errorResponse(reply, 403, "insufficient_capability");
      if (!ready(reply)) return;
      if (!engine.getNotebookContext) return errorResponse(reply, 503, "research_chat_unavailable");
      if (!objectBody(request.body, ["message"]) || typeof request.body.message !== "string") return errorResponse(reply, 400, "invalid_chat_request");
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") return errorResponse(reply, 400, "idempotency_key_required");
      const scope = scopeFor(binding, principal);
      const ledger = options.ledger!;
      let session, claim;
      try {
        session = ledger.getSession(scope, request.params.sessionId!);
        if (!session) return errorResponse(reply, 404, "chat_session_not_found");
        claim = ledger.beginTurn(scope, session.localSessionId, key, request.body.message);
      } catch (error) { return ledgerFailure(reply, error); }
      if (claim.kind === "session_busy") return errorResponse(reply, 409, "chat_session_busy");
      if (claim.kind === "conflict") return errorResponse(reply, 409, claim.code);
      if (claim.kind !== "claimed") {
        if (!await currentRead(request, reply)) return;
        return reply.code(claim.kind === "replay" && claim.receipt.state === "succeeded" ? 200 : 409)
          .send({ ...envelope, receipt: projectReceipt(claim.receipt), replayed: claim.kind === "replay" });
      }
      let executing = false;
      try {
        const context = await engine.getNotebookContext(binding.externalNotebookId);
        const remote = await options.adapter!.getChatSession(binding.externalNotebookId, session.externalSessionId);
        await access.authorize(request, reply, "research:write");
        if (!reply.sent) await access.authorize(request, reply, "research:read");
        if (reply.sent) { try { ledger.reject(scope, key, claim.claimToken, "scope_denied"); } catch { /* pending claim stays held */ } return; }
        executing = true;
        const answer = await options.adapter!.executeChatMessage(binding.externalNotebookId, session.externalSessionId, {
          message: request.body.message, modelId: scope.modelId, context, previousMessages: remote.messages,
        });
        if (answer.type !== "ai") throw new Error("assistant_response_required");
        const receipt = ledger.completeTurn(scope, key, claim.claimToken, { ...answer, type: "ai" });
        if (!await currentRead(request, reply)) return;
        return reply.code(201).send({ ...envelope, receipt: projectReceipt(receipt), replayed: false, providerRetryPolicy: "upstream-controlled" });
      } catch (error) {
        const uncertain = executing && !(error instanceof OpenNotebookChatError && error.disposition === "rejected");
        try {
          const receipt = uncertain ? ledger.markUncertain(scope, key, claim.claimToken, "ambiguous_response") : ledger.reject(scope, key, claim.claimToken, "upstream_rejected");
          if (!await currentRead(request, reply)) return;
          return reply.code(uncertain ? 503 : 502).send({ ...envelope, receipt: projectReceipt(receipt), error: uncertain ? "reconciliation_required" : "research_chat_rejected" });
        } catch { return errorResponse(reply, 503, "reconciliation_required"); }
      }
    }),
  );

  app.get<{ Params: Params }>("/api/research/notebooks/:notebookId/engine/chat/receipts/:idempotencyKey", { onRequest: authorize("research:write", true) }, async (request, reply) =>
    access.run(request, reply, "research:write", async (_engine, binding, principal) => {
      if (!principal.capabilities.includes("research:read")) return errorResponse(reply, 403, "insufficient_capability");
      if (!ready(reply)) return;
      if (!await currentRead(request, reply)) return;
      try {
        const receipt = options.ledger!.getReceipt(scopeFor(binding, principal), request.params.idempotencyKey!);
        return receipt ? { ...envelope, receipt: projectReceipt(receipt) } : errorResponse(reply, 404, "chat_receipt_not_found");
      } catch (error) { return ledgerFailure(reply, error); }
    }),
  );
}
