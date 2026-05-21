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
