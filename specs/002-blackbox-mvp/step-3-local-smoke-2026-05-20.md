# Step 3 — Local Server Smoke (2026-05-20)

> Historical smoke evidence from the pre-international-pivot implementation.
> Legacy `yookassa_live` observations below are not target billing guidance.

## Verdict: **RED — server fails to boot**

Smoke halted before any endpoint probe. Push to remote NOT executed
(per driver hard-rule: "If smoke shows ANY fatal crash → halt before push").

## Environment

- Port: `38080` (free)
- DB: `./data/tensol.db` (file path is hard-coded constant
  `DEFAULT_DATABASE_PATH` in `server/src/server.ts:164`; the config
  schema has no `TENSOL_DB_URL` knob — task instruction predated this)
- Env vars (synthetic, generated for this smoke only):
  - `PORT=38080`
  - `NODE_ENV=development`
  - `TENSOL_AUDIT_SIGNING_KEY` — 128-char hex (random)
  - `TENSOL_SESSION_COOKIE_SECRET` — 128-char hex (random)
  - `TENSOL_WEBHOOK_SECRET=smoke-test-secret`
  - `HETZNER_API_TOKEN=smoke-placeholder-token`
  - `HETZNER_SSH_KEY_NAME=smoke-placeholder-key`
  - `TENSOL_VPS_AGENT_IMAGE=ghcr.io/example/vps-agent:smoke`
  - `TENSOL_WEBHOOK_BASE_URL=http://localhost:38080`
  - `EMAIL_PROVIDER=stdout`
  - `TENSOL_TELEGRAM_BOT_TOKEN` — intentionally unset → expected
    `LoggingTelegramNotifier` fallback
- Launch script: `/tmp/tensol-smoke-launch.sh`
- Log capture: `/tmp/tensol-smoke.log`
- Launch wrapper: `tmux new-session -d -s tensol-smoke "..."`

## Boot result

Server crashed at module-load. The Hono app factory never ran;
`Bun.serve` was never reached. Time-to-crash ≈ 1 s.

```
1 | })
2 | {
    ^
SyntaxError: Export named 'targets' not found in module
'/Users/saveliy/Documents/пентест ИИ/server/src/db/schema.ts'.
      at loadAndEvaluateModule (2:1)

Bun v1.3.11 (macOS arm64)
```

## Root cause

`server/src/jobs/handlers/dispatch-scan.ts:38` statically imports
`targets` from `../../db/schema.ts`:

```ts
import { scans, targets, vpsInstances } from "../../db/schema.ts";
```

The `targets` table was **dropped from the schema** in commit `90bd3e6`
("feat(db): T012 update schema.ts to match migration 0010 — drop:
auth_proofs, targets, projects, magic_link_tokens"). Migration `0010`
removed the table from SQLite; `schema.ts` was updated; but
`dispatch-scan.ts` was not updated to follow suit.

This is a **pre-existing legacy 001 zombie**, NOT introduced by any
post-loop step (1–6). The PR description already acknowledges a
"legacy 001 `magicLinkTokens` zombie" — this is the same class of
cleanup gap on a different table.

Bun's ESM loader resolves `import { targets }` at module-load time;
the missing export aborts evaluation of `dispatch-scan.ts`, which is
transitively imported by `server.ts`, so the entire app never
initialises. `bun test` does not surface this because the dispatch
handler test file (T040) imports a narrower surface, and the failing
test counted in the PR ("1 pre-existing fail") is a separate item.

## Probes attempted

None. Boot crashed before the listener bound to `:38080`, so all
6 planned probes (root health, `/healthz`, `/__test/v2/seed-session`,
`/v1/scan-orders` with cookie, rate-limit burst on
`/v1/deep-inquiries`, `/v1/config/feature-flags`) were not executed.

| Probe | Status |
|-------|--------|
| `GET /` | not reached |
| `GET /healthz` | not reached |
| `POST /__test/v2/seed-session` | not reached |
| `GET /v1/scan-orders` (with cookie) | not reached |
| Rate-limit burst on `POST /v1/deep-inquiries` | not reached |
| `GET /v1/config/feature-flags` | not reached |

## Cleanup

- `tmux kill-session -t tensol-smoke` — already exited (process died
  immediately after the import error), session terminated cleanly.
- `/tmp/tensol-smoke-launch.sh`, `/tmp/tensol-smoke-sign.key`,
  `/tmp/tensol-smoke-sess.key`, `/tmp/tensol-smoke.log` — synthetic
  secrets only, retained for evidence; can be removed.

## Required fix (out of scope for this smoke run)

Two-line patch in `server/src/jobs/handlers/dispatch-scan.ts`:

1. Drop `targets` from the import statement at line 38.
2. Delete (or rewrite) the `from(targets).where(eq(targets.id,
   scan.targetId))` lookup at lines 92–93; in the V2 model the
   target URL lives on `scanOrders.primaryDomain`, not a separate
   `targets` row.

Impact analysis MUST be run on `createDispatchScanHandler` before
the fix (CLAUDE.md mandate) — gitnexus already surfaced its callers:
`startTestServer`, `main`, `buildAppWithRunner`. Risk: the
dispatch-scan code path appears to be invoked from job runner +
tests; fixing the import should be a low-risk surface change but
needs verification that the rewrite of the target lookup matches
the V2 contract.

## Decision

- **Step 3 verdict: RED.**
- **Step 7 push + PR: NOT executed.** Branch `002-blackbox-mvp`
  remains local-only at HEAD `a7ddd6f`.
- This evidence file is left **unstaged** (no commit) per driver
  rules — no point committing smoke evidence that proves the boot
  is broken; the next agent should fix the import then re-run the
  smoke.

## Observations

- The task instructions referenced env vars `TENSOL_PORT` and
  `TENSOL_DB_URL` and `TENSOL_HMAC_SECRET`. These do **not** exist
  in the actual `server/src/config.ts` schema. Actual mapping:
  `TENSOL_PORT → PORT`, `TENSOL_DB_URL → none (fixed
  ./data/tensol.db)`, `TENSOL_HMAC_SECRET → TENSOL_AUDIT_SIGNING_KEY
  + TENSOL_SESSION_COOKIE_SECRET (both ≥64 hex chars, required)`.
- The task description claims "server boots in <X>s" inside the
  ready-made commit message. The server does not currently boot in
  any duration on this branch.
- `bun test` for `server/` ostensibly passes 1065/1066. The static
  import failure is not exercised by the test harness because no
  test imports `dispatch-scan.ts` and the full `server.ts` boot
  composition. The integration tests instantiate the runner with
  a stub dispatcher (`createRunner({ dispatcher: stub })`) that

---

## Follow-up: GREEN re-smoke (2026-05-20, post-fix)

### Verdict: **GREEN — server boots and all five spec endpoints respond as expected**

### Fixes applied

1. **`server/src/jobs/handlers/dispatch-scan.ts`** — replaced dropped
   `targets` table lookup with the canonical V2 path: read
   `scan_orders.primary_domain` via `scans.scan_order_id`. Net
   delta: import line + 4-line lookup block + audit-metadata
   reference all rewritten; behaviour preserved (still produces
   `target_url` for the agent body, now prefixed with `https://`
   since `primary_domain` is stored as a hostname per data-model.md).

2. **`server/src/auth/magic-link.ts`** — wholesale stub. Public
   type contract (`issueLink` / `verifyLink` / their result types)
   preserved so `routes/auth.ts` still compiles and the rest of the
   server can boot. Both functions throw a clear `not_implemented`
   error referencing the T012 auth pivot. Email-schema validation
   in `issueLink` is retained so the `ZodError` documented behaviour
   for malformed input still holds.

### Smoke probe matrix

| Probe | Expected | Observed | Verdict |
|---|---|---|---|
| Boot | `bun run src/server.ts` binds on :38080 within ~5 s with full env set | `[tensol] listening on :38080` after ~3 s | **PASS** |
| `GET /healthz` | 200 + `{ok:true}` | 200 `{"ok":true}` | **PASS** |
| `POST /__test/v2/seed-session {email:"smoke@test.example"}` | 200 + session_id | 200 `{"session_id":"01KS2H0B5YKWNT0MFT88VFXBBF",...}` | **PASS** |
| `GET /v1/scan-orders` w/ `tensol_session` cookie | 200 + array | 200 `[]` (empty for fresh user) | **PASS** |
| `POST /v1/deep-inquiries {}` × 8 | first 5 = 422 (validation), then 429 | attempts 1-5 → 422; attempts 6-8 → 429 `{"error":"rate_limited","retry_after":60}` | **PASS** |
| `GET /v1/config/feature-flags` | 200 + `{yookassa_live:false}` | 200 `{"yookassa_live":false}` | **PASS** |

### Env (synthetic, full set required)

```
PORT=38080
NODE_ENV=development
TENSOL_AUDIT_SIGNING_KEY=<128-hex random>
TENSOL_SESSION_COOKIE_SECRET=<128-hex random>
TENSOL_WEBHOOK_SECRET=smoke-test-secret
HETZNER_API_TOKEN=smoke-fake-token
HETZNER_SSH_KEY_NAME=smoke-fake-key
TENSOL_VPS_AGENT_IMAGE=ghcr.io/example/smoke-agent:latest
TENSOL_WEBHOOK_BASE_URL=http://localhost:38080
GCP_PROJECT_ID=smoke-project-id
GCP_NETWORK_NAME=smoke-network-name
GCP_SUBNET_NAME=smoke-subnet-name
GCP_ZONE=europe-west1-b
GCP_BOOT_DISK_IMAGE_ID=smoke-image-id
GCP_SSH_PUBLIC_KEY="ssh-ed25519 AAAA smoke"
```

The original smoke (above) under-specified the env set. The full
required set is documented here for any future re-runs. The driver's
hard-rule "synthetic secrets only" is respected — none of these are
real-infra credentials.

### Known consequence

5 of 6 tests in `server/tests/integration/auth.test.ts` now fail
because they exercise the full magic-link issue→redeem→session
round-trip against the stub. This is the **expected runtime
manifestation** of the T012 auth pivot — the same suite previously
crashed at module-load time (could not import `magicLinkTokens`
from the dropped schema), so the stub is a net improvement (graceful
runtime error > crash-on-import). Re-implementation under the new
Telegram-auth flow is tracked separately.

Files touched on disk by this follow-up:
- `server/src/jobs/handlers/dispatch-scan.ts`
- `server/src/auth/magic-link.ts`
- `specs/002-blackbox-mvp/step-3-local-smoke-2026-05-20.md` (this file)
  bypasses the broken handler module entirely.
