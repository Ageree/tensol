#!/usr/bin/env bash
# Sthrip production one-shot deploy for the GCP API VM.
#
# Current prod target: GCP project tensol-scanners, VM sthrip-api-prod,
# zone europe-west1-b, api.sthrip.dev -> 34.156.105.67.
# The older Timeweb/GCP deployment is legacy only.
#
# Idempotent — safe to re-run. First invocation provisions packages, repo,
# build artefacts, env-file scaffold, and Caddy. Subsequent runs pull the
# latest branch, rebuild, and reload services.
#
# Usage (on the VM, as root or with sudo):
#
#   gcloud compute ssh sthrip-api-prod \
#     --project=tensol-scanners \
#     --zone=europe-west1-b
#
# Or, once the repo is already cloned at /opt/tensol/repo:
#
#   sudo REPO_REF=<reviewed-tag-or-commit-sha> /opt/tensol/repo/infra/prod/deploy.sh
#
# Required env file:
#   /opt/tensol/.env.prod
#
# Optional until enabled:
#   /opt/tensol/.env.pr-execution-worker
#
# The worker env file is required only when STHRIP_PR_EXECUTION_WORKER_ENABLED
# or STHRIP_PR_EXECUTION_ENABLED is true.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Ageree/tensol.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
REPO_REF="${REPO_REF:-}"
ALLOW_MOVING_PROD_REF="${ALLOW_MOVING_PROD_REF:-false}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/tensol}"
REPO_DIR="$DEPLOY_DIR/repo"
ENV_FILE="$DEPLOY_DIR/.env.prod"
WORKER_ENV_FILE="$DEPLOY_DIR/.env.pr-execution-worker"
SITE_DIST="$DEPLOY_DIR/site-dist"
COMPOSE_FILE="$REPO_DIR/infra/prod/docker-compose.prod.yml"
CADDYFILE_SRC="$REPO_DIR/infra/prod/Caddyfile"
CADDYFILE_DST="/etc/caddy/Caddyfile"

log() { printf '\n\033[1;36m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[deploy:ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (or with sudo)."

# -------------------------------------------------------------
log "1/10  System packages (docker, caddy, git, rsync, curl)"
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
DEPLOY_REF_LABEL="${REPO_REF:-origin/$REPO_BRANCH}"
log "2/10  Repo sync ($REPO_URL @ $DEPLOY_REF_LABEL -> $REPO_DIR)"
# -------------------------------------------------------------
mkdir -p "$DEPLOY_DIR"
if [[ ! -d $REPO_DIR/.git ]]; then
    git clone "$REPO_URL" "$REPO_DIR"
else
    git -C "$REPO_DIR" fetch origin "$REPO_BRANCH"
fi
git -C "$REPO_DIR" fetch --tags origin "$REPO_BRANCH"
if [[ -n $REPO_REF ]]; then
    git -C "$REPO_DIR" checkout --detach "$REPO_REF"
elif [[ $ALLOW_MOVING_PROD_REF == "true" ]]; then
    git -C "$REPO_DIR" checkout "$REPO_BRANCH"
    git -C "$REPO_DIR" reset --hard "origin/$REPO_BRANCH"
else
    die "Set REPO_REF to a reviewed tag/commit SHA. For an emergency moving-branch deploy, set ALLOW_MOVING_PROD_REF=true."
fi

# -------------------------------------------------------------
log "3/10  Env-file check ($ENV_FILE)"
# -------------------------------------------------------------
if [[ ! -f $ENV_FILE ]]; then
    install -m 600 "$REPO_DIR/infra/prod/.env.prod.example" "$ENV_FILE"
    chown root:root "$ENV_FILE"
    die "Created $ENV_FILE from template. Edit it (fill REPLACE_ME values) and re-run."
fi
chmod 600 "$ENV_FILE"

read_env_file_value() {
    local file="$1"
    local key="$2"
    awk -F= -v key="$key" '
        $1 == key {
            value = substr($0, length(key) + 2)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
            sub(/^"/, "", value)
            sub(/"$/, "", value)
            print value
            exit
        }
    ' "$file"
}

read_env_value() {
    local key="$1"
    read_env_file_value "$ENV_FILE" "$key"
}

read_worker_env_value() {
    local key="$1"
    read_env_file_value "$WORKER_ENV_FILE" "$key"
}

env_value_is_true() {
    local value="${1:-}"
    case "${value,,}" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}

PR_EXECUTION_ENABLED=false
if env_value_is_true "$(read_env_value STHRIP_PR_EXECUTION_ENABLED)"; then
    PR_EXECUTION_ENABLED=true
fi

WORKER_PROFILE_ENABLED=false
if [[ $PR_EXECUTION_ENABLED == "true" ]] || env_value_is_true "$(read_env_value STHRIP_PR_EXECUTION_WORKER_ENABLED)"; then
    WORKER_PROFILE_ENABLED=true
fi

if [[ $WORKER_PROFILE_ENABLED == "true" ]]; then
    if grep -q 'REPLACE_ME' "$ENV_FILE"; then
        die "$ENV_FILE still contains REPLACE_ME placeholders. Fill them and re-run."
    fi
else
    if grep -v -E '^STHRIP_PR_EXECUTION_WORKER_SECRET=REPLACE_ME' "$ENV_FILE" | grep -q 'REPLACE_ME'; then
        die "$ENV_FILE still contains REPLACE_ME placeholders outside disabled PR execution. Fill them and re-run."
    fi
    log "  PR execution worker disabled: worker env, image, credentials, and compose profile are skipped"
fi

if [[ $WORKER_PROFILE_ENABLED == "true" ]]; then
    if [[ ! -f $WORKER_ENV_FILE ]]; then
        install -m 600 "$REPO_DIR/infra/prod/.env.pr-execution-worker.example" "$WORKER_ENV_FILE"
        chown root:root "$WORKER_ENV_FILE"
        die "Created $WORKER_ENV_FILE from template. Edit it (fill REPLACE_ME values) and re-run."
    fi
    if grep -q 'REPLACE_ME' "$WORKER_ENV_FILE"; then
        die "$WORKER_ENV_FILE still contains REPLACE_ME placeholders. Fill them and re-run."
    fi
    chmod 600 "$WORKER_ENV_FILE"
elif [[ -f $WORKER_ENV_FILE ]]; then
    chmod 600 "$WORKER_ENV_FILE"
fi

CLERK_SECRET_KEY_VALUE="$(read_env_value CLERK_SECRET_KEY)"
CLERK_AUTHORIZED_PARTIES_VALUE="$(read_env_value CLERK_AUTHORIZED_PARTIES)"
CLERK_TEST_PREFIX="sk""_test"
CLERK_LIVE_PREFIX="sk""_live"
if [[ -z $CLERK_SECRET_KEY_VALUE ]]; then
    die "CLERK_SECRET_KEY is required in $ENV_FILE for production dashboard API auth."
fi
if [[ $CLERK_SECRET_KEY_VALUE == "${CLERK_TEST_PREFIX}_"* ]]; then
    die "CLERK_SECRET_KEY is a Clerk test secret. Use the live Clerk secret that matches sthrip.dev."
fi
if [[ $CLERK_SECRET_KEY_VALUE != "${CLERK_LIVE_PREFIX}_"* ]]; then
    die "CLERK_SECRET_KEY must be a live Clerk secret for production."
fi
if [[ $CLERK_AUTHORIZED_PARTIES_VALUE != *"https://sthrip.dev"* ]]; then
    die "CLERK_AUTHORIZED_PARTIES must include https://sthrip.dev."
fi

if [[ $WORKER_PROFILE_ENABLED == "true" ]]; then
    API_PR_EXECUTION_SECRET_VALUE="$(read_env_value STHRIP_PR_EXECUTION_WORKER_SECRET)"
    WORKER_PR_EXECUTION_SECRET_VALUE="$(read_worker_env_value STHRIP_PR_EXECUTION_WORKER_SECRET)"
    if [[ -z $API_PR_EXECUTION_SECRET_VALUE || -z $WORKER_PR_EXECUTION_SECRET_VALUE ]]; then
        die "STHRIP_PR_EXECUTION_WORKER_SECRET is required in both $ENV_FILE and $WORKER_ENV_FILE when PR execution is enabled."
    fi
    if [[ $API_PR_EXECUTION_SECRET_VALUE != "$WORKER_PR_EXECUTION_SECRET_VALUE" ]]; then
        die "STHRIP_PR_EXECUTION_WORKER_SECRET must match in $ENV_FILE and $WORKER_ENV_FILE."
    fi

    PR_EXECUTION_PROVIDER_VALUE="$(read_worker_env_value STHRIP_PR_EXECUTION_SANDBOX_PROVIDER)"
    VERCEL_TOKEN_VALUE="$(read_worker_env_value VERCEL_TOKEN)"
    VERCEL_TEAM_ID_VALUE="$(read_worker_env_value VERCEL_TEAM_ID)"
    VERCEL_PROJECT_ID_VALUE="$(read_worker_env_value VERCEL_PROJECT_ID)"
    if [[ $PR_EXECUTION_PROVIDER_VALUE != "vercel-sandbox" ]]; then
        die "$WORKER_ENV_FILE: production PR execution requires STHRIP_PR_EXECUTION_SANDBOX_PROVIDER=vercel-sandbox."
    fi
    if [[ -z $VERCEL_TOKEN_VALUE || -z $VERCEL_TEAM_ID_VALUE || -z $VERCEL_PROJECT_ID_VALUE ]]; then
        die "$WORKER_ENV_FILE: the GCP-hosted worker requires the complete VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID triple."
    fi
fi

# -------------------------------------------------------------
log "4/10  GCP service-account credential perms"
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
log "5/10  Build apps/site (static SPA) -> $SITE_DIST"
# -------------------------------------------------------------
mkdir -p "$SITE_DIST" "$DEPLOY_DIR/data" "$DEPLOY_DIR/chrome-cache"
docker run --rm \
    --user root \
    -v "$REPO_DIR:/repo" \
    -w /repo \
    oven/bun:1.3.11-alpine \
    sh -c "apk add --no-cache python3 make g++ && bun install --frozen-lockfile && cd apps/site && bun run build"
rsync -a --delete "$REPO_DIR/apps/site/dist/" "$SITE_DIST/"

# -------------------------------------------------------------
log "6/10  Build server image (tensol-server:latest)"
# -------------------------------------------------------------
docker build \
    -t tensol-server:latest \
    -f "$REPO_DIR/server/Dockerfile" \
    "$REPO_DIR"

# -------------------------------------------------------------
log "7/10  Build PR execution worker image"
# -------------------------------------------------------------
if [[ $WORKER_PROFILE_ENABLED == "true" ]]; then
    docker build \
        -t tensol-pr-execution-worker:latest \
        -f "$REPO_DIR/vps-agent/Dockerfile" \
        "$REPO_DIR/vps-agent"
else
    log "  skipped: STHRIP_PR_EXECUTION_WORKER_ENABLED=false"
fi

# -------------------------------------------------------------
log "8/10  DB migrate"
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
log "9/10  Start server stack (docker compose up -d)"
# -------------------------------------------------------------
cd "$REPO_DIR/infra/prod"
COMPOSE_PROFILE_ARGS=()
if [[ $WORKER_PROFILE_ENABLED == "true" ]]; then
    COMPOSE_PROFILE_ARGS+=(--profile pr-execution)
fi
docker compose -f docker-compose.prod.yml "${COMPOSE_PROFILE_ARGS[@]}" up -d --build
if [[ $WORKER_PROFILE_ENABLED != "true" ]]; then
    docker rm -f tensol-pr-execution-worker >/dev/null 2>&1 || true
fi

# -------------------------------------------------------------
log "10/10  Caddy config"
# -------------------------------------------------------------
install -m 0644 "$CADDYFILE_SRC" "$CADDYFILE_DST"
caddy validate --config "$CADDYFILE_DST"
systemctl enable --now caddy
if ! systemctl reload caddy; then
    log "  caddy reload failed; restarting service instead"
    systemctl restart caddy
fi

log "Done."
cat <<EOF

  Public endpoints:
    https://sthrip.dev
    https://www.sthrip.dev      (redirects to apex)
    https://api.sthrip.dev/healthz

  Verify (from this VM):
    curl -fsS http://127.0.0.1:3000/healthz
    curl -fsS https://api.sthrip.dev/healthz

  Logs:
    docker logs -f tensol-server
    journalctl -u caddy -f

  Redeploy after a code change:
    sudo /opt/tensol/repo/infra/prod/deploy.sh

EOF

if [[ $WORKER_PROFILE_ENABLED == "true" ]]; then
    cat <<EOF
  PR execution worker:
    docker exec tensol-pr-execution-worker bun -e "const r=await fetch('http://127.0.0.1:8080/healthz'); console.log(await r.text()); process.exit(r.ok?0:1)"
    docker logs -f tensol-pr-execution-worker

EOF
else
    cat <<EOF
  PR execution worker:
    disabled. Fill /opt/tensol/.env.pr-execution-worker, set
    STHRIP_PR_EXECUTION_WORKER_ENABLED=true, and re-run deploy.sh to start the
    pr-execution compose profile for smoke testing. Enable
    STHRIP_PR_EXECUTION_ENABLED only after the worker smoke passes.

EOF
fi
