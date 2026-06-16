# Purpose

`server/` is the Bun/Hono backend service for Sthrip: REST API, auth,
scan-order lifecycle, review/whitebox jobs, audit events, reports, notifications,
database migrations, and cloud/VM integrations.

# Ownership

- Own `server/src/**`, migrations, server tests, scripts, Dockerfile, and
  server package configuration.
- Production API target is `https://api.sthrip.dev`, currently served from the
  GCP VM described in `docs/project-current-context.md`.

# Local Contracts

- Treat legacy Tensol/YooKassa/RUB fields as compatibility unless a task
  explicitly targets legacy behavior.
- New billing/entitlement behavior must be provider-agnostic and must not depend
  on YooKassa or RUB-only assumptions.
- Keep API contracts compatible with the existing frontend REST client unless
  the task explicitly includes coordinated frontend/server changes.
- Keep secrets out of source, docs, fixtures, logs, and Dox files.
- Prefer GCP scanner VM rails for current production scan provisioning.
- Live-scan preflight and `spawn_scan_vm` runtime must fail missing explicit
  evidence/report storage env; do not treat object-storage endpoint or
  credentials as optional for real production scans. Preflight must also fail
  when `TENSOL_WEBHOOK_SECRET` equals `TENSOL_AUDIT_SIGNING_KEY`.
- `spawn_scan_vm` dispatches the scanner with `callback_version="v2"` and the
  `/v1/webhooks/scan-complete` contract. Treat `/api/webhooks/scan-progress`
  as legacy compatibility unless a task explicitly targets that path.
- Production `spawn_scan_vm` must generate a fresh backend-to-agent dispatch
  key for each scan VM. Do not pass `TENSOL_AUDIT_SIGNING_KEY` into cloud-init
  as `TENSOL_SIGN_KEY`, and do not fall back from `TENSOL_WEBHOOK_SECRET` to
  the audit key.
- DNS verification's 30-minute hard timeout takes precedence over
  `TENSOL_DEV_DNS_BYPASS=true`; expired verification windows mark the scan order
  `failed` with `failure_reason="timeout"`.
- The V2 scan-complete webhook is terminal: `completed` callbacks create
  report/Telegram/teardown jobs; `failed` callbacks mark scan/order failed,
  refund free-Quick quota for free orders, and enqueue teardown only among
  follow-up jobs.
- V2 scan-complete callback bodies must carry `completed_at` within the last
  24h and not more than 5min in the future; reject stale body timestamps before
  inserting the `webhook_dedup` row or mutating scan state.
- V2 scan-complete idempotency must keep duplicate replay fast-paths, but new
  `webhook_dedup` rows are reserved only after the referenced scan order exists
  and is callback-eligible (`running` / `vm_provisioning`).
- Production `watchdog_scan` jobs are real liveness checks, not placeholders.
  Probe the scanner agent at `http://<vps.ipv4>:8080/status`; the probe is
  liveness-only and must not send secrets.
- Production `retry_telegram_notification` jobs are real operator alerts for
  VM spawn/teardown and PDF render failures. They send plain-text Telegram
  messages through `TENSOL_TELEGRAM_BOT_TOKEN` / `TENSOL_TELEGRAM_CHAT_ID`;
  missing or failing Telegram config should surface through runner retries and
  `job_failed`, not be silently acknowledged.
- Production `send_deep_inquiry_telegram` jobs are real operator notifications
  for the deep-engagement funnel. They use the low-level Telegram text sender
  and re-enqueue themselves on transient Telegram failures instead of relying
  on an in-process retry loop.
- Production `whitebox_scan` jobs wire the Joern reachability adapter
  independently of the MDASH harness gate. `createJoernClient` must degrade to
  an empty result when Joern is absent; `TENSOL_HARNESS_ENABLED` controls only
  the multi-model verdict generator.
- PR runtime execution is control-plane only in the API server. When
  `STHRIP_PR_EXECUTION_ENABLED` is on, dispatch only to an explicitly configured
  isolated worker (`STHRIP_PR_EXECUTION_WORKER_URL` + secret); never add an
  API-server fallback that executes customer branch code locally.
- `TENSOL_AGENT_WHITEBOX_ENABLED` is legacy parse-only compatibility, not a
  runtime whitebox gate. Do not alias it to harness automatically; use
  `TENSOL_HARNESS_ENABLED` plus `TENSOL_RESEARCH_ENABLED` for MDASH deep mode.

# Work Guidance

- Use existing Hono route, service, job-handler, audit, and test patterns.
- For migrations, keep schema changes staged and pair them with regression tests
  around lifecycle, auth, audit, webhook idempotency, or worker behavior as
  appropriate.
- For route/contract changes, update tests and any OpenAPI/spec files that are
  authoritative for the touched surface.

# Verification

- General server tests: `bun run --cwd server test`.
- Secret check when touching config, deploy, docs, or env-adjacent files:
  `bun run --cwd server check:no-secrets`.
- Migration-related changes: run the relevant migration command or migration
  tests before claiming readiness.

# Child DOX Index

No child Dox docs yet.
