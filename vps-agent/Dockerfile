# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM oven/bun:1-slim AS builder
WORKDIR /app

# Copy manifest first for layer caching
COPY package.json ./

# No bun.lock in this package (monorepo lockfile lives at repo root).
# Install only production dependencies inside the image.
RUN bun install --production

# Copy source
COPY tsconfig.json ./
COPY src ./src

# ---------- runtime ----------
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# docker-cli + compose plugin are required because the agent invokes
# `docker compose up` inside the VPS via the mounted /var/run/docker.sock.
# Source from Docker's official Debian repo (not Debian's `docker.io`
# package, which silently did NOT install in earlier builds — confirmed
# by `which docker` returning nothing on the 2026-05-21 image and
# `runner_threw_Executable not found in $PATH: "docker"` at scan time).
# `docker compose` (plugin, no hyphen) is the modern entrypoint that
# decepticon-runner.ts spawns; the legacy `docker-compose` binary is
# NOT what we want.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && apt-get purge -y curl gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./

ENV PORT=8080 \
    NODE_ENV=production
EXPOSE 8080

CMD ["bun", "run", "src/agent.ts"]
