# Secret Rotation Runbook

> 2026-06-07 current state: production has moved to GCP. GCP service-account
> and GCS-compatible object storage procedures below are legacy-only unless a task
> explicitly targets historical compatibility. Current API prod uses GCP
> Compute Engine and GCP service-account JSON; evidence/report object storage
> still needs a verified GCP/GCS-compatible rotation procedure.

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
| `GOOGLE_APPLICATION_CREDENTIALS` | GCP service-account JSON for Compute Engine scan VM lifecycle       | §4      |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | Explicit GCP/GCS-compatible object storage for evidence bucket | §5 |
| `TENSOL_AUDIT_SIGNING_KEY`      | Append-only signed audit chain (`audit/emit.ts`, `verify-chain.ts`)  | §6      |
| Billing provider secrets        | Future international billing provider (manual/MoR/Stripe later)      | §7      |

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

## §4 GCP service-account JSON rotation

Current production uses `GOOGLE_APPLICATION_CREDENTIALS`, mounted from
`/opt/tensol/.gcp/tensol-vm-spawner.json` into the server container. Rotate it
through Google Cloud IAM, update the file on `sthrip-api-prod`, then restart
the server container and verify a GCP API call succeeds.

### Procedure

```bash
# 1. Create a replacement service-account key in Google Cloud IAM.
gcloud iam service-accounts keys create ~/sthrip-vm-spawner-new.json \
  --iam-account="$GCP_VM_SPAWNER_SERVICE_ACCOUNT"

# 2. Copy it to the production API VM.
scp ~/sthrip-vm-spawner-new.json \
  sthrip-api-prod:/opt/tensol/.gcp/tensol-vm-spawner.json

# 3. Normalize permissions and restart the server container.
ssh sthrip-api-prod 'chmod 0755 /opt/tensol/.gcp && chmod 0644 /opt/tensol/.gcp/*.json'
ssh sthrip-api-prod 'cd /opt/tensol && docker compose -f docker-compose.prod.yml up -d --force-recreate server'

# 4. Verify Compute access, then delete the old key from Google Cloud IAM.
ssh sthrip-api-prod 'docker exec tensol-server node -e "console.log(process.env.GOOGLE_APPLICATION_CREDENTIALS)"'
gcloud iam service-accounts keys list --iam-account="$GCP_VM_SPAWNER_SERVICE_ACCOUNT"
gcloud iam service-accounts keys delete "$OLD_KEY_ID" \
  --iam-account="$GCP_VM_SPAWNER_SERVICE_ACCOUNT"
```

Docs: https://cloud.google.com/iam/docs/keys-create-delete

---

## §5 object-storage access-key rotation

Current production must use an explicit GCP/GCS-compatible object-storage
configuration or a native GCS adapter. Do not rotate generic S3 keys into
production until that storage rail has been explicitly approved.

If the approved storage rail uses S3-compatible HMAC credentials, rotate
`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` at the selected provider and
update both the server env and the vps-agent cloud-init/env surface in the
same maintenance window. If the approved rail uses native GCS, rotate the
service-account key or workload identity binding according to Google Cloud IAM
policy instead.

### Procedure

```bash
# 1. Create the replacement credential in the approved storage provider.
# Provider-specific command intentionally omitted; use the approved provider runbook.

# 2. Update env on the server AND on the vps-agent cloud-init template
#    (the agent uploads evidence directly to the bucket)

# 3. Redeploy server. Trigger a no-op evidence upload (e.g. resend the
#    last scan-complete payload) to verify both surfaces.

# 4. Delete or disable the OLD key in the approved provider console/CLI.
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

## §7 Billing provider secret rotation

2026-06-05 update: YooKassa is obsolete after the international product pivot.
There is no live YooKassa secret to rotate for new work.

When international paid billing is implemented, this section must be replaced
with the selected provider's rotation flow. As of 2026-06-05, the operator has
no Stripe account; direct Stripe and Clerk Billing are not production defaults.
Provider candidates such as Paddle, Lemon Squeezy, or Polar require their own
eligibility and webhook/API checks. Billing code should keep provider secrets
behind a provider-agnostic adapter and use webhook event idempotency keys.

### Procedure

1. Confirm `TENSOL_BILLING_LIVE=false` before rotating or swapping providers.
2. Add the new provider secret to the deployment environment.
3. Redeploy and run provider-specific test-mode checkout/webhook verification.
4. Flip traffic only after idempotency and refund paths are verified.
5. Revoke the old provider secret in the provider dashboard.

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
