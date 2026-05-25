# syntax=docker/dockerfile:1.7
#
# Tensol backend (server) — production image.
#
# Multi-stage build:
#   1. deps:    install monorepo deps with --frozen-lockfile
#   2. runtime: copy node_modules + server source, run as non-root
#
# Build context = repo root (because we need root package.json + bun.lock for
# the workspace install). Invoke from infra/prod/docker-compose.prod.yml or
# manually:
#
#   docker build -t tensol-server:latest -f server/Dockerfile .
#
# Resulting image runs `bun run src/server.ts` on PORT 3000.

# ----- stage 1: deps -----
FROM oven/bun:1.3.11-alpine AS deps

# Native-addon toolchain for transitive deps that ship a C/C++ binding
# (e.g. better-sqlite3, sharp). Without this, `bun install` on alpine
# falls back to source builds that fail. Promoted from a manual VM patch
# applied during master deploy v2 — see `fix(deploy)` commit.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Monorepo manifests required for the workspace install. We deliberately
# copy package.json files (not the whole tree) so changes inside src/ don't
# bust this layer.
COPY package.json bun.lock ./
COPY server/package.json ./server/
COPY apps/site/package.json ./apps/site/
COPY vps-agent/package.json ./vps-agent/

# Reproducible install. Bun honours the workspace pin in package.json.
RUN bun install --frozen-lockfile

# ----- stage 2: runtime -----
FROM oven/bun:1.3.11-alpine AS runtime

# wget needed for HEALTHCHECK; tini for proper PID-1 signal handling.
# chromium + deps: the PDF report renderer (reports/pdf.ts) needs a runnable
# headless browser. @sparticuz/chromium-min ships a glibc-linked binary that
# CANNOT execute on Alpine (musl) — posix_spawn fails with ENOENT (fix D2
# 2026-05-25). Alpine's own `chromium` package is musl-native; pdf.ts points
# puppeteer-core at it via CHROMIUM_EXECUTABLE_PATH below. nss/freetype/
# harfbuzz/ttf-freefont are chromium's runtime + font deps.
RUN apk add --no-cache wget tini ca-certificates \
    chromium nss freetype harfbuzz ttf-freefont

WORKDIR /app

# Bring installed node_modules from the deps stage.
COPY --from=deps /app/node_modules ./node_modules
# Workspace `server` symlinks live here — without this the runtime stage
# starts with `cannot find module` on bun:sqlite consumers. Promoted from
# a manual VM patch applied during master deploy v2.
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/package.json /app/bun.lock ./
COPY --from=deps /app/server/package.json ./server/

# Application sources.
COPY server/src        ./server/src
COPY server/migrations ./server/migrations
COPY server/scripts    ./server/scripts
COPY server/drizzle.config.ts ./server/

# T128 Bug #7 — Decepticon stack assets embedded into the per-scan VM
# cloud-init by `server/src/vps/decepticon-embedded.ts`. Reads the three
# files at module-load time via `import.meta.dirname/../../../infra/
# decepticon-overrides/`, which resolves to `/app/infra/...` in this
# image. Without this COPY, the server crashes at boot with
# "required override not found".
COPY infra/decepticon-overrides ./infra/decepticon-overrides

# SQLite + chromium-min cache live under /app/server/data (mounted volume in
# compose). Create the directory and chown it so the non-root bun user can
# write at runtime.
RUN mkdir -p /app/server/data /home/bun/.cache/puppeteer \
 && chown -R bun:bun /app /home/bun

USER bun
WORKDIR /app/server

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_CACHE_DIR=/home/bun/.cache/puppeteer \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "src/server.ts"]
