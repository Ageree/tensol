# Prod 500 diagnosis & fix — 2026-05-21

**Triggered by:** Playwright real-prod smoke (Sub-F, commit `87cf973`) — 2 / 7 tests failed with HTTP 500 on every POST write-path.

**Scope:** `api.tensol.ru` on GCP VM `5.42.106.25`, container `tensol-server:latest` (image `6064d0da7517`, built 2026-05-21 09:23 UTC).

---

## Root cause

The production SQLite database was at the **legacy 001-backend schema** — the 002 migration files (`0010_blackbox_mvp.sql`, `0011_webhook_dedup.sql`) had never been applied.

Tables present BEFORE the fix:
```
__drizzle_migrations  audit_log  auth_proofs  findings  jobs
magic_link_tokens  projects  scans  sessions  sqlite_sequence
targets  users  vps_instances
```

Tables MISSING (the 002 surface the failing routes depend on):
```
pending_signups   ← /api/auth/issue-link writes here   → SQLiteError
scan_orders       ← scan-timeout-watcher reads here     → reconcile-tick error every 30 s
scan_events       deep_inquiries   evidence_artifacts
reports           webhook_dedup
```

Stack trace from `docker logs tensol-server`:

```
auth.issue-link: downstream failure
SQLiteError: no such table: pending_signups
      at prepare (bun:sqlite:345:37)
      at issueLink (/app/server/src/auth/magic-link.ts:190:6)
      at <anonymous> (/app/server/src/routes/auth.ts:113:28)
```

### Why the migrations didn't run

Two layers of drift compounded:

1. **Stale drizzle journal.** `server/migrations/meta/_journal.json` only lists `0000_init` (timestamp `1779134715415`). Migrations `0010_blackbox_mvp.sql` and `0011_webhook_dedup.sql` exist on disk but never made it into the journal. Drizzle's migrator reads the journal — files not listed are invisible.

2. **deploy.sh called `bun run db:migrate`** which in the *deployed image* resolves to `drizzle-kit migrate`. `drizzle-kit` reads the same broken journal and exits "0 migrations to apply." (The repo HEAD has since aliased `db:migrate` → `bun run scripts/migrate.ts`, the journal-less migrator promoted in `87cf973`, but the production image was built *before* that change took effect for the migration step.)

So the prod image had **legacy schema only**; every POST route that touches `pending_signups` / `scan_orders` / `deep_inquiries` crashed with `SQLiteError: no such table`.

---

## Fix

### Hot-fix (already applied to prod VM)

Stopped container → backed up `tensol.db` and `-wal` → ran a one-shot bun script
inside a transient `tensol-server:latest` container that:

1. Created `__migrations` table (matches `scripts/migrate.ts` schema).
2. Inserted `0000_init` row (schema already on disk via legacy drizzle).
3. Applied `0010_blackbox_mvp.sql` + `0011_webhook_dedup.sql` statement-by-statement inside a tx.
4. Inserted matching `__migrations` rows so future runs are idempotent.

Container restarted, healthcheck reports `healthy`.

Final `__migrations` table:
```json
{"tag":"0000_init",          "applied_at":1779357022601}
{"tag":"0010_blackbox_mvp",  "applied_at":1779357123078}
{"tag":"0011_webhook_dedup", "applied_at":1779357123088}
```

Backups: `/opt/tensol/data/tensol.db.bak-1779357014` (+ wal sibling).

### Durable fix (this commit)

`infra/prod/deploy.sh` step `6/8 DB migrate` now invokes
`bun run scripts/migrate.ts` directly instead of `bun run db:migrate`. The
former is the journal-less bun-native migrator (`scripts/migrate.ts`); it
discovers `.sql` files by directory listing and tracks state in
`__migrations`. A stale `meta/_journal.json` can no longer cause schema
drift even if some future contributor forgets to regenerate it.

---

## Phase 3 — Verification (curl against prod)

```
$ curl -sS -X POST https://api.tensol.ru/api/auth/issue-link \
    -H 'Content-Type: application/json' \
    -d '{"telegram_username":"diag_verify_test"}'
{"deep_link":"https://t.me/tensol_leadsbot?start=01KS4Z6PNEA81CHJYR12T4C0NK",
 "token":"01KS4Z6PNEA81CHJYR12T4C0NK",
 "telegram_username":"diag_verify_test",
 "expires_at":1779358045774}
HTTP=200 ✓

$ curl -sS -X POST https://api.tensol.ru/v1/deep-inquiries \
    -H 'Content-Type: application/json' \
    -d '{"company":"Diag Verify","contact_name":"Auto","phone":"+71234567890",
         "email":"diag@example.com","domains_text":"example.com",
         "scope_text":"verify post-fix","consent_accepted":true}'
{"id":"01KS4Z6PVMPKTCGT45XWDSN0E1","status":"received"}
HTTP=201 ✓

$ curl -sS -G "https://api.tensol.ru/api/auth/poll-link" \
    --data-urlencode "token=$TOKEN"
{"status":"pending","expires_at":1779358357820}
HTTP=200 ✓
```

`docker logs --since 5m tensol-server` shows zero errors after the fix.

### Caveat — `/v1/webhooks/telegram-update` returns 200 BUT hangs on outbound

When a webhook arrives with a valid `X-Telegram-Bot-Api-Secret-Token` AND a
real `/start <token>` payload, the route consumes the token successfully
(DB write OK) but then `await notifier.sendMessage(...)` blocks. The
GCP VM **cannot reach `api.telegram.org`** — `curl -m 10
https://api.telegram.org/...` from inside the VM returns `Connection timed
out`. This is a pre-existing network policy (not introduced by today's
changes) and the original 500 in the Playwright report was actually
caused by the same DB schema drift hitting `consumeLink`, NOT by the
network hang. With the schema fixed, invalid-signature webhooks now
return `200` immediately (verified from the original B1 Playwright probe
on `2026-05-21 12:42 UTC` returning 200) and signed webhooks crash later
in the bot-API call.

The hang itself is harmless to Telegram (TG just retries on 5xx; we return
202 within its 5 s budget once the API egress is unblocked) but blocks
the auth round-trip end-to-end. **Operator action required**: open
GCP security-group / NAT egress to `api.telegram.org` (and
verify TENSOL_TELEGRAM_LONGPOLL=true is not forcing a separate transport
in production). Out of scope for this fix.

---

## Phase 4 — B3 (SPA asset truncation) diagnosis

Reproduced via Cloudflare with cache-buster:

```
$ curl -sS -w "size=%{size_download} time=%{time_total}\n" -o /tmp/a.js \
    "https://tensol.ru/assets/index-DOZgcnEZ.js?nocache=$RANDOM$RANDOM" -m 30
curl: (28) Operation timed out after 30010 ms with 23871 bytes received
```

But **directly from origin** the file streams in full at gigabit speed:

```
$ ssh root@5.42.106.25 \
    'curl -sS -k -w "size=%{size_download} time=%{time_total}\n" -o /tmp/a.js \
       --resolve tensol.ru:443:127.0.0.1 \
       "https://tensol.ru/assets/index-DOZgcnEZ.js" -m 30'
size=526285 time=0.008208 http=200 CT=text/javascript ✓
```

Origin (`Caddy → /opt/tensol/site-dist/assets/index-DOZgcnEZ.js`, 526 KiB)
serves the asset cleanly in 8 ms. The truncation is introduced
**between Cloudflare edge (ARN = Stockholm) and origin** — the file is
served from `cf-cache-status: MISS` so CF is reaching origin live, but
the body never reaches the client past ~24 KiB. Plausible causes
(all operator-bound):

- Cloudflare buffering + an origin TCP keepalive misconfig (Caddy
  default keepalive is generous; less likely);
- CF→origin path MTU mismatch on the GCP network egress (Tashkent
  ↔ Stockholm via Cloudflare's transit) — would explain the consistent
  ~24 KiB cutoff (≈ 16 segments of ~1500 B = a typical TCP window);
- CF's `vary: Accept-Encoding` triggering a re-encode path that closes
  the body early.

**Action**: operator to enable Cloudflare "Origin Pull" diagnostic / a
single Cloudflare ray-id trace, and try the Caddy
`servers.protocols.h2c` toggle. Not a server-code defect.

B3 status: **NON-FATAL, OPERATOR-BOUND** (matches Sub-F triage).

---

## Phase 5 — One atomic commit

This evidence file + `infra/prod/deploy.sh` patch ship together as
`fix(prod): diagnose + fix 500s on write-paths`.

No secret VALUES are echoed anywhere in this doc — only env-var NAMES
when relevant. The `/tmp/tensol.env.prod` file is not touched by the
commit.
