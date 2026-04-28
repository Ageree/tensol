# ADR 0004 — Audit Pipeline

- **Status:** Accepted (Sprint 4, 2026-04-27)
- **Supersedes:** N/A
- **Superseded by:** N/A
- **Tags:** audit, deny, append-only, tenant-isolation, redaction, telemetry

## Context

Sprint 3 introduced a per-route `emitAudit` helper inside `apps/api/src/middleware/audit.ts` that the 8 auth routes called explicitly to record state changes. That helper covered the auth surface but left two structural gaps:

1. **Deny channels were dangling.** `RbacDenyError` (thrown by `assertOwnership`) and `MutableRepository.onCrossTenantAttempt` (the cross-tenant repo hook) both produced structured payloads suitable for audit emission, but neither was wired to the audit writer. Cross-tenant attacks therefore reached `403 forbidden` (or returned no rows) without leaving a reconstructible audit trail.
2. **Sprint 5+ would inherit a per-route emission shape.** Without a generalised harness, every new state-changing route would have to re-implement the C29 delta=1 invariant, increasing the chance of regression as the surface grew.

Sprint 4 therefore introduces a `packages/audit` workspace that owns a single typed envelope, a single writer, a single deny helper, a re-usable test harness (`assertExactlyOneAuditRow`), a closed service-actor enum (Sprint 7+), and a pure secret-redaction primitive used by `before` / `after` snapshots.

The existing `apps/api/src/middleware/audit.ts` is reduced to a thin re-export shim; existing call sites in `apps/api/src/routes/shared.ts` continue to work without signature change.

## Decision

The five load-bearing rules of the Sprint 4 audit pipeline:

1. **Single `emitAudit` + `denyAudit` writer, single envelope.** All audit emissions — auth success, auth failure, RBAC deny, cross-tenant attempt, append-only violation — go through one of two functions in `packages/audit`, both of which validate against the `AuditEventEnvelope` schema in `packages/contracts/src/audit.ts`. There are no parallel pipelines.

2. **Append-only contract enforced two ways: compile-time tsd surface + runtime PG trigger SQLSTATE 23514.** The `auditEvents` repository surface in `packages/db` exposes only insert + read (Sprint 2 `AppendOnlyRepository`); a tsd assertion guards against future drift that would re-introduce update/delete. The migration-011 trigger raises with `ERRCODE = 'check_violation'` (SQLSTATE 23514) on UPDATE/DELETE/TRUNCATE; an integration test invokes all three negatively + INSERT positively to confirm the runtime contract still bites.

3. **Cross-tenant deny audit rows are attributed to the actor's tenant (`tenant_id = actor.tenantId`), not the targeted tenant.** Each tenant's auditor sees their own users' denied attempts; cross-tenant attack visibility for the targeted tenant is a future incident-correlation feature (Phase 9). The targeted tenant lands in `metadata.attemptedResourceTenantId` for forensic reconstruction without leaking the row to the targeted tenant's auditor.

4. **Audit-write failure on the deny path returns 500, not 403.** Silently dropping the audit row would violate the auditability invariant. If `denyAudit` throws during the global `onError` handler — for example, the database is briefly unreachable — the response is `500 {error: 'internal_error'}` rather than the canonical `403 {error: 'forbidden'}`. The trade-off is intentional: an attacker who can selectively hard-fail audit inserts to bypass the trail is a worse outcome than a transient 500 surfaced to a legitimate caller during a database outage.

5. **Synchronous emission before the response is sent.** The Hono `onError` handler `await`s `denyAudit` before returning the 403. Asynchronous fire-and-forget emission would leave a window in which the response acknowledges the deny but the audit row never lands.

## Consequences

**Sprints 5+ inherit:**

- The `assertExactlyOneAuditRow` harness in `@cyberstrike/audit/testing`. New state-changing routes append one entry to `tests/integration/audit/c29-delta.test.ts` rather than re-implementing the delta=1 invariant per route.
- The closed `ServiceActor` enum (`coordinator`, `browser-worker`, `validator-worker`, `report-builder`). When Sprint 7 wires the coordinator + workers, every audit row from a non-user path uses one of the four registered IDs. Adding a fifth requires updating the enum + its test in lockstep.
- The `redact()` primitive. Assessment scope diffs (Sprint 6), tool-policy changes (Sprint 6), finding status changes (Sprint 11), and report metadata (Sprint 12) all snapshot user-controlled payloads into `before` / `after`; they call `redact()` to strip `password`/`token`/`bearer`/`jwt`/`session_token`/etc. before persistence.
- The audit-events read API contract (`GET /api/v1/audit-events`) — strict zod query schema, opaque base64 cursor, own-row IP/UA full / other-row null, sentinel filter baked into `auditEventsForTenant`.

## Alternatives considered

- **Decorator-based middleware.** A single `audit()` decorator wrapping every route handler, inferring the action/outcome from the response shape. Rejected: the explicit-call-site shape from Sprint 3 is exactly what the C29 delta=1 invariant needs; an inferred decorator hides the "1 row per attempt" semantics that the test harness asserts. Sprint 3's `audit.ts` comment about "wiring it as middleware would hide the explicit semantics" carries forward.
- **Targeted-tenant attribution.** Rejected: leaks attack details to the victim before incident-correlation tooling exists. A targeted tenant's auditor seeing rows for attacks they have no incident-response context for is operationally unhelpful.
- **Dual-row emission.** Rejected: violates C29 delta=1. A cross-tenant deny attempt must produce exactly one row; routing the duplicate via metadata (rule #3) preserves both forensic visibility and the invariant.

## Limitations

- **Per-process LRUs deferred to Sprint 7.** TOTP-replay LRU, pre-auth-token LRU, and rate-limit token bucket are still per-process from Sprint 3; multi-replica deployments will see the gap. Sprint 7 swap to a shared store (Redis or PG row).
- **`fast-check` declared as dev-only dep.** Used by the redaction property tests (A17). Approved by Evaluator (Q-3).
- **No audit-event archival, no retention policy, no Sentry-backed alerting on append-only violation.** Production-readiness phase.
- **Cross-tenant audit-export endpoint for platform_admin** deferred to Phase 9 (Q-4 / NQ-D). Platform_admin currently receives 403 on `/api/v1/audit-events` — they are intentionally not a viewer of cross-tenant rows in the slice.

## References

- Sprint 4 contract: `.harness/cyberstrike-hybrid/sprint-4-contract.md`
- Product spec §1.1 #6 (auditability invariant), §2 Sprint 4, §4.4 (audit subsystem).
- Sprint 3 ADR 0003 (auth surface this audits).
- Audit-event isolation runbook: `docs/runbooks/audit-event-isolation.md`.
