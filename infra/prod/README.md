# Production deploy — Tensol on Timeweb VM (5.42.106.25)

Operator runbook for shipping `002-blackbox-mvp` to the public `tensol.ru`
domains. Everything here assumes:

- Linux VM `Reasonable Cetus` at `5.42.106.25`, Ubuntu 22.04+, root SSH access.
- DNS A-records already pointing at the VM:
  - `tensol.ru`, `www.tensol.ru`, `app.tensol.ru`, `api.tensol.ru`.
- Ports `80` and `443` reachable from the public internet (Let's Encrypt
  ACME challenge needs `:80`; user traffic uses `:443`).

## Architecture (one-VM topology)

```
Internet ── 443 ──> Caddy (host) ──> /opt/tensol/site-dist   (Vite SPA static)
                                ──> 127.0.0.1:3000           (Bun + Hono API)

Bun server ──> SQLite at /opt/tensol/data/tensol.db
            ──> Yandex Cloud API   (per-scan VM lifecycle)
            ──> Yandex Object Storage (evidence + report PDFs)
            ──> Telegram Bot API   (operator notifications + leads)
            ──> Resend API         (magic-link auth email)
```

All four hostnames terminate on the same Caddy instance; only `api.*` is
reverse-proxied to the Bun container.

## First-time setup (≈10 min, mostly waiting on Docker)

```bash
# 1. SSH to the box
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
#   YANDEX_SA_KEY_JSON                jq -c . < key.json
#   YANDEX_PROD_NETWORK_ID            yc vpc network list
#   YANDEX_PROD_SUBNET_ID             yc vpc subnet list
#   YANDEX_PROD_SSH_PUBLIC_KEY        single-line OpenSSH public key
#   YANDEX_BOOT_DISK_IMAGE_ID         yc compute image get-latest-by-family --family ubuntu-2404-lts --folder-id standard-images
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   Yandex IAM static keys

# 4. Re-run deploy (now succeeds).
sudo /opt/tensol/repo/infra/prod/deploy.sh
```

## Verifying the deploy

```bash
# Local probe (skips TLS):
curl -fsS http://127.0.0.1:3000/healthz
# -> {"ok":true}

# Public probe (Let's Encrypt cert in place):
curl -fsS https://api.tensol.ru/healthz
curl -fsSI https://tensol.ru/        | head -1   # HTTP/2 200
curl -fsSI https://app.tensol.ru/    | head -1   # HTTP/2 200
curl -fsSI https://www.tensol.ru/    | head -1   # HTTP/2 301 -> tensol.ru
```

Browser checks: open `https://tensol.ru` and `https://app.tensol.ru`,
confirm the marketing landing + auth shell render.

## Redeploy after a code change

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
git -C /opt/tensol/repo pull
docker compose -f docker-compose.prod.yml up -d --build
```

## Rollback

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
| `curl https://api.tensol.ru/healthz` -> 502 Bad Gateway | Container down. `docker ps -a` + `docker logs tensol-server` (likely env-var validation).  |
| Caddy can't fetch a cert                                | `journalctl -u caddy` — DNS not propagated, or port 80 blocked. Confirm `dig +short tensol.ru` returns 5.42.106.25 and `nc -zv tensol.ru 80` succeeds. |
| Server boot panics with `Invalid environment configuration` | A required env var in `/opt/tensol/.env.prod` is missing/empty. Re-check against `.env.prod.example`. |
| SPA renders but API calls 404 from the browser          | Confirm the frontend points at `https://api.tensol.ru` (not localhost). Check `apps/site/src` API base config. |
| `db:migrate` step fails on first deploy                 | `/opt/tensol/data` not writable. `ls -ld /opt/tensol/data` should be `drwxr-xr-x root root`. |
| 50 MB+ PDF render hangs                                 | `@sparticuz/chromium-min` cache extraction failed. `docker exec tensol-server ls /home/bun/.cache/puppeteer` should show a chromium build. |

## Security checklist before announcing the URL

- [ ] `/opt/tensol/.env.prod` is `chmod 600` and owned by `root`.
- [ ] No `REPLACE_ME` left in `/opt/tensol/.env.prod`.
- [ ] `TENSOL_DEV_DNS_BYPASS=false`.
- [ ] `TENSOL_YOOKASSA_LIVE` matches intent (false until merchant verified).
- [ ] `TENSOL_OPERATOR_EMAILS` actually maps to admin accounts you control.
- [ ] Outbound firewall allows `api.cloud.yandex.net`, `storage.yandexcloud.net`,
      `api.telegram.org`, `api.resend.com`.
- [ ] Inbound firewall: only 22 (SSH, ideally IP-restricted), 80, 443.

## Files in this directory

| File                          | Purpose                                                    |
|-------------------------------|------------------------------------------------------------|
| `deploy.sh`                   | Idempotent bootstrap + redeploy script. Run as root.       |
| `docker-compose.prod.yml`     | Single-service stack — Bun server only.                    |
| `Caddyfile`                   | Reverse-proxy + static SPA + auto-TLS for 4 hostnames.     |
| `.env.prod.example`           | Annotated env-var template. Copy to `/opt/tensol/.env.prod`. |
| `README.md`                   | This file.                                                 |
