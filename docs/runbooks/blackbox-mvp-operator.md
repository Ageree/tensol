# Blackbox MVP — Operator Handbook

> Day-to-day operator runbook for the Tensol Blackbox MVP (002-blackbox-mvp).
> This is **operational** knowledge, not legal or marketing content — every
> procedure here cites real CLI commands and file paths in this repo.
> Companion docs: `docs/runbooks/secret-rotation.md`,
> `docs/runbooks/auth-rotation.md`, `docs/runbooks/db-migrations.md`,
> `docs/runbooks/audit-event-isolation.md`,
> `docs/runbooks/assessment-lifecycle.md`.

---

## Table of contents

1. Day-1 setup
2. Daily routine
3. Handling Deep inquiries
4. Regenerating reports for clients
5. Force-cancelling stuck scans
6. Reading Telegram alerts
7. Common failures
8. Escalation contacts
9. Recovery procedures

---

## 1. Day-1 setup

### 1.1 Required environment

Authoritative source: `specs/002-blackbox-mvp/quickstart.md`. The operator's
own `.env` must include:

| Variable | Purpose | Where it's set |
| --- | --- | --- |
| `TENSOL_AUDIT_SIGNING_KEY` | Signs the audit chain | server env |
| `TENSOL_WEBHOOK_SECRET` | HMAC between server ↔ vps-agent | server env + cloud-init |
| `TENSOL_TELEGRAM_BOT_TOKEN` | Outbound DMs + magic-link auth | server env |
| `TENSOL_TELEGRAM_WEBHOOK_SECRET` | Validates inbound Telegram updates | server env |
| `YANDEX_SA_KEY_JSON` | IAM exchange for compute/S3 calls | server env (base64) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Yandex S3 evidence bucket | server env |
| `TENSOL_EVIDENCE_BUCKET` | Bucket name | server env |
| `TENSOL_YOOKASSA_LIVE` | YooKassa payments | server env |
| `DATABASE_URL` | SQLite path or Postgres URI | server env |

Rotation procedures live in `docs/runbooks/secret-rotation.md`.

### 1.2 Deploy steps (Yandex Cloud, ru-central1)

```bash
# 1. Provision the long-lived server VM (one-time)
yc compute instance create \
  --name tensol-server-prod \
  --zone ru-central1-a \
  --network-interface subnet-name=default-subnet,nat-ip-version=ipv4 \
  --create-boot-disk image-family=ubuntu-2204-lts,size=40 \
  --service-account-name tensol-prod-sa \
  --ssh-key ~/.ssh/tensol-prod.pub

# 2. Build & ship the server binary
cd server
bun build --target=bun ./src/server.ts --outfile=dist/server.js
scp -r dist/ migrations/ tensol-server-prod:/opt/tensol/

# 3. Run migrations (one-time)
ssh tensol-server-prod 'cd /opt/tensol && bun run db:migrate'

# 4. Start under systemd (operator owns the unit file — example template):
ssh tensol-server-prod 'sudo systemctl enable --now tensol-server'

# 5. Verify
curl -s https://<host>/healthz | jq
```

### 1.3 Smoke verification

```bash
# 5a. Audit chain integrity
ssh tensol-server-prod 'cd /opt/tensol && bun run verify-chain'
# Expected: "CHAIN OK rows=N last_hash=..."

# 5b. Yandex IAM exchange working
ssh tensol-server-prod 'journalctl -u tensol-server --since="5min ago" | grep yandex_iam_token_minted'
# Expected: at least one line per ~12h period

# 5c. Telegram outbound
curl -X POST https://<host>/v1/auth/telegram/start \
  -d '{"telegramHandle":"@kapital0"}'
# Expected: magic-link DM lands in operator chat within 5s
```

---

## 2. Daily routine

### 2.1 Morning check (5 min)

```bash
# Telegram operator channel — scroll up to scan overnight alerts
# Look specifically for these alert kinds (§6 explains each):
#   - operator_alert_vm_spawn_failed
#   - operator_alert_vm_teardown_failed
#   - operator_alert_pdf_render_failed
#   - daily-orphan-cleanup summary

# Dashboard — open https://<host>/app/dashboard
#   filter: status = "failed" within last 24h → review each
#   filter: status = "in_progress" with age > 60min → potential stuck scan (§5)

# Deep inquiries — open https://<host>/app/admin/inquiries (or DB query):
sqlite3 /opt/tensol/data/tensol.db \
  "SELECT id, telegram_handle, company, created_at FROM deep_inquiries WHERE status='new' ORDER BY created_at;"
```

### 2.2 New Deep inquiries → contact within 24h

See §3 for the full workflow.

### 2.3 End-of-day check (5 min)

```bash
# Confirm daily-orphan-cleanup ran (should fire daily at 03:00 UTC)
sqlite3 /opt/tensol/data/tensol.db \
  "SELECT created_at, payload FROM audit_events
   WHERE kind='daily_orphan_cleanup_completed'
   ORDER BY created_at DESC LIMIT 1;"

# Confirm queue depth is reasonable (<10 outstanding jobs typically)
sqlite3 /opt/tensol/data/tensol.db \
  "SELECT handler, COUNT(*) FROM jobs WHERE status='pending' GROUP BY handler;"
```

---

## 3. Handling Deep inquiries

Lifecycle: `new` → `contacted` → `converted` | `declined` | `dropped`.

### 3.1 Within 1 hour of submission (Telegram bot pings operator)

The form on `apps/site/src/pages/DeepInquiry.tsx` relays to the operator
Telegram bot. The operator must:

1. Read the inquiry — name, company, scope, contact channel.
2. Reply within 24 hours via the channel the customer indicated.
3. Update DB row to `status='contacted'`:

```bash
sqlite3 /opt/tensol/data/tensol.db \
  "UPDATE deep_inquiries SET status='contacted', operator_notes='first contact via TG @kapital0' WHERE id='<id>';"
```

### 3.2 First-contact message template

> Здравствуйте, [Имя]. Это команда Tensol. Получили вашу заявку по [компания/URL].
> Команда ознакомится с объёмом периметра и вернётся в течение 24 часов с
> предварительной оценкой стоимости и сроков. Для следующего шага нужен NDA —
> готовы прислать наш типовой документ или подписать ваш.
>
> Спасибо за интерес,
> Tensol

### 3.3 NDA template

Operator-owned. Pointer: `docs/legal/nda-template.docx` (file does NOT yet
exist in repo — operator owns it externally on their workstation).

### 3.4 Conversion flow

- **converted** → manually issue a scan via admin endpoint OR provision a
  custom subscription tier in YooKassa
- **declined** → polite "thanks, not the right fit" message; preserve row
  for analytics
- **dropped** → no response after 7 days; auto-eligible for cleanup

```bash
# Mark conversion
sqlite3 /opt/tensol/data/tensol.db \
  "UPDATE deep_inquiries SET status='converted', operator_notes='Plus, paid via YooKassa intent <id>' WHERE id='<id>';"
```

---

## 4. Regenerating reports for clients

### 4.1 Standard flow (UI)

Customer opens `apps/site/src/pages/Reports.tsx`, picks the scan, clicks
**Regenerate PDF**. The frontend POSTs to `/v1/scans/:id/regenerate-report`,
which enqueues a `render-pdf` job (`server/src/jobs/handlers/render-pdf.ts`).

### 4.2 When the UI flow fails (artifact deleted, customer can't access)

```bash
# 1. Confirm the scan exists and is in 'completed' status
sqlite3 /opt/tensol/data/tensol.db \
  "SELECT id, status, completed_at, report_artifact_key FROM scans WHERE id='<scan_id>';"

# 2. Confirm the source evidence still exists in S3
aws --endpoint-url=https://storage.yandexcloud.net \
  s3 ls s3://${TENSOL_EVIDENCE_BUCKET}/scans/<scan_id>/

# 3. Manually enqueue a regen job (server-side, via Bun REPL or admin script)
ssh tensol-server-prod 'cd /opt/tensol && bun -e "
  import { db } from \"./src/db\";
  import { enqueueJob } from \"./src/jobs/queue\";
  await enqueueJob(db, { handler: \"render-pdf\", payload: { scanId: \"<scan_id>\", reason: \"operator-regen\" } });
"'

# 4. Watch the audit chain for the regen lifecycle
sqlite3 /opt/tensol/data/tensol.db \
  "SELECT created_at, kind FROM audit_events WHERE payload LIKE '%<scan_id>%' ORDER BY created_at DESC LIMIT 20;"
```

### 4.3 If evidence is past the 30-day retention window

Evidence is gone — bucket lifecycle policy purged it. The operator MUST
inform the customer that the PDF cannot be regenerated. The audit-chain
metadata in DB remains (24-month retention per §1.4 of T140 draft), but
without raw evidence the PDF renderer has nothing to render.

There is no recovery path. Document the customer request in the Telegram
operator channel with severity LOW and move on.

---

## 5. Force-cancelling stuck scans

### 5.1 Symptom: status frozen at `vm_provisioning` > 30 min

```bash
# Identify
sqlite3 /opt/tensol/data/tensol.db \
  "SELECT id, status, created_at, (strftime('%s','now') - strftime('%s', created_at))/60 AS age_min
   FROM scans
   WHERE status='vm_provisioning' AND age_min > 30
   ORDER BY age_min DESC;"
```

### 5.2 Force-cancel procedure

```bash
# 1. Update the scan row
sqlite3 /opt/tensol/data/tensol.db \
  "UPDATE scans
   SET status='cancelled', cancelled_at=datetime('now'), cancel_reason='operator_force_cancel_stuck_provisioning'
   WHERE id='<scan_id>';"

# 2. Emit a compensating audit event (KEEP THE CHAIN INTACT — do not bypass emit.ts)
ssh tensol-server-prod 'cd /opt/tensol && bun -e "
  import { db } from \"./src/db\";
  import { emitAudit } from \"./src/audit/emit\";
  await emitAudit(db, {
    kind: \"scan_force_cancelled_by_operator\",
    payload: { scanId: \"<scan_id>\", reason: \"stuck_in_vm_provisioning\", operatorTelegramHandle: \"@kapital0\" }
  });
"'

# 3. Teardown the orphan VM (whether or not it actually exists in Yandex)
ssh tensol-server-prod 'cd /opt/tensol && bun run cleanup-orphan-vms'
# This script: lists Yandex VMs with name prefix "tensol-scan-",
# cross-references against scans table for in_progress/vm_provisioning rows,
# tears down anything orphaned.

# 4. Refund the customer's quota if it was a paid scan
sqlite3 /opt/tensol/data/tensol.db \
  "UPDATE user_quotas SET remaining = remaining + 1 WHERE user_id = (SELECT user_id FROM scans WHERE id='<scan_id>');"
```

### 5.3 Notify customer

> К сожалению, ваш аудит [scan_id] завис на этапе инициализации
> инфраструктуры и был автоматически отменён. Квота возвращена. Можете
> запустить новый аудит из панели. Приносим извинения за неудобство.

---

## 6. Reading Telegram alerts

All alerts are emitted to the operator channel via `server/src/notify/telegram.ts`.

### 6.1 `operator_alert_vm_spawn_failed`

**Source**: `server/src/jobs/handlers/spawn-yandex-vm.ts` — Yandex compute
instance create returned an error or timed out.

**Payload**: `{ scanId, yandexError, retryCount }`.

**Response**:
1. Check Yandex status page (status.yandex.cloud) for ru-central1 incidents.
2. Check IAM token validity — `journalctl -u tensol-server | grep iam_token`.
3. If transient, the job runner retries up to 3× before alerting. If you see
   this alert, retries are exhausted.
4. Force-cancel the scan per §5; refund quota; notify customer.

### 6.2 `operator_alert_vm_teardown_failed`

**Source**: `server/src/jobs/handlers/teardown-yandex-vm.ts` — failed to
delete a per-scan VM after scan completion.

**Payload**: `{ scanId, vmInstanceId, yandexError }`.

**Response**:
1. **THIS IS A BUDGET LEAK** — orphan VM accrues compute cost.
2. Run `bun run cleanup-orphan-vms` immediately.
3. If that fails, manually delete via `yc compute instance delete <vmInstanceId>`.
4. Investigate root cause from server logs.

### 6.3 `operator_alert_pdf_render_failed`

**Source**: `server/src/jobs/handlers/render-pdf.ts` — Playwright/headless
chromium failed to render the report HTML.

**Payload**: `{ scanId, renderError, attemptCount }`.

**Response**:
1. Check disk space on server VM (PDF rendering needs ~500MB temp).
2. Check chromium binary still installed: `ssh tensol-server-prod 'which chromium'`.
3. Manually re-enqueue per §4.2 step 3.

### 6.4 `daily_orphan_cleanup_completed`

**Source**: scheduled job at 03:00 UTC daily.

**Payload**: `{ orphansFound, orphansDeleted, errors }`.

**Response**: informational; if `orphansFound > 0`, root-cause why teardown
missed them (likely a §6.2 silent failure).

### 6.5 Other alerts (less critical)

| Kind | Surface | Action |
| --- | --- | --- |
| `webhook_invalid_signature` | vps-agent → server | check secret rotation, possible attack |
| `scope_violation_attempt` | attacker agent | scan halted; review payload for false positive |
| `dns_verify_failed` | scan launch | DNS check timed out; ask customer to verify zone |
| `payment_intent_failed` | YooKassa webhook | help customer retry payment |

---

## 7. Common failures

### 7.1 DNS verify timeouts

**Symptom**: customer reports "can't launch scan, DNS check keeps failing".

**Diagnosis**:
```bash
dig +trace @8.8.8.8 _tensol-verify.<customer-domain>
```

**Likely causes**:
- Customer's DNS provider has long propagation (Cloudflare ~5 min,
  GoDaddy ~30 min, registrar-default ~24h).
- Customer copied the TXT value with surrounding quotes when their provider
  adds quotes automatically (double-quoted result).
- TXT record on wrong subdomain (root vs `www.` confusion).

**Fix**: walk the customer through `dig` manually; if their DNS is slow,
extend the verification window with an admin DB update:

```bash
sqlite3 /opt/tensol/data/tensol.db \
  "UPDATE target_verifications SET expires_at = datetime('now', '+24 hours') WHERE id='<verify_id>';"
```

### 7.2 S3 quota exceeded

**Symptom**: `operator_alert_vm_spawn_failed` with `s3_quota_exceeded` in
the yandexError field, or PDF jobs failing on upload.

**Fix**: Yandex Object Storage default quota is 1 TB per bucket; if hit,
request quota increase via Yandex Cloud console support. Short-term: run
the manual purge of artifacts older than 30 days (lifecycle should handle
this, but if it lagged):

```bash
aws --endpoint-url=https://storage.yandexcloud.net \
  s3api list-objects-v2 --bucket ${TENSOL_EVIDENCE_BUCKET} \
  --query "Contents[?LastModified<='$(date -u -d '30 days ago' +%Y-%m-%d)'].[Key]" \
  --output text | xargs -I {} aws --endpoint-url=https://storage.yandexcloud.net \
  s3 rm s3://${TENSOL_EVIDENCE_BUCKET}/{}
```

### 7.3 Telegram bot down (revoked token)

**Symptom**: outbound DMs failing with `401 Unauthorized` in server logs.

**Diagnosis**:
```bash
curl -s "https://api.telegram.org/bot${TENSOL_TELEGRAM_BOT_TOKEN}/getMe"
# Expected: {"ok":true,"result":{"id":...,"username":"tensol_leadsbot"}}
# 401 = token revoked or invalid
```

**Fix**: rotate per `docs/runbooks/secret-rotation.md` §2. If BotFather
itself is unreachable (rare), wait for Telegram-side recovery.

### 7.4 Yandex IAM exchange failures

**Symptom**: server logs show `yandex_iam_exchange_failed` repeatedly;
all compute/S3 calls return `401`.

**Diagnosis**: SA key expired or service account permissions changed.

**Fix**: rotate per `docs/runbooks/secret-rotation.md` §4. Confirm SA still
has roles `compute.editor`, `storage.editor`, `iam.serviceAccounts.user`:

```bash
yc resource-manager folder list-access-bindings tensol-prod-folder \
  | grep tensol-prod-sa
```

### 7.5 Stuck job queue

**Symptom**: jobs table growing, no handlers picking them up.

**Diagnosis**:
```bash
sqlite3 /opt/tensol/data/tensol.db \
  "SELECT handler, status, COUNT(*) FROM jobs GROUP BY handler, status;"
```

**Fix**: restart the server (`sudo systemctl restart tensol-server`). The
job runner is in-process; a restart re-claims orphaned jobs after their
heartbeat lease expires (typically 60s).

---

## 8. Escalation contacts

> Operator fills these in for their team. Do NOT commit real phone numbers
> to the repo.

| Role | Contact | When to escalate |
| --- | --- | --- |
| Founder / @kapital0 | Telegram @kapital0 | Customer disputes, prod down |
| Ops on-call | TBD | After-hours alerts |
| Security on-call | TBD | Suspected breach, leaked secret |
| Legal counsel | TBD | 152-ФЗ inquiries, NDA disputes |
| Yandex Cloud support | https://cloud.yandex.com/support | Region-wide outage |
| YooKassa support | merchant dashboard | Payment processor down |

---

## 9. Recovery procedures

### 9.1 DB restore from backup

Assumption: nightly `sqlite3 .backup` to a separate volume + weekly S3
upload. Adjust if operator uses Postgres + pgdump.

```bash
# 1. Stop the server
ssh tensol-server-prod 'sudo systemctl stop tensol-server'

# 2. Locate the latest known-good backup
ls -lh /var/backups/tensol/  # local
# or fetch from S3:
aws --endpoint-url=https://storage.yandexcloud.net \
  s3 ls s3://tensol-backups/db/ | sort | tail -5

# 3. Restore
cp /opt/tensol/data/tensol.db /opt/tensol/data/tensol.db.broken-$(date +%s)
cp /var/backups/tensol/tensol-YYYY-MM-DD.db /opt/tensol/data/tensol.db
chown tensol:tensol /opt/tensol/data/tensol.db

# 4. Verify audit chain still aligns
ssh tensol-server-prod 'cd /opt/tensol && bun run verify-chain'

# 5. Restart
ssh tensol-server-prod 'sudo systemctl start tensol-server'

# 6. Smoke test
curl -s https://<host>/healthz | jq
```

### 9.2 Audit-chain integrity check

```bash
ssh tensol-server-prod 'cd /opt/tensol && bun run verify-chain'
```

Expected output:
```
CHAIN OK rows=NNNN last_hash=<hex>
```

If you see `CHAIN BROKEN at row N`, **STOP** — do not write any more audit
rows until investigated. Likely causes:

- Signing key was rotated incorrectly (§6 of secret-rotation.md says
  DON'T rotate this key in production).
- DB row was manually edited (forensic event — investigate by hand).
- Disk corruption (check `dmesg | grep -i error`).

Recovery from a broken chain requires engineering escalation. Do not paper
over with a fresh chain — that destroys the audit history's legal weight.

### 9.3 Manual quota refund

```bash
# Refund 1 scan to user
sqlite3 /opt/tensol/data/tensol.db \
  "UPDATE user_quotas SET remaining = remaining + 1, updated_at = datetime('now') WHERE user_id = '<user_id>';"

# Emit an audit row so the refund is traceable
ssh tensol-server-prod 'cd /opt/tensol && bun -e "
  import { db } from \"./src/db\";
  import { emitAudit } from \"./src/audit/emit\";
  await emitAudit(db, {
    kind: \"quota_refund_by_operator\",
    payload: { userId: \"<user_id>\", amount: 1, reason: \"<free-text>\", operatorTelegramHandle: \"@kapital0\" }
  });
"'
```

### 9.4 Full disaster recovery (region-wide Yandex outage)

This is out of scope for the MVP. The architectural reality is:

- Server VM in ru-central1-a — single zone, no multi-AZ
- DB on same VM disk — no replica
- S3 in ru-central1 — Yandex's own multi-AZ guarantee is implicit

If ru-central1 is fully down (rare; ~1× in 2 years historically), Tensol is
down until Yandex restores. Customer expectation in Terms (§7 of T140
draft) should explicitly disclaim 99.99% — promise no more than 99.5%
monthly.

---

## Self-check before claiming a procedure complete

1. Did you update the relevant DB rows?
2. Did you emit a compensating audit event for any manual DB change?
3. Did you `verify-chain` if you touched audit rows?
4. Did you notify the customer if they're affected?
5. Did you log the action in the operator Telegram channel for paper-trail?
