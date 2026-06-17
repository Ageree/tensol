# Webhook contract — `vps-agent → server`

This document defines the HMAC-signed contract between the ephemeral
GCP VM (running `vps-agent`) and the Sthrip backend.

## Endpoint

`POST https://api.sthrip.dev/v1/webhooks/scan-complete`

## Signature header

```
X-Tensol-Signature: t=<unix-seconds>, v1=<hex-hmac-sha256>
```

- `t` — unix timestamp (seconds) when the agent built the signature. Must
  be within ±5 minutes of server clock or the request is rejected.
- `v1` — `hex(hmac_sha256(secret, "${t}.${body_bytes}"))`; as a SHA-256
  digest it is exactly 64 hex characters.

The secret is `TENSOL_WEBHOOK_SECRET`, configured on the backend and
provisioned into the VM via cloud-init at spawn time.

## Body schema

```json
{
  "scan_order_id": "<26-char ULID>",
  "status": "completed",
  "failure_reason": null,
  "completed_at": 1779180090123,
  "decepticon_events_count": 759,
  "findings": [
    {
      "raw_yaml_frontmatter": {
        "id": "FIND-001",
        "severity": "critical",
        "cvss_score": 9.3,
        "cvss_vector": "CVSS:4.0/AV:N/...",
        "cwe": ["CWE-89"],
        "mitre": ["T1190", "T1078"],
        "affected_target": "scanme.nmap.org",
        "...": "any other YAML keys preserved as-is"
      },
      "body_md": "# [CRITICAL] ...\n\nfull markdown body...",
      "evidence_keys": [
        "scans/01ARZ.../FIND-001_login-response.json",
        "scans/01ARZ.../FIND-001_jwt-decoded.txt"
      ]
    }
  ],
  "evidence_archive_url": "gs://tensol-evidence-prod/scans/01ARZ.../evidence.tar.gz",
  "duration_seconds": 2280
}
```

Failed terminal callback example:

```json
{
  "scan_order_id": "<26-char ULID>",
  "status": "failed",
  "failure_reason": "decepticon_failed: docker_exit_137",
  "completed_at": 1779180090123,
  "findings": [],
  "duration_seconds": 17
}
```

## Validation order

1. **Signature** (`X-Tensol-Signature` valid + within ±5 min) — failure →
   401 + `webhook_invalid_signature` audit event + Telegram alert to
   operator.
2. **Zod schema** — failure → 422.
3. **Idempotency replay check** — if `webhook_dedup` already has
   `webhook_kind='scan_complete' AND dedup_key=$scan_order_id`, return 200
   no-op (replay protection).
4. **Order ownership** — fetch `scan_orders.id = scan_order_id`. If
   missing or not in status `running` / `vm_provisioning`, return 404/409
   without reserving a new dedup row.
5. **Idempotency reservation** — insert into `webhook_dedup`; a unique-key
   collision returns 200 no-op for concurrent first deliveries.
6. **Findings ingest** — for each finding, parse `raw_yaml_frontmatter`,
   INSERT into `findings`, emit `finding_ingested` audit event.
7. **State transition** — `scan_orders.status` / `scans.status` →
   `completed` or `failed`, `scans.completed_at` set to server receive time,
   emit `scan_completed` or `scan_failed`.
8. **Follow-up effects**: on `completed`, enqueue `render_pdf`,
   `send_scan_complete_telegram`, `teardown_scan_vm`; on `failed`, refund
   free-Quick quota for free orders and enqueue only `teardown_scan_vm`.

## Required fields (machine-validated)

| Field | Type | Required | Notes |
|---|---|---|---|
| `scan_order_id` | string ULID | yes | must match a scan_order owned by the backend |
| `status` | `"completed"` or `"failed"` | no | defaults to `completed` for legacy payloads |
| `failure_reason` | string or null | required when failed | omitted/null when completed; max 255 chars |
| `completed_at` | integer (unix ms) | yes | within last 24h and not more than 5min in the future |
| `decepticon_events_count` | integer | optional | observability metric |
| `findings` | array | yes | may be empty (zero-findings scan) |
| `findings[].raw_yaml_frontmatter` | object | yes | must contain `id`, `severity`, `title` |
| `findings[].body_md` | string | yes | markdown body of the finding |
| `findings[].evidence_keys` | array of strings | yes | may be empty |
| `evidence_archive_url` | string (URI) or null | required when completed | `gs://...` format, must match expected bucket |
| `duration_seconds` | integer | yes | ≥ 0 |

## Required YAML frontmatter fields per finding

The `raw_yaml_frontmatter` object MUST contain:

- `id` — string, unique within the scan (`FIND-001`, etc.)
- `severity` — one of `critical`, `high`, `medium`, `low`, `informational`
- `title` — string

It MAY contain (preserved as-is, parsed into typed columns where present):

- `cvss_score`, `cvss_vector`, `cvss_version`
- `cwe` — array of strings
- `mitre` — array of strings
- `affected_target`, `affected_component`
- `confidence` — one of `verified`, `high`, `medium`, `low`
- `phase`, `agent`
- `objective_id`
- `discovered_at` — ISO-8601 string or unix ms
- `remediation_priority`

Unknown keys are preserved in the `raw_yaml_json` column for
forward-compatibility.

## Error response examples

```json
// 401 — bad signature
{ "error": "webhook_invalid_signature", "message": "Signature verification failed" }

// 401 — too old
{ "error": "webhook_replay_too_old", "message": "Timestamp outside ±5min window" }

// 409 — wrong order state
{ "error": "scan_order_not_running", "message": "Order is in status 'failed'" }

// 422 — malformed body
{ "error": "webhook_body_invalid", "message": "findings[0].raw_yaml_frontmatter.severity missing" }
```

## Retry semantics

`vps-agent` retries the webhook on transport-level failures (network
timeout, 5xx) with backoff: 5s → 15s → 45s → fail. After fail, the agent
logs the error and shuts the VM down anyway — the backend's
`scan_timeout_watcher` cron picks up the order at 90 min mark and marks
it failed.

If Decepticon, finding collection, bundling, or evidence upload fails before a
successful evidence archive exists, `vps-agent` still sends a signed
`status="failed"` callback without `evidence_archive_url`. The backend treats
that as terminal, marks scan/order failed immediately, refunds free-Quick quota
for free orders, and enqueues VM teardown.

The backend treats duplicate webhook bodies (same `scan_order_id`) as
idempotent through `webhook_dedup` — second arrival returns 200 with no state
change. Signed callbacks for unknown orders or orders not yet in
`running`/`vm_provisioning` do not create dedup rows, so a later legitimate
callback for the same order can still complete after the order state is fixed.

## Test fixtures

- `server/test/fixtures/webhook-scan-complete-juiceshop.json` — replay
  of the 9-finding Juice Shop scan from 2026-05-19 for regression
  testing of the ingest parser.
- `server/test/fixtures/webhook-scan-complete-zero-findings.json` —
  empty findings array for zero-result path.
- `vps-agent/test/fixtures/webhook-sample-signed.json` + corresponding
  `signature.txt` — contract test for the signing side.
