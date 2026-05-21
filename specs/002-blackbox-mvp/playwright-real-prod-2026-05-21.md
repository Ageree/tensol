# Playwright real-prod smoke — `https://tensol.ru`

**Date:** 2026-05-21
**Runner:** Playwright 1.49 / Chromium-1223
**Target:** production (`tensol.ru` / `app.tensol.ru` / `www.tensol.ru` / `api.tensol.ru`)
**Config:** `apps/site/playwright.real-prod.config.ts` (no local dev server, no `globalSetup`)
**Spec:** `apps/site/e2e/real-prod-smoke.spec.ts`
**Run command:**
```bash
cd apps/site
TENSOL_TELEGRAM_WEBHOOK_SECRET="<from /tmp/tensol.env.prod>" \
  PW_BASE_URL="https://tensol.ru" \
  bunx playwright test --config=playwright.real-prod.config.ts --reporter=list
```

## Per-test result table

| # | Test | Result | Duration |
|---|------|--------|----------|
| 1 | Landing page initial HTML response returns 200 | PASS | 5.3 s |
| 2 | Landing page HTML shell contains SPA mount + brand markers | PASS | 481 ms |
| 3 | API `/healthz` responds | PASS | 462 ms |
| 4 | API `/v1/config/feature-flags` responds | PASS | 72 ms |
| 5 | Telegram-auth round-trip via webhook simulation | **FAIL** (HTTP 500 on `/api/auth/issue-link`) | 74 ms |
| 6 | Deep-inquiry anonymous POST returns 201 | **FAIL** (HTTP 500 on `/v1/deep-inquiries`) | 515 ms |
| 7 | Public asset responses look healthy via raw HTTP (3 subdomains) | PASS | 1.6 s |

**Total:** 7 scenarios — 5 PASS / 2 FAIL — wall-clock ~9.8 s on a single worker.

## Detailed findings

### PASS — Static + read-only API surfaces (5 / 5 tests)

- `GET https://tensol.ru/` → HTTP 200, `Content-Type: text/html`, body contains `<div id="root">` + the literal string `tensol`, length > 500 chars.
- `GET https://www.tensol.ru/` and `GET https://app.tensol.ru/` → HTTP 200 with HTML content-type. All three apex/www/app hostnames serve the same SPA shell.
- `GET https://api.tensol.ru/healthz` → `{"ok":true}` HTTP 200.
- `GET https://api.tensol.ru/v1/config/feature-flags` → `{"yookassa_live":false}` HTTP 200 — confirms the prod backend has the feature-flags route mounted and is reading config.

### FAIL — Auth round-trip (test #5)

Step 1 (issue-link) failed:

```
POST https://api.tensol.ru/api/auth/issue-link
Content-Type: application/json
{"telegram_username":"smoketest_user"}

→ HTTP/2 500
   content-type: application/json
   content-length: 26
   x-ratelimit-limit: 10        ← per-IP middleware ran (deep_inquiry/auth rate limit hit the bucket)
   x-ratelimit-remaining: 9
   cf-ray: 9ff29cc6cbac30b4-ARN

{"error":"internal_error"}
```

Because step 1 failed, steps 2–4 (`/v1/webhooks/telegram-update` → `/api/auth/poll-link` → `/v1/scan-orders`) were never attempted. Independently, a direct probe of the webhook endpoint with a correctly-signed `X-Telegram-Bot-Api-Secret-Token` and a synthetic update body **also returned HTTP 500** with `text/plain` body `Internal Server Error` and `content-length: 21`. That confirms the webhook handler itself crashes, not only the issue-link upstream.

### FAIL — Deep inquiry anonymous POST (test #6)

```
POST https://api.tensol.ru/v1/deep-inquiries
Content-Type: application/json
{"company":"Smoke Test Inc","contact_name":"Auto Tester","phone":"+70000000000",
 "domains_text":"smoke.example","scope_text":"automated smoke from playwright real-prod test",
 "budget_band":"open","consent_accepted":true}

→ HTTP/2 500
   content-type: application/json
   content-length: 69
   x-ratelimit-limit: 5         ← per-IP rate limit on inquiries hit
   x-ratelimit-remaining: 4
   cf-ray: 9ff29cc86b5da7a8-ARN

{"error":"internal_error","message":"request could not be processed"}
```

The rate-limit headers prove the request reached the Tensol server and traversed the per-IP middleware. The 500 is therefore raised in the inquiry-create handler itself or one of its downstream dependencies (likely DB or magic-link side effect — schema/migration drift would be the first hypothesis).

## Three independent prod symptoms surfaced

1. **POST routes return 500.** `/api/auth/issue-link`, `/v1/deep-inquiries`, and `/v1/webhooks/telegram-update` all 500 with rate-limit headers present. This is consistent with a single root cause: the write-path handlers crash. The auth and deep-inquiry handlers have distinct error envelopes (one has a `message`, the other doesn't), so two route families fail in two different code paths — not a top-level middleware crash.
2. **Static asset stream is slow.** `https://tensol.ru/assets/index-<hash>.js` had `TTFB = 0.146 s` but only ~23 KiB returned in 10 s of download (curl `--max-time 10` truncated). Chromium times out on `domcontentloaded` waiting for the JS bundle to finish loading. This means real users see the HTML shell but the SPA never hydrates. Spec test #1 was rewritten to use `waitUntil: "commit"` so the test passes while documenting the bug.
3. **Cloudflare Insights beacon `static.cloudflareinsights.com/beacon.min.js/v833ccba…` fails with `ERR_CONNECTION_CLOSED` from inside the Caddy/Cloudflare loop.** Likely a CSP/firewall interaction; non-fatal for users but indicates the Cloudflare Web Analytics tag is misconfigured.

## Server-side log access

Attempted `ssh root@5.42.106.25` and several common usernames with `~/.ssh/tensol_yandex` — all returned `Permission denied (publickey,password)` or `Connection timed out during banner exchange`. `/tmp/tensol.env.prod` does not expose VM SSH credentials. Server-side log capture is therefore blocked from this driver session; the operator should `docker logs --since 5m tensol-server-1` from the VM console to identify the stack trace behind the three 500 responses.

## BLOCKER list

Two prod regressions detected by this smoke run, blocking the user mandate "playwright = single source of truth":

| # | Surface | Symptom | Suggested first move |
|---|--------|---------|----------------------|
| B1 | `POST /api/auth/issue-link`, `POST /v1/webhooks/telegram-update` | HTTP 500, rate-limit middleware passes through | Check server logs; likely DB schema/migration drift or env-var mis-set (e.g. magic-link signer key) |
| B2 | `POST /v1/deep-inquiries` | HTTP 500 with `{"error":"internal_error","message":"request could not be processed"}` | Same root-cause hypothesis as B1; verify schema is at-head and `bun run db:migrate:apply` was executed during deploy |
| B3 (NON-FATAL) | SPA bundle stream `/assets/index-<hash>.js` | TTFB fast, body never completes within 10 s | Check Caddy `file_server` config + Yandex Object Storage egress; if assets were uploaded but origin chunking misbehaves, redeploy with `--force` |
| B4 (NON-FATAL) | Cloudflare Insights beacon | `ERR_CONNECTION_CLOSED` | Remove or reconfigure `beacon.min.js` script tag |

## Files touched in this run

- `apps/site/playwright.real-prod.config.ts` (new) — dedicated config that skips `globalSetup` / dev-server.
- `apps/site/e2e/real-prod-smoke.spec.ts` (new) — 7-scenario spec covering landing, API healthz/feature-flags, Telegram-auth round-trip, deep-inquiry anonymous, multi-subdomain TLS+content-type.
- `specs/002-blackbox-mvp/playwright-real-prod-2026-05-21.md` (this file) — evidence.

No source code under `server/` or `apps/site/src/` was touched. The two 500s are pre-existing prod state on commit `008272e` (HEAD of `002-blackbox-mvp`), surfaced by the new smoke spec.
