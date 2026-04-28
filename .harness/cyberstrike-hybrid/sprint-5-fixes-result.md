# Sprint 5 — Evaluator Final Verdict (iterations 2-5)

> Evaluator: evaluator-2 (fresh session — replaced original after context limit)
> Verified against: `.harness/cyberstrike-hybrid/sprint-5-contract.md` (v2)
> Repo state: `a12c9c8` + uncommitted F3 + F4a + F5 patches on working tree
> Date: 2026-04-28
> Bun runtime: 1.3.11

---

## Final verdict: **PASS** — Sprint 5 contract delivered

After 5 iterations of progressive fault unmasking, the suite reaches **566 pass / 0 fail** at full PG scope, all 8 deferred orthogonal probes verify the substance, and every contract acceptance criterion (A-State-1..5, A-Proj-1..6, A-Tgt-1..7, A-Asm-1..13, R1-R9, A-DB-1..3, A-RBAC-1..4, A-Idem-1..2, A-Audit-1..3, A-IDOR-1..2, A-Doc-1..2, A-Reg-1..2) is met.

The iter-1 → iter-5 trajectory `533/33 → 546/19 → 564/2 → 564/1 → 566/0` is the workflow doing exactly what it was designed for: each layer of fault-finding peeled back one masking issue until the Sprint 5 substance was visible end-to-end. F1+F2+F3+F4a+F4b were test fixtures; F5 was the production-code bug that those fixture issues had been hiding (only A-Asm-5 with non-empty `['c2']` triggers the JSONB array-literal bug; every other test passes `[]` which silently writes `{}` empty-object).

---

## Iteration timeline

| Iter | Verdict | PG result | Blockers |
|---|---|---|---|
| 1 | FAIL | 532/33 | F1 slug collision (32×), F2 B6 stale (1×) |
| 2 | FAIL | 546/19 | F3 resetAuthState DELETE order (19×) |
| 3 | FAIL | 564/2 | F4a seedAssessment JSONB (1×) + F4b cascade (1×) |
| 4 | FAIL | 564/1 | F5 production-code JSONB serialization (1×) |
| **5** | **PASS** | **566/0 (566 pass, +1 regression test)** | none |

Coverage at iter-5: **93.97% lines** across the whole codebase (up from ~59% in iter-4 because the test surface now reaches code paths that earlier iterations short-circuited).

---

## Cumulative §7 — final iter-5 results

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 245 files, 0 errors |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — 423 / 187 skip / 0 fail / 75 files / 16 334 expect |
| `bun run db:migrate:check` | N/A — host pg_dump absent in this session; B6 in-tree rollback test passes |
| **`DATABASE_URL=… bun test`** | **PASS — 566 pass / 0 fail / 16 334 expect / 75 files** |

---

## Fix audit (all 5 issues)

| ID | Class | Site | Fix | Iter |
|---|---|---|---|---|
| F1 | test fixture | 5 IT files (15 sites) | `uniqSlug(base) = `${base}-${Date.now()}-${random}`` + `seedExtraLoggedInUser` helper | 2 (commit a12c9c8) |
| F2 | test assertion | `tests/integration/db/migrations.test.ts:45-74` | `platform_settings` → `assessment_approvals` | 2 (commit a12c9c8) |
| F3 | test fixture | `tests/integration/auth/helpers/auth-fixture.ts:213-220` | move `DELETE FROM audit_events;` to first inside DO-block | 3 (working tree) |
| F4a | test fixture | `tests/integration/db/helpers/db-fixture.ts:341-350` | `JSON.stringify(highImpactCategories ?? [])` + `JSON.stringify({})` | 4 (working tree) |
| F4b | cascade | A-Proj-1 list pagination | resolved automatically once F4a stopped causing pg-client half-rollback state | 4 (auto) |
| F5 | **production code** | `apps/api/src/routes/assessments/assessments.ts:240, 477, 675` | `JSON.stringify(...)` wrap on 3 JSONB array writes; setClause type changed to `string` | 5 (working tree) |

---

## 8 orthogonal probes — all PASS

### A-State-4 — 64-case state machine matrix ✓
- `packages/contracts/src/assessment-state.test.ts:48` explicit assertion `8 states × 8 commands = 64`.
- Lines 54-55 use `for (const from of ASSESSMENT_STATES)` × `for (const command of ASSESSMENT_COMMANDS)` — fully generated, not hand-written. No drift possible.
- Terminal-state coverage at lines 99-100 exercises all 3 terminal × 8 command pairs.
- `transition()` is pure (no I/O, no DB, no clock); `lookupDecision`-shape table at `assessment-state.ts:75-76` covers `markCompleted` and `markFailed` per A-State-3.

### R2 — idempotency 2xx-only cache (5xx + 4xx no-cache) ✓
- `apps/api/src/middleware/idempotency.ts:55` and `packages/db/src/repos/idempotency-keys.ts:36`: `isCacheable(status) = status >= 200 && status < 300`.
- Insert path gated (idempotency.ts), AND lookup path defence-in-depth (idempotency-keys.ts:66 returns null for non-cacheable rows).
- Tests at `idempotency.test.ts:249` (`first call 5xx → row not cached; second call re-runs handler`) and `:290` (`first call 4xx → row not cached; second call re-runs handler (R2 4xx-no-cache)`).
- Correctly closes both 5xx-replay-lockout AND 403→role-upgrade cache-bypass attack vectors.

### R5 — dual-table approve in single tx ✓
- `apps/api/src/routes/assessments/assessments.ts:678` — `await deps.db.transaction().execute(async (tx) => { ... })` block:
  - line 681: `tx.insertInto('assessment_approvals').values({...}).execute()` — forensic record
  - line 692-705: `tx.updateTable('assessments').set({state: 'approved', approved_by, approved_at, version+1, updated_at})` — hot-path columns
- Single transaction, atomic. Both writes carry `JSON.stringify(cats)` correctly post-F5.
- Approve route also enforces ownership-verified gate at line 645 (every target must have `ownership_status='verified'` else 422 `unverified_high_impact_targets`).

### R8 — temporal gate route-level + assessment.start.denied audit ✓
- `assessments.ts:758` — state machine transition runs first.
- `:762` — `now = new Date()` evaluated AFTER transition success.
- `:763-790` — `now > testing_window_end` → 422 `testing_window_expired` + `assessment.start.denied` audit with `outcome='denied'`, `metadata.reason='window_expired'`.
- `:792-822` — `now < testing_window_start` → 422 `testing_window_not_yet_open` + `assessment.start.denied` audit with `metadata.reason='window_not_yet_open'`.
- Note: state machine in `packages/contracts/src/assessment-state.ts` stays pure — no clock. Temporal coupling lives only at route layer.

### R9 — p95 oracle ≤ 50ms ✓
- `tests/integration/idor/p95-oracle.test.ts:33-44` — p95 helper + `measure()` end-to-end timer (drains body to ensure full latency).
- Line 137-140: `for (let i = 0; i < N; i++) { measure(403); measure(404); }` with N≥30; warm-up consumed.
- Line 151: `expect(Math.abs(p95Cross - p95Nf)).toBeLessThanOrEqual(P95_GAP_MS)` (50ms cap).
- 3 tests (projects, targets, assessments) — mirrors Sprint 3 C26 password-reset oracle pattern.
- `describe.skipIf(!hasDatabaseUrl())` guards skip-without-DB.

### A-IDOR-1 — actor-tenant attribution (ADR 0004 R3 / CF-8) ✓
- All `RbacDenyError` instances across the 3 new route files use `actorTenantId: actor.tenantId` consistently (assessments.ts:178, 204, 322, 383, 412, 451, 624, 749; projects.ts and targets.ts identical pattern).
- R4 cross-tenant precedence at `assessments.ts:200-208` throws `RbacDenyError` BEFORE the 422 `invalid_targets` path — 403 + `rbac.deny` audit attributed to actor's tenant with `metadata.attemptedResourceTenantId = T2_id`.
- Cross-tenant deny audit landing in T1's view (not T2's) is the contract requirement; structurally satisfied.

### A-RBAC-1 — role transitions + 1274 cardinality ✓
Per-role assessment grants verified by direct read of matrix files:
- `tenant_admin`: `r,l,c,u,d,submit,approve,start,pause,resume,cancel,change_status` (matrix/tenant_admin.ts:13-26) — gains all 6 lifecycle commands ✓
- `security_lead`: `r,l,c,u,submit,start,pause,resume,cancel,change_status` (matrix/security_lead.ts:5-16) — `approve` removed (Sprint 5 A-RBAC-1) ✓
- `operator`: `r,l,start,pause,resume,cancel` (matrix/operator.ts:13) — no c/u/submit/approve, gains start/pause/resume/cancel ✓
- 1274 invariant: `packages/authz/src/matrix.test.ts:9-11` explicit `expect(RBAC_MATRIX.size).toBe(1274)` and `expect(ROLES.length * RESOURCES.length * ACTIONS.length).toBe(1274)`.
- A15b Sprint 4 `audit_log` allow restrictions preserved (operator.ts:21 `audit_log: []`).

### ADR 0005 — D1-D5 verbatim ✓
`docs/adr/0005-assessment-state-machine.md:31-46`:
- D1 (line 33): "The state machine is a pure function in `packages/contracts`. The Sprint 7 coordinator imports the same function — there is no parallel state graph."
- D2 (line 35): "The 8-state enum from migration 004 is reused as-is. `starting`/`resuming`/`cancelling` intermediate states are deferred to Sprint 7 with the queue-dispatch work."
- D3 (line 37): "The idempotency cache only persists 2xx responses; the insert path AND the lookup path both gate on `[200, 300)`."
- D4 (line 41): "`testingWindow` temporal gate fires at the route layer, AFTER `transition('approved','start')` succeeds and BEFORE the DB write commits."
- D5 (line 45): "Approval metadata is split across two surfaces. Append-only `assessment_approvals` (forensic record) + hot-path columns `approved_by` and `approved_at` on `assessments`..."

(Minor copy nit: section preamble says "four load-bearing rules" while there are 5; non-blocking — content is complete.)

---

## What was verified PASS at iter-5 cumulative

- **State machine**: 64-case generated table-driven matrix; pure function; single source of truth (CI grep guards parallel state graph drift).
- **RBAC matrix**: 1274 cardinality; A-RBAC-1 role transitions (tenant_admin gains all lifecycle, security_lead loses approve, operator gets r/l/start/pause/resume/cancel only); A15b Sprint 4 invariant intact.
- **Idempotency middleware**: 2xx-only cache at insert + lookup; 5xx and 4xx no-cache; ASCII printable header validation; required-vs-optional rule (state-transition POSTs require, create POSTs don't).
- **Routes**: 6 projects + 7 targets + 14 assessments routes; idempotency wired on 6 state-transition POSTs; R3 atomic delete-then-insert; R4 cross-tenant precedence (T2 → 403 BEFORE T1+wrong-project → 422); R5 dual-table approve in single tx; R7 timeline RBAC keyed on `(assessment, read)`; R8 temporal gate route-level with `assessment.start.denied` audit on both expired and not-yet-open windows.
- **Audit**: 26 emission points enumerated (16 new in Sprint 5 + 10 from Sprint 4); C29 `delta=1` invariant per emission; per-tenant isolation; metadata redaction via Sprint 4 A16.
- **IDOR**: 3-way precedence (200 / 403 / 404) with actor-tenant attribution and p95 oracle gap ≤ 50ms.
- **Migration 016**: 4 new tables (`assessment_targets`, `idempotency_keys`, `target_ownership_claims`, `assessment_approvals`) + `assessments.approved_at` column; B6 rollback test passes.
- **ADR 0005**: D1-D5 verbatim present.
- **Path-footguns**: zero hits across new directories (per Generator's report; not re-run).
- **F5 regression test**: explicit `['c2','ad']` round-trip through create + approve, asserting both `assessments.high_impact_categories` and `assessment_approvals.high_impact_categories` retain the array (would fail 500 if any of the 3 sites reverts).

---

## Limitations (per contract §11, accepted)

L-1 through L-9 hold as documented in contract v2:
- No queue dispatch on start (Sprint 7).
- No scope-engine evaluation (Sprint 6).
- No real ownership-verification flow (Phase 9).
- Findings/evidence/observations/reports are placeholder GETs (Sprints 9-12).
- 3 deferred LRUs stay deferred to Sprint 7.
- No starting/resuming/cancelling intermediate states (Sprint 7 with queue work).

---

## Notes for Lead

1. **F5 audit completeness**: I verified the 3 production sites in `apps/api/src/routes/assessments/assessments.ts` are fixed. Generator noted other JSONB sites in `db-fixture.ts` (`seedAssessmentApproval`, `scopeRules` payload, `seedIdempotencyKey response_body`) untouched per directive — the regression test only exercises `assessments` and `assessment_approvals`. If any of those other paths is later exercised by a future sprint's IT, the same 22P02 might surface. Suggest adding a defensive lint rule or following Generator's offer to prophylactically wrap them in a Sprint 6 cleanup PR.
2. **Coverage jump from 59% → 94%**: not contract drift — earlier iterations short-circuited the test suite at fixture setup, so coverage was artificially low. Once F5 unblocked the route paths, coverage recovered to its real value.
3. **Working-tree state**: F3 (auth-fixture.ts), F4a (db-fixture.ts), F5 (assessments.ts + assessments.test.ts) sit on the working tree; not yet committed beyond `a12c9c8`. Lead's call when to commit + push.
4. **Memory updated**: the JSONB-array-literal pitfall has been added to `~/.claude/projects/.../memory/project_cyberstrike_hybrid.md` so future sprints don't re-hit it.

---

## Files I produced

- `.harness/cyberstrike-hybrid/sprint-5-fixes-result.md` — this final PASS verdict (iter-5 overwrites prior iter-2/3/4 contents at canonical path; iter-1 from prior Evaluator preserved at `sprint-5-evaluator-result.md`).
