#!/usr/bin/env bash
# Tensol production one-shot deploy for Timeweb VM (5.42.106.25).
#
# Idempotent — safe to re-run. First invocation provisions packages, repo,
# build artefacts, env-file scaffold, and Caddy. Subsequent runs pull the
# latest branch, rebuild, and reload services.
#
# Usage (on the VM, as root or with sudo):
#
#   curl -fsSL https://raw.githubusercontent.com/Ageree/tensol/002-blackbox-mvp/infra/prod/deploy.sh \
#     | sudo bash
#
# Or, once the repo is already cloned at /opt/tensol/repo:
#
#   sudo /opt/tensol/repo/infra/prod/deploy.sh
#
# Required env file: /opt/tensol/.env.prod  (template: .env.prod.example).
# The script aborts if it is missing or unfilled.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Ageree/tensol.git}"
REPO_BRANCH="${REPO_BRANCH:-002-blackbox-mvp}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/tensol}"
REPO_DIR="$DEPLOY_DIR/repo"
ENV_FILE="$DEPLOY_DIR/.env.prod"
SITE_DIST="$DEPLOY_DIR/site-dist"
COMPOSE_FILE="$REPO_DIR/infra/prod/docker-compose.prod.yml"
CADDYFILE_SRC="$REPO_DIR/infra/prod/Caddyfile"
CADDYFILE_DST="/etc/caddy/Caddyfile"

log() { printf '\n\033[1;36m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[deploy:ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (or with sudo)."

# -------------------------------------------------------------
log "1/8  System packages (docker, caddy, git, rsync, curl)"
# -------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y

# Install ca-certs + curl first so the Caddy apt repo TLS works.
apt-get install -y ca-certificates curl gnupg lsb-release rsync git

# Docker Engine + compose plugin (Docker's official repo).
if ! command -v docker >/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    UBU_CODENAME="$(lsb_release -cs)"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $UBU_CODENAME stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
fi

# Caddy (official Cloudsmith repo).
if ! command -v caddy >/dev/null; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
        > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
fi

# -------------------------------------------------------------
log "2/8  Repo sync ($REPO_URL @ $REPO_BRANCH -> $REPO_DIR)"
# -------------------------------------------------------------
mkdir -p "$DEPLOY_DIR"
if [[ ! -d $REPO_DIR/.git ]]; then
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR"
else
    git -C "$REPO_DIR" fetch origin "$REPO_BRANCH"
    git -C "$REPO_DIR" checkout "$REPO_BRANCH"
    git -C "$REPO_DIR" reset --hard "origin/$REPO_BRANCH"
fi

# -------------------------------------------------------------
log "3/8  Env-file check ($ENV_FILE)"
# -------------------------------------------------------------
if [[ ! -f $ENV_FILE ]]; then
    install -m 600 "$REPO_DIR/infra/prod/.env.prod.example" "$ENV_FILE"
    chown root:root "$ENV_FILE"
    die "Created $ENV_FILE from template. Edit it (fill REPLACE_ME values) and re-run."
fi
if grep -q 'REPLACE_ME' "$ENV_FILE"; then
    die "$ENV_FILE still contains REPLACE_ME placeholders. Fill them and re-run."
fi
chmod 600 "$ENV_FILE"

# -------------------------------------------------------------
log "4/9  GCP service-account credential perms"
# -------------------------------------------------------------
# The server container runs as the oven/bun image's `bun` user (uid 1000) and
# mounts /opt/tensol/.gcp read-only (see docker-compose.prod.yml). On the
# first GCP spawn, google-auth-library fs.readFile()s the SA JSON named by
# GOOGLE_APPLICATION_CREDENTIALS. If that file is mode 600 owned by root, the
# container user cannot read it and EVERY scan fails auth (then dangles in
# vm_provisioning). The operator drops the key into .gcp out-of-band, so we
# normalize perms here every deploy: dir traversable, *.json readable by the
# container uid. (Single-tenant host — world-readable JSON is acceptable; the
# key is already on this disk in .env.prod.) Idempotent + skips cleanly when
# the GCP rail is not provisioned on this host.
GCP_CREDS_DIR="$DEPLOY_DIR/.gcp"
if [[ -d $GCP_CREDS_DIR ]]; then
    chmod 0755 "$GCP_CREDS_DIR"
    if compgen -G "$GCP_CREDS_DIR/*.json" >/dev/null; then
        find "$GCP_CREDS_DIR" -maxdepth 1 -name '*.json' -exec chmod 0644 {} +
        log "  normalized $GCP_CREDS_DIR (dir 0755, *.json 0644) for container uid 1000"
    else
        log "  $GCP_CREDS_DIR exists but holds no *.json — drop the SA key there if using the GCP rail"
    fi
else
    log "  $GCP_CREDS_DIR absent — skipping (GCP rail not provisioned on this host)"
fi

# -------------------------------------------------------------
log "5/9  Build apps/site (static SPA) -> $SITE_DIST"
# -------------------------------------------------------------
mkdir -p "$SITE_DIST" "$DEPLOY_DIR/data" "$DEPLOY_DIR/chrome-cache"
docker run --rm \
    -v "$REPO_DIR:/repo" \
    -w /repo \
    oven/bun:1.3.11-alpine \
    sh -c "bun install --frozen-lockfile && cd apps/site && bun run build"
rsync -a --delete "$REPO_DIR/apps/site/dist/" "$SITE_DIST/"

# -------------------------------------------------------------
log "6/9  Build server image (tensol-server:latest)"
# -------------------------------------------------------------
docker build \
    -t tensol-server:latest \
    -f "$REPO_DIR/server/Dockerfile" \
    "$REPO_DIR"

# -------------------------------------------------------------
log "7/9  DB migrate"
# -------------------------------------------------------------
# Use the bun-native migrator (server/scripts/migrate.ts), NOT
# `drizzle-kit migrate`. The drizzle-kit migrator relies on
# `server/migrations/meta/_journal.json`, which historically lagged
# behind the `.sql` files (0010_blackbox_mvp / 0011_webhook_dedup were
# missing on 2026-05-21 → production DB stayed on the legacy 001
# schema → all POST routes returned 500 with "no such table:
# pending_signups"). The bun migrator discovers `.sql` files by
# directory listing and tracks its own `__migrations` table, so a
# stale journal cannot cause schema drift again.
docker run --rm \
    --env-file "$ENV_FILE" \
    -v "$DEPLOY_DIR/data:/app/server/data" \
    -w /app/server \
    tensol-server:latest \
    bun run scripts/migrate.ts

# -------------------------------------------------------------
log "8/9  Start server stack (docker compose up -d)"
# -------------------------------------------------------------
cd "$REPO_DIR/infra/prod"
docker compose -f docker-compose.prod.yml up -d --build

# -------------------------------------------------------------
log "9/9  Caddy config"
# -------------------------------------------------------------
install -m 0644 "$CADDYFILE_SRC" "$CADDYFILE_DST"
caddy validate --config "$CADDYFILE_DST"
systemctl enable --now caddy
systemctl reload caddy

log "Done."
cat <<EOF

  Public endpoints:
    https://tensol.ru
    https://www.tensol.ru      (redirects to apex)
    https://app.tensol.ru
    https://api.tensol.ru/healthz

  Verify (from this VM):
    curl -fsS http://127.0.0.1:3000/healthz
    curl -fsS https://api.tensol.ru/healthz

  Logs:
    docker logs -f tensol-server
    journalctl -u caddy -f

  Redeploy after a code change:
    sudo /opt/tensol/repo/infra/prod/deploy.sh

EOF
