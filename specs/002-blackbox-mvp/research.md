# Phase 0 — Research Notes

**Feature**: 002-blackbox-mvp
**Date**: 2026-05-19

This document resolves the open questions and dependency-best-practice items
identified in the design doc (`docs/superpowers/specs/2026-05-19-blackbox-mvp-design.md`)
and the spec. Each entry follows the **Decision / Rationale / Alternatives**
format.

---

## R1 — Subdomain auto-discovery aggressiveness

**Question**: Step 1 of the wizard auto-detects subdomains for the primary
domain. How aggressive? CT (certificate transparency) logs, brute-force
wordlist, both, or just `www`?

**Decision**: Use **Certificate Transparency logs as the sole source** in
MVP. Query `crt.sh` JSON endpoint (`https://crt.sh/?q=%.{domain}&output=json`)
with a 5-second timeout and a 100-result cap. Filter to unique hostnames
that match the primary domain's apex. Always include `www.<domain>` as a
default-checked entry whether CT returned it or not.

**Rationale**:
- CT logs return real-world deployed hostnames (the attacker's actual
  starting set). Brute-force wordlists return *theoretical* targets that
  may not exist, which adds UI noise and slows the wizard.
- `crt.sh` is free, well-maintained, no API key.
- The 5-second timeout keeps the wizard responsive when `crt.sh` is slow.
- The 100-result cap prevents pathological domains (e.g. SaaS providers
  with thousands of customer subdomains) from drowning the UI.
- Brute-force wordlists are deferred; Decepticon's recon agent does its
  own enumeration during the scan, so we don't lose coverage.

**Alternatives considered**:
- *Wordlist-only*: noisy, theoretical, slow.
- *Hybrid CT + wordlist*: doubles surface complexity without measurable
  signal gain for a 4-step wizard.
- *Skip auto-discovery, only let user enter manually*: too much friction
  for users who don't remember every subdomain they own.

**Implementation note**: One function `discoverSubdomains(primary, timeoutMs, capN)`
in `server/src/scan-orders/subdomain-probe.ts`. Result merged with `www`
fallback. Cached per scan_order_id so the user can navigate back from
step 2 without re-querying.

---

## R2 — Audit-chain unification for `deep_inquiries`

**Question**: Should `deep_inquiries.*` state changes emit into the same
HMAC audit chain as `scans`, or into a separate chain?

**Decision**: **Single unified chain.** All state-changing events
(`scan_order_created`, `inquiry_received`, `inquiry_telegram_sent`,
`vm_provisioning`, `finding_ingested`, …) emit through one
`emitSignedAudit()` call. The chain hash includes the event-type field,
so verifier tooling can filter without losing chain integrity.

**Rationale**:
- Constitution Principle X says "every state-changing operation MUST emit
  a signed audit row". Splitting chains adds operational complexity
  (two `verify-chain` tools, two retention policies) for no security gain.
- The unified chain gives a single forensic timeline that links a Deep
  inquiry's lifecycle to any eventual Quick scan from the same user_id.
- The audit emit pattern (`emitSignedAudit(db, args)`) is already
  reusable — no abstraction work needed.

**Alternatives considered**:
- *Separate chain*: extra `audit_log_inquiries` table + dedicated verifier
  CLI. Premature separation, violates Principle IV.
- *No audit for inquiries*: violates Principle X.

**Implementation note**: Reuse `emitSignedAudit()` from
`server/src/audit/emit.ts`. New event types added to the existing event
enum.

---

## R3 — Exact ₽ pricing values per tier

**Status**: **DEFERRED — operator decision, not technical research.**

The operator (project owner) will finalize prices once the cost model
spreadsheet is filled in (LLM cost × profile × margin × infra overhead).
This is a business decision, not a research question. The MVP ships with:
- Quick = **free** (interim, feature-flagged)
- Deep = **"from ₽X, см. форма заявки"** (no specific price, contact-based)

Once paid checkout activates (`TENSOL_YOOKASSA_LIVE=true`), the operator
will provide the exact numbers and they will be stored in a single config
file `server/config/pricing.ts` (or env vars), not hard-coded in routes.

**No further research action.**

---

## R4 — Yandex Cloud REST API integration pattern

**Question**: Yandex Cloud's API design guide
(https://yandex.cloud/ru/docs/api-design-guide/concepts/general) is
gRPC-first with REST via gRPC-JSON transcoder. What's the integration
pattern from TypeScript/Bun?

**Decision**: Use **plain `fetch` against the REST endpoints** with three
shared helpers (`getIamToken`, `pollOperation`, `idempotencyKey`).

Endpoints used (MVP scope):
- `POST https://compute.api.cloud.yandex.net/compute/v1/instances` — spawn VM
- `GET  https://operation.api.cloud.yandex.net/operations/{operationId}` — poll async op
- `GET  https://compute.api.cloud.yandex.net/compute/v1/instances/{instanceId}` — status
- `DELETE https://compute.api.cloud.yandex.net/compute/v1/instances/{instanceId}` — teardown
- `POST https://iam.api.cloud.yandex.net/iam/v1/tokens` — IAM token refresh
- `POST https://storage.yandexcloud.net/{bucket}/{key}` — Object Storage upload
  (or via aws-sdk-style signing)

**Rationale**:
- The official Yandex Cloud SDK for Node is heavyweight (depends on
  full gRPC + protobuf stack). The handful of endpoints we touch (4 compute
  endpoints + IAM + Object Storage) is much lighter as a hand-rolled REST
  client at ~250 LOC.
- Avoids transitive deps explosion in `package.json`.
- Constitution VII (small files) and IV (no premature abstraction)
  favor a thin REST client.

**Async operation pattern** (per API design guide):
Every state-changing call returns an `Operation` object with `done: false`.
We poll `GET /operations/{id}` with exponential backoff (1s → 2s → 4s →
max 8s) up to 10 minutes total before timing out. On `done: true`, the
`response` field contains the final resource; on error, the `error` field
contains a structured error.

**Idempotency**:
Every spawn includes `Idempotency-Key: <scan_order_id>` header. Yandex
deduplicates within a 24-hour window. Safe to retry on transient failures.

**Alternatives considered**:
- *Official Yandex Cloud SDK*: bloated, gRPC dep, slow build.
- *Terraform-as-a-runtime via API*: overkill, indirect, slow.
- *cdktf or pulumi*: same problem.

**Implementation note**: All Yandex REST in `server/src/vps/yandex.ts`.
Mock at the `fetch`-call level for default tests (per Constitution VI:
fake provider, real provider on PR-merge + nightly).

---

## R5 — IAM token lifecycle

**Question**: Yandex IAM tokens are short-lived (12 hours). How does the
backend refresh them safely?

**Decision**: **Refresh-on-demand with cached singleton.** The Yandex
client module exposes `getIamToken()` which:
1. Returns the cached token if `now < expiresAt - 5min`.
2. Otherwise calls `POST /iam/v1/tokens` with the service-account JSON
   key (signed JWT per spec), updates the cache, returns.

The service-account key lives in env `YANDEX_SA_KEY_JSON` (base64-encoded
JSON). Backend never writes it to disk.

**Rationale**: 5-minute safety margin avoids race conditions during
long-running polling loops. Singleton cache makes the refresh O(1)
amortized.

**Alternatives considered**:
- *Pre-refresh on a schedule*: needs a separate job runner entry; extra
  complexity. On-demand is simpler.
- *Pass token as env var*: token expires every 12h; operator would have
  to rotate manually.

---

## R6 — DNS resolver bypass for ownership verification

**Question**: Spec FR-009 requires using public, independent DNS resolvers
(not system resolver) to mitigate spoofing. How implemented?

**Decision**: **Direct UDP/TCP resolver via `node:dns/promises.Resolver`
with explicit servers**. Two-resolver-and-agree pattern:
- Primary: `1.1.1.1` (Cloudflare) and `1.0.0.1`
- Secondary: `8.8.8.8` (Google) and `8.8.4.4`

We query both and require the TXT record to be present in BOTH resolvers'
responses to count as verified. If either resolver returns NXDOMAIN /
empty, we treat as unverified and retry on the next poll.

**Rationale**:
- Two independent resolver vendors makes a successful spoofing attack
  require compromising both Cloudflare and Google's DNS at once.
- TXT lookups are fast (~50-200ms typical).
- Both resolvers are free, no API key, well-known stable IPs.

**Alternatives considered**:
- *DoH (DNS over HTTPS)*: more complex, HTTP overhead, not measurably
  more secure for this purpose.
- *Authoritative resolution*: requires SOA lookup + recursive walk;
  too complex for MVP.

**Implementation note**: `server/src/dns-verify/resolver.ts` exports
`resolveTxtAgreed(domain): Promise<string[] | null>`. Returns the
intersection of TXT records both resolvers agree on; null if any timeout.

---

## R7 — PDF rendering reliability

**Question**: Puppeteer crashes are a known operational risk. How does the
PDF job survive?

**Decision**: **Render in a dedicated `jobs/handlers/render-pdf.ts`
worker with 3-retry policy, fallback to email-without-attachment.**

Sequence:
1. Worker spawns Puppeteer (`puppeteer-core` + `@sparticuz/chromium-min`
   to avoid heavy Chrome dep in production).
2. 60-second timeout on render. On crash/timeout → retry (max 3 attempts
   with 30s gap).
3. After 3 failures, mark scan's `pdf_render_status = 'failed'` and
   emit email **without** attachment (link only).
4. User can click "Regenerate PDF" on Reports page → re-enqueues the job.

**Rationale**:
- Puppeteer is the standard for HTML→PDF in Node; alternatives
  (`pdfkit`, `puppeteer-cluster`) are either lower-fidelity or more
  complex.
- 3-retry + fallback satisfies SC-006 (≤1% of completed scans lack a
  downloadable report within 5min).
- Email-link fallback keeps scan completion non-blocking on PDF.

**Alternatives considered**:
- *Server-side render via React Server Components → string → wkhtmltopdf*:
  wkhtmltopdf is unmaintained.
- *Headless Chromium in a separate microservice*: violates Constitution
  III (single binary). Worker-thread within `server/` is the compromise.

---

## R8 — Telegram bot send-retry on rate limit

**Question**: Telegram Bot API returns 429 with `retry_after` header
under bursts. How does the inquiry notify handle this?

**Decision**: **Exponential backoff with `retry_after` honored, max 5
attempts.** Use the `retry_after` from the 429 response body
(`parameters.retry_after`) when present; otherwise back off
2^attempt seconds.

If all 5 attempts fail, the inquiry row still has `status='new'` and a
background cron retries every 10 minutes for 24 hours. Operator notified
via Telegram alert when retries succeed (or after 24h fail).

**Rationale**:
- Telegram's 429 rate is generous (~30 msg/sec to a single chat); we'd
  hit it only on bursts. Backoff is sufficient.
- Background cron ensures eventual delivery (Spec SC-007 measures the
  60-sec target on the success path; abnormal retries are non-blocking
  for the user, who sees their thank-you page regardless).

**Alternatives considered**:
- *Queue-based retry with a dedicated `notification_jobs` table*: same
  outcome with more code.

---

## R9 — Yandex Object Storage upload from VM

**Question**: How does `vps-agent` upload `evidence.tar.gz` to Object
Storage? The VM has a service-account-scoped IAM key.

**Decision**: **AWS S3-compatible signing** via the `aws-sdk-v3` S3
client (Yandex Object Storage is S3-compatible). The VM receives a
write-only IAM access-key + secret scoped to one bucket prefix
(`s3://tensol-evidence/scans/<scan_order_id>/*`). Key issued at VM
spawn time, ephemeral.

**Rationale**:
- Yandex Object Storage advertises S3 wire-compatibility, so the AWS
  SDK works out of the box.
- Per-scan scoped keys prevent one compromised VM from reading
  cross-tenant evidence.
- The `aws-sdk-v3` `@aws-sdk/client-s3` package is well-supported.

**Alternatives considered**:
- *Server-mediated upload (VM POSTs to our backend, backend stores)*:
  doubles bandwidth + backend RAM pressure under concurrent scans.
- *VM uses MinIO SDK*: irrelevant — Yandex isn't MinIO.

**Implementation note**: VM cloud-init writes
`/etc/tensol/yandex-s3-key.json`. `vps-agent` reads this, configures
S3 client at `https://storage.yandexcloud.net`, uploads.

---

## R10 — Cleanup cron for orphan VMs

**Question**: How does the system avoid leaking ephemeral VMs when the
backend or worker crashes between `spawnVm` and `teardownVm`?

**Decision**: **Cron-fired script `scripts/cleanup-orphan-vms.ts`
every 15 minutes.** Lists all VMs in the test folder (and prod folder)
matching name prefix `tensol-test-*` or `tensol-scan-*` AND
`createdAt < now - <grace>` where grace = 30 min for tests / 120 min
for prod. Deletes each. Idempotent. Alerts operator via Telegram if
more than 0 orphans deleted in a single run (signals a real teardown
bug to fix).

**Rationale**:
- Belt-and-braces: even if `afterAll`/teardown-job logic has a bug,
  no VM lives longer than the grace window.
- 120-min prod grace = ~30% margin over the 90-min scan timeout.
- Telegram alert on every nonzero cleanup makes silent leakage
  impossible.

**Alternatives considered**:
- *Yandex-side lifecycle policy*: not exposed for Compute instances.
- *Trust the teardown job alone*: too brittle; one crash leaks money.

---

## R11 — Cloud-init bootstrap reliability

**Question**: Cloud-init bugs only manifest on real VMs. How do we ship
confidence in the bootstrap script?

**Decision**: **Three layers of confidence.**
1. **Unit-tested template rendering** — `cloud-init.test.ts` verifies the
   bash output matches expected fixtures for representative inputs.
2. **Real-VM integration test in `vps/yandex-real.test.ts`** — runs on
   PR-merge + nightly, spawns a real VM with a minimal Decepticon-less
   payload that writes a marker file `/tmp/cloud-init-marker`. Test polls
   for marker via SSH (or via backend webhook), confirms cloud-init
   reached the end without error.
3. **Nightly smoke test** runs full scan path on `juice-shop.tensol.dev`
   (operator-controlled vulnerable target), confirms ≥3 findings ingested.

**Rationale**:
- Layer 1 catches template-syntax bugs cheaply, every test run.
- Layer 2 catches actual-VM bugs (apt failures, docker race conditions,
  missing tools) at PR-merge time.
- Layer 3 catches Decepticon-side regressions and webhook contract drift.

**Alternatives considered**:
- *Skip layer 2, only nightly*: PR-merge would silently break
  cloud-init until next nightly. Too slow.

---

## R12 — Email transactional provider choice

**Question**: Which email provider? Constraints: must work for RU
recipients, support attachment delivery, simple HTTP API.

**Decision**: **Resend**. Sign up under operator's ИП. Use Resend's API
for both magic-link (already existing) and scan-complete notifications.

**Rationale**:
- Resend has a clean API (single `POST /emails`), supports attachments
  via base64 payload.
- Deliverability to RU mailboxes (mail.ru, yandex.ru, gmail.com) is
  validated by the existing magic-link flow.
- Same provider for two email paths reduces operational surface.

**Alternatives considered**:
- *SendGrid*: more enterprise, expensive on low volume.
- *AWS SES*: requires AWS account (operator may not have); region
  ru-central1 not natively supported.
- *Self-hosted SMTP*: deliverability nightmare.

**Implementation note**: `RESEND_API_KEY` env var. `server/src/notify/
email.ts` wraps the API with retry-on-5xx.

---

## R13 — Feature-flag mechanism for paid checkout toggle

**Question**: How is `TENSOL_YOOKASSA_LIVE` consumed? Compile-time or
runtime?

**Decision**: **Runtime env var read on each request that branches
behavior.** No compile-time DI, no feature-flag service.

- Backend: `process.env.TENSOL_YOOKASSA_LIVE === 'true'` checked in three
  places (1) `scan-orders/service.ts::launchScan` to gate `quick` free
  vs paid path, (2) `routes/scan-orders.ts` to surface tier availability
  to frontend, (3) `pricing` API endpoint to advertise tier prices.
- Frontend: reads `/v1/config/feature-flags` (new tiny endpoint) on
  app boot, caches in React context for session.

When the toggle flips, **no migration needed** — current Quick scans
in flight stay free; new Quick scans after the flip require payment.

**Rationale**:
- Tiny scope (1 flag). LaunchDarkly / etc. is YAGNI.
- Env-var-based flags are operator-friendly (set in cloud-init / Docker
  env) and trivially auditable.

---

## Summary of resolved unknowns

| ID | Status | Output landing in |
|---|---|---|
| R1 Subdomain discovery | Decided: CT logs only | `data-model.md`, `contracts/openapi.yaml` |
| R2 Audit chain unification | Decided: single chain | `data-model.md` |
| R3 Pricing values | Deferred (operator decision) | `server/config/pricing.ts` (TBD) |
| R4 Yandex REST integration | Decided: hand-rolled fetch + helpers | `server/src/vps/yandex.ts` |
| R5 IAM token lifecycle | Decided: on-demand cached singleton | `server/src/vps/yandex.ts` |
| R6 DNS resolver bypass | Decided: dual-resolver agreement | `server/src/dns-verify/resolver.ts` |
| R7 PDF reliability | Decided: 3-retry + email-link fallback | `server/src/jobs/handlers/render-pdf.ts` |
| R8 Telegram retry | Decided: 5-attempt backoff + 24h cron | `server/src/notify/telegram.ts` |
| R9 Object Storage upload | Decided: AWS-SDK v3 S3 client | `vps-agent/src/evidence-upload.ts` |
| R10 Orphan cleanup | Decided: cron + Telegram alert | `server/scripts/cleanup-orphan-vms.ts` |
| R11 Cloud-init reliability | Decided: 3-layer test confidence | `server/src/vps/cloud-init.test.ts` + real-Yandex IT + nightly |
| R12 Email provider | Decided: Resend | `server/src/notify/email.ts` |
| R13 Feature flag toggle | Decided: runtime env var | `server/src/scan-orders/service.ts` |

**Zero remaining NEEDS CLARIFICATION items**. Ready for Phase 1.
