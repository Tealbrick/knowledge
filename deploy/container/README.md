# Knowledge deployment

One deployment is one trusted instance. The edge listens on `PORT`
(5310 default), runs the Program on a separate loopback-only ephemeral port,
and protects every request except exact `GET /healthz`. The
`X-Knowledge-Instance-Token` credential is reserved for trusted operator recovery
and deployment validation. Generate a distinct 32+ character cryptographic
random secret per installation; do not deliver it to connected agents or their
harnesses. Customer runtimes use a distinct configured Knowledge service-principal
bearer directly, with the independent CRUD ceiling enforced by the Program on
every operation. See [customer runtime authorization](../../docs/customer-runtime-auth.md)
for the exact supported routes, operator claim proof, and configuration.
Research additionally requires its separately configured principal grant.
Never put credentials in browser storage, URLs, or tool arguments.

The instance recovery credential is **not** agent authorization. Agent access is
partition-aware object authorization: every direct runtime request resolves a
server-configured principal, intersects its capabilities with a matching
partition grant, and derives the effective partition on the server. A single
instance can therefore host multiple independent people, companies or projects
when their principals and grants are configured explicitly. The Portal can launch an owner browser session through a one-use ticket and
HttpOnly cookie. The edge introspects it on each request and checks the Origin
on mutations. Research retains its separate scoped session and grants.

A legacy optional Portal attachment path requires all of `TEALBRICK_PORTAL_URL`
(fixed HTTPS origin), `TEALBRICK_DEPLOYMENT_ID`, `KNOWLEDGE_COMPANY_ID`
(bound workspace ID), and `KNOWLEDGE_PORTAL_ORG_ID` (the server-attested Portal
organization ID). Agents send an attachment bearer and separate
`X-Tealbrick-Agent-Token`. Every operation introspects both with the fixed
Portal `/api/deployment-access/introspect`; no customer content is sent there.
Expired/revoked/foreign grants and Portal outages fail closed. Only document
collection create/list, document create/read, company search and Brain reads
are allowed. Company paths and object ownership are checked, and Brain scopeRef
is overwritten with the configured workspace. The attached Brain is exclusive
to that configured workspace. Research and native memory operations remain
separately authorized through their principal bindings; attachment grants do
not silently widen those contracts. Instance access remains
the trusted operator recovery path.

The direct customer-runtime path does not call this introspection service. Its
trusted customer connector separately verifies short-lived Portal configuration
and entitlement metadata; Knowledge independently enforces the app-local bearer
ceiling. A bare app bearer is not proof of a purchased licence.

## Build and distribute

From this repository root, `sh deploy/container/build-local.sh` builds a local
`tealbrick-knowledge:local-0.1.0` image using an allowlisted disposable build
context, bundled GBrain and the shared presentation SDK. The script prints the
temporary path for inspection and retains it after the build. No operator
database, env file, provider state or node_modules is copied. The regular
Dockerfile also provides a Dockerfile-specific ignore file for BuildKit.

The build defaults to linux/amd64 for Railway/Coolify; set
`KNOWLEDGE_BUILD_PLATFORM=linux/arm64` for native Apple-Silicon verification.
`KNOWLEDGE_EXPORT_ONLY=1` prepares the same allowlisted context without building,
for a native remote builder. Do not export the entire dirty LABS checkout.

The primary distribution target is a source-backed Railway service. Portal
points Railway at the public `Tealbrick/knowledge` repository and protected
release branch `release-knowledge-v0.2.2`, fixed at commit
`f31f904fbedf0ecfd25b636bf23bdfd3c98adc3a`; Railway builds the Dockerfile in
the customer's project, while Portal verifies and records the resolved source
commit before acceptance. The preserved release tag is
`v0.2.2`. No
publisher GitHub PAT or registry credential belongs in a customer project.
An OCI image under `ghcr.io/tealbrick/knowledge` is optional and must not be a
source-backed deployment prerequisite. `public-deployment.json` is the source
for generated deployment artifacts:

```sh
node deploy/container/generate-public-deployment.mjs --write
node deploy/container/generate-public-deployment.mjs --check
```

Keep the protected source branch, preserved release tag, resolved commit, licence bundle and any optional image
digest associated with each release. Agent consumers use the separately
published `@tealbrick/knowledge-agent` package; they do not receive the
instance recovery credential.

## Coolify / Compose

Use `compose.yaml` with a verified image digest in `KNOWLEDGE_IMAGE` only for
the optional self-hosted image path.
Configure distinct `KNOWLEDGE_INSTANCE_TOKEN`, `OPEN_NOTEBOOK_PASSWORD`,
`OPEN_NOTEBOOK_ENCRYPTION_KEY`, and `SURREAL_PASSWORD` in the deployment secret
store. Required-variable checks prevent default passwords. Connect Coolify's
TLS proxy only to Knowledge port 5310. No upstream or database host port is
published. The default local binding is 127.0.0.1:5310.

The official Open Notebook image includes its API and background worker. Its
1.14.0 tag and SurrealDB 2.6.5 are pinned to verified Linux amd64 manifests;
ARM hosts need emulation or separately verified ARM digests. Official latest
Open Notebook GitHub release remained v1.14.0 when checked on 2026-09-13.
SurrealDB 3.x is outside the audited API baseline. Node and Bun build images
are pinned to the verified multi-architecture image digests.

## Railway template

The exact three-service setup, variables and release gates are in
[RAILWAY.md](RAILWAY.md) and [railway-blueprint.json](railway-blueprint.json).
The blueprint is a Teal Brick deployment specification, not an undocumented
Railway API import format. `railway.json` is the Knowledge service config,
**not a published template**.
`recipe.json` is the machine-readable portal recipe. Create three private
services matching Compose: Knowledge (only public domain), Open Notebook
(private API port 5055) and SurrealDB (private port 8000). Attach respectively
`/data`, `/app/data` and `/mydata` persistent volumes. Use private DNS for
`KNOWLEDGE_OPEN_NOTEBOOK_BASE_URL` and `SURREAL_URL`; inject the same upstream
password into Knowledge and Open Notebook. The launcher initializes only the
`/data` mount root ownership and drops to UID/GID 1000 before loading the
Program. Existing restored files must already be writable by UID 1000; the
launcher does not recursively rewrite ownership.

Use one replica per service. SQLite and PGlite do not support arbitrary
horizontal replicas sharing their files. Back up all three volumes and the
encryption key/mappings consistently while writes are stopped; restore into a
fresh isolated deployment and verify data before switching traffic. Rollback
requires a compatible data snapshot as well as the prior image digest.

## Research and Brain provisioning

Follow [RESEARCH-SETUP.md](RESEARCH-SETUP.md) for the source-backed Research
provider, model, service-principal and notebook-binding prerequisites. Portal
attachments do not yet grant Research access.

Set the server-only principal and notebook mapping arrays using
`../../docs/open-notebook-connection.md`. Empty arrays intentionally grant no
Research access. Create local and upstream notebooks then bind their exact IDs.
Chat also needs an explicit upstream `model:<id>` and provider credentials
configured in the trusted Open Notebook service. No provider key is bundled.
A fresh GBrain waits for model configuration. Use Settings → Models to verify
and save chat and embedding endpoints before it initializes persistent PGlite. A healthy process
does not prove those features. Heavy Docling/Crawl4AI installers are disabled.

Compose accepts optional `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and
`GOOGLE_API_KEY` for Open Notebook only. Select the intended provider and add
its credential through the deployment secret store. Then use Open Notebook's
trusted administration UI/API on its private connection to register/select a
language model and obtain its saved `model:<id>`; set that exact ID on Knowledge.
Provider credentials alone do not create a notebook mapping or establish a
working chat model. The GBrain child does not receive Open Notebook's keys
from this Compose service; configure its separate provider deliberately if
reasoning/extraction/embedding is required. Basic document CRUD works before model setup; Brain readiness must be checked
after configuring its models.

Current readiness gaps before a full Research acceptance: upstream three-service
runtime, explicit independently generated service principal, existing local and
upstream notebook IDs/mapping, provider credential, saved language model ID,
source create/read and chat receipt round-trip. None are supplied by the image.
Keep Research unavailable until those exact operations pass. No automatic
provider purchase or model charge is part of packaging.

The agent package supplies a stdio MCP adapter backed by scoped HTTP calls.
There is no public HTTP `/mcp` endpoint; internal GBrain MCP is not the Knowledge
product contract. See [the agent adapter](../../adapters/agent/README.md). Preserve
idempotency keys and held uncertain write receipts for Research.

## Verification

`node --test deploy/container/edge.test.mjs` from this repository root exercises
the real Program with disposable state: missing/wrong edge credentials, exact
health exemption, authenticated status, CORS suppression and independent
Research authorization. It does not invoke a model or prove a deployed image.

Acceptance must additionally record image digest, volume ownership, service
health, authenticated `/api/status`, a document write/read across restart,
real GBrain and mapped Open Notebook calls, and a local Eve adapter round-trip.
Run these only against disposable data in the intended test deployment.

Upstream references: https://github.com/lfnovo/open-notebook/releases/tag/v1.14.0
and its pinned compose source at commit
`30c7e2a63e43b7f270fc2c638f0b6246934a53f4`.
