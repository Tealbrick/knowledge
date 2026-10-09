# Deploying Knowledge

## Container layout

The standalone repository includes the Program, bundled memory sidecar and UI SDK. `deploy/container/build-local.sh` prepares the build layout expected by the Dockerfile without requiring a portfolio checkout. Run it from this repository; `KNOWLEDGE_EXPORT_ONLY=1` performs an export only.

The edge listens on port 5310 by default and starts the internal Program on loopback. Use this authenticated edge for remote deployments. Configure a distinct instance recovery credential, and separate narrowly scoped service principals for agents. Never expose the internal Program or memory administration endpoint publicly.

## Runtime package boundary

The production image is immutable: install and update OS packages during image builds, then deploy the replacement image. It does not include apt, Perl, mount/namespace tools, or filesystem administration utilities. Keep host administration and custom package installation outside this container. Shells and GNU tar/gzip remain for health checks and the bundled skillpack implementation.

The default launcher briefly runs as root to initialize the mounted data directory, then drops supplementary groups and runs the application as UID/GID 1000. Docker exec and overridden commands do not inherit that privilege drop; use `docker exec --user 1000:1000` for application diagnostics. Do not treat the image as a general-purpose root shell or grant it privileged host access.

## Persistent data

Attach a persistent `/data` volume. Keep the complete volume and any separately configured Research storage in a coordinated backup plan. Use one instance per customer workspace until multi-tenant deployment acceptance says otherwise. Record the deployed image digest and back up before upgrades.

## Upgrading existing indexes

The privacy fixes sanitize every Facts/Takes fence before new indexing and remote reads. They do not retroactively remove text from chunks or embeddings written by an older release. Before exposing an upgraded instance to agents, back up its complete state, rebuild derived indexes from canonical documents in an isolated restored copy, and verify remote searches with private-content canaries. Do not treat an image replacement alone as proof that an existing index is clean. Keep remote access disabled until this migration is verified for that deployment.

## Transferring a build context from macOS

Export with `KNOWLEDGE_EXPORT_ONLY=1` and transfer only the printed disposable context. When archiving it on macOS, use `COPYFILE_DISABLE=1 tar --disable-copyfile --no-xattrs -czf context.tar.gz -C <export-directory> .` to avoid AppleDouble metadata files entering the Linux image. Inspect the archive before building; do not transfer the full operator checkout.

## Railway

The primary Railway path is source-backed. Portal supplies the public
`Tealbrick/knowledge` repository at protected branch
`release-knowledge-v0.5.1`, fixed at reviewed commit
`11361dbd5c2ccd2a78f886ee4c09f5d2815a1578`; the preserved release tag is
`v0.5.1`. Railway builds
`deploy/container/Dockerfile` in the customer's project and Portal verifies the
provider-resolved commit before accepting the deployment. The generated
blueprint remains a specification until Portal creates and publishes the
template. An OCI image is optional and is not a deployment gate.

The source-build acceptance workflow builds the public source checkout and runs
the agent-first API probe against the resulting image. It proves synthetic
ingestion, retrieval, actor provenance, partition denial, restart persistence
and cold-volume restore; it does not prove a live
Railway deployment or human UAT.

A successful deployment must demonstrate authenticated access, rejection of missing/wrong credentials, scoped agent access and revocation, durable writes across restart, and recovery. `/healthz` is only a liveness check.

## Optional Research

Research requires a separately configured Open Notebook service and its storage, model/provider configuration, scoped principals and notebook bindings. See [the connection guide](open-notebook-connection.md). A bundled memory engine does not supply this Research service automatically.

## Current limitations

This document describes packaging and required acceptance. It does not assert a
created Railway template, deployed service, complete Research setup or
production security clearance. Public releases must include their immutable
source branch, preserved release tag and resolved commit, supported configuration and verification
record. Optional image evidence is recorded separately.
