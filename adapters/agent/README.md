# Knowledge agent adapter

Standalone MCP for Codex/Claude, an explicit Eve extension, and a JavaScript
client for the authenticated Knowledge native memory API. No Portal dependency,
host credentials, engine administration, implicit agent hooks or Boardstate.
This adapter covers memory, not the separate Open Notebook Research API.

## Build and install

Use Node 24 and the committed lockfile:

```sh
cd adapters/agent
npm ci
npm test
npm run build
npm pack
```

The resulting `tealbrick-knowledge-agent-0.1.0.tgz` includes the standalone
MCP source and built Eve extension. The package is published separately on
npm; verify the exact version and integrity from the registry before use. The Eve development
pin is 0.58.1, tested with AI SDK 7.0.105. It does not auto-upgrade a harness.

## Standalone MCP (Codex, Claude Code or Claude Desktop)

Install the tarball in a trusted local directory. Configure a stdio MCP using:

- Command: `node`
- Arguments: the absolute path to `node_modules/@tealbrick/knowledge-agent/src/mcp.mjs`
- Runtime environment: `KNOWLEDGE_BASE_URL`, `KNOWLEDGE_PARTITION_KEY`,
  `KNOWLEDGE_SERVICE_TOKEN`.

Use the client's private environment/secret mechanism. The service token is
an individually scoped Knowledge principal credential, never the instance
administrator, GBrain or model-provider key. Keep plaintext config private
where the MCP host requires it; never put the token in command-line arguments,
URL query parameters, project files or source control. HTTPS is required except
for loopback development. Remote private endpoints must be reachable from the
customer machine running MCP, not from Portal.

MCP exposes `knowledge_brain_tools({operation?, query?})` and
`knowledge_brain_call({operation, arguments, idempotencyKey?})`. The operation
set is the deployment engine's (GBrain or Hindsight), discovered at runtime;
every write needs an `idempotencyKey`. The fixed
partition is runtime configuration, not model-controlled input. Discover the
native schemas, use `query`/`search`, then `get_page`/`get_chunks` to read the
answer-bearing source. Native errors and uncertain-write receipts remain errors.

## Standalone Eve extension

Install the tarball alongside the consumer's supported Eve version, then add
`agent/extensions/knowledge.ts`:

```ts
import knowledge from '@tealbrick/knowledge-agent';
export default knowledge({
  baseUrl: 'https://your-knowledge.example',
  partitionKey: 'your-workspace',
  tokenEnv: 'KNOWLEDGE_SERVICE_TOKEN',
});
```

Keep the credential in the agent runtime environment. The mount contributes
`knowledge__brain_tools`, `knowledge__brain_call` and usage instructions only.
It does not contribute channels, schedules, subagents or sandbox configuration.
The consumer must author its own root instructions and agent configuration.
Run `eve info --json`, `eve build` and the consumer's normal runtime checks.

## Portal-managed Eve/Codex package path

The companion `tealbrick-packages` changes add `memory_tools` and
`memory_native_<verb>` to the existing `tealbrick_capabilities`/`tealbrick_call`
connector. Send native fields inside `input.arguments`, and a stable
`input.idempotencyKey` for mutations. Portal's signed grants and the local
Knowledge principal must BOTH allow the request; `remember` needs Create and
Update, `forget` needs Delete. The catalog is filtered to their intersection.
Only customer-side runtime calls Knowledge; Portal receives configuration/acks,
not documents or app credentials. Existing legacy operations stay compatible.

## Acceptance

From `program`, run `tsx scripts/verify-agent-adapters.ts`, optionally setting
`TEALBRICK_PACKAGES_PATH` to the built companion checkout. This runs actual
stdio MCP requests, a tarball-installed Eve discovery/build/session, and the
Portal MCP connector against disposable real GBrain storage. A deterministic
model selects the Eve tool; this is routing/authorization proof, not an LLM
accuracy score or Codex/Claude desktop UI acceptance. No live service is changed.
