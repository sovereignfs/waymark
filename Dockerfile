# This app as one image (contracts/app-manifest.md §4): a process that is not root, configured by its environment alone, listening on
# the port its manifest names, that applies its own migrations when it starts.
#
# The manifest (sovereign.manifest.json) is the one place the port is written, and the image's label is made from it, so build with the
# arguments @sovereignfs/manifest prints from it:
#
#   eval "docker build $(pnpm exec sovereign-manifest docker-args) -t waymark ."
#
# The base is Debian ("glibc"), not Alpine: libSQL's native client, which the `file:` form of the database loads, has no build for musl
# (DESIGN.md §24.1), and neither has `sharp`'s libvips build the app re-encodes photos with (3.2). The sqld and PostgreSQL forms would run on
# either, but one image has to run all three.

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.28.9

# --- Build ---------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
# Dependencies first, from the lockfile alone, so they are not fetched again for a change to the source. pnpm-workspace.yaml carries pnpm's
# settings (the platforms the lockfile covers, which include glibc's, and the install scripts that are allowed), so the install needs it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build
# The licences of what is built in and is not ours, collected where they are and kept in the image (DESIGN.md §25 Licence): sharp (Apache-2.0) and libvips (LGPL-3.0, a
# dynamically linked library that sharp's platform package carries), whose text sharp's own README asks to accompany copies. The build stops if either is missing.
RUN mkdir /licenses \
 && cp node_modules/sharp/LICENSE /licenses/sharp.LICENSE \
 && libvips="$(find node_modules/.pnpm -path '*@img/sharp-libvips-linux-*/LICENSE' | head -n 1)" \
 && test -n "$libvips" && cp "$libvips" /licenses/libvips.LICENSE \
 && test -s /licenses/sharp.LICENSE && test -s /licenses/libvips.LICENSE

# --- What runs -----------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# The port comes from the manifest, as the build argument sovereign-manifest docker-args gives. A build without it would listen where the
# instance does not look, so it stops here.
ARG PORT
RUN test -n "${PORT}" || { echo 'Build with: eval "docker build $(pnpm exec sovereign-manifest docker-args) ."' >&2; exit 1; }

LABEL org.opencontainers.image.title="Waymark" \
      org.opencontainers.image.description="Check in where you are, plan trips with the people going, and look back on everywhere you have been" \
      org.opencontainers.image.source="https://github.com/sovereignfs/waymark" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=${PORT} \
    HOSTNAME=0.0.0.0

WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# The icons and the other files served as they are (`public/`), which `next build` leaves out of the standalone output.
COPY --from=build --chown=node:node /app/public ./public
# The migrations are read from disk when the server starts, and Next does not trace them.
COPY --from=build --chown=node:node /app/migrations ./migrations

# Licences travel with the image: ours, and the design system's NOTICE, which carries Lucide's ISC licence and asks that it accompany copies (a
# standalone build prunes it). The licences of what joins later (MapLibre, the time-zone table, the map's fonts) are added by the
# tasks that add them (DESIGN.md §25 Licence).
COPY --from=build /app/LICENSE /usr/share/licenses/waymark/LICENSE
COPY --from=build /app/node_modules/@sovereignfs/ui/LICENSE /usr/share/licenses/sovereignfs-ui/LICENSE
COPY --from=build /app/node_modules/@sovereignfs/ui/NOTICE /usr/share/licenses/sovereignfs-ui/NOTICE
COPY --from=build /licenses/sharp.LICENSE /usr/share/licenses/sharp/LICENSE
COPY --from=build /licenses/libvips.LICENSE /usr/share/licenses/libvips/LICENSE

# Everything the app writes is under /data (the manifest's `data`): the database file when the instance keeps one (WAYMARK_SQLITE_URL=file:/data/waymark.db),
# and the photos, files, imports and the map's cache that later tasks add. The directory is the app's user's, so that a volume made from it is too.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE ${PORT}

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
