# Production deploy — Sthrip API on GCP Compute Engine

> Current source of truth: `docs/project-current-context.md`.
> Google Cloud, Google Cloud Storage, Timeweb, and `tensol.*` production
> assumptions are legacy unless a task explicitly targets old evidence or
> backwards compatibility.

Current production snapshot:

- GCP project: `tensol-scanners`.
- API VM: `sthrip-api-prod`, zone `europe-west1-b`, static IP `34.156.105.67`.
- DNS: Vercel DNS has `api.sthrip.dev A 34.156.105.67`.
- Frontend: `sthrip.dev` remains on Vercel; this VM serves the API only.
- API entrypoint: `https://api.sthrip.dev`.
- Runtime: Caddy on the VM terminates TLS and proxies to the Bun/Hono server
  container on `127.0.0.1:3000`.
- GitHub App webhook: `https://api.sthrip.dev/v1/review/github/webhook`.
- Evidence/report object storage: not yet production-complete on GCP. Do not
  revive Google Cloud Storage defaults; configure explicit GCS-compatible
  storage or implement a native GCS adapter first.

## Current API topology

```
GitHub / browser / Vercel frontend
  └─ https://api.sthrip.dev
      └─ Vercel DNS A record -> 34.156.105.67
          └─ GCP VM sthrip-api-prod
              └─ Caddy :443 -> 127.0.0.1:3000
                  └─ Docker container tensol-server

Bun server ──> SQLite at /opt/tensol/data/tensol.db
            ──> GCP Compute Engine (per-scan VM lifecycle)
            ──> object storage adapter (GCP migration pending)
            ──> Telegram Bot API   (operator notifications + leads)
            ──> GitHub App API     (PR review webhooks + review artifacts)
```

## Access

```bash
gcloud compute ssh sthrip-api-prod \
  --project=tensol-scanners \
  --zone=europe-west1-b
```

Important paths on the VM:

| Path | Purpose |
| --- | --- |
| `/opt/tensol/repo` | Deployed repo bundle. |
| `/opt/tensol/.env.prod` | Production env file; never copy into git. |
| `/opt/tensol/.gcp/tensol-vm-spawner.json` | GCP service-account JSON mounted read-only into the container. |
| `/opt/tensol/data` | SQLite database volume. |
| `/etc/caddy/Caddyfile` | Live Caddy config. |

## Verifying production

```bash
curl -fsS https://api.sthrip.dev/healthz
docker ps --filter name=tensol-server
docker logs --tail=80 tensol-server
journalctl -u caddy --since "1 hour ago"
```

Expected API health response:

```json
{"ok":true}
```

## Legacy Timeweb runbook

The sections below describe the old one-VM Timeweb flow and are retained only
as historical context. Do not follow them for current production without first
rewriting them for GCP.

## Legacy first-time setup (do not use for current GCP production)

```bash
# 1. SSH to the old Timeweb box
ssh root@5.42.106.25

# 2. One-shot bootstrap (installs Docker + Caddy + clones repo).
curl -fsSL https://raw.githubusercontent.com/Ageree/tensol/002-blackbox-mvp/infra/prod/deploy.sh \
  | sudo bash
# -> First run aborts at step 3 because /opt/tensol/.env.prod is unfilled.

# 3. Generate secrets and fill /opt/tensol/.env.prod
sudo nano /opt/tensol/.env.prod
# Required REPLACE_ME values:
#   TENSOL_AUDIT_SIGNING_KEY          openssl rand -hex 64
#   TENSOL_SESSION_COOKIE_SECRET      openssl rand -hex 64
#   TENSOL_WEBHOOK_SECRET             openssl rand -hex 32
#   TENSOL_TELEGRAM_WEBHOOK_SECRET    openssl rand -hex 32
#   RESEND_API_KEY                    Resend dashboard
#   TENSOL_TELEGRAM_BOT_TOKEN         @BotFather
#   TENSOL_TELEGRAM_CHAT_ID           numeric chat id of operator
#   GCP_SERVICE_ACCOUNT_JSON                jq -c . < key.json
#   GCP_PROD_NETWORK_ID            gcloud compute networks list
#   GCP_PROD_SUBNET_ID             gcloud compute networks subnets list --project=tensol-scanners
#   GCP_PROD_SSH_PUBLIC_KEY        single-line OpenSSH public key
#   GCP_BOOT_DISK_IMAGE_ID         gcloud compute images describe-from-family ubuntu-2404-lts --project=ubuntu-os-cloud
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   GCP IAM static keys

# 4. Re-run deploy (now succeeds).
sudo /opt/tensol/repo/infra/prod/deploy.sh
```

## Legacy deploy verification

```bash
# Local probe (skips TLS):
curl -fsS http://127.0.0.1:3000/healthz
# -> {"ok":true}

# Public probe (Let's Encrypt cert in place):
curl -fsS https://api.sthrip.dev/healthz
curl -fsSI https://sthrip.dev/        | head -1   # HTTP/2 200
curl -fsSI https://www.sthrip.dev/    | head -1   # HTTP/2 301 -> sthrip.dev
```

Browser checks: open `https://sthrip.dev`,
confirm the marketing landing + auth shell render.

## Legacy redeploy after a code change

The deploy script is idempotent — re-running it pulls latest, rebuilds, and
reloads:

```bash
sudo /opt/tensol/repo/infra/prod/deploy.sh
```

Skip the Docker rebuild if only the SPA changed:

```bash
cd /opt/tensol/repo && git pull
docker run --rm -v "$PWD:/repo" -w /repo oven/bun:1.3.11-alpine \
  sh -c "bun install --frozen-lockfile && cd apps/site && bun run build"
rsync -a --delete /opt/tensol/repo/apps/site/dist/ /opt/tensol/site-dist/
sudo systemctl reload caddy
```

Server-only change:

```bash
cd /opt/tensol/repo/infra/prod
sudo REPO_REF=<reviewed-tag-or-commit-sha> /opt/tensol/repo/infra/prod/deploy.sh
```

The deploy script intentionally requires a reviewed `REPO_REF` for normal
production runs. For an emergency moving-branch deploy, set both values
explicitly:

```bash
sudo REPO_BRANCH=main ALLOW_MOVING_PROD_REF=true /opt/tensol/repo/infra/prod/deploy.sh
```

## Legacy rollback

The server image is tagged `tensol-server:latest`. Tag a known-good image
before redeploying and you can swap back instantly:

```bash
# Right after a green deploy:
docker tag tensol-server:latest tensol-server:rollback

# Roll back:
docker tag tensol-server:rollback tensol-server:latest
docker compose -f /opt/tensol/repo/infra/prod/docker-compose.prod.yml up -d
```

For schema rollbacks, restore the SQLite file from a snapshot:

```bash
sudo systemctl stop docker  # or: docker compose down
cp /opt/tensol/data/tensol.db.backup /opt/tensol/data/tensol.db
sudo systemctl start docker
```

(Set up `cron`/`borg` snapshots of `/opt/tensol/data` — out of scope for
this script; see Timeweb's snapshot feature for a no-effort option.)

## Logs

| Source        | Command                                                   |
|---------------|-----------------------------------------------------------|
| Bun server    | `docker logs -f tensol-server`                            |
| Caddy         | `journalctl -u caddy -f`                                  |
| TLS / ACME    | `journalctl -u caddy --since "1 hour ago" | grep acme`    |
| Build         | tail of `/var/log/syslog` during `deploy.sh` run          |

## Common failures

| Symptom                                                | Diagnosis                                                                                  |
|--------------------------------------------------------|---------------------------------------------------------------------------------------------|
| `curl https://api.sthrip.dev/healthz` -> 502 Bad Gateway | Container down. `docker ps -a` + `docker logs tensol-server` (likely env-var validation).  |
| Caddy can't fetch a cert                                | `journalctl -u caddy` — DNS not propagated, or port 80 blocked. For current API prod, confirm `dig +short api.sthrip.dev A` returns `34.156.105.67` and GCP firewall rule `allow-sthrip-api-web` allows `tcp:80,tcp:443`. |
| Server boot panics with `Invalid environment configuration` | A required env var in `/opt/tensol/.env.prod` is missing/empty. Re-check against `.env.prod.example`. |
| SPA renders but API calls 404 from the browser          | Confirm the frontend points at `https://api.sthrip.dev` (not localhost). Check `apps/site/src` API base config. |
| Signed-in dashboard API calls return `401 unauthenticated` | Check `/opt/tensol/.env.prod`: `CLERK_SECRET_KEY` must be the live Clerk secret for `clerk.sthrip.dev`, and `CLERK_AUTHORIZED_PARTIES` should include `https://sthrip.dev,https://www.sthrip.dev`. Recreate the server container after changing env. |
| `db:migrate` step fails on first deploy                 | `/opt/tensol/data` not writable. `ls -ld /opt/tensol/data` should be `drwxr-xr-x root root`. |
| 50 MB+ PDF render hangs                                 | `@sparticuz/chromium-min` cache extraction failed. `docker exec tensol-server ls /home/bun/.cache/puppeteer` should show a chromium build. |

## Security checklist before announcing the URL

- [ ] `/opt/tensol/.env.prod` is `chmod 600` and owned by `root`.
- [ ] No `REPLACE_ME` left in `/opt/tensol/.env.prod`.
- [ ] `TENSOL_DEV_DNS_BYPASS=false`.
- [ ] Provider-agnostic billing is explicitly set to the approved provider
      (`TENSOL_BILLING_PROVIDER=oxapay`; legacy `TENSOL_YOOKASSA_LIVE`
      unset/false while old compatibility code exists).
- [ ] `TENSOL_OPERATOR_EMAILS` actually maps to admin accounts you control.
- [ ] Outbound firewall allows GCP APIs, `api.telegram.org`, GitHub API, and
      whichever explicit GCP/GCS-compatible object-storage endpoint is approved.
- [ ] Inbound firewall: only 22 (SSH, ideally IP-restricted), 80, 443.

## Files in this directory

| File                          | Purpose                                                    |
|-------------------------------|------------------------------------------------------------|
| `deploy.sh`                   | Idempotent bootstrap + redeploy script. Run as root.       |
| `docker-compose.prod.yml`     | Single-service stack — Bun server only.                    |
| `Caddyfile`                   | Reverse-proxy + static SPA + auto-TLS for 4 hostnames.     |
| `.env.prod.example`           | Annotated env-var template. Copy to `/opt/tensol/.env.prod`. |
| `README.md`                   | This file.                                                 |
