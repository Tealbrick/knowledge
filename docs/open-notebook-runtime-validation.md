# Real Open Notebook runtime validation

The opt-in fixture starts a private native SurrealDB, the pinned Open Notebook
API and its required command worker. It provisions synthetic A/B notebooks,
stores one plain-text source through Knowledge's production write route without
embeddings or transformations, reopens Knowledge and replays the same key
without creating another upstream source, and reads
it through Knowledge's authenticated routes. It checks missing/wrong upstream
credentials, missing Knowledge credentials, cross-company rejection and an
empty B notebook. Knowledge's local mappings survive closing/reopening its
temporary SQLite store. Success is reported only after fixture cleanup.
It also builds full-content Research context through Knowledge, checks the
exact A source text, empty B context, cross-company denial and rejected caller
context selectors. No model is invoked. In the network-restricted fixture,
upstream token counting may use its documented word-count estimate fallback.

This is real upstream runtime proof, not a mock API. It is still not a live
deployment, browser/harness UAT, model-backed ask/chat, upstream cold-restart
test, customer database migration, or whole-Program tenant-isolation proof.
The source write uses the durable Knowledge receipt ledger. Automatic recovery
of uncertain outcomes remains pending; held keys are not automatically retried.

## Verified dependency baseline

- Open Notebook `v1.14.0`: `30c7e2a63e43b7f270fc2c638f0b6246934a53f4`.
- Its frozen `uv.lock` SHA-256:
  `59216cbb049c14ae81242b4229fb26ddb532eb5c304312e6188b4a6697997d8b`.
- Python 3.12.13; upstream declares Python `>=3.11,<3.13`.
- SurrealDB 2.6.5, the latest patch in the upstream-targeted 2.x release line,
  not the latest overall database major. Open Notebook's shipped Compose uses
  `surrealdb:v2`; upgrading to 3.x is a separate compatibility exercise.
- The macOS ARM64 release archive SHA-256 was independently matched to the
  official release asset digest:
  `71d031be990d59ed57e41e147fda7463660a2b449ae91868c83eb0888d07fade`.

Sources: [Open Notebook release](https://github.com/lfnovo/open-notebook/releases/tag/v1.14.0),
[SurrealDB 2.6.5 assets](https://github.com/surrealdb/surrealdb/releases/tag/v2.6.5),
[2.6 release notes](https://surrealdb.com/releases/2.6).

## Reproduce

Use a fresh temporary upstream checkout, not an existing customer installation:

```sh
fixture_checkout=$(mktemp -d /tmp/knowledge-open-notebook.XXXXXX)
git clone --depth 1 --branch v1.14.0 https://github.com/lfnovo/open-notebook.git "$fixture_checkout/upstream"
git -C "$fixture_checkout/upstream" rev-parse HEAD
uv sync --project "$fixture_checkout/upstream" --frozen --no-dev --python 3.12 --no-install-project
```

Verify the printed ref equals the full pin above. Download the appropriate
SurrealDB 2.6.5 binary from its official release, verify the archive against
that platform's published SHA-256, and extract into the fixture directory.
Do not substitute a moving `latest` image or install over a global executable.

From Knowledge's `program` folder, with its existing frozen dependencies:

```sh
node scripts/open-notebook-native-fixture.mjs "$fixture_checkout/upstream" /absolute/path/to/verified/surreal
```

The runner verifies the upstream ref and clean source, checks the database
version, allocates loopback ports, generates fresh private credentials in
memory, disables `.env` loading, and uses an allowlisted environment without
provider keys. A fixture-only Python socket guard rejects non-loopback network
and DNS calls; SurrealDB outbound networking is denied. This is not an OS-wide
network sandbox. Nothing starts through AVM, systemd, Docker or a global worker.

The script starts **API plus worker**: the upstream synchronous source endpoint
submits a command and waits for the worker. Starting only the API produces an
ambiguous timeout despite healthy API/database probes. It must not be retried
as if nothing happened. The first root test reproduced this and preserved its
failure evidence before adding the missing worker.

Each run has bounded startup, operation and shutdown deadlines. Only owned
child PIDs are stopped; only its newly-created data directories and synthetic
IDs are removed. Readiness retries are safe GET probes; writes are never
automatically retried. Diagnostic logs remain under the printed `evidenceRoot`.
The prepared upstream checkout, Python environment and downloaded binary remain
available for reproduction; they contain no customer data or provider keys.

## Remaining first-hookup work

Add explicit evidence-based reconciliation for uncertain write receipts.
Scoped context/chat routes are now implemented using server-built notebook
context; see the [current Research agent contract](research-agent-contract.md).
This older keyless fixture does not validate that model path. Stock global
upstream search/ask cannot be made tenant-scoped with a caller notebook label.
The [container Research runbook](../deploy/container/RESEARCH-SETUP.md) identifies
the remaining deployed configuration and Portal attachment gaps. General
Knowledge domain authorization, durable audit, deployment and human UAT remain
separate evidence gates.
