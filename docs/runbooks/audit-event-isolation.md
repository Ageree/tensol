# Audit-event isolation runbook

> Operational procedures for querying `audit_events` safely across tenants
> and verifying append-only invariants. Owner: security on-call.
> Updated: Sprint 4.

## §1 Per-tenant query template

When triaging a security event for a single tenant, always include the
`__platform__` sentinel exclusion. The sentinel is created lazily by
`apps/api/src/routes/shared.ts:ensurePlatformTenantId` to satisfy the
`audit_events.tenant_id` foreign key on unattributed rows (failed logins for
unknown email, register-410-Gone, password-reset miss, pre-auth-token replay).
Including it in a per-tenant aggregate would skew counts.

```sql
SELECT id, action, resource_type, resource_id, actor_id, actor_name,
       ip, user_agent, after_state, occurred_at
  FROM audit_events
 WHERE tenant_id = :tenant_id
   AND tenant_id NOT IN (SELECT id FROM tenants WHERE slug = '__platform__')
 ORDER BY occurred_at DESC
 LIMIT 100;
```

The product API at `GET /api/v1/audit-events` enforces the same filter via
`AuditEventsRepo.findForTenantPage`. Compliance scripts that talk to the DB
directly MUST keep the `NOT IN` subquery.

## §2 Platform-level query template

Only for compliance reviewers / platform_admin role. Reads the unattributed
sentinel rows.

```sql
SELECT id, action, resource_type, resource_id, actor_id, actor_name,
       ip, user_agent, after_state, occurred_at
  FROM audit_events
 WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '__platform__')
 ORDER BY occurred_at DESC
 LIMIT 200;
```

Cross-tenant audit visibility is **not** part of the read API in this slice;
platform_admin receives 403 on `GET /api/v1/audit-events` per ADR 0004
§Limitations. The compliance review path is direct-DB only.

## §3 Trigger health check

The append-only enforcement on `audit_events` lives in the migration-011
PL/pgSQL trigger. Verify the trigger is still attached:

```sql
SELECT tgname, tgenabled
  FROM pg_trigger
 WHERE tgrelid = 'audit_events'::regclass
   AND NOT tgisinternal;
```

Expected output: at least two rows with `tgenabled = 'O'` (enabled) — one
row-level (`BEFORE UPDATE OR DELETE`) and one statement-level
(`BEFORE TRUNCATE`). If `tgenabled` is `'D'` (disabled) on either, the
append-only contract is broken; immediately escalate to security-lead.

## §4 Recovery procedure for a dropped trigger

If §3 reports a missing or disabled trigger:

1. **Stop ingestion writes.** Pause any service that may be writing to
   `audit_events`. The Hono API does so via the `denyAudit` / `emitAudit`
   path, but no write is fatal compared to a tampered audit row.
2. **Snapshot.** `pg_dump --table=audit_events --data-only > /tmp/audit-snapshot.sql`.
3. **Restore the trigger** by replaying migration 011's relevant DDL:
   ```sh
   bun run db:migrate:rollback   # rolls back 011
   bun run db:migrate:up         # re-applies, attaching the trigger
   ```
   This temporarily drops + recreates `audit_events`; the snapshot from
   step 2 restores the data.
4. **Restore data.** `psql ... -f /tmp/audit-snapshot.sql`.
5. **Verify.** Re-run §3; confirm both triggers are enabled. Re-run the
   §1 per-tenant query for a known recent tenant; confirm the count is
   nonzero.
6. **Audit the audit.** Manually insert an `audit.append_only_violation`
   row recording the recovery (`actor_type='service'`, `actor_id='system'`,
   `actor_name='oncall-recovery'`, `reason='trigger-restoration'`,
   `metadata.snapshot_path='/tmp/audit-snapshot.sql'`).

## §5 Legitimate audit-event archival (deferred)

Out of scope for Sprint 4. Production-readiness phase will add:

- A nightly archival job that copies rows older than a retention threshold
  to a separate cold-storage table (or object storage) and removes them
  from `audit_events` only via a privileged migration that suspends the
  append-only triggers inside a transaction.
- Tenant-specific retention windows driven by compliance requirements
  (FSTEC, GOST R, SOC 2).

Until then, `audit_events` grows monotonically. Capacity planning is the
infra owner's responsibility.

## §6 Verifying the deny pipeline

If a security incident calls for confirming that the deny pipeline
(`apps/api/src/factory.ts:onError`) is wired:

```sql
SELECT count(*) FROM audit_events
 WHERE action IN ('rbac.deny', 'tenant.cross_tenant_attempt')
   AND occurred_at > now() - interval '24 hours';
```

If the count is suspiciously low for a tenant with active users, escalate
to the security-lead — either the pipeline is broken or the tenant is
genuinely quiet. Cross-reference against the `auth.login.password failure`
count from the same window.

## §7 Audit trail of this runbook

Every action in §3 / §4 / §6 leaves an `audit_events` row with
`actor_type='service'`, `actor_name='security-oncall'` (or
`oncall-recovery` per §4), and `after_state.runbook_section` naming the
section taken. The append-only trigger guarantees those rows can't be
quietly removed.
