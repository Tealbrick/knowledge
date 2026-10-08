/** `GET /.well-known/tealbrick/guidance/1`: the usage guide for an agent holding a Knowledge grant. */
export const GUIDANCE_VERSION = "1";

export const GUIDANCE_MARKDOWN = `# Knowledge: guide for agents

Knowledge keeps one workspace's canonical documents, a memory engine (Brain) and research notebooks. You reach it with the
grant the Teal Brick connector gives you. You see only the operations your agent's edge covers.

## Where your data goes

- Everything you read or write is scoped to your edge's memory partition. A partitioned edge works in its own partition
  (the workspace id plus the edge key). You cannot read or write another partition, by id or by path.
- Name the workspace in the path (\`/api/companies/{companyId}/knowledge/...\`). A partitioned edge is narrowed to its own partition for you.

## Operations

- Documents: \`knowledge.collections.list\`, \`knowledge.collections.create\`, \`knowledge.documents.search\` (query parameter \`q\`),
  \`knowledge.documents.create\`, \`knowledge.documents.get\`.
- Brain recall: \`knowledge.brain.context\`, \`knowledge.brain.recall\` (body: \`query\`, \`scopeRef\`, optional \`purpose\`, \`sourceIds\`) and
  \`knowledge.brain.entities\`. These only read.
- Memory engine: \`knowledge.engine.tools\` lists the tools you may call. Call a read tool with \`knowledge.engine.read\`
  (\`POST /api/brain/native/{operation}\`) and a write tool with \`knowledge.engine.write\` (\`POST /api/brain/native/write/{operation}\`).
  Both take \`{"arguments": {...}}\`. A read call to a write tool, or the other way round, is refused.
- Research: list the notebooks bound to your partition, then read their sources, notes and context. Add a text source, start a
  chat session and ask a question. Asking spends the account's model budget.

## Writes

- Every create needs an \`Idempotency-Key\` header (letters, digits, \`_ . : / -\`, at most 256 characters). The same key with the
  same body returns the first answer. The same key with another body is a conflict (409). A request that has not finished is
  never repeated: wait, or use a new key.
- Research writes are not retried for you. If an answer says the outcome is uncertain, read the receipt
  (\`knowledge.research-sources.receipt-get\`, \`knowledge.research-chat.receipt-get\`) before you write again.
- A document is created in a collection of your partition. Text sources are text only, at most 512 KiB.

## Errors

- 401 \`grant_required\`, \`grant_invalid\`, \`grant_expired\`, \`grant_denied\`, \`grant_revoked\`: the connector must renew the grant.
- 403 \`operation_not_granted\`: your edge does not cover this operation. 403 \`operation_unknown\`: not an agent operation.
- 403 \`operation_owner_only\`: only the workspace owner can do this, in the Knowledge app.
- 403 \`partition_claim_invalid\`: your edge's partition could not be verified; nothing was done.
- 503 \`grant_verification_unavailable\`: Portal could not be reached; nothing was done. Retry later.
`;
