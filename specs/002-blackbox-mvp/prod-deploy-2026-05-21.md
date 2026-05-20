# Production Deploy — tensol.ru — 2026-05-21

**Status: HALTED at Phase 1 / step 3 — pre-flight surfaced ownership BLOCKERs that require operator decision before any destructive action.**

Driver: autonomous /goal subagent acting on user mandate "доделать все блокеры при помощи субагентов чтобы все работало от начало и до конца".

Target: full E2E deploy of branch `002-blackbox-mvp` (HEAD `aa8fe68`) to VM `5.42.106.25` behind `tensol.ru`, `www.tensol.ru`, `app.tensol.ru`, `api.tensol.ru`.

---

## VM state at preflight (2026-05-21 ~00:45 MSK)

| Probe | Value |
|---|---|
| `uname -a` | Linux 6836843-wy572708.twc1.net 6.8.0-107-generic #107-Ubuntu SMP PREEMPT_DYNAMIC Fri Mar 13 19:51:50 UTC 2026 x86_64 |
| OS | Ubuntu 24.04.4 LTS |
| Disk | 82G total, 44G used, 39G free on `/` |
| RAM | 15 Gi total, 13 Gi free, 2.1 Gi buff/cache |
| Docker | 29.2.1 (a5c7197) |
| Caddy host binary | NOT installed pre-deploy; installed during step 2 (`caddy 2.6.2` via apt) but **could not start** (port 80 in use by an existing docker-proxy) |

SSH connectivity worked once we forced `PreferredAuthentications=password PubkeyAuthentication=no` (the agent's `~/.ssh/id_ed25519.pub` is NOT in the server's `authorized_keys`, and the dual-auth path was confusing sshpass into hanging). Helper scripts at `/tmp/sshr.sh` and `/tmp/scpr.sh` (operator-side, never committed).

---

## BLOCKER 1 — VM already runs an unrelated production stack

```text
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}":
NAMES                    STATUS                 PORTS
tensol-app-1             Up 5 weeks             (network_mode: host)
tensol-caddy-1           Up 5 weeks             0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp, 443/udp, 2019/tcp
tensol-supabase-rest-1   Up 5 weeks             127.0.0.1:3001->3000/tcp
tensol-supabase-db-1     Up 5 weeks (healthy)   127.0.0.1:5432->5432/tcp
```

Inspection of `/opt/tensol/`:

* `package.json` — Next.js 16.2.1 + Supabase SSR + Hermes + AI SDK v6 (`@ai-sdk/openai 3.0.48`, `@ai-sdk/react 3.0.140`, `next-auth 5.0.0-beta.30`)
* `docker-compose.yml` — `app` (host-network, port 3000), `supabase-db` (Postgres 16), `supabase-rest` (postgrest v12.2.3), `caddy` (`:80` → `host.docker.internal:3000`)
* `.env` has 16 keys including `OPENROUTER_API_KEY`, `HERMES_*`, `SUPABASE_SERVICE_ROLE_KEY` (values not read; chmod 600 preserved)
* `.git` is pointed at `https://github.com/Ageree/Tensol.git` (capital T — case-folds to `Ageree/tensol`, **same** GitHub repo)
* Last commit on its `main` branch: **`a2d62a6 fix: use text-start/text-delta/text-end SSE format for AI SDK v6`** — this commit is **NOT present in any branch of the local working copy** (`git cat-file -p a2d62a6` → fatal: Not a valid object name). The VM is running a fork or a stale branch that has been overwritten in our remote.
* `tensol-app-1` started `2026-04-10T12:10:55Z` — 5.6 weeks before this deploy attempt.
* `tensol-supabase-db-1` healthy — contains user data of unknown ownership.
* Zabbix agent on `:10050` (`zabbix_agentd`) — host is under a third-party monitoring contract.

Ports held by the existing stack on host:

```text
:80   docker-proxy (tensol-caddy-1)
:443  docker-proxy (tensol-caddy-1)
:3000 next-server (tensol-app-1)
:3001 docker-proxy (tensol-supabase-rest-1, postgrest)
:5432 docker-proxy (tensol-supabase-db-1, postgres)
:10050 zabbix_agentd
:9000 hermes
```

All three ports the new `002-blackbox-mvp` deployment needs (`80`, `443`, `3000`) are occupied.

**Decision needed from operator before proceeding:**

* (A) **Tear down**: stop & `docker compose down` the existing `tensol-app/caddy/supabase` stack, snapshot the Postgres volume `tensol_pgdata` first. Risk: any external users hitting `tensol.ru` today (it answers `521` via Cloudflare today, but the origin stack itself appears healthy on `127.0.0.1`) get an outage. Whoever pushed `a2d62a6` will lose their working server.
* (B) **Coexist on alternate ports**: change `infra/prod/docker-compose.prod.yml` to bind the new server on `127.0.0.1:3100` and serve Caddy on `:81/:444` (or stand up Caddy in front via the existing `tensol-caddy-1` config). Requires (i) a second Caddy instance or merging Caddyfiles, (ii) Cloudflare origin rule to pick the right backend per hostname, (iii) accepting that two `tensol-*` stacks coexist on the same VM (operational confusion risk).
* (C) **Different VM**: provision a fresh Timeweb VM (or any of the 3 deployment rails in `project_tensol_deployment_topology_2026-05-19`) and target it instead.

---

## BLOCKER 2 — DNS does not point at the target VM

All four hostnames resolve to **Cloudflare** edge IPs (not `5.42.106.25`):

```text
tensol.ru     → 172.67.151.137, 104.21.88.171  (Cloudflare)
app.tensol.ru → 172.67.151.137, 104.21.88.171  (Cloudflare)
api.tensol.ru → 104.21.88.171, 172.67.151.137  (Cloudflare)
```

`curl https://tensol.ru` returns `521` (Cloudflare "origin down"), `server: cloudflare`.

Implications:

1. **Caddy auto-TLS will fail** as written in `infra/prod/Caddyfile`. ACME HTTP-01/TLS-ALPN challenges from Let's Encrypt land on Cloudflare's edge, not on the VM, so the cert issue would never complete. We must either
   * disable Cloudflare's orange-cloud proxy for these hostnames (set "DNS only"), then re-resolve DNS to `5.42.106.25` directly; or
   * switch Caddy to ACME **DNS-01** challenge with a Cloudflare API token (`acme_dns cloudflare ...`), keep the orange cloud.

2. Cloudflare account credentials & nameserver control are **not in the operator-side artifact set** (`/tmp/tensol.env.prod` has Telegram, Yandex, audit secrets — no Cloudflare API token). Cannot do this autonomously.

---

## BLOCKER 3 — SSH key trust gap

The agent's `~/.ssh/id_ed25519.pub` (fingerprint `Ckq8W7lqwffoerfsvhlhf+EupEJspGXoyspjJUOSaak`) is **not in `/root/.ssh/authorized_keys` on the VM**. Password auth works via `sshpass`, but:

* every command is gated through `sshpass -e` (password in env-var) — fragile, leaks to `ps` of any user with shell on the VM.
* `scp` of build artifacts (apps/site dist, ~3-8 MB) works but throughput is limited and password-prompt latency adds ~1-2 s per invocation.
* If the operator rotates the root password (highly recommended after this deploy attempt), every saved automation breaks.

Suggested fix during operator triage: `cat ~/.ssh/id_ed25519.pub | ssh ... 'cat >> /root/.ssh/authorized_keys'` once, then run the rest of the deploy with key-based auth (and rotate the root password).

---

## Other findings (advisory, not blockers)

* `caddy 2.6.2` from Ubuntu 24.04's default `noble` repo is **two major versions behind** current upstream (Caddy 2.10.x). Our Caddyfile uses `acme_ca`, `respond ... { close }`, `try_files` — all supported in 2.6, but if we want DNS-01 via Cloudflare we need the official Caddy package (newer; supports `cloudflare` provider out-of-the-box) or to build with xcaddy.
* GHCR image `ghcr.io/ageree/tensol-vps-agent:002-blackbox-mvp-latest` is **not pull-tested from the VM** because no scan ever spawned. If the image is private and the VM has no `GHCR_PAT`, the first scan will fail at VM-spawn with `unauthorized: authentication required`. This is fine for boot but blocks the first end-to-end scan smoke.
* `/tmp/tensol.env.prod` was never copied to the VM (Phase 2 / step 4 not executed) — no real secret made it onto the box during this aborted run.
* Repository was **not cloned to `/opt/tensol/repo/`** — directory is empty (just created).

---

## Files / artifacts created during this run

| Location | Purpose | Cleanup? |
|---|---|---|
| `/tmp/sshr.sh`, `/tmp/scpr.sh` (operator laptop) | password-auth SSH/SCP helpers | safe to leave; password baked in (chmod 700 recommended) |
| `/opt/tensol/{repo,data,chrome-cache,site-dist}` on VM | empty dirs created at Phase 1/step 3 | safe to leave; harmless |
| `caddy 2.6.2` apt package installed on VM | systemd unit failed to start (port 80 busy) | **disable + mask** the unit so it doesn't compete: `systemctl disable --now caddy; systemctl mask caddy` |

## Files / artifacts **NOT** created (would have been, if we had proceeded)

* `/opt/tensol/.env.prod` — real secrets NOT copied (good, blast radius minimal)
* No `git clone` ran inside `/opt/tensol/repo/`
* No `docker build` ran
* No `tensol-server:latest` image exists
* No DB migration ran
* No Caddyfile copied to `/etc/caddy/Caddyfile`

## Recommended next steps for operator (in order)

1. **Decide the VM-coexistence question** (BLOCKER 1: A vs B vs C).
2. **Resolve DNS ownership** (BLOCKER 2: orange-cloud off, OR provide Cloudflare API token for DNS-01).
3. **Install agent's ssh key** (BLOCKER 3) and rotate root password.
4. Once 1–3 are settled, re-run this deploy plan from Phase 1.

## Bash exit-code summary

| Step | Result |
|---|---|
| 1.1 SSH preflight | ✓ (after password-auth fix) |
| 1.2 Install Caddy via apt | ✓ binary installed (`caddy 2.6.2`); ✗ systemd unit failed (`bind: address already in use` on `:80`) |
| 1.3 Mkdir `/opt/tensol/...` | ✓ (note: pre-existing `/opt/tensol/` with unrelated stack) |
| 2.x scp + clone | not attempted (HALTED) |
| 3.x build site + server | not attempted (HALTED) |
| 4.x migrate + start | not attempted (HALTED) |
| 5.x Caddy enable | not attempted (HALTED) |

End of evidence.
