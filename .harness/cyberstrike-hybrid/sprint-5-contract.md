# Sprint 5 Contract — Projects / Targets / Assessments CRUD + State Machine (v2)

> **Author:** Planner (contract drafter at Lead's request)
> **Project:** cyberstrike-hybrid
> **Sprint:** 5 (spec §2 Sprint 5 + plan §4.5)
> **Source spec:** `.harness/cyberstrike-hybrid/product-spec.md` (read-only)
> **Source plan:** `.omx/plans/implementation-cyberstrike-hybrid.md` (read-only)
> **Baseline:** HEAD `734523d` (Sprint 4 PASS, single iteration, 19 ortho probes, 388 PG tests)
> **Audience:** Generator-2 (implementer), Evaluator (reviewer/verifier)
> **v2 changelog (Evaluator iteration 1, all 9 revisions folded):**
> - **R1:** A-Tgt-5 evidence size cap (`z.string().max(8192)`).
> - **R2 (security):** A-Idem-1 caches **only 2xx** responses; 4xx/5xx re-runs handler. Closes 500-replay lockout + 403-cache permission bypass.
> - **R3:** A-Asm-2 / A-Asm-3 explicit scope-rules persistence path → `assessment_scope_rules` join in same DB tx; PATCH on draft = atomic delete-then-insert.
> - **R4:** A-Asm-2 cross-tenant target precedence (T2 targetId → 403 + `rbac.deny`; T1 wrong-project → 422 `invalid_targets`; T1 same-project → 200).
> - **R5 (security/schema):** approve metadata gets a dedicated append-only table `assessment_approvals` (Path B chosen); hot-path columns `approved_by` + `approved_at` stay on `assessments`.
> - **R6:** Idempotency-Key required for **all state-transition POSTs** (submit, approve, start, pause, resume, cancel); not for create POSTs.
> - **R7:** A-Asm-11 timeline RBAC authorizes via `(role, assessment, read)`, not `(role, audit_log, *)`. Sprint 4 audit_log allows stay tight.
> - **R8 (security):** A-Asm-6 start enforces testingWindow temporal gate at the route layer (state machine stays pure).
> - **R9:** A-IDOR-2 precedence pinned (T1+T1 → 200, T1+T2 → 403+audit, T1+nonexistent → 404 no audit).
> - **OQ-8:** Idempotency-Key char-class constraint added (`/^[\x21-\x7E]+$/`, ASCII printable).
> - **Optional Evaluator notes folded:** DoS caps `targetIds.length ≤ 1000` + `scopeRules.length ≤ 1000`; Sprint 7 hook comments at cancel-from-running site; path-footguns scope extended to `idempotency.ts` + new route dirs.
> **Generator-2 may not start coding until Evaluator re-approves this v2.**

---

## 1. Goal

Land the three first-class aggregates of the platform — **projects**, **targets**, **assessments** — behind tenant-aware, RBAC-gated, audit-logged REST endpoints, and ship the **assessment state machine** as a pure function shared between the API layer and the (future Sprint 7) coordinator. After Sprint 5, a security_lead can: create a project, register and ownership-prove targets, create an assessment with scope rules and high-impact-category declarations, submit it, have a tenant_admin approve it, and start it (state transition only — actual queue dispatch lands in Sprint 7).

Sprint 5 deliberately does **not** ship: scope-engine decisions (Sprint 6), queue envelopes (Sprint 7), browser-worker (Sprint 9), validators (Sprint 10), or report builder (Sprint 12). The state machine, however, must already match what those later sprints expect (the `running` state is real; coordinator-side enqueue plumbing slots in at Sprint 7 without rewriting this sprint's transitions).

---

## 2. Hard invariants (carry-forward from spec §1.1, active surface in Sprint 5)

1. **Auditability.** Every state-changing endpoint emits exactly one `audit_events` row (Sprint 4 C29 generalisation, A18). Sprint 5 extends the `assertExactlyOneAuditRow` regression suite from 10 → N emission points (see A-Audit-1).
2. **Tenant isolation.** Every route is gated by `tenantGuard`; every repository call is tenant-scoped; cross-tenant access produces an `RbacDenyError` → 403 + `rbac.deny` audit row via the global `onError` (Sprint 4 A8).
3. **Findings only after deterministic validation.** No surface in Sprint 5; documented here so future agents don't accidentally ship `findings` write paths through this sprint's CRUD scaffolding.
4. **Ownership-verified high-impact tools.** Sprint 5 enforces this at the assessment-submit/approve layer: `high_impact_categories` may include any of `c2`, `post_exploit`, `ad`, `credential_audit`, but the assessment cannot transition `submitted → approved` unless **all** included targets have `ownership_status = 'verified'`. The verification *flow* itself remains stubbed (no real ownership challenge until Phase 9); the `POST /targets/:id/ownership-proof` endpoint records the claim and emits audit but does not auto-verify.
5. **Scope-first execution.** Sprint 5 stores scope rules but does not *evaluate* them; that's Sprint 6. The state machine enforces that an assessment cannot start with zero targets or zero scope rules.

---

## 3. Carry-forwards from prior sprints (locked in)

| # | Carry-forward | Where it lands |
|---|---------------|----------------|
| CF-1 | C29 `delta=1` invariant — every state-changing action emits exactly one audit row via `emitAudit` and is verified via `assertExactlyOneAuditRow`. | A-Audit-1, A-Audit-2 |
| CF-2 | `auditEventsForTenant` is the canonical query path for any audit lookups (Sprint 4 A11). Sprint 5 does not add new audit-read endpoints, but reuses the helper for assertions. | A-Audit-2 |
| CF-3 | `assertOwnership` + `RbacDenyError` already wired through `onError` to `denyAudit` (Sprint 4 A8). Sprint 5 routes call `assertOwnership` after `findById`; do not re-implement. | All routes |
| CF-4 | `seedX` library extends Sprint 2/3 patterns. Sprint 5 adds `seedProject(db, opts)`, `seedTarget(db, opts)`, `seedAssessment(db, opts)`, `seedScopeRule(db, opts)`. | A-Test-1 |
| CF-5 | `unit-tests` matrix in CI auto-discovers new packages via the existing `bun run` script — no CI YAML edits expected if Generator-2 stays inside `apps/api/src/routes/...` and `packages/contracts/src/...`. If a new workspace appears (see A-Pkg-1), CI matrix must be extended. | §4 |
| CF-6 | The 3 per-process LRUs (TOTP-replay, pre-auth-token, rate-limit) remain deferred to Sprint 7. Sprint 5 must not touch them. | §11 L-1 |
| CF-7 | **From Evaluator's Sprint 4 forward note R7:** describe RBAC matrix changes as "N allows tightened" or "N allows added", not "cardinality A→B". Matrix size is an invariant under flips when total `(role × resource × action)` allow rows count holds. | A-RBAC-1 |
| CF-8 | Cross-tenant deny audit row is attributed to **actor's tenant**, with targeted tenant in `metadata.attemptedResourceTenantId` (Sprint 4 ADR 0004 §Decision rule #3). Sprint 5 IDOR test fixtures must assert this attribution, not "row appears in T2's view". | A-IDOR-1 |
| CF-9 | Audit-write failure on a deny path returns 500, not the original status (Sprint 4 ADR 0004 §Decision rule #4). Sprint 5 inherits this through `denyAudit` — no new code path needed. | (implicit) |

---

## 4. Files / dirs touched (allowlist)

Generator-2 may add or modify files under:

- `apps/api/src/routes/projects/` — **new** directory (one file per route or one consolidated file ≤ 800 lines).
- `apps/api/src/routes/targets/` — **new**.
- `apps/api/src/routes/assessments/` — **new**.
- `apps/api/src/routes/register-routes.ts` — wire the new route trees.
- `apps/api/src/middleware/idempotency.ts` — **new** middleware for `Idempotency-Key` header handling (Section 5.3).
- `packages/contracts/src/projects.ts`, `targets.ts`, `assessments.ts`, `scope-rules.ts`, `assessment-state.ts` — **new** zod DTOs + state machine pure function.
- `packages/db/src/repos/aggregates.ts` — **modify only** to expose targeted query helpers (`assessmentByIdAndTenant`, `targetsByAssessment`, etc.) — keep the file under 800 lines; if it crosses, extract per-aggregate query files.
- `packages/db/migrations/` — **NEW migration 016** for the idempotency-key persistence table (Section 5.3 — schema decision in §6 OQ-1) and for the `assessment_targets` join table (Section 5.5).
- `tests/integration/projects/`, `tests/integration/targets/`, `tests/integration/assessments/` — **new** suites.
- `tests/fixtures/seed-x.ts` (or wherever Sprint 3's seed helpers live) — extend with `seedProject`, `seedTarget`, `seedAssessment`, `seedScopeRule`.
- `packages/authz/src/matrix/*.ts` — **modify** to add the per-aggregate action grants (Section 5.6).
- `packages/authz/src/matrix.test.ts` — update cardinality and the per-role spec assertions.
- `docs/adr/0005-assessment-state-machine.md` — **new** ADR.
- `docs/runbooks/assessment-lifecycle.md` — **new** runbook.

Generator-2 **must not** touch:

- `.omx/plans/*`, `PROJECT-SPECS-*`, `STACK-*`, `.harness/cyberstrike-hybrid/product-spec.md` (read-only).
- `packages/db/migrations/0[0-1][0-5]_*.ts` (Sprint 1-4 frozen).
- `packages/audit/` source — **only** consume; no edits.
- The 3 deferred LRUs (Sprint 7).
- `apps/api/src/routes/auth/*` (Sprint 3 frozen) and `apps/api/src/routes/audit-events/*` (Sprint 4 frozen).

---

## 5. Acceptance criteria (binary, testable)

> **Conventions.**
> - Every `A*` is a single binary criterion.
> - Coverage threshold for new code: 80% / 80% / 80% / 80% on `apps/api/src/routes/{projects,targets,assessments}`, `apps/api/src/middleware/idempotency.ts`, `packages/contracts/src/{projects,targets,assessments,scope-rules,assessment-state}.ts`, and the new IT suites.
> - Tenant-isolation, IDOR, and C29-delta tests must continue to pass at the full Sprint 1-5 cumulative scope.

### 5.1. State machine (pure function)

**A-State-1.** `packages/contracts/src/assessment-state.ts` exports a pure function `transition(current: AssessmentState, command: AssessmentCommand) -> Result<AssessmentState, StateError>`. No I/O. No DB, no clock, no random.

**A-State-2.** States exposed are exactly those in migration 004's `CHECK` constraint: `draft`, `submitted`, `approved`, `running`, `paused`, `cancelled`, `completed`, `failed`. **No new states are added in this sprint.** Lead's message mentioned `starting`, `resuming`, `cancelling`; those would require a migration 016b to widen the enum — Planner has chosen to **omit them** for Sprint 5 because (a) the existing 8-state enum is sufficient to express every transition the plan requires; (b) they would silently expand the schema in a sprint nominally about CRUD; (c) Sprint 7 is where transient "starting/resuming/cancelling" matter (the queue dispatch is mid-flight) and that sprint can introduce them with the queue work. **OQ-2 in §6** flags this for Evaluator confirmation.

**A-State-3.** Allowed transitions (all others rejected with a typed error `InvalidStateTransitionError(from, command, allowedFromStates)`):

| Command         | From states            | To state    |
|-----------------|------------------------|-------------|
| `submit`        | `draft`                | `submitted` |
| `approve`       | `submitted`            | `approved`  |
| `start`         | `approved`             | `running`   |
| `pause`         | `running`              | `paused`    |
| `resume`        | `paused`               | `running`   |
| `cancel`        | `draft`, `submitted`, `approved`, `running`, `paused` | `cancelled` |
| `markCompleted` | `running`, `paused`    | `completed` |
| `markFailed`    | `submitted`, `approved`, `running`, `paused` | `failed`   |

Terminal states (`cancelled`, `completed`, `failed`) accept no further commands; any command in a terminal state produces `TerminalStateError(state)`.

**A-State-4.** Table-driven unit tests cover **every** (state × command) pair: 8 states × 8 commands = 64 cases. Each is asserted as either an explicit allowed transition (per A-State-3) or the typed rejection. Test fixture is generated, not hand-written, to prevent drift.

**A-State-5.** The state machine is the **single source of truth**. Routes invoke `transition(...)`; they do not encode the state graph independently. A grep test in CI fails if any string literal matching `'draft'|'submitted'|'approved'|'running'|'paused'|'cancelled'|'completed'|'failed'` appears in `apps/api/src/routes/assessments/*` outside the state-machine import (allow-list: `state` JSON field name in DTOs).

### 5.2. Endpoints — Projects (plan §4.5 list)

Path prefix: `/api/v1`.

**A-Proj-1.** `GET /projects` lists projects for the actor's tenant. Pagination via `?limit` (1–100, default 50) + `?cursor` (opaque base64 of `{createdAt, id}` — same shape as Sprint 4 A14). Strict zod query (`.strict()`); unknown keys → 400 `invalid_query`. Returns `{ data: Project[], nextCursor: string | null }`.

**A-Proj-2.** `POST /projects` creates a project. Body: `{ name: string, description?: string }`. `name` unique within tenant (DB constraint already in migration 003). On 409 (unique violation) returns `409 {error: 'duplicate_name'}`. Audit `project.created`. RBAC: `security_lead`, `tenant_admin`.

**A-Proj-3.** `GET /projects/:id` returns 404 if not found in actor's tenant; 403 if found in another tenant (cross-tenant via `assertOwnership`); 200 otherwise.

**A-Proj-4.** `PATCH /projects/:id` updates `name?`, `description?`, `status? ('active'|'archived')`. Optimistic-lock via `If-Match: <version>` header → 409 `version_mismatch` on stale. Audit `project.updated`. RBAC: `security_lead`, `tenant_admin`.

**A-Proj-5.** `DELETE /projects/:id` is a **soft delete** — sets `status = 'archived'`. No row removal. Returns 204. Audit `project.archived`. RBAC: `tenant_admin` only. Why soft delete: targets and assessments reference projects via FK; hard delete would break audit reconstruction.

**A-Proj-6.** `GET /projects/:id/summary` returns `{ id, name, targetCount, assessmentCounts: {draft, submitted, approved, running, paused, cancelled, completed, failed}, openFindingsCount: 0 }` — `openFindingsCount` is hard-coded `0` in this sprint (findings ship in Sprint 11). RBAC: `security_lead`, `tenant_admin`, `auditor`.

### 5.3. Endpoints — Targets

**A-Tgt-1.** `GET /projects/:projectId/targets` lists targets for the project. Same pagination + strict-query shape as A-Proj-1. RBAC: `security_lead`, `tenant_admin`, `operator`, `auditor`.

**A-Tgt-2.** `POST /projects/:projectId/targets` creates a target. Body: `{ kind: 'url'|'domain'|'ip'|'cidr'|'cloud_account'|'k8s_namespace'|'repo', value: string }`. Unique within `(tenant_id, project_id, kind, value)` (migration 003). On 409 returns `409 {error: 'duplicate_target'}`. **Initial `ownership_status` is always `'unverified'`** — Generator-2 must reject any client-provided `ownership_status` field with 400 (zod `.strict()`). Audit `target.created`. RBAC: `security_lead`, `tenant_admin`.

**A-Tgt-3.** `GET /targets/:id` — same 404/403/200 semantics as A-Proj-3.

**A-Tgt-4.** `PATCH /targets/:id` updates `value?` only. Re-uniqueness check on conflict. **`ownership_status` is not patchable through this endpoint** — only via `POST /targets/:id/ownership-proof` (A-Tgt-5). Optimistic-lock via `If-Match`. Audit `target.updated`. RBAC: `security_lead`, `tenant_admin`.

**A-Tgt-5.** `POST /targets/:id/ownership-proof` records an ownership claim. Body: `{ method: 'dns_txt'|'http_meta'|'manual_attestation', evidence: z.string().max(8192) }` — **R1: 8KB cap** (DNS TXT records, HTTP `<meta>` snippets, and manual attestation strings all fit comfortably; per-method structured validation is deferred to Sprint 6 with the scope-engine work). The endpoint:
- Persists a claim row (see A-Tgt-Schema-1 below — new column or new table).
- Sets `targets.ownership_status = 'pending'`.
- Audit `target.ownership_proof.submitted`.
- Returns 202.
- Does **not** auto-verify (verification flow is Phase 9). A separate platform-admin-only flow would flip `pending → verified`; that endpoint is **out of scope** this sprint and remains future work.
- RBAC: `security_lead`, `tenant_admin`.

**A-Tgt-Schema-1.** Schema decision: where does the ownership claim land?
- **Path A:** add a `target_ownership_claims` append-only table in migration 016 (next to the existing append-only family). Each `POST /targets/:id/ownership-proof` inserts a row.
- **Path B:** store the latest claim in a JSONB column on `targets` (no migration needed, but loses claim history).

Planner recommendation: **Path A**, append-only. Audit invariant requires reconstructing *who claimed what when*; JSONB overwrite loses that. **OQ-3 in §6 flags for Evaluator confirmation.** If Path A, the migration also attaches the `enforce_append_only` trigger from migration 011.

**A-Tgt-6.** `DELETE /targets/:id` returns 409 if the target is referenced by **any** assessment (via the `assessment_targets` join — see §5.5). Otherwise hard-deletes. Audit `target.deleted`. RBAC: `tenant_admin` only.

**A-Tgt-7.** `GET /targets/:id/observations` returns `{ data: [], nextCursor: null }` — observations land in Sprint 9. Endpoint exists so the UI route in Sprint 11 can be built against a stable surface; pagination shape locked to A-Proj-1 / A14 (Sprint 4) so future Sprint 9 wiring is mechanical.

### 5.4. Endpoints — Assessments

**A-Asm-1.** `GET /projects/:projectId/assessments` and `GET /assessments/:id` follow the same 404/403/200 + pagination conventions.

**A-Asm-2.** `POST /projects/:projectId/assessments` creates a draft assessment. Body:

```ts
{
  name: z.string().min(1).max(200),
  testingWindow: z.object({ start: z.string().datetime(), end: z.string().datetime() }).nullable(),
  highImpactCategories: z.array(z.enum(['c2','post_exploit','ad','credential_audit'])).max(4),
  targetIds: z.array(z.string().uuid()).min(1).max(1000),    // DoS cap (Evaluator note)
  scopeRules: z.array(ScopeRuleSchema).min(1).max(1000),     // DoS cap (Evaluator note)
}
```

Initial state = `draft`. Audit `assessment.created`. RBAC: `security_lead`, `tenant_admin`. The transaction inserts:
1. one `assessments` row,
2. N `assessment_targets` join rows,
3. M `assessment_scope_rules` rows (R3 — **scope rules persist to the existing migration-004 table; not JSONB on assessments** so Sprint 6's scope-engine can query them by index),
4. one `audit_events` row,
5. (if Idempotency-Key provided) one `idempotency_keys` row.

All in a single DB transaction; rollback discards all five.

**R4 — Cross-tenant target precedence (test all three paths):**
- **T1 cookie + targetId in T2 (cross-tenant) → 403 + `rbac.deny` audit row** attributed to T1's tenant per CF-8 with `metadata.attemptedResourceTenantId = T2_id` and `metadata.attemptedResourceType = 'target'`. The 403 fires *before* the 422 invalid_targets path can be reached. Detected by: `findById(T1, targetId)` returns null while `findByIdAcrossTenants(targetId)` returns a T2 row → `RbacDenyError` thrown by `assertOwnership`.
- **T1 cookie + targetId in T1 but in a different project → 422 `invalid_targets`** with `details: { targetId, expectedProjectId, actualProjectId }`. No deny audit row (this is a user error, not a security event).
- **T1 cookie + targetId in T1 + same project → 200** (positive control).

**A-Asm-3.** `PATCH /assessments/:id` allows editing `name?`, `testingWindow?`, `highImpactCategories?`, `targetIds?`, `scopeRules?` **only while state is `draft`**. Any patch attempt on a non-`draft` assessment returns 409 `not_editable_in_state`. Optimistic-lock via `If-Match`. Audit `assessment.updated`.

**R3 atomic replacement semantics for PATCH:**
- If `targetIds` is in the patch body → atomic delete-then-insert in `assessment_targets` (same tx as the assessment row).
- If `scopeRules` is in the patch body → atomic delete-then-insert in `assessment_scope_rules` (same tx).
- Both replacements are **set replacement, not diff** — caller submits the full intended set; server discards old rows and inserts new ones. This avoids partial-update ambiguity on a draft.
- DoS caps from A-Asm-2 (`targetIds ≤ 1000`, `scopeRules ≤ 1000`) carry over.
- The R4 cross-tenant precedence applies on PATCH as well: T2 targetId in PATCH body → 403 + `rbac.deny`.

**A-Asm-4.** `POST /assessments/:id/submit` transitions `draft → submitted`. RBAC: `security_lead`, `tenant_admin`. Audit `assessment.submitted`.

**A-Asm-5 (R5 — schema decision pinned: Path B).** `POST /assessments/:id/approve` transitions `submitted → approved` **only if** every `targetId` in the assessment has `ownership_status = 'verified'` AND the actor's role is `tenant_admin`. The role gate is enforced by the matrix (A-RBAC-1), but the ownership check is route-level: 422 `unverified_high_impact_targets` lists the offending target IDs in `details`. Audit `assessment.approved`.

**Approval metadata storage (R5 — Path B chosen, single-purpose table):**
- A new append-only table `assessment_approvals` (added in migration 016 — see A-DB-1 #4) stores the forensic record: `id`, `tenant_id`, `assessment_id`, `approved_by`, `approved_at`, `target_count`, `high_impact_categories JSONB`. Attaches `enforce_append_only` trigger from migration 011's shared function.
- Hot-path columns `approved_by UUID` (already present in migration 004) and `approved_at TIMESTAMPTZ` (added in migration 016 — see A-DB-1 #5) live on `assessments` itself for fast list/summary queries. They are written in the same transaction as the `assessment_approvals` insert.
- **Why Path B (new table) over Path A (expand `assessment_artifacts`):** `assessment_artifacts` was sized in Sprint 2 for blob refs (object_storage_key + sha256 + size_bytes per B23). Approval is metadata, not a blob. Single-purpose tables keep query cost predictable and make the append-only retention rules clearer per surface.

**Note:** the ownership-verified gate fires for *every* target on the assessment, not only when `highImpactCategories` is non-empty. Rationale: §2 invariant 4 binds high-impact tooling to verified ownership, and *any* approved assessment can later acquire high-impact categories via Sprint 7+ flows (the verification status of the targets themselves is the source of truth, not the current category list).

**A-Asm-6.** `POST /assessments/:id/start` transitions `approved → running`. Idempotency-Key header **required** (A-Idem-1). RBAC: `security_lead`, `tenant_admin`. Audit `assessment.started`. **No queue enqueue in Sprint 5** — that lands in Sprint 7. The state machine transition is sufficient for this sprint; an in-line comment in the route hand-off site says `// Sprint 7: enqueue assessment.start envelope here`.

**R8 — testingWindow temporal gate (route-level, state machine stays pure):**
The route MUST evaluate `testingWindow` against `now` (server clock) **after** the state-machine `transition('approved','start')` succeeds and **before** the DB write commits. If `testingWindow` is null → no temporal check, transition proceeds. If non-null:
- `now > testingWindow.end` → roll back the DB tx, return **422 `testing_window_expired`** with `details: { now, end }`. No state change, no audit emission for `assessment.started` (the action did not happen). Audit a separate `assessment.start.denied` event with `outcome='denied'` and `metadata.reason='window_expired'` so the deny is reconstructible.
- `now < testingWindow.start` → roll back, **422 `testing_window_not_yet_open`** with `details: { now, start }`. Same audit-deny pattern.
- `testingWindow.start ≤ now ≤ testingWindow.end` → transition commits.

State machine is a pure function and stays unchanged; the temporal gate is route-only. Test matrix (A-State-Time-1 in §5.1's regression suite):
- `testingWindow=null` + start → 200.
- valid window + start → 200.
- expired window + start → 422 `testing_window_expired` + audit `assessment.start.denied`.
- not-yet-open window + start → 422 `testing_window_not_yet_open` + audit `assessment.start.denied`.

**Note on additional emission point:** `assessment.start.denied` is added to the C29-delta enumeration in A-Audit-1 alongside the success emissions.

**A-Asm-7.** `POST /assessments/:id/pause` transitions `running → paused`. Idempotency-Key required. Audit `assessment.paused`.

**A-Asm-8.** `POST /assessments/:id/resume` transitions `paused → running`. Idempotency-Key required. Audit `assessment.resumed`.

**A-Asm-9.** `POST /assessments/:id/cancel` transitions any non-terminal state → `cancelled`. Idempotency-Key required. Audit `assessment.cancelled`. When the source state is `running` or `paused`, the route hand-off site includes the inline comment `// Sprint 7: enqueue queue cleanup envelope here` so the queue-dispatch sprint plugs in mechanically.

**A-Asm-10.** `GET /assessments/:id/status` returns `{ id, state, version, updatedAt, transitionsAvailable: AssessmentCommand[] }`. `transitionsAvailable` is computed from the state machine — single source of truth.

**A-Asm-11 (R7 clarified).** `GET /assessments/:id/timeline` returns the assessment's audit-event tail filtered to `resourceType='assessment' AND resource_id=:id`, paginated like A14.

**Authorization (R7):** the route authorizes via `assertCan(actor, 'read', { type: 'assessment', id })` — i.e. checks `(role, assessment, read)` in the matrix, **not** `(role, audit_log, *)`. RBAC: `security_lead`, `tenant_admin`, `auditor` (these three already have `(role, assessment, read)` per A-RBAC-1; `operator` and `developer` also have `(role, assessment, read)` so they can use this endpoint too — confirm via A-RBAC-1 table). This means the Sprint 4 `audit_log` allows stay tight (only `auditor` + `tenant_admin` get the broad `GET /api/v1/audit-events` endpoint); the per-assessment timeline rides on the assessment resource's own grants.

**Query path:** internally uses `auditEventsForTenant(tenantId, { resourceType: 'assessment', resourceId: id })`. The `__platform__` sentinel filter from Sprint 4 A11 carries through automatically.

**Test:**
- `auditor` + `assessment.timeline` → 200, sees rows.
- `developer` + own-tenant `assessment.timeline` → 200 (developer has `(role, assessment, read)` per A-RBAC-1).
- T1 cookie + T2 assessment → 403 + `rbac.deny`.
- Returned rows do **not** include any `audit_log` allows test impact — the test asserts `assertCan(actor, 'read', { type: 'audit_log', id: 'x' })` still returns denied for `security_lead`/`operator`/`platform_admin` (Sprint 4 A15b invariant unchanged).

**A-Asm-12.** `GET /assessments/:id/artifacts` lists `assessment_artifacts` rows (append-only, Sprint 2). Same pagination shape. RBAC: `security_lead`, `tenant_admin`, `auditor`.

**A-Asm-13.** `GET /assessments/:id/engine` returns `{ engine: 'fake_decepticon', engineState: 'not_started' }` — placeholder. Real engine state arrives in Sprint 8. RBAC: `security_lead`, `tenant_admin`, `operator`, `auditor`.

### 5.5. Schema additions (migration 016)

**A-DB-1.** Migration 016 ships:

1. **`assessment_targets` join table.** Columns: `assessment_id UUID FK assessments.id`, `target_id UUID FK targets.id`, `tenant_id UUID FK tenants.id` (denormalised for tenant-scope filtering), `created_at TIMESTAMPTZ`. PK on `(assessment_id, target_id)`. Index on `(tenant_id, assessment_id)` and `(tenant_id, target_id)`. Insert paths: `POST /assessments/...` (A-Asm-2) and `PATCH /assessments/:id` (A-Asm-3 atomic delete-then-insert) — both within the same DB transaction as the parent write.
2. **`idempotency_keys` table.** Columns: `key TEXT`, `tenant_id UUID FK tenants.id`, `actor_id TEXT`, `route_method TEXT`, `route_path TEXT`, `request_hash TEXT` (sha256 of canonical body), `response_status INT`, `response_body JSONB`, `created_at TIMESTAMPTZ`. PK on `(tenant_id, key)`. TTL index on `created_at` (24h). See A-Idem-1. **Only 2xx responses are persisted** (R2 — see A-Idem-1); 4xx/5xx never write a cache row.
3. **`target_ownership_claims` table** (Path A, OQ-3 resolved). Append-only. Columns: `id UUID PK`, `tenant_id UUID FK`, `target_id UUID FK`, `method TEXT CHECK IN ('dns_txt','http_meta','manual_attestation')`, `evidence TEXT` (≤ 8192 chars per R1), `submitted_by_user_id UUID FK users.id`, `submitted_at TIMESTAMPTZ`. Attaches `enforce_append_only` trigger from migration 011's shared function. Index on `(tenant_id, target_id, submitted_at DESC)` for "latest claim" lookups.
4. **`assessment_approvals` table (R5 — Path B).** Append-only. Columns: `id UUID PK`, `tenant_id UUID FK tenants.id`, `assessment_id UUID FK assessments.id`, `approved_by UUID FK users.id`, `approved_at TIMESTAMPTZ`, `target_count INT NOT NULL`, `high_impact_categories JSONB NOT NULL` (snapshot of the categories at approval time). Attaches `enforce_append_only` trigger. Index on `(tenant_id, assessment_id, approved_at DESC)` for "latest approval" lookups.
5. **Column add on `assessments` (R5 — hot-path):** `ALTER TABLE assessments ADD COLUMN approved_at TIMESTAMPTZ NULL`. Already has `approved_by UUID FK users.id` from migration 004. Both columns are written in the same transaction as the `assessment_approvals` insert by the A-Asm-5 route. Used by list/summary queries to avoid joining `assessment_approvals` for every read.

**A-DB-2.** Migration applies cleanly to a fresh DB and rolls forward in CI (`bun run db:migrate:check`). All Sprint 1-4 migrations continue to apply.

**A-DB-3.** Repository helpers added in `packages/db/src/repos/aggregates.ts`:
- `assessmentTargets`: `MutableRepository` (or thin wrapper) for the join. Tenant-scoped.
- `idempotencyKeys`: dedicated repo with `findOrCreate(key, tenant, actor, requestHash)` semantics; **insert path enforces R2 — only call insert when `response_status >= 200 && response_status < 300`**.
- `targetOwnershipClaims`: `AppendOnlyRepository`. Tenant-scoped.
- `assessmentApprovals`: `AppendOnlyRepository`. Tenant-scoped. Insert in same tx as the `assessments` UPDATE (`state = 'approved'`, `approved_by`, `approved_at`).

### 5.6. RBAC matrix changes

**A-RBAC-1.** Add per-role allows in `packages/authz/src/matrix/*.ts` to support the new endpoints. Resources: `project`, `target`, `assessment`. Actions: `read`, `list`, `create`, `update`, `delete`, `submit`, `approve`, `start`, `pause`, `resume`, `cancel`. Most resources don't take all actions; the matrix file structure already encodes this per-resource. Per-role grants:

| Role            | project       | target          | assessment                                            |
|-----------------|---------------|-----------------|-------------------------------------------------------|
| platform_admin  | *(no change)* | *(no change)*   | *(no change)*                                         |
| tenant_admin    | r,l,c,u,d     | r,l,c,u,d       | r,l,c,u,submit,approve,start,pause,resume,cancel      |
| security_lead   | r,l,c,u       | r,l,c,u         | r,l,c,u,submit,start,pause,resume,cancel              |
| operator        | r,l           | r,l             | r,l,start,pause,resume,cancel                         |
| developer       | r,l           | r,l             | r,l                                                   |
| auditor         | r,l           | r,l             | r,l                                                   |
| viewer          | r,l           | r,l             | r,l                                                   |

(`r=read, l=list, c=create, u=update, d=delete`.) **Note:** `approve` is granted only to `tenant_admin`. `start/pause/resume/cancel` go to `tenant_admin`, `security_lead`, `operator` (operator runs the assessment day-to-day; security_lead can intervene; tenant_admin has full control). `developer` is read-only on all three aggregates; this matches Sprint 3's policy: developer reads findings (Sprint 11) but never changes scope or tool policy.

**A-RBAC-2.** Phrase the matrix change as **"N allows added"** in the test comment, per CF-7. Generator-2 may not include a "cardinality A→B" line. Total new allows across the 7 roles × 3 resources × the action set above is computable; Generator-2 reports the count in `sprint-5-result.md` after running the matrix-built test.

**A-RBAC-3.** `packages/authz/src/matrix.test.ts` is extended with explicit assertions for every new (role, resource, action) tuple — both allowed and denied. The Sprint 4 cardinality assertion (1268) is updated to the new value Generator-2 reports; the test comment is `Sprint 5 / A-RBAC-2: added N allows for project/target/assessment`. The C10 auditor invariant ("auditor has read+list on every resource, no other actions") continues to pass.

**A-RBAC-4.** A negative regression test: every state-changing route, when called by `developer` or `viewer` (read-only roles), returns 403 + emits a single `rbac.deny` audit row attributed to actor's tenant per CF-8.

### 5.7. Idempotency middleware

**A-Idem-1 (R2 + R6 + OQ-8).** `apps/api/src/middleware/idempotency.ts` exports `idempotency(deps, opts)` Hono middleware. It:

- Reads `Idempotency-Key` header. **Header validation (OQ-8):** zod `z.string().min(1).max(200).regex(/^[\x21-\x7E]+$/)` (ASCII printable, no whitespace, 1–200 chars). Invalid → 400 `invalid_idempotency_key`.
- If header present, computes `request_hash = sha256(method + '\n' + path + '\n' + canonical_body_json)`.
- Looks up `(tenant_id, key)` in `idempotency_keys`. If found AND `request_hash` matches AND age < 24h **AND `response_status` is in [200, 300)** → returns the cached response (`response_status` + `response_body`) without invoking the handler.
- If found but `request_hash` mismatch → 422 `idempotency_conflict` with `details: { existingHash, providedHash }` (no oracle leak — the actual bodies aren't returned).
- If found but cached row's `response_status` is **outside [200, 300)** → treat as not-cached, re-run handler. (R2 — never observable in practice because the insert path below also gates on 2xx; this guard is defense-in-depth in case a row was inserted by a future code path.)
- If not found OR cache miss per the 2xx rule → invokes the handler, captures the response, and **only if `response_status` is in [200, 300)** persists `(key, request_hash, response_status, response_body)` to `idempotency_keys` (post-write insert pattern; Sprint 7's queue work will move this into the outbox tx). 4xx and 5xx responses **never** write a cache row.

**R2 — security rationale (locked in ADR 0005 §Decision):**
- **No 5xx caching.** A first-call DB outage would otherwise replay 500 forever, blocking recovery once the underlying cause clears.
- **No 4xx caching.** A first-call 403 (actor lacked permission) would otherwise return 403 from cache after a role upgrade, bypassing the post-upgrade auth re-check. The auth pipeline must be invoked on every retry that wasn't a confirmed success.

**R6 — required-vs-optional precedence:**
- `Idempotency-Key` header is **REQUIRED** for **all state-transition POSTs**: `POST /assessments/:id/{submit,approve,start,pause,resume,cancel}`. Missing header → 400 `idempotency_key_required`.
- `Idempotency-Key` header is **NOT required** (but accepted) for create POSTs: `POST /projects`, `POST /projects/:projectId/targets`, `POST /projects/:projectId/assessments`, `POST /targets/:id/ownership-proof`. Duplicate-create is naturally guarded by DB unique constraints (e.g. `projects_tenant_name_unique`) and append-only patterns (ownership claims). The mechanical rule: state-transition → required; create → optional.

**A-Idem-2 (R2 expanded). Test matrix:**

| Scenario | Expected outcome |
|---|---|
| Same key + same body, first call 2xx, second call within 24h | Second response byte-identical to first. Single audit row for the underlying action (only the first call triggers). |
| Same key + same body, first call **5xx** (mock DB throw on the handler's primary write), second call within 24h | **Second call re-runs handler** — no cache hit. Tests both branches: second call succeeds (DB recovered) → 2xx + new audit row + cache populated; second call fails too → 5xx, still no cache row. |
| Same key + same body, first call **4xx** (e.g. handler returns 422 for some semantic conflict), second call within 24h | **Second call re-runs handler** — no cache hit. After fixing the cause, the retry succeeds. |
| Same key + same body, first call **403** (actor lacked permission), then actor's role upgraded, second call within 24h | **Second call re-runs auth pipeline** — no cache hit. Post-upgrade actor proceeds; original 403 is **not** replayed from cache. **This is a security-critical assertion.** |
| Same key + different body | 422 `idempotency_conflict`. No new audit row. |
| Same key, different tenant (direct repo call; not reachable via cookies) | Not found (tenant-scoped lookup). |
| Key older than 24h | Treated as not-found; new request proceeds. |
| Concurrent duplicate requests (race) | Unique constraint on `(tenant_id, key)` ensures one wins; the loser observes the winner's row and returns the cached response (only if winner was 2xx). |
| Header `Idempotency-Key: ` (empty) | 400 `invalid_idempotency_key`. |
| Header with whitespace `Idempotency-Key: foo bar` | 400 `invalid_idempotency_key` (regex rejects 0x20). |
| Header > 200 chars | 400 `invalid_idempotency_key`. |
| State-transition POST without header | 400 `idempotency_key_required`. |
| Create POST without header | 200 / 201 (header optional). |

### 5.8. Audit emission (CF-1, CF-2)

**A-Audit-1.** Every state-changing route emits exactly one audit row. The `assertExactlyOneAuditRow` regression test (Sprint 4 A19, currently 10 emission points) is extended to **enumerate every new emission point added in this sprint**. Generator-2 maintains the test file `tests/integration/audit/c29-delta.test.ts` adding entries for:

- **Projects (3):** `project.created`, `project.updated`, `project.archived`.
- **Targets (4):** `target.created`, `target.updated`, `target.deleted`, `target.ownership_proof.submitted`.
- **Assessments — success (8):** `assessment.created`, `assessment.updated`, `assessment.submitted`, `assessment.approved`, `assessment.started`, `assessment.paused`, `assessment.resumed`, `assessment.cancelled`.
- **Assessments — deny (1):** `assessment.start.denied` (R8 — emitted by the route on `testing_window_expired` or `testing_window_not_yet_open` 422; `outcome='denied'`, `metadata.reason ∈ {'window_expired','window_not_yet_open'}`).

Total new emission points: **16**. Combined with Sprint 4's 10 → expected total 26 enumerated entries. Final count is recorded in `sprint-5-result.md`.

**A-Audit-2.** Per-tenant isolation: `auditEventsForTenant(T1)` after a multi-tenant CRUD scenario returns only T1 rows; T2 rows are not visible from T1 actor sessions; `__platform__` rows (e.g. failed login from Sprint 3) remain hidden.

**A-Audit-3.** Audit metadata for each emission carries:
- `before_state` and `after_state` JSON snapshots (redacted via Sprint 4 A16).
- For state transitions: `metadata = { fromState, toState, command }`.
- For ownership-proof submit: `metadata = { method, evidenceLength }` (`evidence` itself is not in the audit row to avoid leaking proof content).
- For approve: `metadata = { approvedBy, highImpactCategories, targetCount }`.

### 5.9. IDOR + tenant isolation

**A-IDOR-1.** For every endpoint, run the cross-tenant matrix: T1 cookie + T2 resource → 403 + `rbac.deny` audit row attributed to **T1's tenant** (CF-8) with `metadata.attemptedResourceTenantId = T2`. T1 auditor sees the row; T2 auditor does not. Same shape Sprint 4 A8 established.

**A-IDOR-2 (R9 — status precedence pinned to prevent existence oracle).** Path-param resources in nested routes (e.g. `POST /projects/:projectId/targets`, `GET /assessments/:id/timeline`, etc.) follow this precedence:

| Path-param resource | Status |
|---|---|
| Resource exists in actor's tenant (T1 cookie + T1 resource) | 200 / 201 / 204 (positive control) |
| Resource exists in another tenant (T1 cookie + T2 resource) | **403 `forbidden`** + `rbac.deny` audit row attributed to T1's tenant per CF-8 with `metadata.attemptedResourceTenantId = T2` |
| Resource does not exist anywhere (T1 cookie + nonexistent UUID) | **404 `not_found`** with body `{error: 'not_found'}`. **No audit emission** — 404 is a request shape error, not a deny |

**Why both 403 and 404 (not just 404 everywhere):** flattening to 404 for cross-tenant requests would hide a security event (cross-tenant attempt) from auditors. Distinguishing the two requires the existence-oracle test below to confirm the codepath does not leak existence information through other channels.

**Existence-oracle test (one per nested route family — projects, targets, assessments):** time the 403 and 404 responses end-to-end with N≥30 measurements each on a fresh DB. p95(403) and p95(404) must be within 50ms of each other (matches Sprint 3 C26 latency-variance pattern for the password-reset oracle). If the gap is wider, the codepath is doing tenant lookup before existence lookup or vice versa in a way an attacker could time-attack — Generator-2 must reorder.

**Test all three paths for every nested route:** 200 positive, 403 cross-tenant, 404 nonexistent. Generator-2 records the count in `sprint-5-result.md`.

### 5.10. Documentation

**A-Doc-1.** `docs/adr/0005-assessment-state-machine.md` contains:
- §Context — why the state machine is a pure function in `packages/contracts`, not in the API.
- §Decision — the 8-state enum is reused as-is from migration 004; `starting/resuming/cancelling` deferred to Sprint 7. Per-state command table (mirrors A-State-3). Terminal-state rule.
- §Consequences — Sprint 7 coordinator imports the same function; no parallel state graph.
- §Alternatives — including states (rejected: schema churn for transient values without a consumer this sprint) and route-level state-graph encoding (rejected: violates single-source-of-truth).

**A-Doc-2.** `docs/runbooks/assessment-lifecycle.md` documents:
- Operator workflow: create project → register targets → ownership-prove → create assessment → submit → tenant_admin approve → start.
- Recovery: cancel a stuck assessment.
- Audit query template for "who started assessment X" using `auditEventsForTenant`.

### 5.11. Cumulative regression

**A-Reg-1.** All Sprint 1-4 tests continue to pass at the full PG-backed scope. `bun run lint`, `bun run typecheck`, `bun run db:migrate:check`, `bun test` (no DATABASE_URL), and `DATABASE_URL=… bun test` all green. The Sprint 4 baseline of 388 PG tests becomes the floor; Sprint 5 reports the new total in `sprint-5-result.md`.

**A-Reg-2.** Path-footguns grep (Sprint 2's helper) extended to: `apps/api/src/routes/projects/`, `apps/api/src/routes/targets/`, `apps/api/src/routes/assessments/`, `apps/api/src/middleware/idempotency.ts`, `packages/contracts/src/{projects,targets,assessments,scope-rules,assessment-state}.ts`, and the new IT directories. Zero hits required for the existing footgun list.

---

## 6. Open questions — RESOLVED in v2

Evaluator iteration 1 resolved all 8 questions. Recorded for traceability:

- **OQ-1.** Single migration 016 → **APPROVED**. Atomic apply/rollback cleaner.
- **OQ-2.** Defer `starting/resuming/cancelling` to Sprint 7 → **APPROVED**. A-State-2 rationale stands.
- **OQ-3.** Path A append-only `target_ownership_claims` → **APPROVED**. Wired into A-DB-1 #3.
- **OQ-4.** Soft-delete projects → **APPROVED**.
- **OQ-5.** Hard-delete targets with reference-protection → **APPROVED**.
- **OQ-6.** Developer read-only on all 3 aggregates → **APPROVED**.
- **OQ-7.** Operator no approve → **APPROVED**.
- **OQ-8.** Any non-empty string ≤ 200 chars → **APPROVED with char-class constraint**: `/^[\x21-\x7E]+$/` (ASCII printable, no whitespace). Wired into A-Idem-1.

**No open questions remain.** Generator-2 may proceed once Evaluator re-approves v2.

---

## 7. Verification commands (Evaluator copy-paste)

```bash
cd "/Users/saveliy/Documents/пентест ИИ"

bun run bun:assert-version
bun run lint
bun run typecheck

docker compose -f infra/docker/docker-compose.local.yml up -d
bun run db:migrate:check

bun test  # no DB
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test  # full

DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test --coverage \
  apps/api/src/routes/projects \
  apps/api/src/routes/targets \
  apps/api/src/routes/assessments \
  apps/api/src/middleware/idempotency.ts \
  packages/contracts/src/{projects,targets,assessments,scope-rules,assessment-state}.ts \
  tests/integration/projects \
  tests/integration/targets \
  tests/integration/assessments

bun run check:path-footguns

# Manual probe — state machine matrix
bun -e "import {transition} from './packages/contracts/src/assessment-state.ts'; for (const s of ['draft','submitted','approved','running','paused','cancelled','completed','failed']) for (const c of ['submit','approve','start','pause','resume','cancel','markCompleted','markFailed']) console.log(s, c, JSON.stringify(transition(s as any, c as any)));"
```

---

## 8. Dependencies

- Sprints 1-4 PASS (already at HEAD `734523d`).
- No new external deps expected. If Generator-2 needs anything beyond what's in `package.json`, declare in §11 L-3.

---

## 9. Test strategy

| Layer | Tooling | Where |
|-------|---------|-------|
| Unit (state machine) | `bun test` | `packages/contracts/src/assessment-state.test.ts` (table-driven 64-case matrix) |
| Unit (DTOs) | `bun test` | one `.test.ts` per DTO file |
| Unit (idempotency hash, redaction reuse) | `bun test` | `apps/api/src/middleware/idempotency.test.ts` |
| Integration (PG-backed) | `bun test` with `DATABASE_URL` | `tests/integration/{projects,targets,assessments,idempotency}/*.test.ts` |
| C29-delta regression | `tests/integration/audit/c29-delta.test.ts` | extend |
| IDOR + tenant isolation | `tests/integration/idor/*.test.ts` | extend Sprint 3-4 patterns; new file per aggregate |
| Cumulative regression | full PG-backed run | floor 388 → target 388 + (new) |

---

## 10. Sliced delivery (recommended; Generator-2's call)

Sprint 5 is large (~20 routes + state machine + middleware + 1 migration + RBAC matrix expansion + 3 IT suites + ADR + runbook). Sprint 3 was sliced into 7 commits. Generator-2 may slice along these natural boundaries:

1. **Slice 1.** State machine pure function + DTOs + ADR. No routes yet. (Lands the testable core early.)
2. **Slice 2.** Migration 016 + repo helpers + seed-X library extension.
3. **Slice 3.** RBAC matrix expansion + matrix tests update.
4. **Slice 4.** Projects routes + IT.
5. **Slice 5.** Targets routes + ownership-proof + IT.
6. **Slice 6.** Idempotency middleware + IT.
7. **Slice 7.** Assessments routes (depends on slices 1, 6) + IT.
8. **Slice 8.** C29-delta extension + IDOR matrix + path-footguns + runbook.
9. **Slice 9.** Final verification + `sprint-5-result.md`.

Slices are advisory. If Generator-2 lands them in fewer commits with clean diffs, that's fine.

---

## 11. Limitations (explicitly out of scope; Evaluator must not flag)

- **L-1.** No queue dispatch on `start` (Sprint 7).
- **L-2.** No scope-engine evaluation (Sprint 6); scope rules are stored, not enforced.
- **L-3.** No new external deps unless declared by Generator-2 here (and approved).
- **L-4.** No real ownership-verification flow (Phase 9). `POST /ownership-proof` accepts the claim and audits; status stays `pending` until a future admin-only endpoint flips it.
- **L-5.** No findings, evidence, observations, reports surface beyond placeholder GETs (Sprints 9-12).
- **L-6.** No `Idempotency-Key` for non-mutating GETs.
- **L-7.** 3 deferred LRUs from Sprint 3 stay deferred to Sprint 7.
- **L-8.** No `starting/resuming/cancelling` intermediate states (OQ-2; Sprint 7).
- **L-9.** No platform_admin cross-tenant queries (Phase 9).

---

## 12. Workflow

1. Evaluator reviews this contract; resolves OQ-1 through OQ-8; sends revisions or approval.
2. Generator-2 implements per the slice plan (or their preferred order). TDD throughout.
3. Generator-2 writes `sprint-5-result.md` with: cumulative test count, RBAC allow delta count (CF-7 phrasing), path-footguns scan, and any open follow-ups.
4. Evaluator runs §7 commands + writes `evaluator-probe-sprint5.ts` with orthogonal probes targeting:
   - State machine 64-case table.
   - Idempotency same-key + same-body byte-identical replay.
   - Idempotency same-key + different-body 422.
   - Approve gate when one or more targets are unverified.
   - IDOR + actor-tenant attribution on every new route.
   - Soft-delete preserves rows; hard-delete blocks on reference.
   - Audit emission count matches enumerated emission points.
5. PASS → Lead clears Sprint 6 (scope engine).
6. FAIL → up to 3 Generator↔Evaluator iterations, then escalate.

---

End of contract.
