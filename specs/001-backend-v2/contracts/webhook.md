# Webhook Contract — VPS-agent → Backend

## Purpose

The scan environment running on each ephemeral VPS reports back to the backend exactly once when the scan reaches a terminal state. This document defines the wire contract.

## Endpoint

`POST {TENSOL_WEBHOOK_BASE_URL}/webhooks/scan-progress`

`TENSOL_WEBHOOK_BASE_URL` is passed to the VPS at provision time as part of the cloud-init payload. The VPS never resolves DNS for the backend by itself.

## Required headers

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-Tensol-Scan-Id` | The `scans.id` ULID this callback is about |
| `X-Tensol-Signature` | Hex-encoded HMAC-SHA256, see *Signature* below |

## Request body

```json
{
  "scan_id": "01HXAB...",
  "status": "done" | "failed",
  "failure_reason": "agent_timeout" | "decepticon_crash" | null,
  "usage": { "tokens": 12345, "usd_cents": 87 } | null,
  "findings": [
    {
      "severity": "high",
      "title": "Reflected XSS on /search?q=",
      "body_md": "...",
      "evidence": { "request": "...", "response": "..." }
    }
  ]
}
```

- `scan_id` in the body MUST match the `X-Tensol-Scan-Id` header. Mismatch → reject 400.
- `findings` is omitted (or empty) when `status='failed'`.
- `body_md` is plain markdown, no `<script>` (server sanitizes on read).

## Signature

The signature is HMAC-SHA256 over the **raw request body bytes** using the `sign_key` from the matching `vps_instances` row (the same key the backend generated and embedded in the VPS cloud-init payload).

```
signature_hex = hex(HMAC-SHA256(sign_key_bytes, body_bytes))
```

The backend looks up the key by `X-Tensol-Scan-Id → vps_instances.sign_key`. On mismatch it returns `401` and writes an audit row `webhook_signature_invalid`. **The scan state is not changed on signature failure** — the watchdog will probe the VPS-agent directly.

The agent SHOULD retry on network failures with exponential backoff (1s, 5s, 25s, 125s, then give up). The backend MUST be idempotent: duplicate callbacks for the same `scan_id` after the scan is terminal are accepted with `200` but mutate nothing.

## Status transitions triggered

| Callback status | Backend action |
|-----------------|----------------|
| `done` | Insert findings (dedup by `scan_id + sha256(title)`), set `scans.status='completed'`, set `usage_*`, audit `scan_completed`, enqueue `teardown_vps` |
| `failed` | Set `scans.status='failed'`, `failure_reason` from body, audit `scan_failed`, enqueue `teardown_vps` |

## Failure modes

| Condition | Status | Audit event |
|-----------|--------|-------------|
| Signature mismatch | `401` | `webhook_signature_invalid` |
| Unknown `scan_id` | `404` | `webhook_unknown_scan` |
| Scan already terminal | `200` | `webhook_late_callback` (informational) |
| Body fails Zod validation | `400` | `webhook_invalid_body` |

## Why this shape

- Single callback per scan (not streaming): keeps both sides stateless and the contract debuggable.
- HMAC over raw body: simplest possible signature scheme; no canonicalization to argue about.
- Idempotency via dedup key on findings: retries don't double-count.
- 401 doesn't change scan state: an attacker who forges a partial callback can't move a scan to failed; the watchdog is authoritative for unreachable agents.
