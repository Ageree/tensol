# Sprint 4 Contract — Audit Subsystem (v2)

> **Author:** Planner (acting as contract drafter at Lead's request)
> **Project:** cyberstrike-hybrid
> **Sprint:** 4 (audit subsystem; spec §2 Sprint 4 + plan §4.4)
> **Source spec:** `.harness/cyberstrike-hybrid/product-spec.md` (read-only)
> **Source plan:** `.omx/plans/implementation-cyberstrike-hybrid.md` (read-only)
> **Baseline:** HEAD `8175cc9` (Sprint 3 PASS, commit `976cd81` for the Sprint 3 result doc)
> **Audience:** Generator-2 (implementer), Evaluator (reviewer/verifier)
> **v2 changelog (Evaluator iteration 1 — all 9 revisions folded):**
> - **R1:** A14 IP-redaction precedence pinned (own-row vs other-row → `null`).
> - **R2:** A14 cursor = opaque base64 `(occurred_at, id)`, monotonically decreasing, with explicit ordering test.
> - **R3 + R7:** Cross-tenant deny audit row attributed to **actor's** tenant; targeted tenant captured in `metadata.attemptedResourceTenantId`. Locked into ADR 0004 §Decision (A23 expanded).
> - **R4:** A13b verified against migration 011 — `ERRCODE = 'check_violation'` (SQLSTATE 23514) is already the runtime contract; positive control added.
> - **R5:** A22 telemetry call wrapped in try/catch; must never block the audit row write.
> - **R6:** A19 expanded from 8 to **10** emission points (added `rbac.deny` + `tenant.cross_tenant_attempt`).
> - **R8:** A14 strict zod query schema; unknown query keys → 400 `invalid_query`.
> - **R9:** A14 RBAC matrix entries for `audit_log` resource locked.
> - **Optional Evaluator notes folded:** A8 audit-write failure during deny → 500 (NQ-A); redaction key list extended with `bearer`/`jwt`/`session_token` (NQ-B).
> **v2.1 addendum (2026-04-28, Planner answering Generator-2 ambiguity):** A15b clarified — Path (A) enforce-via-matrix chosen. RBAC allows on `audit_log` removed from `platform_admin`, `security_lead`, `operator`. Cardinality assertion in `matrix.test.ts` drops from **1274 → 1268** (−6 allows). No route-level role enum gate. See A15b for full decision and rationale.
> **Generator-2 may not start coding until Evaluator re-approves this v2.**

---

## 1. Goal

Land a tenant-aware, append-only audit pipeline that:

1. Centralizes audit emission behind a single typed surface (`packages/audit`) so every state-changing call site has one obvious way to record what happened, why, and on whose authority.
2. Wires the two existing-but-dangling deny channels — **`RbacDenyError`** thrown by `assertOwnership` and **`onCrossTenantAttempt`** fired by `MutableRepository` — through that surface as `outcome='denied'` events.
3. Establishes the **service actor** model required by Sprints 7+ (coordinator, browser-worker, validator-worker, report-builder).
4. Enforces audit append-only at the repository contract level (compile-time + runtime), and locks `tenant_id != __platform__` filtering into every per-tenant aggregate query.
5. Adds the secret-redaction primitive that all later sprints (assessment scope diffs, tool policy, finding status, report metadata) will rely on for `before_state` / `after_state` snapshots.

This sprint **does not** add new state-changing routes. The audit-event coverage matrix in spec §3.2 ramps up sprint by sprint; Sprint 4 captures only the auth surface that already exists plus the deny channels. CRUD audit emissions for projects/targets/assessments land in Sprint 5 and later.

---

## 2. Hard invariants this sprint must preserve

(All invariants from product spec §1.1 carry forward; the ones with active surface area in Sprint 4:)

- **Auditability (spec §1.1 #6).** Every security-relevant decision is reconstructible. Sprint 4 makes this enforceable: deny actions, secret access, and append-only violations all leave reconstructible rows.
- **Immutability.** No mutation of envelope objects after construction; every helper returns a new object.
- **Append-only at the repository level.** `audit_events` (and the future `llm_audit_events` consumer) repository must expose insert + read only. Mutation methods are not just absent — they are a TypeScript compile error to call (Sprint 2 already enforces this via `AppendOnlyRepository`; Sprint 4 must add a tsd test asserting the surface is stable).

---

## 3. Carry-forwards from Sprint 3 (locked in)

These items came out of Sprint 3 verification and Generator-2's pre-stage report. They are non-negotiable for Sprint 4 PASS:

| # | Carry-forward | Where it lands in Sprint 4 |
|---|---------------|----------------------------|
| CF-1 | Wire a `denyAudit` consumer into `RbacDenyError` handling (completes C18c audit-side half — Sprint 3 deferred for write routes; Sprint 4 picks it up). | Section 5, A6. |
| CF-2 | Wire `onCrossTenantAttempt` hook from `MutableRepository` into the audit pipeline (the hook is plumbed but not connected — `packages/db/src/repos/mutable.ts:7` and `aggregates.ts:RepoOptions`). | Section 5, A7. |
| CF-3 | Compliance / per-tenant aggregate queries must filter `tenant_id != (SELECT id FROM tenants WHERE slug = '__platform__')`. The platform sentinel tenant carries unattributed FKs (failed logins, pre-auth-token replays, register-410-Gone). | Section 5, A11. |
| CF-4 | The C29 *delta = 1* invariant must hold for every state-changing route as Sprints 5+ land. Sprint 4 expresses this as a generalisable harness — a re-usable test helper — not just per-route. | Section 5, A8. |
| CF-5 | Per-tenant audit-event read isolation: T2 cookie cannot read T1 audit rows. | Section 5, A12. |
| CF-6 | Service actor model from spec §4.4 — synthetic actors for coordinator / browser-worker / validator-worker / report-builder, used in Sprint 7+. | Section 5, A4. |
| CF-7 | The 3 per-process LRUs deferred to Sprint 7 (TOTP-replay, pre-auth-token, rate-limit) remain deferred. Restated explicitly in §11 Limitations; they are **not** Sprint 4 work and must not be touched. | Section 11. |

Generator-2 also flagged that gitnexus's index of `emitAudit` may be stale; Generator should **not** rely on gitnexus call-graph counts for verification — re-grep with `bun run` / `rg` for ground truth before claiming a hook is unused.

---

## 4. Files / dirs touched (allowlist)

Generator may add files under:

- `packages/audit/` — **new** workspace. Owner of all audit emission surface.
- `packages/contracts/` — **new** types only: `AuditEventEnvelope` zod schema, `AuditAction` union (extended), `AuditOutcome` union (extended), `ServiceActor` enum, `RedactionConfig`. No runtime side effects.
- `apps/api/src/middleware/audit.ts` — **becomes a thin re-export shim** importing from `packages/audit`. The free-function `emitAudit` and `audit()` in `routes/shared.ts` continue to work; their bodies move into the package, the call sites do not change.
- `apps/api/src/factory.ts` — wire `onCrossTenantAttempt` and `RbacDenyError` consumers when building `Repositories` and the Hono `onError` handler.
- `apps/api/src/routes/_test/resource.ts` (and any other RBAC-throw site) — emit deny audit when catching `RbacDenyError`.
- `tests/integration/audit/` — **new** suite (Postgres-backed integration tests).
- `tests/integration/db/cross-tenant-hook.test.ts` — extend to assert the hook now produces an audit row (move beyond Sprint 2's plumbing-only assertion).
- `docs/adr/0004-audit-pipeline.md` — **new** ADR (see §9).
- `docs/runbooks/audit-event-isolation.md` — **new** runbook for compliance/per-tenant queries (see §10).

Generator **must not** touch:

- `.omx/plans/*`, `PROJECT-SPECS-*`, `STACK-*` (read-only sources).
- `.harness/cyberstrike-hybrid/product-spec.md` (read-only spec).
- `packages/db/migrations/0*.ts` (Sprint 2 frozen).
- `packages/authz/src/passwords.ts`, `totp.ts`, `password-reset.ts` (Sprint 3 frozen primitives).
- The 3 per-process LRUs deferred to Sprint 7 (`pre-auth-tokens.ts`, the rate-limiter LRU, the TOTP-replay LRU).
- Any route or middleware not listed above.

A new migration is **not** required this sprint. The append-only triggers from migration 011 plus the existing `audit_events` schema cover everything Sprint 4 records. If Generator finds a missing column in practice, escalate to Lead before adding a migration.

---

## 5. Acceptance Criteria (binary, testable)

**Conventions.**
- Every `A*` is a single binary criterion. No "and/or" hidden inside.
- Test paths below are illustrative; Generator may organise files differently as long as each criterion has a dedicated, named test.
- Coverage threshold for new code: **80% / 80% / 80% / 80%** (lines / functions / statements / branches), measured by `bun test --coverage` against `packages/audit` and `tests/integration/audit/`. Existing thresholds for other workspaces continue to apply.

### 5.1. New `packages/audit` surface

**A1.** `packages/audit` workspace exists with `package.json`, `tsconfig.json` (extends `tsconfig.base.json`, `composite: true`), `src/index.ts`, and at least: `src/envelope.ts`, `src/redact.ts`, `src/writer.ts`, `src/deny.ts`, `src/service-actors.ts`. `bun run typecheck` and `bun test` both green for the workspace.

**A2.** `AuditEventEnvelope` zod schema (in `packages/contracts/src/audit.ts`, re-exported from `packages/audit`) parses an object with all of: `id` (UUID), `actor` (`{type: 'user'|'service', id: string, name: string}`), `tenantId` (UUID), `projectId` (UUID | null), `assessmentId` (UUID | null), `action` (typed union), `resourceType` (string), `resourceId` (string | null), `before` (JSON value | undefined), `after` (JSON value | undefined), `ip` (string | null), `userAgent` (string | null), `traceId` (32-char hex), `outcome` (typed union), `occurredAt` (ISO string). Schema rejects extra keys and any envelope where `actor.type==='service'` but `actor.id` is not one of the registered service actor IDs.

**A3.** `AuditAction` union, defined in `packages/contracts/src/audit.ts`, contains exactly the Sprint 3 set plus the new entries needed for Sprint 4's deny pipeline. The union includes:
- All current entries: `auth.register`, `auth.login.password`, `auth.login.mfa`, `auth.logout`, `auth.mfa.enable`, `auth.mfa.verify`, `auth.password.reset.request`, `auth.password.reset.confirm`.
- New: `rbac.deny`, `tenant.cross_tenant_attempt`, `audit.append_only_violation`.
A unit test asserts `AuditAction` is the **exhaustive** set above (no more, no fewer).

**A4.** `AuditOutcome` union extended to include all current entries (`success`, `failure`, `mfa_required`, `gone`, `no_session`, `issued`, `miss`, `replay`) plus: `denied`, `forbidden`, `cross_tenant`. A unit test asserts the exhaustive set.

**A5.** `ServiceActor` enum exported from `packages/audit/src/service-actors.ts` defines exactly the 4 IDs reserved for Sprints 7+: `coordinator`, `browser-worker`, `validator-worker`, `report-builder`. Each has a stable `actor.id` (lowercase kebab-case literal) and `actor.name` (human-readable). Unit test asserts the enum is closed (adding a 5th entry without updating the test fails).

### 5.2. Migration of existing emit path

**A6.** `apps/api/src/middleware/audit.ts` is reduced to a thin re-export of `packages/audit`'s `emitAudit` symbol, preserving the existing call sites in `apps/api/src/routes/shared.ts`. No call site of `emitAudit` changes its signature. All Sprint 3 auth-route audit tests continue to pass (`bun test` green for `apps/api`).

### 5.3. Deny pipeline (CF-1, CF-2)

**A7.** `denyAudit(deps, args)` is exported from `packages/audit`. Signature accepts: `actor`, `tenantId` (or `__platform__` sentinel for unauthenticated denials), `action` (one of the deny actions), `resourceType`, `resourceId?`, `reason: string`, `ip?`, `userAgent?`, `traceId`, `metadata?`. It writes exactly one row with `outcome='denied'` (or `'forbidden'` / `'cross_tenant'` per the action type). Unit test asserts the row shape.

**A8.** A global Hono `onError` handler (in `apps/api/src/factory.ts`) catches `RbacDenyError` and:
- Returns `403 {error: 'forbidden'}` (unchanged response shape — preserves Sprint 3 C18c).
- **Synchronously** (before the response body is sent — R-Q5) calls `denyAudit` with:
  - `tenantId = error.actorTenantId` (the actor's tenant — R3, **not** the targeted tenant).
  - `actor` from session context.
  - `action='rbac.deny'`.
  - `outcome='forbidden'`.
  - `resourceType` and `resourceId` from the error payload.
  - `metadata.attemptedResourceTenantId = error.targetedTenantId` (forensic reconstruction; R3).
  - `reason='cross-tenant access'`.
- **Audit-write failure during deny path (NQ-A):** if the `denyAudit` insert throws (e.g. DB outage), the handler responds **500 `{error: 'internal_error'}`** rather than 403. Silently dropping the audit row would violate the auditability invariant. Document this trade-off in ADR 0004 §Decision.

Integration test asserts:
- T2 cookie + T1 project resource → 403 body byte-equal to `{"error":"forbidden"}` AND exactly 1 new row in `audit_events` with `action='rbac.deny'`, `outcome='forbidden'`, `tenant_id = T2_id`, `metadata.attemptedResourceTenantId = T1_id`.
- T1's auditor (calling A14) sees the deny row; T2's auditor does **not** see any row referencing this attempt.
- Audit-write failure injection (mock DB to throw on insert) → handler returns 500, not 403; tested via dependency-injected DB.

**A9.** `buildRepositories(db, opts)` is called from `createApp()` with `onCrossTenantAttempt` set to a closure that calls `denyAudit` with:
- `tenantId = event.actorTenantId` (R3 — actor's tenant).
- `action='tenant.cross_tenant_attempt'`.
- `outcome='cross_tenant'`.
- `resourceType` and `resourceId` from the event.
- `metadata.attemptedResourceTenantId = event.rowTenantId` (the row's tenant — forensic).
- `reason='repository-level cross-tenant detected'`.

The test in `tests/integration/db/cross-tenant-hook.test.ts` is extended to assert that triggering the hook leaves exactly one matching audit row attributed to `event.actorTenantId`.

**A10.** A second integration test asserts that a single cross-tenant attempt produces **exactly one** audit row even when both the route-layer `assertOwnership` and the repository-layer hook fire (i.e. dedup is not required, but double-emission is — by request shape — impossible because the route returns before the repo path runs OR the repo path runs without the route, never both for the same request). The contract here is: there is no API request shape where both fire for the same logical event. Generator demonstrates this by enumerating the call paths in a test fixture and asserting per-path counts.

### 5.4. Tenant isolation + sentinel filtering (CF-3, CF-5)

**A11.** A repository helper `auditEventsForTenant(tenantId, filters?)` exists in `packages/db/src/repos/aggregates.ts` (or as a method on the existing `auditEvents` repo) that returns rows with `tenant_id = $1 AND tenant_id != (SELECT id FROM tenants WHERE slug = '__platform__')`. A unit test seeds 3 rows: T1, T2, `__platform__`; asserts `auditEventsForTenant(T1)` returns only the T1 row.

**A12.** Integration test: T1 cookie → `GET /audit-events` (read-only endpoint added in this sprint, see A14) returns only T1 rows. T2 cookie returns only T2 rows. Neither tenant's response includes any `__platform__` rows. Sprint 3 tenant-isolation suite continues to pass.

### 5.5. Append-only enforcement (compile + runtime)

**A13.** A tsd test (`packages/audit/test/append-only.tsd.ts` or equivalent — Generator may use any compile-time assertion mechanism that fails CI on regression) asserts that the `auditEvents` repository surface has `insert`, `findById`, `find`, `count` and **does not** have `update`, `delete`, `truncate`. Removing `update`/`delete` from `AppendOnlyRepository` is already enforced by Sprint 2; this test guards against future drift.

**A13b.** A runtime integration test against docker-compose Postgres asserts the existing append-only trigger (migration 011, verified to use `RAISE EXCEPTION ... USING ERRCODE = 'check_violation'`, SQLSTATE `23514`) is still in force on `audit_events`:
- **Negative control 1:** raw SQL `UPDATE audit_events SET action='tampered' WHERE 1=1` → expects throw with PG SQLSTATE `23514` (`check_violation`). Generator must read `packages/db/migrations/011_audit_events.ts` to confirm the SQLSTATE before authoring this test (R4 verification gap closed by Planner; do not change migration 011).
- **Negative control 2:** raw SQL `DELETE FROM audit_events WHERE 1=1` → same expected SQLSTATE.
- **Negative control 3:** raw SQL `TRUNCATE audit_events` → same expected SQLSTATE (statement-level trigger).
- **Positive control:** raw SQL `INSERT INTO audit_events (id, tenant_id, actor_type, actor_id, actor_name, action, resource_type, trace_id) VALUES (...)` with valid data → succeeds. Without this control, A13b could pass for the wrong reason (e.g. table dropped).
- When SQLSTATE `23514` is caught from a `UPDATE`/`DELETE`/`TRUNCATE` attempt inside the test harness, the harness calls `denyAudit` with `action='audit.append_only_violation'`, `outcome='denied'`, `reason='append-only constraint violation'`, and the test asserts the resulting row (which itself is a successful append, not blocked). Note: this `denyAudit` call is **only** wired into the test harness in Sprint 4 — production code never has a path that would attempt UPDATE/DELETE on `audit_events`. Sprints 5+ may surface a real call site if a route ever tries the rejected operation; for now, the harness coverage is sufficient.

### 5.6. Audit-event read API

**A14.** `GET /api/v1/audit-events` route added behind `tenantGuard` and RBAC matrix. Returns paginated rows for the actor's tenant, **excluding** the platform sentinel tenant.

- **Query schema (R8 — strict).** Zod schema `z.object({limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().regex(/^[A-Za-z0-9+/=]+$/).optional()}).strict()`. Any unknown query key → `400 {error: 'invalid_query'}`. Test: `?action=foo`, `?tenant_id=...`, `?actor_id=...` all return 400. This prevents probing for filter shapes that would leak data.
- **Cursor (R2 — opaque, deterministic, monotonically decreasing).** Cursor is `base64(JSON.stringify({occurredAt: ISO, id: UUID}))`. Order: `ORDER BY occurred_at DESC, id DESC` (id tiebreak handles same-timestamp ties). Sorting is monotonically decreasing. Test: insert 3 rows `r1 < r2 < r3` (by `occurred_at`), call with `limit=1` → response `[r3]` and `nextCursor` decodes to `{occurredAt: r3.occurredAt, id: r3.id}`; second call with that cursor and `limit=1` → `[r2]`; third call → `[r1]`; fourth → `[]` and `nextCursor: null`.
- **Fields exposed:** `id`, `actor: {type, id, name}`, `action`, `resourceType`, `resourceId`, `outcome`, `traceId`, `occurredAt`, `ip`, `userAgent`, `metadata` (after redaction A16).
- **R1 — IP redaction precedence.** "Own row" = `row.actor.type === 'user' AND row.actor.id === currentUser.id`. For own rows, `ip` is the original value. For all other rows, `ip` is `null` (literally `null` in the JSON response — not omitted, not the string `'[redacted]'`). Same rule applies to `userAgent`. Test: T1 auditor querying mixed rows (some authored by T1's own auditor user, some by other T1 users) sees own rows with full `ip`, other rows with `ip: null`. Sprint 3 C18c UUID-leak guard carries forward — response body must contain no UUIDs other than (a) the `id` of each row and (b) `actor.id` (which is a known-to-tenant identifier, not a leak vector).
- **Sentinel exclusion:** A11's `auditEventsForTenant` is the sole query path for this endpoint.

**A15.** RBAC + isolation matrix:
- Auditor with valid T1 session → 200 with T1 rows only.
- Tenant_admin with valid T1 session → 200 with T1 rows only.
- Operator / developer / security_lead / viewer with valid T1 session → 403 (existing `assertCan` pipeline) AND `rbac.deny` audit row emitted (A8 wiring).
- Platform_admin with valid session → 403 (cross-tenant view is deferred to Phase 9 per Q-4 / NQ-D; platform_admin reading their own tenant's `__platform__`-attributed rows is also out of scope this sprint — defer to enterprise compliance phase).
- T2 cookie querying via direct row id (path param IDOR test) → 403 + `rbac.deny` audit row.

**A15b (R9) — Planner addendum 2026-04-28 resolves the path interpretation.**

Generator-2 verified at HEAD `8175cc9` that `audit_log` is already a registered resource (`packages/authz/src/resources.ts:16`) and the Sprint 3 matrix grants `read|list` on it to **five** roles: `auditor`, `tenant_admin`, `platform_admin`, `security_lead`, `operator`. The Sprint 3 contract drafter wrote those allows speculatively before any audit-read endpoint existed. With Sprint 4 introducing the first such endpoint, three of those five must be tightened to match A15's expected 403 behavior.

**Decision: Path (A) — enforce via matrix; no route-level role enum gate.**

Rationale (locked in):
1. **Single source of truth.** Authorization decisions for `audit_log` flow through `assertCan` only. A parallel role-enum gate in the route handler would create two mechanisms; future audit endpoints would have to remember to install the gate.
2. **Removing dead allows is tightening, not regressing.** Sprint 3 had no audit-read endpoint, so `platform_admin|security_lead|operator` allows on `audit_log` were never exercised. Path (A) brings the matrix into agreement with the Sprint 4 product behavior described in A15.
3. **A15 deny audit row is automatic.** A15 requires that operator/developer/security_lead/viewer get `403 + rbac.deny` row; under Path (A) this falls out of the existing `assertCan` pipeline. Path (B) would have skipped the matrix layer.
4. **Phase 9 cross-tenant audit export** for `platform_admin` is its own future endpoint and will declare its own matrix entries when authored. Today's removal does not foreclose that path.

**Concrete changes Generator-2 must make:**

1. `packages/authz/src/matrix/platform_admin.ts`: set `audit_log: []`.
2. `packages/authz/src/matrix/security_lead.ts`: set `audit_log: []`.
3. `packages/authz/src/matrix/operator.ts`: set `audit_log: []`.
4. `packages/authz/src/matrix/developer.ts`: confirm `audit_log: []` (already so; assert in test).
5. `packages/authz/src/matrix/viewer.ts`: confirm `audit_log: []` (already so).
6. `packages/authz/src/matrix/auditor.ts`: confirm `audit_log: ['read','list']`.
7. `packages/authz/src/matrix/tenant_admin.ts`: confirm `audit_log: ['read','list']`.
8. `packages/authz/src/matrix.test.ts`: add explicit denied-for-audit_log assertions for `security_lead`, `operator`, `platform_admin`, parallel to the existing viewer assertion at line ~195. The C10 auditor invariant continues to pass unchanged.

**Cardinality.** The matrix is built from per-role action lists; the test's cardinality assertion (1274) is sensitive to total `(role × resource × action)` allow entries. Removing 6 allows (3 roles × 2 actions on `audit_log`) drops the count to **1268**. Generator-2 must update the cardinality constant from `1274` to `1268` and document the delta in the test comment ("Sprint 4 / A15b: removed 3 dead allows on audit_log → −6"). Evaluator's orthogonal probe will assert the new value.

**Route behavior under Path (A):**
- `auditor` / `tenant_admin` → 200 with rows (A14).
- `security_lead` / `operator` / `developer` / `viewer` / `platform_admin` → `assertCan` denies, the global `onError` catches the resulting `RbacDenyError`, returns `403 {error: 'forbidden'}`, and emits the `rbac.deny` audit row per A8.
- No role-enum check anywhere in the route handler.

### 5.7. Secret redaction

**A16.** `redact(input, config?)` in `packages/audit/src/redact.ts` is a pure function that:
- Strips top-level and nested keys matching (case-insensitive) any of: `password`, `passwd`, `secret`, `token`, `cookie`, `authorization`, `set-cookie`, `mfa_secret`, `totp_secret`, `private_key`, `api_key`, `bearer`, `jwt`, `session_token` (last 3 added per NQ-B). Replacement value: `'[redacted]'`.
- Preserves array structure and other keys verbatim.
- Handles cycles without infinite recursion (track visited references; cycle markers replaced with `'[circular]'`).
- Accepts a `RedactionConfig` to extend the key list per call site (additive only — defaults always apply).
- Is the single redaction implementation used by the audit middleware **and** any future route that snapshots `before`/`after` (e.g. assessment scope diffs in Sprint 6, finding status changes in Sprint 11).

**A17.** Property-based test (using `fast-check` or hand-rolled if `fast-check` is not yet a dep — note any new dep in §11) covers: deeply nested objects (≥5 levels), arrays of objects, mixed-type arrays, circular references, objects with `Symbol` keys (skipped — symbols must not break redaction), `undefined`/`null` values.

### 5.8. C29 generalisation (CF-4)

**A18.** A re-usable test helper `assertExactlyOneAuditRow(db, predicate)` lives in `packages/audit/src/testing.ts` (exported under the `testing` subpath so it's available to all sprints' integration tests). Given a query predicate (action, resource_id, trace_id), asserts the count is exactly 1. A unit test asserts: count=0 → fails with named error; count=2 → fails with named error; count=1 → passes.

**A19 (R6 — count is 10, not 8).** A single regression integration test (`tests/integration/audit/c29-delta.test.ts`) re-asserts via `assertExactlyOneAuditRow` that every emission point produces exactly one row per attempt:

1. `auth.register` (Sprint 3)
2. `auth.login.password` (Sprint 3)
3. `auth.login.mfa` (Sprint 3)
4. `auth.logout` (Sprint 3)
5. `auth.mfa.enable` (Sprint 3)
6. `auth.mfa.verify` (Sprint 3)
7. `auth.password.reset.request` (Sprint 3)
8. `auth.password.reset.confirm` (Sprint 3)
9. **`rbac.deny`** (Sprint 4 / CF-1 / A8)
10. **`tenant.cross_tenant_attempt`** (Sprint 4 / CF-2 / A9)

Test runs against docker-compose Postgres. Serves as the template Sprints 5+ extend (each new state-changing route adds one entry).

### 5.9. Service actors (CF-6)

**A20.** A service-actor emission test: calling `emitAudit` with `actor={type: 'service', id: 'coordinator', name: 'Coordinator Service'}` produces a row whose `actor_type='service'` and `actor_id='coordinator'`. Same for the other 3 service IDs. Calling with `actor.type='service'` and an unregistered `actor.id` throws `UnknownServiceActorError` (compile-time hint via the union; runtime guard for ill-typed callers).

**A21.** No service-actor emission paths are wired to actual coordinator/worker code in this sprint (those services don't exist yet). The interface and primitives only.

### 5.10. Telemetry stub continuity

**A22 (R5 — failure isolation).** `packages/telemetry` Sentry breadcrumb stub (Sprint 1 placeholder) is invoked once per audit emit when `SENTRY_DSN` is set; otherwise skipped.
- The telemetry call is wrapped in a try/catch inside the audit writer.
- A throw from the telemetry SDK is caught, logged via `console.warn` with a structured tag (`{event: 'telemetry_failure', traceId}`), and **must not** propagate, retry, or block the audit row insert.
- Unit tests assert all three branches:
  - SENTRY_DSN unset → telemetry call skipped, audit row written.
  - SENTRY_DSN set, mocked SDK succeeds → telemetry call invoked once, audit row written.
  - SENTRY_DSN set, mocked SDK **throws** → audit row still written, `console.warn` called once with the structured tag, no exception bubbles to the caller.
- **No real Sentry network call** in tests (mock the SDK).

### 5.11. Documentation

**A23.** `docs/adr/0004-audit-pipeline.md` exists and contains:
- **§Context.** Why audit lives in its own package; why deny channels go through it.
- **§Decision.** Must contain at least these load-bearing rules verbatim:
  1. Single `emitAudit` + `denyAudit` writer, single envelope.
  2. Append-only contract enforced two ways (compile-time tsd surface + runtime PG trigger SQLSTATE 23514).
  3. **Cross-tenant deny audit rows are attributed to the actor's tenant (`tenant_id = actor.tenantId`), not the targeted tenant.** (R3, R7) Rationale: each tenant's auditor sees their own users' denied attempts; cross-tenant attack visibility for the targeted tenant is a future incident-correlation feature (Phase 9). The targeted tenant lands in `metadata.attemptedResourceTenantId` for forensic reconstruction without leaking the row to the targeted tenant's auditor.
  4. **Audit-write failure on the deny path returns 500, not 403.** (NQ-A) Silently dropping the audit row would violate the auditability invariant.
  5. Synchronous emission before the response is sent (Q-5).
- **§Consequences.** What Sprints 5+ inherit (the `assertExactlyOneAuditRow` harness, the service-actor enum, the redact primitive, the read API contract).
- **§Alternatives considered.** Decorator-based middleware vs explicit call-site emission — explicit chosen, citing Sprint 3 `audit.ts` comment about hidden semantics. Tenant-attribution alternatives — targeted-tenant attribution (rejected: leaks attack details to the victim before incident-correlation tooling exists) and dual-row emission (rejected: violates C29 delta=1 invariant).
- **§Limitations.** Per-process LRUs deferred to Sprint 7 (TOTP-replay, pre-auth-token, rate-limit). `fast-check` dev dep declared if adopted (Q-3).

**A24.** `docs/runbooks/audit-event-isolation.md` exists and documents: how to query audit events for a tenant (with the `__platform__` sentinel filter); how to query unattributed platform-level events; how to verify the append-only triggers are still attached (`SELECT tgname FROM pg_trigger WHERE tgrelid='audit_events'::regclass`); recovery procedure if a trigger is found dropped (re-run migration 011 down + up; restore from backup).

### 5.12. Cumulative regression

**A25.** All Sprint 1 + Sprint 2 + Sprint 3 tests continue to pass. Concretely: full local PG-backed run reports **at least 304 + (Sprint 4 new tests)** pass / 0 fail. Generator must record the exact pass/fail count in the eventual `sprint-4-result.md`.

**A26.** `bun run lint`, `bun run typecheck`, `bun run db:migrate:check`, `bun test` (no DATABASE_URL) and `DATABASE_URL=… bun test` (full PG-backed) all green.

**A27.** Path-footguns grep extended to `packages/audit/`, new audit IT directory: zero hits for the existing footgun list (Sprint 2 §B-something — Generator knows the helper).

---

## 6. Test strategy

| Layer | Tooling | Where |
|-------|---------|-------|
| Unit | `bun test` | `packages/audit/src/*.test.ts`, `packages/contracts/src/audit.test.ts` |
| Compile-time | tsd or equivalent | `packages/audit/test/append-only.tsd.ts` |
| Integration (PG-backed) | `bun test` with `DATABASE_URL` | `tests/integration/audit/*.test.ts`, `tests/integration/db/cross-tenant-hook.test.ts` |
| Regression | extend Sprint 3 suites | already-existing auth IT |
| Property-based | `fast-check` (add as dev dep to `packages/audit` if introduced — note in §11) | `packages/audit/src/redact.property.test.ts` |

---

## 7. Verification commands (Evaluator copy-paste)

```bash
cd "/Users/saveliy/Documents/пентест ИИ"

# 1. Static checks
bun run bun:assert-version
bun run lint
bun run typecheck

# 2. Migrations remain deterministic (no new migration this sprint, but check anyway)
docker compose -f infra/docker/docker-compose.local.yml up -d
bun run db:migrate:check

# 3. Unit + integration without DB
bun test

# 4. Full PG-backed run
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test

# 5. Coverage on new package
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test --coverage \
  packages/audit tests/integration/audit

# 6. Path-footguns grep (Generator's helper, extended scope)
bun run check:path-footguns

# 7. Manual probe — append-only constraint still bites at the DB layer
psql postgres://cs:cs@localhost:5433/cyberstrike -c "UPDATE audit_events SET action='tampered' WHERE 1=1;" \
  # expected: ERROR: append-only table audit_events: UPDATE rejected

# 8. Probe — sentinel exclusion
psql postgres://cs:cs@localhost:5433/cyberstrike -c "SELECT count(*) FROM audit_events WHERE tenant_id = (SELECT id FROM tenants WHERE slug='__platform__');"
  # expected: nonzero (existing 410-Gone, replay, miss audits accumulated since Sprint 3)
```

Evaluator should also re-run `evaluator-probe-sprint3.ts` to confirm Sprint 3's 19 probes still pass.

---

## 8. Dependencies

- **Sprints 1-3 PASS:** required.
- **Postgres docker-compose:** required for integration tests.
- **No new external deps required** unless Generator chooses `fast-check` for A17. If so, Generator declares it explicitly in §11 and the Evaluator decides whether to accept (acceptance criterion: dep is dev-only, MIT/Apache-2.0/BSD, single-author OK if maintained ≥ 2025).

---

## 9. ADR — `docs/adr/0004-audit-pipeline.md`

ADR must answer (at minimum):
1. Why `packages/audit` exists as a separate workspace rather than living inside `apps/api/src/middleware`.
2. Why deny audit goes through the same writer as success audit (single envelope, no parallel pipelines).
3. Why append-only is enforced both at the repository surface (compile-time) and at the Postgres trigger (runtime).
4. Why service-actor IDs are a closed set defined now even though Sprint 4 has no service callers.
5. Limitations carried forward from Sprint 3 (the 3 LRUs).

---

## 10. Runbook — `docs/runbooks/audit-event-isolation.md`

Runbook must contain:
1. Per-tenant query template (with `__platform__` exclusion).
2. Platform-level query template (only for compliance reviewers / auditor with platform_admin role).
3. Trigger health check (`pg_trigger` query).
4. Recovery procedure for a dropped trigger.
5. Procedure for legitimate audit-event archival (out of scope for Sprint 4 — pointer to Phase 8 production-readiness work).

---

## 11. Limitations (explicitly out of scope)

These are declared up-front; Evaluator must **not** flag them as gaps:

- **L-1.** No CRUD audit emissions for projects/targets/assessments. Those land in Sprint 5 and are tested via the same `assertExactlyOneAuditRow` harness introduced here (A18).
- **L-2.** No scope-engine deny audit. Scope engine is Sprint 6; its deny channel will use `denyAudit` directly.
- **L-3.** No tool policy audit. Tool catalog is deferred entirely from the first slice (spec §1.4).
- **L-4.** No LLM audit (`llm_audit_events`) writes. The table exists (migration 012), the repository exists (`AppendOnlyRepository`), but no caller exists in the slice. Sprint 4 leaves `llm_audit_events` untouched except for adding it to the tsd append-only assertion (A13).
- **L-5.** Per-process LRUs (TOTP-replay, pre-auth-token, rate-limit) remain deferred to Sprint 7. Re-stated from Sprint 3 contract C-something / Generator-2's pre-stage. **Not** Sprint 4 work.
- **L-6.** No audit-event archival, no retention policy, no Sentry-backed alerting on append-only violation. Production-readiness phase.
- **L-7.** No Russian-language audit messages. Same.
- **L-8.** New external deps:
  - [x] `fast-check` (dev-only, MIT) — adopted for A17 redaction property tests (Evaluator-approved Q-3). Declared in `packages/audit/package.json` `devDependencies`.
  - (none other expected.)

---

## 12. Open questions — RESOLVED in v2

Evaluator iteration 1 resolved all five questions plus added two new ones (NQ-A, NQ-B). Recorded here for traceability:

- **Q-1.** Audit-events read API in scope this sprint? → **YES** (Evaluator approved). Wired into A14 and A15.
- **Q-2.** Thin re-export of `apps/api/src/middleware/audit.ts`? → **YES** (Evaluator approved). Wired into A6.
- **Q-3.** `fast-check` dev-only dep for A17 redaction property tests? → **YES** (Evaluator approved). Declared in §11 L-8.
- **Q-4.** Cross-tenant audit-export endpoint for platform_admin? → **NO**, deferred to Phase 9 (Evaluator approved). Wired into A15 (platform_admin returns 403 in this slice).
- **Q-5.** Emit deny BEFORE or AFTER 403? → **BEFORE** (synchronous in `onError`, Evaluator approved). Wired into A8.
- **NQ-A (new from Evaluator).** Audit-write failure during deny path → **500, not 403** (Evaluator approved). Wired into A8.
- **NQ-B (new from Evaluator).** Extend redaction key list with `bearer`, `jwt`, `session_token` → **YES** (Evaluator approved). Wired into A16.

**No open questions remain.** Generator-2 may proceed once Evaluator re-approves v2.

---

## 13. Workflow

1. Evaluator reviews this contract; sends revisions or approval to Generator-2.
2. Generator-2 implements TDD (RED → GREEN → REFACTOR), keeping files <800 lines, immutable patterns.
3. Generator-2 runs all commands in §7 locally, captures output, writes `sprint-4-result.md`.
4. Evaluator runs §7 commands independently + extends `evaluator-probe-sprint3.ts` (or writes `evaluator-probe-sprint4.ts`) for orthogonal assertions on A8, A9, A11, A13b, A14, A15, A19, A20.
5. PASS → Lead runs `/codex:adversarial-review`, fixes findings, advances to Sprint 5.
6. FAIL → up to 3 Generator↔Evaluator iterations, then escalate to Lead.

---

End of contract.
