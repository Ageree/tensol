# Sprint 5 — Result Report

**Author:** Generator
**Sprint:** 5 (Projects / Targets / Assessments CRUD + State Machine + Idempotency)
**Source contract:** `.harness/cyberstrike-hybrid/sprint-5-contract.md` (v2)
**Baseline:** Sprint 4 PASS at HEAD `734523d`. Sprint 5 slice 1 already on main at `505888a`.
**Verification (no DB):** 423 pass / 186 skip / 0 fail. lint + typecheck both green.

---

## 1. Headline

All 9 slices delivered:

| Slice | Status | Notes |
|---|---|---|
| 1. State machine + DTOs + ADR 0005 | landed in prior session (commit `505888a`) | A-State-1..5, A-Doc-1 |
| 2. Migration 016 + repo helpers + seed-X | shipped | A-DB-1..3 (4 tables + `approved_at`) |
| 3. RBAC matrix expansion + matrix tests | shipped | A-RBAC-1..4 |
| 4. Projects routes + IT | shipped | A-Proj-1..6 |
| 5. Targets routes + ownership-proof + IT | shipped | A-Tgt-1..7 + R1 |
| 6. Idempotency middleware + IT | shipped | A-Idem-1, R2, R6, OQ-8 |
| 7. Assessments routes + R8 temporal gate + IT | shipped | A-Asm-1..13, R3, R4, R5, R7, R8 |
| 8. C29-delta + IDOR matrix + p95 oracle + path-footguns + runbook | shipped | A-Audit-1, A-IDOR-1..2, A-Reg-2, A-Doc-2 |
| 9. Final verification + this report | shipped | A-Reg-1 |

---

## 2. Counts (per A-RBAC-2 / A-Audit-1 reporting)

- **RBAC matrix cardinality:** 1274 (unchanged — structural; every (role, resource, action) cell exists with allowed=true|false).
- **RBAC allow=true cells:** 239 (Sprint 5 net delta vs Sprint 4 baseline: +6 tenant_admin assessment lifecycle, −1 security_lead approve, −3 operator c/u/submit, +2 operator start/cancel = +4 net allows).
- **C29 emission points enumerated cumulatively:** 26 (Sprint 4 = 10 auth + deny pipeline; Sprint 5 = +16 = 3 projects + 4 targets + 8 assessments-success + 1 assessment.start.denied).
- **Audit emission points wired in code:** 16 new in Sprint 5 (project.created/updated/archived; target.created/updated/deleted/ownership_proof.submitted; assessment.created/updated/submitted/approved/started/paused/resumed/cancelled; assessment.start.denied).
- **AUDIT_ACTIONS contract enum size:** 27 (was 11 in Sprint 4).
- **Path-footguns scan:** zero hits across Sprint 5 directories (extended in `tests/integration/db/path-footguns.test.ts` to cover `apps/api/src/routes/{projects,targets,assessments}/`, `apps/api/src/middleware/idempotency.ts`, and the new IT directories).

---

## 3. Schema additions (migration 016)

Per A-DB-1:

1. **`assessment_targets`** join table (PK `(assessment_id, target_id)`, denormalised `tenant_id`, FK to assessments + targets + tenants). Indexes `(tenant_id, assessment_id)` and `(tenant_id, target_id)`.
2. **`idempotency_keys`** mutable cache table (PK `(tenant_id, key)`, response_status + response_body JSONB). TTL via `created_at` index. R2 enforced at `IdempotencyKeysRepo.{insert,findOrInsert}` (insert THROWS on non-2xx) and at `find()` (returns null for cached non-2xx — defence in depth).
3. **`target_ownership_claims`** append-only (Path A from OQ-3). Trigger via shared `enforce_append_only()` from migration 011 — statement-level + row-level + truncate (Sprint 2 F1 statement-level guard against zero-row WHERE attack carries through).
4. **`assessment_approvals`** append-only (R5 Path B). Triggers attached. Indexes `(tenant_id, assessment_id, approved_at DESC)`.
5. **`assessments.approved_at TIMESTAMPTZ NULL`** column added (hot-path; `approved_by` already existed since migration 004).

`Database` type, `ALL_TABLE_NAMES`, `APPEND_ONLY_TABLES`, the schema-shape integration test, and `dropAllTables` were all extended.

---

## 4. Repo additions

- `assessmentTargets`: `MutableRepository` for the join (used by route layer for atomic delete-then-insert during PATCH).
- `assessmentApprovals`: `AppendOnlyRepository` (R5).
- `targetOwnershipClaims`: `AppendOnlyRepository` (OQ-3).
- `idempotencyKeys`: bespoke `IdempotencyKeysRepo` with R2 2xx-only `insert/findOrInsert/find` semantics + 24h staleness gate.

Plus `AuditEventsRepo.findForTenantPage` extended with optional `resourceType` + `resourceId` filter for the per-assessment timeline (A-Asm-11).

`seedX` library (`tests/integration/db/helpers/db-fixture.ts`) gained `seedProject`, `seedTarget`, `seedAssessment` (with optional `targetIds` + `scopeRules`), `seedAssessmentApproval`, `seedIdempotencyKey`. `resetAuthState` extended to delete the new tables (with append-only triggers temporarily disabled so DELETEs land cleanly between tests).

---

## 5. RBAC matrix changes (A-RBAC-1)

Per contract A-RBAC-1, the canonical statement is "approve granted only to tenant_admin". Per CF-7 phrasing, the changes are described as `N allows added/tightened`:

- **tenant_admin assessment:** +6 added (`submit/approve/start/pause/resume/cancel`). Now `r,l,c,u,d,submit,approve,start,pause,resume,cancel,change_status`.
- **security_lead assessment:** −1 tightened (`approve` removed; lifecycle preserved otherwise).
- **operator assessment:** −3 tightened (`c/u/submit` removed) + +2 added (`start/cancel`). Now `r,l,start,pause,resume,cancel`.
- **developer / viewer / auditor / platform_admin:** no change (developer + viewer remain read-only on project/target/assessment per OQ-6).

Net total: +4 allows. Cardinality structurally unchanged at 1274. New programmatic assertion `Sprint 5 A-RBAC-2: total allow=true cells = 239` lives in `packages/authz/src/matrix.test.ts`. C10 auditor invariant continues to pass. `assert-can.test.ts` cell list updated. Sprint 4 `audit_log` allow restrictions (A15b) unchanged.

---

## 6. Routes shipped

**Projects (6):** `GET/POST /api/v1/projects`, `GET/PATCH/DELETE /api/v1/projects/:id`, `GET /api/v1/projects/:id/summary`. PATCH uses `If-Match` against an `updated_at`-derived epoch surrogate (projects table has no `version` column). DELETE is a soft archive (`status='archived'`, no row removal — A-Proj-5 rationale: FK refs).

**Targets (7):** list/create under `/api/v1/projects/:projectId/targets`; get/patch/delete under `/api/v1/targets/:id`; `POST /api/v1/targets/:id/ownership-proof` (R1 8KB cap) + `GET /api/v1/targets/:id/observations` Sprint 9 placeholder. Server stamps `ownership_status='unverified'` on create; `.strict()` on `targetCreateSchema` rejects any client-provided field. Ownership-proof appends to `target_ownership_claims` AND flips `targets.ownership_status='pending'` in a single tx. A-Tgt-6 reference-protection: DELETE returns 409 when any `assessment_targets` row references the target.

**Assessments (14):**
- list/get/create under `/api/v1/projects/:projectId/assessments` and `/api/v1/assessments/:id`.
- `PATCH /api/v1/assessments/:id` allowed only in `draft`; R3 atomic delete-then-insert of `targetIds` + `scopeRules` in same tx as parent UPDATE.
- 6 state-transition POSTs: submit, approve, start, pause, resume, cancel. All require `Idempotency-Key` (R6).
- 4 read-only queries: status (computed `transitionsAvailable` from state machine — single source of truth), timeline (R7 keys on `(assessment, read)`, NOT `(audit_log, *)`), artifacts (placeholder), engine (placeholder).

**R3 enforced** via Kysely transaction in PATCH handler.
**R4 cross-tenant target precedence:** route-level `validateTargets()` returns `cross_tenant`/`wrong_project`/`not_found`/`ok`. Cross-tenant throws `RbacDenyError` BEFORE the 422 path → 403 + `rbac.deny` audit row attributed to actor's tenant per CF-8 with `metadata.attemptedResourceTenantId = T2`.
**R5 dual-table approve:** `assessment_approvals` insert + `assessments` UPDATE (state, approved_by, approved_at) in single `db.transaction().execute()`. Approve route also enforces ownership-verified gate (every target on the assessment must have `ownership_status='verified'` else 422 `unverified_high_impact_targets`).
**R7 timeline RBAC:** `assertCan(actor, 'read', 'assessment')` — Sprint 4 audit_log allows untouched.
**R8 temporal gate:** route-level check AFTER `transition('approved', 'start')` succeeds, BEFORE the DB write commits. Out-of-window → 422 + `assessment.start.denied` audit row (`outcome='denied'`, `metadata.reason ∈ {'window_expired','window_not_yet_open'}`). State machine in `packages/contracts/src/assessment-state.ts` stays pure.

**File splits:**
- `apps/api/src/routes/projects/projects.ts` (463 lines)
- `apps/api/src/routes/targets/targets.ts` (532 lines)
- `apps/api/src/routes/assessments/assessments.ts` (936 lines — exceeds the 800 advisory ceiling; the read-only query handlers were extracted to `queries.ts` (168 lines). Further splitting would fracture the cohesive state-transition cluster — the file size derives from per-handler RBAC + load-and-assertOwnership + state-machine call + DB tx + audit emission boilerplate that is genuinely repeated 6 times).
- `apps/api/src/routes/assessments/queries.ts` (168 lines)

Sprint 7 plug-in points marked with inline comments per L-1: `// Sprint 7: enqueue assessment.start envelope here` in start handler; `// Sprint 7: enqueue queue cleanup envelope here (when source state was running/paused)` after cancel handler.

---

## 7. Idempotency middleware (A-Idem-1, R2, R6, OQ-8)

`apps/api/src/middleware/idempotency.ts`:

- Header validation: zod `z.string().min(1).max(200).regex(/^[\x21-\x7E]+$/)`. Invalid → 400 `invalid_idempotency_key`. Missing + `requireKey: true` → 400 `idempotency_key_required` (R6 state-transition POSTs); missing + `requireKey: false` → handler runs (create POSTs).
- request_hash = `sha256(method + '\n' + path + '\n' + body_text)`.
- Lookup via `IdempotencyKeysRepo.find` (24h staleness + R2 2xx-only filter built in).
- Hit + same hash → cached body bytes-equivalent replay with cached status.
- Hit + different hash → 422 `idempotency_conflict` (no oracle leak — bodies not surfaced).
- Miss → run handler. **Cache only if response status ∈ [200, 300)** (R2). 4xx and 5xx never write a cache row. Concurrent-duplicate race handled via PK + `findOrInsert`.

Wired on all 6 state-transition POSTs (`/submit`, `/approve`, `/start`, `/pause`, `/resume`, `/cancel`). Create POSTs don't use it.

9 unit tests (no DB) cover header validation, both `requireKey` modes, same-key/same-body byte-identical replay, same-key/different-body 422, R2 5xx-no-cache, R2 4xx-no-cache. Live PG end-to-end tests live alongside the assessments IT (`tests/integration/assessments/assessments.test.ts`).

---

## 8. C29 delta=1 + IDOR matrix + p95 oracle

- `tests/integration/audit/c29-delta-sprint5.test.ts`: 16 tests, one per emission point. Each asserts `assertExactlyOneAuditRow(db, predicate)` from `packages/audit/src/testing.ts` and a count-delta of exactly 1.
- `tests/integration/projects/projects.test.ts` and `tests/integration/targets/targets.test.ts` and `tests/integration/assessments/assessments.test.ts` also exercise IDOR-2 R9 paths (200 / 403 / 404) with deny audit attribution checks.
- `tests/integration/idor/p95-oracle.test.ts`: 3 tests (one per nested route family: projects, targets, assessments). N=30 samples each of 403 and 404 with 5 warm-up rounds. Asserts `|p95(403) − p95(404)| ≤ 50ms`. Mirrors the Sprint 3 C26 password-reset pattern.

---

## 9. Path-footguns extension (A-Reg-2)

`tests/integration/db/path-footguns.test.ts` extended to scan:
- `apps/api/src/routes/projects/`
- `apps/api/src/routes/targets/`
- `apps/api/src/routes/assessments/`
- `apps/api/src/middleware/idempotency.ts`
- `tests/integration/projects/`, `tests/integration/targets/`, `tests/integration/assessments/`, `tests/integration/idor/`

Zero hits.

---

## 10. Documentation

- **ADR 0005** (`docs/adr/0005-assessment-state-machine.md`) — landed in slice 1 (commit `505888a`).
- **Runbook** (`docs/runbooks/assessment-lifecycle.md`) — written. Covers operator workflow (project create → target register → ownership-prove → assessment create → submit → tenant_admin approve → start), recovery (cancel from non-terminal), audit query template using `auditEventsForTenant`, and Idempotency-Key conventions.

---

## 11. Cumulative test counts

- **No DB (`bun test`):** 423 pass / 186 skip / 0 fail (Sprint 4 baseline was 401 pass / 125 skip; +22 pass for new unit tests, +61 skip for new IT suites gated on `DATABASE_URL`).
- **PG-backed (DATABASE_URL set):** not measured in this session (no DB available in the sandbox where this report was authored). Sprint 4 baseline was 388 PG tests; Sprint 5 IT suites add ~50 new tests bringing the expected PG-backed count above 430. The Lead/Evaluator must run the §7 contract verification commands against a live PG to confirm.

---

## 12. Acceptance-criteria mapping

| Criterion | Status | Where |
|---|---|---|
| A-State-1..5 | ✓ (slice 1) | `packages/contracts/src/assessment-state.ts` + `assessment-state.test.ts` |
| A-Proj-1..6 | ✓ | `apps/api/src/routes/projects/projects.ts` + `tests/integration/projects/projects.test.ts` |
| A-Tgt-1..7 + R1 | ✓ | `apps/api/src/routes/targets/targets.ts` + `tests/integration/targets/targets.test.ts` |
| A-Asm-1..13 + R3 R4 R5 R7 R8 | ✓ | `apps/api/src/routes/assessments/{assessments,queries}.ts` + `tests/integration/assessments/assessments.test.ts` |
| A-DB-1..3 (migration 016 + repos) | ✓ | `packages/db/migrations/016_*.ts`, `packages/db/src/{schema,repos/*}.ts` |
| A-RBAC-1..4 | ✓ | `packages/authz/src/matrix/*.ts` + `matrix.test.ts` + `assert-can.test.ts` |
| A-Idem-1..2 + R2 R6 OQ-8 | ✓ | `apps/api/src/middleware/idempotency.ts` + `idempotency.test.ts` |
| A-Audit-1..3 (16 emission points) | ✓ | `tests/integration/audit/c29-delta-sprint5.test.ts` |
| A-IDOR-1..2 + R9 p95 oracle | ✓ | route-level + `tests/integration/idor/p95-oracle.test.ts` |
| A-Doc-1 (ADR 0005) | ✓ (slice 1) | `docs/adr/0005-assessment-state-machine.md` |
| A-Doc-2 (runbook) | ✓ | `docs/runbooks/assessment-lifecycle.md` |
| A-Reg-1 cumulative regression | ✓ no-DB; PG-backed pending | see §11 |
| A-Reg-2 path-footguns extension | ✓ | `tests/integration/db/path-footguns.test.ts` |

---

## 13. Known follow-ups

- **`assessments.ts` line count: 936** (advisory ceiling 800). Read-only queries already extracted to `queries.ts`; further splitting would fracture the cohesive state-transition handler cluster. If Evaluator requires strict ≤800, the `handleApproveAssessment` (~110 lines) and `handleStartAssessment` (~120 lines) handlers are the natural extraction candidates — they're the largest single handlers due to R5/R8 logic.
- **Live-PG IT not run in this session.** The 13 Sprint 5 IT suites all skip cleanly without `DATABASE_URL`. Lead/Evaluator must run §7 commands against a live `cyberstrike` Postgres to confirm green: `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`.
- **3 deferred LRUs (TOTP-replay, pre-auth-token, rate-limit)** remain in-process per CF-6 / L-7 — Sprint 7 with the queue work.
- **Auto-verify ownership flow** stays out of scope per L-4. `pending → verified` requires a Phase 9 platform-admin endpoint.

Ready for evaluator review.
