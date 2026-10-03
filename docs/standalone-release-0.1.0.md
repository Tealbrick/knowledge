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
- OCI image: `ghcr.io/tealbrick/knowledge@sha256:<published digest>`.
- Agent package: `@tealbrick/knowledge-agent@0.1.0`.

The image digest and package integrity are filled from the publication receipts,
not inferred from a source build or mutable tag. Portal consumers must use the
exact digest-pinned image and their own server-attested deployment/org binding.

## Acceptance evidence

Source and deterministic evidence:

- Program typecheck, 390 Program tests and 59 web tests pass.
- Container edge, browser-auth, browser-edge and customer-runtime edge tests
  pass against disposable state.
- The agent adapter tests, extension build and npm pack inspection pass.
- The source tree contains no Boardstate API surface and no operator runtime
  state, credentials, databases or local environment files.

Image evidence is supplied by the public-image CI workflow. Its anonymous
consumer job pulls the exact public digest and proves agent authentication,
partition isolation, denied cross-partition access, volume restart persistence,
cold-volume restore, and a container memory measurement. A successful image
pull or `/healthz` response alone is not deployment or human-UAT proof.

## Known boundaries

Research provider/model configuration, real Brain quality, Portal entitlement,
customer deployment, backup custody, and named human UAT remain separate
acceptance records. The optional Portal attachment path is not a substitute for
direct Knowledge principal authorization.
