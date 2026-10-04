# Build context: the standalone Knowledge repository root.
FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e AS bun
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node-base

# Build patched Debian source packages natively for Bookworm. Keeping this as a
# separate target lets CI and reviewers export the exact .deb and source inputs.
FROM node-base AS os-backports-build
COPY deploy/container/os-backports /tmp/os-backports
RUN chmod +x /tmp/os-backports/build.sh && /tmp/os-backports/build.sh

FROM scratch AS os-backports-artifacts
COPY --from=os-backports-build /out/ /

FROM node-base AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY LICENSE THIRD_PARTY_NOTICES.md /app/knowledge/
COPY licenses /app/knowledge/licenses
WORKDIR /app/knowledge/program
COPY program/package.json program/pnpm-lock.yaml program/tsconfig.json program/LICENSE ./
RUN pnpm install --frozen-lockfile
COPY sidecars/gbrain /app/knowledge/sidecars/gbrain
RUN cd /app/knowledge/sidecars/gbrain && bun install --frozen-lockfile --ignore-scripts
RUN cd /app/knowledge/sidecars/gbrain/admin && bun install --frozen-lockfile --ignore-scripts \
    && cd .. && bun run build:admin \
    && bun -e 'await import("./src/admin-embedded.ts"); console.log("Embedded admin assets verified")'
COPY program/src ./src
COPY program/web ./web
COPY .sdk/tealbrick-ui /app/.sdk/tealbrick-ui
RUN pnpm build:web \
    && cp -R /app/knowledge/licenses ./web-dist/licenses \
    && cp -R /app/.sdk/tealbrick-ui/assets/fonts/licenses ./web-dist/licenses/fonts
COPY deploy/container/server.ts deploy/container/entrypoint.mjs deploy/container/attachment-auth.mjs deploy/container/browser-auth.mjs deploy/container/package.json deploy/container/LICENSE /app/knowledge/deploy/container/
RUN rm -rf /app/knowledge/sidecars/gbrain/node_modules /app/knowledge/sidecars/gbrain/admin/node_modules \
    && cd /app/knowledge/sidecars/gbrain \
    && bun install --production --frozen-lockfile --ignore-scripts

# Build a production Program dependency tree, keeping tsx because the runtime
# entrypoint deliberately imports the TypeScript server and Program modules.
FROM node-base AS program-runtime-deps
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app/knowledge/program
COPY program/package.json program/pnpm-lock.yaml ./
RUN node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); const v=p.devDependencies?.tsx; if(!v) throw Error("tsx runtime dependency is missing"); p.dependencies={...p.dependencies,tsx:v}; delete p.devDependencies.tsx; fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n"); const lockPath="pnpm-lock.yaml"; let lock=fs.readFileSync(lockPath,"utf8"); const entry=`      tsx:\n        specifier: ${v}\n        version: ${v}\n`; if(lock.split(entry).length!==2) throw Error("Expected one locked tsx importer entry"); const devStart=lock.indexOf("    devDependencies:\n"); const depsStart=lock.indexOf("    dependencies:\n"); if(devStart<0||depsStart<0||devStart<depsStart) throw Error("Unexpected lockfile importer shape"); const entryAt=lock.indexOf(entry,devStart); if(entryAt<0) throw Error("tsx lock entry is not under devDependencies"); lock=lock.slice(0,entryAt)+lock.slice(entryAt+entry.length); lock=lock.slice(0,devStart)+entry+lock.slice(devStart); fs.writeFileSync(lockPath,lock)' \
    && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node-base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5310 KNOWLEDGE_DATA_DIR=/data KNOWLEDGE_GBRAIN_HOME=/data/gbrain-home KNOWLEDGE_GBRAIN_AUTOSTART=true
COPY --from=os-backports-build /out/runtime/ /tmp/os-backports/runtime/
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends ca-certificates \
    && apt-get install -y --no-install-recommends /tmp/os-backports/runtime/*.deb \
    # Immutable application runtime: update packages at build time only.
    # These distro-Essential tools are not application dependencies. Keep
    # sh/bash, tar/gzip and their libraries for health checks and skillpacks.
    && apt-get purge -y --allow-remove-essential \
      apt libapt-pkg6.0 bsdutils e2fsprogs \
      util-linux util-linux-extra mount libblkid1 libmount1 libsmartcols1 libuuid1 \
      libsystemd0 libudev1 ncurses-bin \
    # Purge hooks above require Perl; remove it only after they finish.
    && dpkg --purge --force-remove-essential perl-base \
    && rm -rf /var/lib/apt/lists/* /root/.cache/* /tmp/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY LICENSE THIRD_PARTY_NOTICES.md /app/knowledge/
COPY licenses /app/knowledge/licenses
COPY program/LICENSE /app/knowledge/program/LICENSE
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app/knowledge/program
COPY --from=program-runtime-deps /app/knowledge/program/node_modules ./node_modules
COPY --from=build /app/knowledge/program/package.json /app/knowledge/program/tsconfig.json ./
COPY --from=build /app/knowledge/program/src ./src
COPY --from=build /app/knowledge/program/web-dist ./web-dist
COPY --from=build /app/knowledge/sidecars/gbrain /app/knowledge/sidecars/gbrain
COPY --from=build /app/knowledge/deploy/container /app/knowledge/deploy/container
RUN find / -xdev -type f -perm /6000 -print -exec chmod a-s {} + \
    && mkdir /data && chown node:node /data
EXPOSE 5310
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "../deploy/container/entrypoint.mjs"]
