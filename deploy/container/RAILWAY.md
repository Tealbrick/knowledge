# Railway three-service deployment blueprint

This is a reviewable deployment specification and runbook. No Railway template
ID, deployment or publication is created by these files. Apply
`railway-blueprint.json` through Railway's service/template editor; that JSON
is our specification, not a claimed Railway import schema. `railway.json`
configures only a Knowledge service built from source.

## Release prerequisites

Use a new, dedicated Railway project environment for one Teal Brick workspace.
The private network is environment-scoped. These images listen on IPv4; new
Railway environments provide IPv4 and IPv6, while legacy environments may
provide only IPv6. Do not assume this recipe works unchanged in an IPv6-only
environment. [Railway private networking](https://docs.railway.com/networking/private-networking/how-it-works)

The primary Knowledge source is the public GitHub repository at the protected
release branch below. Railway builds this source in the customer project;
customers do not
need publisher registry credentials or access to a private image registry.

```text
repository: https://github.com/Tealbrick/knowledge
ref: release/knowledge-v0.1.0-api-provenance.1 (protected branch)
release tag: v0.1.0-api-provenance.1 (preserved audit marker)
resolved source commit: ed71875f1a7d97bd2f20514019fc289cfce2b0db
root directory: /
Dockerfile: deploy/container/Dockerfile
service config: deploy/container/railway.json
```

Railway `templateDeployV2` receives the protected branch as its source input;
the preserved tag and resolved commit are release evidence. GitHub protection
requires one pull-request approval, includes administrators, requires linear
history and conversation resolution, and disables force-pushes and deletion.
Portal must verify the provider-resolved commit after the build and record it
against the deployment. A GHCR image may be used for an optional self-hosted
path, but anonymous image pull is not a Railway source-build gate.

## Source build

Export the allowlisted Docker context from this repository root:

```sh
KNOWLEDGE_EXPORT_ONLY=1 sh deploy/container/build-local.sh
```

For Railway, configure the Knowledge service from the public GitHub repository
and protected branch above. Use repository root as the source root, Dockerfile
`deploy/container/Dockerfile`, and config path `deploy/container/railway.json`.
Railway's build is equivalent to:

```sh
docker buildx build --platform linux/amd64 \
  --file deploy/container/Dockerfile \
  .
```

The source-build acceptance workflow runs the same Dockerfile build from the
public tag, then runs the agent-first API probe against that built image. A
successful source build does not by itself prove a Railway deployment or
template publication.

## Services and storage

Keep these exact names because variable references use them:

| Service | Source | Listen / health port | Volume | Public access |
| --- | --- | --- | --- | --- |
| `SurrealDB` | Pinned 2.6.5 digest in blueprint | 8000, `/health` | `/mydata` | None; no TCP proxy |
| `OpenNotebook` | Pinned 1.14.0 digest in blueprint | API 5055, `/health` | `/app/data` | None; UI 8502 remains private |
| `Knowledge` | Public GitHub protected release branch above; Railway builds `deploy/container/Dockerfile` | 5310, `/healthz` | `/data` | HTTPS domain targeting 5310 only |

Use one replica for every service, disable serverless sleeping, and keep all
three in the same environment/region. Begin Knowledge capacity testing with
1536MiB; this is a provisional tested-fixture target, not a workload sizing
guarantee. Budget Open Notebook and SurrealDB separately. Set a deployment
health timeout of 300 seconds. Create volumes before first application start.

Retain Open Notebook's default image entrypoint: it includes the API and command
worker. Retain Knowledge's authenticated entrypoint: it prepares `/data`
ownership then drops to UID/GID1000. Do not substitute `program/src/index.ts`,
which bypasses the edge. SurrealDB uses this non-secret start command:

```text
/surreal start --log info --bind 0.0.0.0:8000 rocksdb:/mydata/knowledge.db
```

Railway does not execute Compose or translate `depends_on`. For first manual
bootstrap, start SurrealDB and verify it, then OpenNotebook, then Knowledge.
A deployable reusable template must also pass a simultaneous cold-start/retry
test. Private service names and volumes are runtime facilities, unavailable
during an image build. [Compose translation](https://docs.railway.com/guides/docker-compose)

## Variables

Copy each service's `variables` object from the blueprint into that service's
Variables editor. Template-only `${{secret(64, "abcdef0123456789")}}` functions
generate four independent secrets. For a direct project deployment, provide
four independently generated values instead of treating that function as a
shell command. Keep reference expressions literal in Railway:

| Consumer variable | Exact reference |
| --- | --- |
| `OpenNotebook.SURREAL_URL` | `ws://${{SurrealDB.RAILWAY_PRIVATE_DOMAIN}}:8000/rpc` |
| `OpenNotebook.SURREAL_PASSWORD` | `${{SurrealDB.SURREAL_PASS}}` |
| `Knowledge.KNOWLEDGE_OPEN_NOTEBOOK_BASE_URL` | `http://${{OpenNotebook.RAILWAY_PRIVATE_DOMAIN}}:5055` |
| `Knowledge.KNOWLEDGE_OPEN_NOTEBOOK_TOKEN` | `${{OpenNotebook.OPEN_NOTEBOOK_PASSWORD}}` |

The database server expects `SURREAL_PASS`; Open Notebook expects
`SURREAL_PASSWORD`. Their values must match through the reference. The separate
Open Notebook encryption key must survive restores. Service reference syntax
and generated secrets are Railway features, not Docker environment expansion.
[Variable reference syntax](https://docs.railway.com/variables/reference),
[template secret functions](https://docs.railway.com/templates/create#template-variable-functions)

Populate Knowledge's four required operator settings from the trusted Portal
deployment record: exact `TEALBRICK_PORTAL_URL`, `TEALBRICK_DEPLOYMENT_ID`,
`KNOWLEDGE_COMPANY_ID`, and `KNOWLEDGE_PORTAL_ORG_ID`. The company ID is the
workspace ID; the Portal organization ID is the server-attested organization
binding emitted by the canonical deployment planner. Do not use Railway's
`RAILWAY_DEPLOYMENT_ID`, a canvas display name, or a browser-supplied company
or organization label as these authorities. Existing deployments created
before this variable was emitted require an explicit trusted-variable backfill
or redeploy before this contract can be accepted. No external/shared
`GBRAIN_BASE_URL` is permitted.

The current Portal deployment planner must also emit `KNOWLEDGE_PORTAL_ORG_ID`
from its server-owned organization record before an automatically provisioned
deployment can satisfy this four-variable attachment/browser contract. Until
that Portal-side change is released, set the value only from the trusted
deployment owner record; never derive it from a browser label or agent input.

`KNOWLEDGE_INSTANCE_TOKEN` is operator recovery/deployment validation only.
Connected agents receive their own agent credential plus a short-lived Portal
attachment, and send those directly to Knowledge. Do not deliver the instance
secret to Eve or another connected harness. The allowed attachment capabilities
currently cover Documents and Brain reads, not Research or fact extraction.

## Research provisioning and acceptance

The blueprint starts with empty principal and notebook-binding arrays. This
is intentionally unavailable Research, not an automatic end-to-end installation.
Use the trusted private upstream administration path to configure:

1. An intended provider credential, supplied only to OpenNotebook (optional
   `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`).
2. A saved language-model record; set its exact `model:<id>` as
   `KNOWLEDGE_OPEN_NOTEBOOK_CHAT_MODEL_ID` on Knowledge.
3. An existing local Knowledge notebook and matching upstream notebook, then
   an explicit company mapping and independent Research service principal.
   Follow [the scoped connection contract](../../docs/open-notebook-connection.md).
4. Authenticated source create/read, mapped context, chat, held/replayed receipt,
   and restart checks using synthetic data. Do not infer success from `/health`.

No model-provider key is bundled or copied from the operator. GBrain uses its
own persistent PGlite home; provider-backed reasoning/extraction/embeddings
require separate deliberate configuration. Whole-instance Brain data must
never be shared across workspace deployments.

## Release and template gates

Verify public health, missing-credential denial, scoped attachment permissions,
active Brain status and a projected document surviving restart. Record the
source branch, preserved release tag and provider-resolved commit, all three service releases, any image
digests, volume mounts, measured memory/OOM state, and Research posture.
Railway health checks gate deployment only; they do not
continuously monitor the service. Volume-attached redeploys can cause downtime.
Configure separate monitoring and test coordinated backups/restores before
production use. [Railway health checks](https://docs.railway.com/deployments/healthchecks)

After successful deployment acceptance, create a template from the three-service
project or reproduce the blueprint in Workspace → Templates → New Template.
Remove actual credentials, operator identifiers and customer mappings from its
defaults; use generated secrets and required inputs. Verify the resulting
template in a fresh isolated project. Only a returned, tested template URL
proves creation. Marketplace publication is a separate authorized action.
[Create templates](https://docs.railway.com/templates/create),
[publish and share](https://docs.railway.com/templates/publish-and-share)
