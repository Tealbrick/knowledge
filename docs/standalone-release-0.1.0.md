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
- Source tag: `v0.1.0`.
- OCI image target: `ghcr.io/tealbrick/knowledge@sha256:<published digest>`
  (the current GHCR package remains private pending organization policy).
- Agent package target: `@tealbrick/knowledge-agent@0.1.0` (npm publication
  remains pending its required one-time-password step).

The image digest and package integrity are filled from publication receipts,
not inferred from a source build or mutable tag. Portal consumers must use the
exact digest-pinned image and their own server-attested deployment/org binding.
The current source receipt therefore does not claim a public image, anonymous
pull, npm publication, formal GitHub release, live deployment, or human UAT.

## Acceptance evidence

Source and deterministic evidence:

- Program typecheck, 390 Program tests and 59 web tests pass.
- Container edge, browser-auth, browser-edge and customer-runtime edge tests
  pass against disposable state.
- The agent adapter tests, extension build and npm pack inspection pass.
- The source tree contains no Boardstate API surface and no operator runtime
  state, credentials, databases or local environment files.
- CI run 37125063563 built and pushed the private OCI artifact
  `ghcr.io/tealbrick/knowledge@sha256:106d4dff58046bb1fe5264c81a2c5fb7ca46a9e776b4055bad51f0cea5fee5e4`.
  Its authenticated agent consumer proved the listed runtime checks and
  measured a container memory peak of 114073600 bytes (about 108.8 MiB) under
  a 1.5 GiB test limit.

Image evidence is supplied by the image CI workflow. The consumer job pulls
the exact published digest with the smallest registry credential currently
available and proves agent authentication, partition isolation, denied
cross-partition access, volume restart persistence, cold-volume restore, and
a container memory measurement. If the registry package is public, the same
job must be rerun without registry credentials to establish anonymous-pull
evidence. A successful image pull or `/healthz` response alone is not
deployment or human-UAT proof.

## Known boundaries

Research provider/model configuration, real Brain quality, Portal entitlement,
customer deployment, backup custody, and named human UAT remain separate
acceptance records. The GHCR package is still private: an unauthenticated
manifest probe returned HTTP 401, so anonymous pull and public-image readiness
are not proven. The GitHub release is not created and the npm package is not
published. The optional Portal attachment path is not a substitute for direct
Knowledge principal authorization.
