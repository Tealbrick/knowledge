/** `GET /.well-known/tealbrick/guidance/1`: the usage guide for an agent holding a Knowledge grant. */
export const GUIDANCE_VERSION = "1";

export const GUIDANCE_MARKDOWN = `# Knowledge: guide for agents

Knowledge keeps one workspace's canonical documents, a memory engine (Brain) and research notebooks. You reach it with the
grant the Teal Brick connector gives you. You see only the operations your agent's edge covers.

## Where your data goes

- Everything you write goes to your edge's memory partition (its write partition). A partitioned edge works in its own
  partition (the workspace id plus the edge key).
- Your edge can also have a read set: more partitions you may read but never write. Lists, search, Brain recall, context,
  entities and memory-engine reads then cover every partition you may read, merged. \`GET /api/knowledge/partitions\` shows them.
- Name the workspace in the path (\`/api/companies/{companyId}/knowledge/...\`) or as \`partitionKey\`. That means your own view:
  writes go to your write partition, reads cover your read set. To read one partition of your read set only, name it
  (\`{companyId}/{key}\`).
- An id outside your read set (or outside your write partition, for a write) gets the same answer as an id that does not exist:
  404 \`not_found\`. Ids are random; do not guess them.

## Operations

- Documents: \`knowledge.collections.list\`, \`knowledge.collections.create\`, \`knowledge.documents.search\` (query parameter \`q\`),
  \`knowledge.documents.create\`, \`knowledge.documents.get\`, \`knowledge.documents.update\` (\`PATCH\`, needs the
  update action) and \`knowledge.documents.delete\` (needs the delete action).
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
- A document is created in a collection of your write partition. Text sources, chat sessions and memory-engine writes also
  go to your write partition only. Text sources are text only, at most 512 KiB.
- Memory-engine reads that look up, list or search (for example \`recall\`, \`search\`, \`get_page\`, \`recall_memories\`) cover your
  read set. Reads that keep state or spend model budget (\`delta\`, \`context_pack\`, \`synthesize\`, \`think\`, \`reflect\`) use one
  partition: your own, or the read partition you name in \`partitionKey\`.

## Errors

- 401 \`grant_required\`, \`grant_invalid\`, \`grant_expired\`, \`grant_denied\`, \`grant_revoked\`: the connector must renew the grant.
- 403 \`operation_not_granted\`: your edge does not cover this operation. 403 \`operation_unknown\`: not an agent operation.
- 403 \`operation_owner_only\`: only the workspace owner can do this, in the Knowledge app.
- 404 \`not_found\`: no such object in the partitions you may use for this operation.
- 403 \`partition_claim_invalid\`: your edge's partition could not be verified; nothing was done.
- 403 \`partition_binding_required\`: Portal did not state your edge's partition; nothing was done. Use the attachment path until it does.
- 503 \`grant_verification_unavailable\`: Portal could not be reached; nothing was done. Retry later.
`;
