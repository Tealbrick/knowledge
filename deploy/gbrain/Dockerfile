# Unmodified upstream GBrain (github.com/garrytan/gbrain, MIT) as a separate
# Knowledge memory-engine service. No Tealbrick patches are applied: the build
# fetches the pinned commit by SHA, verifies it, and installs from upstream's
# lockfile. Only the entrypoint (owner-side provisioning) is Tealbrick's.
FROM oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef

ARG GBRAIN_REPOSITORY=https://github.com/garrytan/gbrain.git
ARG GBRAIN_COMMIT=99de5707f6fc0916f43b4c167802a5f8d9ea0cf0
ARG GBRAIN_VERSION=0.60.57.0

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/gbrain
RUN git init -q . \
  && git remote add origin "$GBRAIN_REPOSITORY" \
  && git fetch -q --depth 1 origin "$GBRAIN_COMMIT" \
  && git checkout -q FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "$GBRAIN_COMMIT" \
  && test "$(cat VERSION)" = "$GBRAIN_VERSION" \
  && git status --porcelain | (! grep .) \
  && rm -rf .git \
  && bun install --frozen-lockfile --production --ignore-scripts

COPY entrypoint.sh /usr/local/bin/knowledge-gbrain-entrypoint
RUN chmod 0755 /usr/local/bin/knowledge-gbrain-entrypoint \
  && useradd --uid 1000 --create-home gbrain \
  && mkdir -p /data && chown gbrain:gbrain /data

ENV GBRAIN_HOME=/data \
    GBRAIN_HTTP_TRUST_PROXY=1 \
    PORT=3131
LABEL org.opencontainers.image.source="https://github.com/Tealbrick/knowledge" \
      org.opencontainers.image.description="Unmodified upstream GBrain service for Tealbrick Knowledge" \
      dev.tealbrick.gbrain.commit="99de5707f6fc0916f43b4c167802a5f8d9ea0cf0" \
      dev.tealbrick.gbrain.version="0.60.57.0"
USER gbrain
EXPOSE 3131
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/knowledge-gbrain-entrypoint"]
