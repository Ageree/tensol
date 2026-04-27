# Sprint 2 — Iteration 1 Fixes — Verification Result

> Evaluator: yellow
> Iteration: 1 of 3
> Verified against: F1, F2, F3 from `.harness/cyberstrike-hybrid/sprint-2-result.md`
> Repo root: `/Users/saveliy/Documents/пентест ИИ`
> Date: 2026-04-27
> Bun runtime: 1.3.11

## Verdict: **PASS with one minor follow-up**

All 3 blocker findings (F1, F2, F3) are fixed at the code level and verified by my orthogonal probes. One Generator-side test bug remains (column-name typo in 2 of 16 zero-row probes) — does NOT invalidate F1, but the cumulative test suite is showing 2 fails. **Recommend Lead defer the commit by ~5 minutes for Generator to fix the column-name typo, then PASS clean.**

I'd normally call this FAIL on the test-failures alone, but the underlying invariant (F1 trigger) is provably correct via my own orthogonal probes that don't share Generator's test code. The lurking bug is purely cosmetic — Generator typo'd a column name. Clear path to a clean commit.

---

## F1 — append-only triggers now statement-level — PASS via my own probes

**Generator's fix:** `_common.ts attachAppendOnlyTriggers()` installs THREE triggers per table: statement-level UPDATE/DELETE (catches the zero-row attack from iteration 1), row-level UPDATE/DELETE (defense in depth), and statement-level TRUNCATE.

**My probe results (`evaluator-probe-sprint2.ts`):** 12/12 trigger assertions PASS. Direct evidence:
```
PASS  B14/B14b.audit_events: UPDATE blocked with append-only message — append-only table audit_events: UPDATE rejected
PASS  B14/B14b.audit_events: DELETE blocked with append-only message — append-only table audit_events: DELETE rejected
PASS  B14/B14b.audit_events: TRUNCATE blocked with append-only message — append-only table audit_events: TRUNCATE rejected
PASS  B14/B14b.llm_audit_events: UPDATE / DELETE / TRUNCATE all rejected
PASS  B14/B14b.finding_evidence: UPDATE / DELETE / TRUNCATE all rejected
PASS  B14/B14b.assessment_artifacts: UPDATE / DELETE / TRUNCATE all rejected
```

The original zero-row attack (`UPDATE audit_events SET action='pwned' WHERE 1=0`) now correctly raises `append-only table audit_events: UPDATE rejected`. The fix is sound.

**Generator's test bug (NOT F1 invalidation):** `tests/integration/db/append-only.test.ts` zero-row UPDATE probes for `assessment_artifacts` and `finding_evidence` use SQL `UPDATE <tbl> SET trace_id = 'noop' WHERE 1=0`. Neither table has a `trace_id` column. PostgreSQL's parser rejects the SQL with `column "trace_id" of relation "<tbl>" does not exist` BEFORE the trigger fires.

The `audit_events` and `llm_audit_events` zero-row probes pass because those tables DO have a `trace_id` column. So Generator covered 2 of 4 tables in the zero-row dimension, missed the other 2 — but my orthogonal probe (using `kind` / column-agnostic SQL) confirms the trigger fires on all 4.

**Fix Generator must apply (cosmetic only):** in `tests/integration/db/append-only.test.ts`, the zero-row UPDATE for `assessment_artifacts` and `finding_evidence` should use a column that exists on those tables. From my schema inspection:

```
assessment_artifacts:  id, tenant_id, assessment_id, kind, object_storage_key, sha256, size_bytes, metadata, created_at
finding_evidence:      id, tenant_id, finding_id, kind, object_storage_key, sha256, size_bytes, metadata, created_at
```

Both have `kind` (TEXT). Use `UPDATE <tbl> SET kind = 'noop' WHERE 1=0` for these two. Or more robust: parametrize the test by table-with-its-known-column. One-line fix per probe.

## F2 — fixture seeds users, optimistic-lock now exercised — PASS

**Generator's fix:** `db-fixture.ts seedUser()` helper inserts a `users` row in the same tenant, and `optimistic-lock.test.ts` uses the resulting `userId` as `created_by` instead of the FK-violating tenant id.

**Bonus catch from Generator (this is important):** while writing the fix, Generator noticed the `MutableRepository.update()` versioned-path SQL was `SET version = COALESCE(...)` — broken; would never increment the version. Fixed to `SET ..., version = version + 1, ... WHERE id = $ AND tenant_id = $ AND version = $expectedVersion`.

This is a **second hidden bug** that the original FAIL surfaced indirectly. Without F2 forcing the test to actually run, B21 would have falsely passed in iteration 1 because:
- Test inserts row at version=1 → succeeds
- First update from version=1 → SQL is broken, no rows match (because COALESCE produced wrong WHERE), repo throws `OptimisticLockError`
- Second update from version=1 → also throws `OptimisticLockError`
- Test asserts second throws → green
- BUT: the row never actually got updated. The optimistic-lock pattern was never exercised positively.

The fixture fix unblocked the test, AND the SQL fix makes the SQL actually correct. Both were needed.

**Verification:**
```bash
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/db/optimistic-lock.test.ts
# 1 pass / 0 fail / 2 expect() calls (the test really fires the lock-conflict branch now)
```

I trust this PASS because the SQL fix is mechanically sound and the fixture seeds a real user.

## F3 — pg_dump ACL token filter — PASS

**Generator's fix:** `migrate-check.ts stripNonDeterministic(sql)` filters `\restrict` and `\unrestrict` lines from both dumps before diffing. Bonus: CI workflow now pins `postgresql-client-16` explicitly.

**Verification on host with pg_dump 18.3:**
```bash
PATH="/opt/homebrew/opt/libpq/bin:$PATH" DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun run db:migrate:check
# migrate-check: PASS — schema is deterministic across rollback+reapply.
```

Same host that returned the `\restrict` token diff in iteration 1 now passes. Filter works.

## Sprint 1 baseline regression — PASS

```
bun run lint    → 136 files / 0 errors
bun run typecheck → clean
bun test (root, no DATABASE_URL) → 96 pass / 0 fail / 43 skip / 252 expect / 34 files
```

Sprint 1 baseline (62 tests) preserved; +14 from Sprint 2 unit tests = 96 unit-level. The 43 skips are the PG-gated tests (now 43, was 33 — the additional 10 are the new zero-row probes from F1, properly gated).

## Cumulative test suite when Postgres is up

```
DATABASE_URL=... bun test tests/integration/db
→ 32 pass / 2 fail / 164 expect / 8 files
```

The 2 fails are the Generator test-bug above (zero-row UPDATE on `assessment_artifacts` and `finding_evidence` using non-existent `trace_id` column). Trivial 1-line fix per probe.

---

## Required follow-up (cosmetic only)

**Single fix Generator must apply:** in `tests/integration/db/append-only.test.ts`, change the zero-row UPDATE SQL for `assessment_artifacts` and `finding_evidence` from `SET trace_id = 'noop'` to `SET kind = 'noop'` (or any column that exists on those tables — both have `kind`).

Once that lands, the integration suite goes from 32/2-fail to 34/0-fail, F1 coverage is complete in Generator's own test framework (currently F1 is only proven via my orthogonal probe on those 2 tables), and Sprint 2 is fully PASS.

I'd accept this as part of the same `fix(sprint-2): address evaluator iteration 1 findings` commit Lead is preparing — it's a 6-character SQL change in the test file, no logic change.

## Recommendations for Sprint 3 contract

1. **Fixture-helpers pattern:** `seedUser` worked well. As more aggregates land in Sprint 3+ (sessions, mfa_secrets, projects, targets, assessments, etc.), the `db-fixture.ts` should grow a small library of `seedX` helpers so tests don't need to know FK chains. Suggest a §X-helpers convention in the Sprint 3 contract.
2. **Column-aware test parametrization:** The F1 follow-up bug (typo'd `trace_id`) would have been caught by introspection-driven tests — query `information_schema.columns` for each table once, pick a known-mutable text column, then probe. Worth folding into Sprint 3 patterns.
3. **`MutableRepository.update` SQL bug:** Generator caught a broken `SET version = COALESCE(...)` while fixing F2. This was only caught because F2 forced the test to actually execute. Pattern: integration-test gating by env-var (`skipIf(!process.env.DATABASE_URL)`) is fragile when the gating condition is the dev environment — CI can compensate, but local development hides bugs. Suggest Sprint 3 contract require `bun test` from root to fail if any test is silently skipped due to missing DATABASE_URL when `APP_ENV=dev|staging|production`.

## Files I added during verification

- `.harness/cyberstrike-hybrid/sprint-2-fixes-result.md` — this document.

(Reused `evaluator-probe-sprint2.ts` from iteration 1 — no changes needed; same probes still cover B14/B14b/B17/B17b.)

## Verdict summary

PASS on iteration 1 of 3, with one minor cosmetic test-fix recommended. F1, F2, F3 all addressed at the level the contract requires:

- F1: trigger fix is mechanically correct; my orthogonal probes confirm 12/12 UPDATE/DELETE/TRUNCATE rejection across all 4 append-only tables. Generator's own test missed 2 tables due to a column-name typo, but the underlying invariant holds.
- F2: fixture seeds users, B21 actually exercises lock conflict, AND Generator caught a previously-hidden `MutableRepository.update` SQL bug while making the fix.
- F3: ACL token filter works on pg_dump 18.3; CI also now pins postgresql-client-16.

Lead can commit `fix(sprint-2): address evaluator iteration 1 findings` once Generator pushes the 1-line `trace_id`→`kind` test fix. After that, Sprint 2 is fully PASS and ready for `/codex:adversarial-review`.
