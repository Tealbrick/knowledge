# Knowledge 0.1.0 release receipt

This document records the standalone, agent-first release boundary. It is
separate from hosted Portal or customer deployment acceptance.

## Product contract

Knowledge is an HTTP Program with a thin browser surface and trusted agent
adapters. Direct agent requests use server-configured Knowledge principals and
partition grants. The principal's capability ceiling is intersected with the
matching partition grant on every operation; callers cannot widen scope by
submitting a different agent label, company path, or partition selector.

The instance token is for operator recovery and deployment validation only. It
is never an agent credential. Research and native Brain operations keep their
separate typed authorization contracts. Boardstate is not a product dependency
or authority.

## Immutable release outputs

- Source repository: the public `Tealbrick/knowledge` repository.
- Source tag: `v0.1.0-api-provenance.1`.
- Resolved source commit: `ed71875f1a7d97bd2f20514019fc289cfce2b0db`.
- Railway distribution: Portal-owned source-backed template/service. Railway
  builds the public repository in the customer project from the source tag;
  Portal records the provider-resolved commit before acceptance. No template
  URL is claimed until Portal creates and tests it.
- Optional OCI image: `ghcr.io/tealbrick/knowledge` (the current GHCR package
  remains private; this is not a Railway source-build prerequisite).
- Agent package: `@tealbrick/knowledge-agent@0.1.0`, published with registry
  integrity `sha512-LAI1xHKwQa4N5jMiyrUz/duGx6Rgdz+9IxEkEJrq7SqysQO7XCVMMGJbgaz9XfGA2F9zdUts3FNlwK+k4P91/w==`.

The source commit and package integrity are recorded from public-source and
registry evidence, not inferred from a mutable branch. Portal consumers use
their own server-attested deployment/org binding. The current source receipt
does not claim a created Railway template, live deployment, formal GitHub
release, or human UAT.

## Acceptance evidence

Source and deterministic evidence:

- Program typecheck, 390 Program tests and 59 web tests pass.
- Container edge, browser-auth, browser-edge and customer-runtime edge tests
  pass against disposable state.
- The agent adapter tests, extension build and npm pack inspection pass.
- The source tree contains no Boardstate API surface and no operator runtime
  state, credentials, databases or local environment files.
- Historical CI run 37125063563 built and pushed the private OCI artifact
  `ghcr.io/tealbrick/knowledge@sha256:106d4dff58046bb1fe5264c81a2c5fb7ca46a9e776b4055bad51f0cea5fee5e4`.
- Its authenticated agent consumer proved agent authentication, partition
  isolation, volume restart persistence, cold-volume restore, and measured a
  container memory peak of 114073600 bytes (about 108.8 MiB) under a 1.5 GiB
  test limit. It is image evidence, not anonymous-pull or Railway evidence.
- The source-build acceptance workflow builds the public source checkout from
  the immutable tag and runs the current agent-first API probe against the
  resulting image. The probe covers synthetic ingestion, retrieval, actor
  provenance, projection-event evidence, partition denial, restart persistence,
  and cold-volume restore.
- The npm registry serves the exact 20-file adapter tarball with the reviewed
  shasum `4b38d0fd8a80d708f25c750ef0f111cc0ac817ea`, matching the reviewed
  local pack. A clean consumer install imported the MCP/client entrypoints and
  the root Eve extension when its declared `eve@0.58.1` peer was installed.

Image evidence is supplied by the optional image CI workflow. The consumer job
pulls the exact published digest with the smallest registry credential currently
available and proves the image-specific runtime checks. A successful image pull
or `/healthz` response alone is not deployment or human-UAT proof.

## Known boundaries

Research provider/model configuration, real Brain quality, Portal entitlement,
customer deployment, backup custody, Railway template creation/publication, and
named human UAT remain separate acceptance records. The GHCR package is still
private: an unauthenticated manifest probe returned HTTP 401, so anonymous pull
is not proven; it is also not required for the source-backed Railway path. The
GitHub release is not created and live deployment or human UAT remain unproven.
The optional Portal attachment path is not a substitute for direct Knowledge
principal authorization.
