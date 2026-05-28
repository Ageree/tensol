# Secret Rotation Runbook

> Operator handbook for rotating sensitive credentials used by the Tensol
> Blackbox MVP backend (002-blackbox-mvp). Closes T145 finding LOW
> ("no documented rotation procedure"). Owner: security on-call.

> Companion to `docs/runbooks/auth-rotation.md`, which covers user-session
> and password secrets from feature 001. This runbook covers the
> infrastructure-side secrets in `server/.env.example`.

## Scope

| Secret                          | Used by                                                              | Section |
| ------------------------------- | -------------------------------------------------------------------- | ------- |
| `TENSOL_WEBHOOK_SECRET`         | `webhooks-scan-complete.ts` ↔ `vps-agent/src/webhook-sign.ts`        | §1      |
| `TENSOL_TELEGRAM_BOT_TOKEN`     | `server/src/notify/telegram.ts` (notifications + magic-link auth)    | §2      |
| `TENSOL_TELEGRAM_WEBHOOK_SECRET`| `POST /v1/webhooks/telegram-update` (`X-Telegram-Bot-Api-Secret-Token`) | §3   |
| `YANDEX_SA_KEY_JSON`            | IAM token exchange for compute/storage SDK calls                     | §4      |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | Yandex Object Storage S3 (evidence bucket)             | §5      |
| `TENSOL_AUDIT_SIGNING_KEY`      | Append-only signed audit chain (`audit/emit.ts`, `verify-chain.ts`)  | §6      |
| `TENSOL_YOOKASSA_LIVE`          | YooKassa payments                                                    | §7      |

> Note: `server/.env.example` also lists `TENSOL_HMAC_SECRET` — this is a
> legacy placeholder name. The live code binds the audit-signing key to
> `TENSOL_AUDIT_SIGNING_KEY` (see `server/src/config.ts:19`). Treat the two
> as the same secret; the `.env.example` rename is filed as a polish task.

---

## §1 `TENSOL_WEBHOOK_SECRET` rotation

Shared HMAC-SHA256 secret between the backend and every per-scan VPS
running `vps-agent`. Used for the `X-Tensol-Signature: t=<sec>, v1=<hex>`
envelope per `specs/002-blackbox-mvp/contracts/webhook.md`.

### When to rotate

- Suspected leak (commit, log, screenshot, operator handover).
- 90-day scheduled cadence (recommended).
- After any cloud-init template review fails its lint.

### Procedure (zero-downtime via dual-secret window)

1. Generate the new secret: `openssl rand -hex 32`.
2. Deploy the server with BOTH old and new accepted (env:
   `TENSOL_WEBHOOK_SECRET` = new, `TENSOL_WEBHOOK_SECRET_PREV` = old; the
   verifier tries the new value first and falls back to `_PREV`).
3. Wait until all in-flight scans complete (≤45 min SLA per scan, plus a
   safety margin — recommend 60 min).
4. Push the new secret to the vps-agent cloud-init template so every NEW
   VM signs with the new secret. Existing in-flight VMs continue to sign
   with the old.
5. Wait ≤45 min for in-flight VMs to drain.
6. Remove `TENSOL_WEBHOOK_SECRET_PREV` from server env; redeploy.
7. Verify: replay a previously-captured old-signed body — the verifier
   must return `401 webhook_invalid_signature` and emit an
   `webhook_invalid_signature` audit row with `reason: "hmac_mismatch"`.

> impl-task — **dual-secret support is not yet implemented**. The current
> `webhooks-scan-complete.ts:272` reads a single `webhookSecret` field.
> The dual-secret window requires ~2h of work: thread an optional
> `prevWebhookSecret` through `CreateWebhookScanCompleteRouterDeps`, try
> the new secret first, fall back to the prev secret if present, and emit
> a `webhook_signature_via_prev_secret` audit row when the fallback path
> wins (so the operator can see when in-flight VMs cut over). Until that
> lands, treat this section as **hard-cutover with planned downtime**:
> bounce the fleet during a maintenance window.

### Hard-cutover fallback (until dual-secret lands)

1. Pause new scan starts (`/v1/admin/scans/pause` if available, or a feature flag).
2. Wait for all in-flight scans to terminate (worst case 45 min).
3. Rotate secret in server env + cloud-init template simultaneously.
4. Resume new scans.

---

## §2 `TENSOL_TELEGRAM_BOT_TOKEN` rotation

The Telegram Bot API token used by `server/src/notify/telegram.ts` for
outbound DMs (magic-link delivery, scan-complete notifications, operator
handoffs).

### When to rotate

- Token exposed in repo / log / Telegram support ticket.
- 180-day scheduled cadence.
- After an operator with prod env access leaves.

### Procedure

1. Open `@BotFather` in Telegram → `/mybots` → select `@tensol_leadsbot`
   (the value of `TENSOL_TELEGRAM_BOT_USERNAME`) → API Token → `Revoke`.
2. BotFather emits a new token. Copy it into the password manager.
3. Update `TENSOL_TELEGRAM_BOT_TOKEN` in server env; redeploy.
4. Verify by sending a test message: any `/v1/auth/telegram/start` call
   that mints a magic-link DM should land in the operator's chat.
5. If using webhook (not long-poll), re-run `setWebhook` with the new
   token. The webhook URL stays the same; only the secret rotates.

> Bot token revoke is **instant**. Old token returns `401 Unauthorized`
> from `api.telegram.org` immediately, so there's no overlap window —
> every queued notification job between revoke and redeploy will fail and
> retry. The job runner already handles this (transient 401 → retry with
> backoff).

---

## §3 `TENSOL_TELEGRAM_WEBHOOK_SECRET` rotation

Validates `X-Telegram-Bot-Api-Secret-Token` on inbound updates from
Telegram. Independent of the bot token; rotating one does not require
rotating the other.

### Procedure

1. Generate: `openssl rand -hex 32`.
2. Update `TENSOL_TELEGRAM_WEBHOOK_SECRET` in server env.
3. Re-register the webhook with the new secret:
   ```bash
   curl -s "https://api.telegram.org/bot${TENSOL_TELEGRAM_BOT_TOKEN}/setWebhook" \
     -d "url=https://<host>/v1/webhooks/telegram-update" \
     -d "secret_token=${TENSOL_TELEGRAM_WEBHOOK_SECRET}"
   ```
4. Redeploy server. Old inbound updates within the race window get
   rejected with `401`; Telegram retries with exponential backoff.

---

## §4 `YANDEX_SA_KEY_JSON` rotation

Yandex service-account key (JSON). Used at boot to mint short-lived IAM
tokens (~12h TTL) for compute + storage API calls.

### Procedure

```bash
# 1. Mint a new key
yc iam key create \
  --service-account-name tensol-prod-sa \
  --description "rotation $(date -u +%Y-%m-%d)" \
  --output ~/tensol-sa-new.json

# 2. Update the env var (base64 the JSON OR drop the file on the host)
base64 -w0 ~/tensol-sa-new.json   # → YANDEX_SA_KEY_JSON

# 3. Redeploy server; verify IAM exchange succeeds
#    (boot log: "yandex_iam_token_minted_at=..." emitted)

# 4. Delete the OLD key (list, find by id, delete)
yc iam key list --service-account-name tensol-prod-sa
yc iam key delete <OLD_KEY_ID>
```

Docs: https://cloud.yandex.com/docs/iam/operations/sa/create-access-key

Operator note: the working SA key currently lives in
`server/.env.yandex` (gitignored, on operator workstation only). Keep
this file out of any backup target that ships off-host.

---

## §5 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` rotation

Yandex Object Storage S3 creds for the evidence bucket
(`TENSOL_EVIDENCE_BUCKET`). The variable names follow AWS convention
because the Yandex S3 endpoint is AWS-compatible.

### Procedure

```bash
# 1. Mint a new pair on the same SA that the server uses
yc iam access-key create \
  --service-account-name tensol-prod-sa \
  --description "evidence-rotation $(date -u +%Y-%m-%d)"
# → returns key_id + secret (one-shot)

# 2. Update env on the server AND on the vps-agent cloud-init template
#    (the agent uploads evidence directly to the bucket)

# 3. Redeploy server. Trigger a no-op evidence upload (e.g. resend the
#    last scan-complete payload) to verify both surfaces.

# 4. Delete the OLD key
yc iam access-key list --service-account-name tensol-prod-sa
yc iam access-key delete <OLD_KEY_ID>
```

> The agent + server use the same SA, so a single rotation covers both
> surfaces. Update both env stores within the same maintenance window.

---

## §6 `TENSOL_AUDIT_SIGNING_KEY` — DO NOT ROTATE in production

This key signs the append-only audit chain
(`server/src/audit/emit.ts`). Each row's `signature` field is
`hmac_sha256(key, prev_signature || row_canonical_bytes)`. Rotating it
**permanently breaks `verify-chain`** on every row signed before
rotation.

### When rotation is acceptable

- The key was demonstrably leaked (committed to a public repo, logged
  in plaintext, etc.) AND
- the business accepts that all historical audit rows become
  unverifiable AND
- there is a signed operator approval recorded in `docs/security-log.md`.

### Special procedure (only if rotating)

1. Stop the audit emitter (server shutdown — no row can land mid-rotation).
2. Generate the new key: `openssl rand -hex 32`.
3. Insert a sentinel `audit_key_rotation` row, signed with the OLD key,
   containing both key fingerprints (`sha256(old)`, `sha256(new)`) — this
   is the verifier's anchor that "everything before me is signed by key
   A, everything after me by key B".
4. Persist the OLD key into a verification-only env:
   `TENSOL_AUDIT_KEY_LEGACY_<YYYYMMDD>`.
5. Swap `TENSOL_AUDIT_SIGNING_KEY` to the new value; restart server.
6. Verify: emit a fresh audit row; run `verify-chain` — must report
   `CHAIN OK` only when given BOTH keys; with only the new key, must
   fail at the rotation sentinel.

> impl-task — **multi-key verify-chain is not yet implemented**.
> `server/src/audit/verify-chain.ts` accepts one key. Required work:
> accept a comma-separated key list, detect the `audit_key_rotation`
> sentinel event, swap the active key at the sentinel row, continue.
> Until that lands, treat §6 as **conceptual** — operators MUST escalate
> to engineering before rotating in production.

---

## §7 `TENSOL_YOOKASSA_LIVE` rotation

YooKassa live API token. Used for payment intents.

### Procedure

1. In the YooKassa merchant dashboard, generate a new live key.
2. Update env on the server; redeploy.
3. Trigger a `0.01 ₽` test charge against an operator-owned card to
   verify the new key works.
4. Revoke the old key in the dashboard.

YooKassa supports multiple active keys, so rotation is a clean
new-then-revoke flow with zero downtime.

---

## Per-rotation checklist (copy-paste)

- [ ] Generated new secret with ≥256-bit entropy
- [ ] Stored new secret in password manager (1Password / Bitwarden)
- [ ] Notified team via Telegram operator channel
- [ ] Deployed dual-accept config (where supported — §1 only)
- [ ] Waited drain window (≤45 min for in-flight scans where relevant)
- [ ] Removed old secret from server env
- [ ] Tested old-signed request / call → rejected
- [ ] Logged rotation in `docs/security-log.md` (date, key, reason, operator, verified)

## Rotation log template

Append rows to `docs/security-log.md` (create the file on first rotation):

| Date       | Secret                       | Reason         | Operator    | Verified |
| ---------- | ---------------------------- | -------------- | ----------- | -------- |
| 2026-MM-DD | `TENSOL_WEBHOOK_SECRET`      | scheduled 90d  | @kapital0   | yes      |
| 2026-MM-DD | `TENSOL_TELEGRAM_BOT_TOKEN`  | operator depart| @kapital0   | yes      |

## Outstanding impl-tasks (referenced above)

| ID  | Surface                                        | Estimate |
| --- | ---------------------------------------------- | -------- |
| 1   | Dual-secret support in webhooks-scan-complete  | ~2h      |
| 2   | Multi-key support in verify-chain              | ~3h      |
| 3   | Rename `TENSOL_HMAC_SECRET` placeholder in `.env.example` to `TENSOL_AUDIT_SIGNING_KEY` | ~10 min |
| 4   | `/v1/admin/scans/pause` admin endpoint (for hard-cutover §1) | ~4h |

File these against the polish backlog when accepted.
