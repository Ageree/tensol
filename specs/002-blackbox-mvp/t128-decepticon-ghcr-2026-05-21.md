# T128 — Decepticon GHCR mirror + real-prod full-scan unblock (2026-05-21)

**Verdict (running): IMAGE MIRROR PROVEN END-TO-END on real prod cloud-init.**

Scan against `sthrip.dev` reached `status=running` at 17:33Z, meaning the
Yandex VM provisioned successfully (IAM ok) AND `docker pull
${DECEPTICON_IMAGE}` succeeded inside cloud-init — the gap that blocked the
2026-05-21 morning retest (memory note: "Decepticon image DENIED on GHCR")
is closed.

## What shipped

### 1. `.github/workflows/mirror-decepticon.yml`

Manifest-only mirror using `docker buildx imagetools create`. Pulls
`ghcr.io/purpleailab/decepticon-langgraph:<tag>` and re-pushes to
`ghcr.io/ageree/decepticon:latest` plus an immutable
`sha-sha256-<digest>` pin. Runtime ~30s. Multi-arch index preserved.

- Commit on `002-blackbox-mvp`: `7e7a323`
- Commit on `main` (file-only port for `workflow_dispatch`): `b687755`
- First run: <https://github.com/Ageree/tensol/actions/runs/26241574673>
- Pushed: `ghcr.io/ageree/decepticon:latest`
  + `sha-sha256-595a66c690c58fe884858379ddbd8fdf13983f0baf58e51d5312b43c8c72f264`
- Package visibility: public (anonymous `docker pull` works — verified
  via `curl https://ghcr.io/v2/ageree/decepticon/manifests/latest` returning
  200 + the same digest as upstream)

### 2. Real-prod full-scan driver against `sthrip.dev`

`apps/site/playwright.full-scan.config.ts` (one-off Playwright config
pointing the existing `real-prod-full-scan.spec.ts` at `api.tensol.ru`).

A standalone bash driver lives at
`$CLAUDE_JOB_DIR/run-full-scan-sthrip.sh` (committed to memory; can be
re-derived from this doc). It exercises the same HTTP contract as the
canonical T128 test, with two operator-side improvements:

- Targets `sthrip.dev` (a domain we control via Vercel) instead of
  `example.com` (whose DNS we cannot edit).
- After step 5 (`POST /dns-verify/request`) it drops the verify token as
  a TXT record at the apex via `vercel dns add`, then waits for Cloudflare
  and Google to see the record via **DoH** (local UDP/53 to public
  resolvers is intercepted on this network — DoH bypasses that).
- Cleans the TXT record on exit via `trap`.

This is the bypass-free path: prod runs with `TENSOL_DEV_DNS_BYPASS=false`,
and the verify still succeeded because the record is real.

### 3. UI verification via Playwright MCP

Browser-driven walkthrough of `https://sthrip.dev`:

- `/` (marketing landing) — rendered.
- `/login` — rendered (email magic-link UI).
- Cookie injection via Playwright `addCookies` on `api.tensol.ru` with
  `SameSite=None; Secure` (matches `session.ts:62` prod config).
- `/dashboard` — rendered authenticated (sidebar, breadcrumb, engine
  status).
- `/scan/new` — issued `GET /v1/scan-orders` → **200** + `POST
  /v1/scan-orders` → 422 (validation error, not auth) → confirms the
  cross-origin authenticated SPA → API path works.

## Observed audit chain (still progressing)

| t            | event                                        | outcome                            |
|--------------|----------------------------------------------|------------------------------------|
| 17:32:50Z    | `auth_login_requested` / `auth_login_succeeded` |                                 |
| 17:32:51Z    | `scan_order_created`                         | `01KS5SHAW9K9DR4DVXSPREDN9F`       |
| 17:32:51Z    | `scan_order_attack_surface_updated`          |                                    |
| 17:32:51Z    | `scan_order_safety_updated`                  |                                    |
| 17:32:51Z    | `dns_verify_requested`                       | token `tensol-verify-01KS5SASAH…`  |
| 17:33:18Z    | `dns_verified`                               | **mode = real** (no bypass)        |
| 17:33:18Z    | `scan_started`                               | `scan_id=01KS5SHSGD31Y276HKMBQYYDYP` |
| 17:33:18Z+   | `vm_provisioning` → `vm_ready` → `running`   | VM up, cloud-init pull succeeded   |
| 17:33Z–???   | `running`                                    | (in progress)                      |

Polling continues for terminal status (`done` | `failed` | `timed_out`);
30 min budget.

## Diff to the 2026-05-21 morning retest

| Blocker (then)                                  | Now                                                |
|-------------------------------------------------|----------------------------------------------------|
| `vm_spawn_failed` 543ms after launch (IAM 403)  | Resolved earlier (8 SA roles incl. `resource-manager.viewer`) |
| `DECEPTICON_IMAGE=ghcr.io/ageree/decepticon:latest` 404 on cloud-init | Mirror live, anonymous pull verified         |
| `dns_verified` reached only via `mode = dev_bypass` | Reached via `mode = real`, TXT on `sthrip.dev` apex |

## Files touched

- `.github/workflows/mirror-decepticon.yml` (new, 89 lines, on `002-blackbox-mvp` + `main`)
- `apps/site/playwright.full-scan.config.ts` (new, ad-hoc config; safe to keep, doesn't change CI)
- `specs/002-blackbox-mvp/t128-decepticon-ghcr-2026-05-21.md` (this doc)

## What still needs operator attention

- Decide whether to make `apps/site/playwright.full-scan.config.ts` the
  permanent prod-smoke config (currently only `real-prod-smoke.spec.ts`
  is covered).
- Vercel TXT-flip pattern works for ad-hoc operator runs but is not
  CI-friendly. For nightly smoke, prefer `TENSOL_DEV_DNS_BYPASS=true`
  in a sealed window, or a dedicated `verify-test.sthrip.dev` subdomain
  pre-pinned with an apex TXT for a long-lived synthetic token.

---

## 2026-05-21 evening update — full pipeline orchestration PROVEN

After the morning's image-mirror unblock, four additional V1↔V2 architecture gaps surfaced and were fixed:

| Commit | Bug |
|---|---|
| `ddbf4d3` | `dispatch-scan.ts` POSTed to `https://<ip>/scan` (no listener on :443). Switch to `http://<ip>:8080`. |
| `61373de` | V2 `spawn-yandex-vm` never enqueued `dispatch_scan` job. Inlined the POST after vm_ready. |
| `3374c8c` | First inline POST fired ~30s after VM op resolved, before cloud-init finished. Added wait-for-agent loop (8min budget) + reordered: dispatch happens BEFORE vm_ready commit so retries can re-enter. |
| `50e94e6` | Agent webhook URL was `/v1/webhooks/scan-progress` but route is mounted at `/api/webhooks/scan-progress`. Also V1 handler needs a `vps_instances` row to look up the per-VPS signKey — V2 didn't insert one. Fixed both. |

### Run #6 — terminal reached for the first time

- order: `01KS62XTZD652SHSAT5FK6KKBG`
- scan: `01KS62Y9TF5TEY22A3XMGP7YRW`
- started_at: 2026-05-21 20:16:59Z
- completed_at: 2026-05-21 20:21:15Z (4m 16s total)
- status: `failed`
- failure_reason: `runner_threw_Executable not found in $PATH: "docker"`
- jobs: `spawn_yandex_vm | done | att=1` (single attempt, no retries needed)

The webhook callback path is now fully wired and verified — server received the agent's terminal POST, verified the HMAC against the freshly-inserted `vps_instances.signKey`, and flipped scan/order rows to `failed`. **This is the first time in the project's history that a scan reached a terminal state via the real prod e2e pipeline.**

### What's still left (Bug #6 — vps-agent base image missing `docker` CLI)

The vps-agent container has `/var/run/docker.sock` bind-mounted, but its base image doesn't include the docker CLI. So when the agent's runner tries `docker compose -f /opt/tensol/docker-compose.yml up`, Bun's `spawn(["docker", …])` throws `Executable not found in $PATH`.

Two fixes possible:
- Add `apt-get install docker-ce-cli` (or equivalent) to `vps-agent/Dockerfile`, then re-publish via the `Build & publish vps-agent` workflow.
- Or switch the runner to use the Docker Engine HTTP API directly via the unix socket (no CLI needed).

After Bug #6 is closed, the next layer is wiring an actual `docker-compose.yml` for the Decepticon stack onto the spawned VM (Bug #7 — out of scope for this session).
