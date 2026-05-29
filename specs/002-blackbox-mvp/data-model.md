# Phase 1 — Data Model

**Feature**: 002-blackbox-mvp
**Date**: 2026-05-19

This document defines entities, relationships, validation rules, and state
transitions for the Blackbox MVP. Implementation lives in
`server/src/db/schema.ts` (Drizzle TS DSL); migrations land in
`server/src/db/migrations/`.

## Conventions

- All primary keys are **Crockford ULID** (26 chars, regex
  `^[0-9A-HJKMNP-TV-Z]{26}$`), generated via `server/src/lib/ids.ts`.
- All timestamps are **unix milliseconds (`INTEGER`)** at UTC.
- Foreign keys use `ON DELETE CASCADE` for owned records, `ON DELETE
  RESTRICT` for cross-domain references.
- `CHECK` constraints enforce enums (Drizzle adds them as
  `text(..., { enum: [...] })`).

---

## E1 — `users` (existing, extended)

Already exists from 001-backend-v2 with magic-link auth. Extended for free
Quick quota.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK, ULID | existing |
| `email` | TEXT | UNIQUE NOT NULL | existing |
| `created_at` | INTEGER | NOT NULL | existing |
| `last_login_at` | INTEGER | nullable | existing |
| **`free_quick_consumed_at`** | INTEGER | nullable | NEW — unix ms of last consumed free Quick |
| **`free_quick_consumed_count`** | INTEGER | NOT NULL DEFAULT 0 | NEW — lifetime counter for analytics |

**Quota rule**: `canStartFreeQuick(userId) = (free_quick_consumed_at IS NULL OR free_quick_consumed_at < now - 7d)`.

**Atomic consume** (Drizzle SQL):

```sql
UPDATE users
SET    free_quick_consumed_at  = :now,
       free_quick_consumed_count = free_quick_consumed_count + 1
WHERE  id = :userId
  AND  (free_quick_consumed_at IS NULL OR free_quick_consumed_at < :now - 604800000)
RETURNING id;
```

Executed inside `BEGIN IMMEDIATE` tx. Empty `RETURNING` → quota
unavailable; 1 row → consumed.

---

## E2 — `scan_orders` (NEW)

The user's intent-to-scan record. Drives the wizard state machine.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK, ULID | |
| `user_id` | TEXT | FK→users(id) ON DELETE CASCADE NOT NULL | |
| `status` | TEXT | NOT NULL CHECK IN (...) DEFAULT 'draft' | see state machine below |
| `tier` | TEXT | NOT NULL CHECK IN ('quick','deep') | |
| `primary_domain` | TEXT | NOT NULL | normalized, lowercase, no trailing dot |
| `attack_surface_json` | TEXT | NOT NULL DEFAULT '[]' | JSON array of `{domain, primary, headers:[{k,v}]}` |
| `safety_rps` | INTEGER | NOT NULL DEFAULT 50 CHECK 1≤x≤500 | |
| `dns_verify_token` | TEXT | NOT NULL | `tensol-verify-<26-char-ulid>` (token IS the value to put in TXT) |
| `dns_verify_requested_at` | INTEGER | nullable | when status → dns_pending |
| `dns_verified_at` | INTEGER | nullable | when verified |
| `dns_check_attempts` | INTEGER | NOT NULL DEFAULT 0 | counter for debugging |
| `vps_instance_id` | TEXT | nullable | Yandex compute instance id |
| `vps_provider` | TEXT | NOT NULL DEFAULT 'yandex' CHECK IN ('yandex') | provider taxonomy, currently single value |
| `vps_zone` | TEXT | nullable | `ru-central1-{a,b,d}` |
| `scan_id` | TEXT | FK→scans(id) nullable | populated at launch |
| `failure_reason` | TEXT | nullable | enum-ish: `dns_timeout`, `vm_spawn_failed`, `scan_timeout`, `cancelled_pre_start`, `cancelled_post_start`, `webhook_timeout`, `internal_error` |
| `cancelled_at` | INTEGER | nullable | |
| `payment_kind` | TEXT | NOT NULL DEFAULT 'free_quick' CHECK IN ('free_quick','yookassa') | reserved for future paid path |
| `amount_kopecks` | INTEGER | nullable | reserved for future paid path; NULL for free |
| `created_at` | INTEGER | NOT NULL | |
| `updated_at` | INTEGER | NOT NULL | |

**Indexes**:
- `idx_scan_orders_user (user_id, created_at DESC)` — dashboard list
- `idx_scan_orders_status_updated (status, updated_at) WHERE status IN ('dns_pending','vm_provisioning','running')` — partial, for cron/timeout watchers

**State machine** (status transitions):

```
draft
  ↓ attack-surface + safety written
draft  (allowed to keep editing)
  ↓ POST /dns-verify/request
dns_pending
  ↓ resolveTxtAgreed loop success      → dns_verified
  ↓ 30-min timeout / cancel            → failed
dns_verified
  ↓ POST /launch (with quota consume)
vm_provisioning
  ↓ spawnVm + pollOperation success    → running
  ↓ spawnVm failure (3 retries)        → failed (refund quota)
running
  ↓ webhook scan-complete received     → completed
  ↓ 90-min wall-clock timeout          → failed (refund quota)
  ↓ DELETE scan_orders/:id within 3min → cancelled (refund quota)
  ↓ DELETE scan_orders/:id after 3min  → cancelled (NO refund)
```

Each transition emits a signed audit event (see E11).

---

## E3 — `scans` (existing, simplified)

Already exists from 001-backend-v2. We simplify by dropping auth-proof and
target relationships (now lifted into scan_orders).

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK, ULID | existing |
| `user_id` | TEXT | FK→users(id) NOT NULL | existing |
| `scan_order_id` | TEXT | FK→scan_orders(id) NOT NULL | NEW — replaces target_id |
| `profile` | TEXT | enum('recon','standard','max') | existing (we use 'recon' for Quick) |
| `status` | TEXT | enum + new transitions | unchanged |
| `failure_reason` | TEXT | nullable | unchanged |
| `started_at` | INTEGER | NOT NULL | unchanged |
| `completed_at` | INTEGER | nullable | unchanged |
| `usage_tokens` | INTEGER | nullable | unchanged |
| `usage_usd_cents` | INTEGER | nullable | unchanged |

**Drop columns** from 001 schema: `target_id`. **Drop tables** from 001:
`targets`, `projects`, `auth_proofs`.

---

## E4 — `scan_events` (NEW)

Per-scan progress event log. Used by the polling-based Live page and by
SSE-reconnect-replay logic. Append-only.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK, ULID | |
| `scan_id` | TEXT | FK→scans(id) ON DELETE CASCADE NOT NULL | |
| `event_type` | TEXT | NOT NULL CHECK IN (...) | see enum below |
| `payload_json` | TEXT | nullable | event-specific JSON |
| `created_at` | INTEGER | NOT NULL | |

**Event types**:
- `vm_provisioning`, `vm_ready`, `vm_teardown`
- `agent_started`, `agent_phase_changed` (payload: `{phase}`)
- `finding_detected` (payload: `{finding_id, severity, title}`)
- `scan_completed`, `scan_failed`

**Indexes**:
- `idx_scan_events_scan (scan_id, created_at)` — supports polling
  query `WHERE scan_id = ? AND created_at > ?`

---

## E5 — `findings` (NEW, but may already exist as stub in 001)

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK, ULID | |
| `scan_id` | TEXT | FK→scans(id) ON DELETE CASCADE NOT NULL | |
| `external_id` | TEXT | NOT NULL | the `id` field from YAML frontmatter (e.g. "FIND-001") |
| `severity` | TEXT | NOT NULL CHECK IN ('critical','high','medium','low','informational') | |
| `title` | TEXT | NOT NULL | |
| `target` | TEXT | NOT NULL | e.g. "scanme.nmap.org" |
| `cvss_score` | REAL | nullable | 0.0–10.0 |
| `cvss_vector` | TEXT | nullable | full CVSS:4.0/... vector string |
| `cvss_version` | TEXT | nullable | "4.0", "3.1" |
| `cwe_json` | TEXT | NOT NULL DEFAULT '[]' | JSON array of CWE strings (e.g. `["CWE-89"]`) |
| `mitre_json` | TEXT | NOT NULL DEFAULT '[]' | JSON array (e.g. `["T1190","T1078"]`) |
| `confidence` | TEXT | nullable CHECK IN ('verified','high','medium','low') | |
| `phase` | TEXT | nullable | which Decepticon phase produced this |
| `agent` | TEXT | nullable | which agent (recon, exploit, etc.) |
| `body_md` | TEXT | NOT NULL | full markdown body |
| `raw_yaml_json` | TEXT | NOT NULL | full YAML frontmatter as JSON, for forward-compat |
| `evidence_keys_json` | TEXT | NOT NULL DEFAULT '[]' | JSON array of Object Storage keys |
| `discovered_at` | INTEGER | nullable | from frontmatter `discovered_at` |
| `created_at` | INTEGER | NOT NULL | |

**Indexes**:
- `idx_findings_scan (scan_id, severity)`
- `idx_findings_severity (severity, created_at DESC)` — for analytics

---

## E6 — `deep_inquiries` (NEW)

Lead-gen records.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK, ULID | |
| `user_id` | TEXT | FK→users(id) nullable | NULL if anonymous |
| `company` | TEXT | NOT NULL | |
| `contact_name` | TEXT | NOT NULL | |
| `position` | TEXT | nullable | |
| `email` | TEXT | NOT NULL | |
| `phone` | TEXT | NOT NULL | E.164 or Telegram `@handle` |
| `domains_text` | TEXT | NOT NULL | free-form, one per line |
| `desired_date` | INTEGER | nullable | unix ms |
| `budget_band` | TEXT | nullable CHECK IN ('under_500k','500k_1m','1m_3m','3m_plus','open') | |
| `scope_text` | TEXT | NOT NULL | free-form, sanitized server-side |
| `consent_accepted_at` | INTEGER | NOT NULL | |
| `status` | TEXT | NOT NULL DEFAULT 'new' CHECK IN ('new','contacted','converted','declined','dropped') | |
| `telegram_sent_at` | INTEGER | nullable | |
| `telegram_send_attempts` | INTEGER | NOT NULL DEFAULT 0 | |
| `created_at` | INTEGER | NOT NULL | |
| `updated_at` | INTEGER | NOT NULL | |

**State machine** (manual transitions by operator):

```
new ─→ contacted ─→ converted
                ─→ declined
                ─→ dropped (no response)
```

**Sanitization rule** (Spec FR-034): `scope_text` is run through a
password-pattern regex (`password\s*[:=]\s*\S+`, `pwd\s*[:=]`, etc.) and
matches are replaced with `[REDACTED]` BEFORE persistence and BEFORE
Telegram notification.

---

## E7 — `jobs` (existing, extended)

The in-process SQLite-backed polling queue from 001. We extend the `kind`
enum.

| Existing kinds | New kinds (this feature) |
|---|---|
| `spawn_vps`, `teardown_vps`, `cleanup_vps_failed`, … | `spawn_yandex_vm`, `teardown_yandex_vm`, `render_pdf`, `send_scan_complete_email`, `poll_dns_verify` (optional bg poll), `scan_timeout_watcher` (cron), `retry_telegram_notification`, `cleanup_orphan_vms` (cron) |

Old kinds `spawn_vps`/`teardown_vps` are kept as deprecated aliases that
the runner routes to the new yandex-specific handlers if seen.

---

## E8 — `audit_log` (existing)

Already exists with 13-field HMAC chain from 001. We add event types but
do not change schema.

**New event types** emitted by this feature:

`scan_order_created`, `scan_order_attack_surface_updated`,
`scan_order_safety_updated`, `dns_verify_requested`, `dns_verified`,
`dns_verify_failed`, `free_quota_consumed`, `free_quota_refunded`,
`scan_order_launched`, `vm_provisioning`, `vm_ready`, `scan_started`,
`finding_ingested`, `scan_completed`, `scan_failed`, `vm_teardown`,
`pdf_render_requested`, `pdf_rendered`, `pdf_render_failed`,
`email_send_requested`, `email_sent`, `email_send_failed`,
`scan_cancelled`, `inquiry_received`, `inquiry_telegram_sent`,
`inquiry_telegram_failed`, `inquiry_status_changed`,
`webhook_invalid_signature`, `webhook_received`.

**Per Constitution X**, every state-changing operation emits one of
these. Per R2, all events land in the same audit chain.

---

## E9 — `evidence_artifacts` (NEW lightweight)

Maps Object Storage keys to scans for lifecycle management.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK, ULID | |
| `scan_id` | TEXT | FK→scans(id) NOT NULL | |
| `bucket` | TEXT | NOT NULL | `tensol-evidence-prod` etc. |
| `key` | TEXT | NOT NULL | `scans/<scan_order_id>/evidence.tar.gz` |
| `size_bytes` | INTEGER | nullable | |
| `expires_at` | INTEGER | NOT NULL | created_at + 30d |
| `created_at` | INTEGER | NOT NULL | |

Cron job (daily) deletes Object Storage objects whose `expires_at < now`
and removes the row. Lifecycle policy on the bucket is the belt; this
row tracker is the braces.

---

## E10 — `reports` (NEW)

PDF generation state and storage pointer.

| Column | Type | Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK, ULID | |
| `scan_id` | TEXT | FK→scans(id) NOT NULL UNIQUE | one report per scan |
| `status` | TEXT | NOT NULL CHECK IN ('pending','rendering','ready','failed') DEFAULT 'pending' | |
| `bucket` | TEXT | nullable | populated when ready |
| `key` | TEXT | nullable | populated when ready |
| `byte_size` | INTEGER | nullable | |
| `render_attempts` | INTEGER | NOT NULL DEFAULT 0 | |
| `last_error` | TEXT | nullable | |
| `expires_at` | INTEGER | nullable | created_at + 30d when ready |
| `created_at` | INTEGER | NOT NULL | |
| `updated_at` | INTEGER | NOT NULL | |

---

## E11 — Relationships summary

```
users 1───* scan_orders 1───1 scans 1───* scan_events
              │                  │
              │                  └──* findings 1───* evidence_artifacts
              │                  │
              │                  └──1 reports
              │
users 1───* deep_inquiries (optional FK)

audit_log — single unified chain, references entity-IDs via metadata json
jobs     — generic queue, references scan_id / scan_order_id via payload
```

---

## Validation rules (cross-cutting)

| Field | Rule | Where enforced |
|---|---|---|
| `scan_orders.primary_domain` | Valid hostname (RFC 1035), lowercase, no trailing dot, max 253 chars, no IP literal | Zod schema + service |
| `scan_orders.safety_rps` | 1–500 inclusive | Zod schema + DB CHECK |
| `scan_orders.attack_surface_json` | Array of `{domain: valid hostname, primary: bool, headers: {k:str, v:str}[]}`, max 20 items, max 10 headers each | Zod schema |
| `scan_orders.dns_verify_token` | Server-generated, format `tensol-verify-<26-char-ulid>`, never set by client | service |
| `deep_inquiries.email` | RFC 5322 (Zod `.email()`) | Zod schema |
| `deep_inquiries.scope_text` | Pre-sanitized via password-pattern regex before persistence | service |
| `deep_inquiries.consent_accepted_at` | Must be present and non-null at insert time | Zod schema + service |
| `findings.severity` | Lowercase from a fixed set | DB CHECK + ingest mapping |
| `users.free_quick_consumed_at` | Only writable via the atomic `BEGIN IMMEDIATE` consume statement | service (no other write paths) |

---

## Migration

Drizzle migration file `server/src/db/migrations/0010_blackbox_mvp.sql`:

1. `DROP TABLE auth_proofs` (cascade)
2. `DROP TABLE targets` (cascade)
3. `DROP TABLE projects` (cascade)
4. `ALTER TABLE users ADD COLUMN free_quick_consumed_at INTEGER`
5. `ALTER TABLE users ADD COLUMN free_quick_consumed_count INTEGER NOT NULL DEFAULT 0`
6. `ALTER TABLE scans DROP COLUMN target_id`
7. `ALTER TABLE scans ADD COLUMN scan_order_id TEXT NOT NULL REFERENCES scan_orders(id)`
   (since 001 has no prod users yet, no data preservation needed)
8. `CREATE TABLE scan_orders (...)`
9. `CREATE TABLE scan_events (...)`
10. `CREATE TABLE findings (...)` if absent
11. `CREATE TABLE deep_inquiries (...)`
12. `CREATE TABLE evidence_artifacts (...)`
13. `CREATE TABLE reports (...)`
14. Create indexes per E2/E4/E5.

No data is migrated (001 has no prod users per Constitution V backwards-compat clause).

---

**End of data model.**
