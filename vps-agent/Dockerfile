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

# docker-cli is required because the agent invokes `docker compose up`
# inside the VPS via the mounted /var/run/docker.sock (docker-in-docker).
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./

ENV PORT=8080 \
    NODE_ENV=production
EXPOSE 8080

CMD ["bun", "run", "src/agent.ts"]
