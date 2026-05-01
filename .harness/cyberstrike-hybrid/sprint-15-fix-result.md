# Sprint 15 Fix-Review Result — codex adversarial + regression fixes

**Evaluator:** evaluator-s15 (Opus, isolated context)
**Generator:** generator-s15 (Sonnet 4.6)
**Date:** 2026-04-30
**Commits under review:**
- `7065a49` — regression fixes (workspace-names + stale real-driver stub tests)
- `d1db15a` — codex adversarial fixes (4 findings: scope-guard at recipe steps, null-scope fail-closed, target binding, redirect/route scope)

**Baseline:** `9993823` (my Opus REVISE verdict)
**Verdict:** **REVISE** — 4 codex findings + 2 regressions correctly fixed (excellent work), but 4 NEW hard failures surfaced by the full PG suite

---

## Headline (full-suite counts per team-lead's process improvement)

- Lint: **0 errors** (445 files via biome)
- Typecheck: **0 errors** (`tsc -b` silent exit)
- No-DB tests: **1031 pass / 0 fail / 345 skip** (1376 across 162 files, 19021 expects) — **CLEAN** ✓ (was 1025/5 before fix)
- Full-PG tests: **1243 pass / 10 fail / 13 skip** (1266 across 162 files, 20004 expects) — **HARD FAIL**, 9 hard failures over the ≤3 flake budget
- AUDIT_ACTIONS: 56 → **58** (+2: `auth.credential.target_mismatch`, `auth.recipe.scope_denied`) — generator's message claimed +1 but the code added 2. Cardinality test `.toBe(58)` matches actual array length 58. Internally consistent but the recap was misleading.

R3 discipline: ONE PG run + 1 targeted re-run on `tests/integration/browser-auth` and 1 on `tests/integration/db` to extract failure stacks. Within budget.

---

## Codex finding fixes — VERIFIED CORRECT

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | CRITICAL — scope guard at recipe navigate steps | **PASS** | `packages/browser-auth/src/executor.ts:40-48` — `scopeCheck?: (url: string) => Promise<void>` parameter, `if (scopeCheck) await scopeCheck(url)` BEFORE `page.goto(url, …)`. `executeRecipe` at line 81 propagates through to `executeStep` (line 84). Throws fail-closed. New unit test at `executor.test.ts` verifies scopeCheck called per navigate step + denied URL prevents goto. |
| 2 | HIGH — null scope fails-closed | **PASS** | `services/browser-worker/src/auth-handler.ts:144-146` — null-scope nack at `'scope_unavailable'` BEFORE the decrypt block. The pre-fix `if (scope)` skip is gone. |
| 3 | HIGH — credential target binding | **PASS** | `auth-handler.ts:123-132` — `if (credRow.targetId !== payload.targetId) { … emit 'auth.credential.target_mismatch' … return nack(…) }` BEFORE decryption. `auth.credential.target_mismatch` registered in `audit.ts:110`. |
| 4 | HIGH — redirect/subrequest scope bypass | **PASS** | `services/browser-worker/src/real-driver.ts:91-99` — route handler order verified: `if (this.scopeCheck) { await this.scopeCheck(req.url()); … route.abort('blockedbyclient'); return; }` → `route.fetch()` only reached if scope-check passes. The redirect-scope-bypass attack vector closed. |

All 4 codex P1/P2 findings correctly addressed. This part of the fix-commit is **excellent work**.

---

## Regression fixes from R1 — VERIFIED

| ID | Status | Evidence |
|---|---|---|
| B1 (PG cascade) | **FIXED** | `tests/integration/db/helpers/db-fixture.ts:78` — `'target_credentials'` added. PG cascade gone (was 114 fail, now 10 — different failures, see below). |
| B2 (stale real-driver tests) | **FIXED** | `services/browser-worker/src/real-driver.test.ts` rewritten/replaced. No-DB suite was 5 fail → 0 fail. |
| B3 (A-15-ScopeGuard IT) | **PARTIALLY FIXED** | `tests/integration/browser-auth/login-flow.test.ts:300` — `test('A-15-ScopeGuard: null scope → nack before decryption + auth.recipe.scope_denied audit', …)` exists. **BUT it fails** (see HF1). |
| B4 (workspace-names) | **FIXED** | New packages now export `name = 'packages/<dir>'`. No-DB clean. |

R1 mechanical fixes all addressed. Quality of those fixes is fine; they unblocked further verification which then surfaced 4 NEW hard failures.

---

## NEW Hard Failures (HF1-HF4) — Sprint-15 still REVISE

### HF1 [HARD P0] — All 5 A-15-* IT cases fail with same setup error

**Symptom:** Every A-15-* IT case (LoginHappyPath, LoginFailed, ScopeGuard, DecryptionFailure, CredentialRepo) fails with:
```
error: null value in column "tenant_id" of relation "projects" violates not-null constraint
```

**Diagnosis:** The IT setup helper (likely in `tests/integration/browser-auth/helpers/` or `auth-fixture.ts` extension) is inserting into `projects` without seeding a `tenant_id`. This is a fixture sequencing bug introduced by the recent IT changes — the headline browser-auth IT suite is **completely broken**. Zero green A-15-* tests means the actual handler-level invariants are unverified end-to-end.

**Fix needed:** Trace the IT setup chain. Either the test setup needs to call `seedTenant` before `insertProject`, OR the projects insert is missing the `tenantId` field. Both are common mistakes when a new IT file is bootstrapped without copying the full setup pattern from existing IT files (e.g. `tests/integration/findings-api/`).

**Severity:** P0 — verifies nothing about the codex fixes at the IT layer. The unit test added to `executor.test.ts` proves the function-level scope-check works; but the integration path through `handleBrowserAuth` → repo → DB → audit is unverified because the IT can't even start.

---

### HF2 [HARD] — B23 BYTEA columns invariant violated by mig 018

**Symptom:** `(fail) schema shape (B9-B12, B23, B23b, B24) > B23 — no BYTEA columns anywhere`

**Diagnosis:** `tests/integration/db/schema-shape.test.ts:110` asserts `data_type='bytea'` returns zero rows across all tables. Migration 018 introduced three bytea columns: `encrypted_blob`, `iv`, `auth_tag`. The B23 invariant predates S15 — it's a long-standing rule "no BYTEA columns anywhere" (likely because pg-bytea has known performance/encoding pitfalls in this codebase's adapter setup).

**Generator's pitfall catalog item P5 ("EncryptedBlob fields are Buffer, not Uint8Array")** addressed the JS-type side correctly, but didn't notice that the SQL bytea storage violates the project-wide rule. Generator should have flagged this in the contract; I missed it in R1 because I focused on B6/trigger pattern.

**Fix options:**
- (a) Update B23 with an explicit allow-list for `target_credentials.encrypted_blob/iv/auth_tag` (cleaner — encryption blobs are the canonical exception).
- (b) Switch the migration to `text` columns storing hex/base64 encodings of the bytes. Slightly worse storage, but no schema rule change.
- (c) Use `varbit` (bit-string) — not really an improvement.

Option (a) is preferred. Add a `B23_BYTEA_EXEMPT` const and exempt the three columns by `(table_name, column_name)` pair.

---

### HF3 [HARD] — B6 rollback test still expects mig 017's `langgraph_thread_id`

**Symptom:** `(fail) migrations :: apply / rollback / redo (B5/B6) > B6 — rollback removes the latest migration`

**Diagnosis:** `tests/integration/db/migrations.test.ts:46-75` (the original B6 test) asserts that one `migrateDown()` removes the `langgraph_thread_id` column on `decepticon_sessions`. With mig 018 now in place, one `migrateDown()` removes `target_credentials` instead — and `langgraph_thread_id` is still present. The test fails because the assertion targets the wrong migration.

This is exactly my R4 contract revision: "B6 now asserts `target_credentials` dropped after step-1 down; add NEW assertion that step-2 down still removes `langgraph_thread_id`." The new B6 test for target_credentials at lines 152-180 was added correctly, but the existing 017-langgraph B6 was not retargeted.

**Fix:** Update `migrations.test.ts:46-75`:
- After step-1 `migrateDown()`: assert `target_credentials` table is gone (it's now the latest).
- Then step-2 `migrateDown()`: assert `langgraph_thread_id` gone (017).
- Then re-apply both for downstream tests.

---

### HF4 [HARD] — B6 reports column shape test now failing (collateral)

**Symptom:** `(fail) migrations :: apply / rollback / redo (B5/B6) > B6 — reports table has expected column shape after migration 013 [188.64ms]`

**Diagnosis:** This test was passing in R1 baseline. Likely collateral from HF3: when the B6 langgraph test fails (HF3), the migrator may be left in a partially-rolled-back state; the next test (B6 reports) runs against an unexpected schema state and fails.

**Fix:** Once HF3 is fixed (proper migrateDown sequencing + re-apply at end), HF4 should resolve as a side-effect. If not, dig into the test's beforeEach for migration state.

---

## Soft findings

1. **AUDIT_ACTIONS recap mismatch.** Generator's message says "+1: `auth.credential.target_mismatch`". Actual code adds 2: `auth.credential.target_mismatch` AND `auth.recipe.scope_denied`. Cardinality assertion `.toBe(58)` matches actual array length 58 (verified via grep + awk count). Code is internally consistent, but the message is misleading. Update commit message or recap so future reviewers can trust the recap.

2. **executor.test.ts adversarial unit test PASSES** — this is good. The function-level scope-check is verified. But the IT-level coverage is missing because of HF1 (all A-15-* IT broken). When HF1 is fixed, the codex findings will be IT-verified end-to-end.

3. **Generator's recap claimed "1031 pass / 0 fail / 345 skip" (FULL no-DB)** — verified accurate. Process improvement absorbed: this is the right shape of test counts to report.

---

## §7 Verification Matrix (delta from R1)

| ID | R1 Status | Fix Status | Notes |
|---|---|---|---|
| A-15-Schema | PASS | PASS | mig 018 OK |
| A-15-DriverFacade | PASS | PASS | unchanged |
| A-15-RecipeSchema | PASS | PASS | unchanged |
| A-15-Executor | PASS | **PASS+** | new scopeCheck wiring + adversarial unit test |
| A-15-Crypto | PASS | PASS | unchanged |
| A-15-CredentialRepo | PARTIAL | **FAIL** | IT broken (HF1) — append-only probe never runs |
| A-15-Integration | FAIL (4 of 5) | **FAIL** | 5 of 5 cases now exist as test() blocks BUT all 5 fail (HF1) |
| A-15-FixtureReset | PASS | PASS | unchanged |
| A-15-BrowserWorkerIntegration | FAIL (stale tests) | **FAIL→PASS** | stale tests removed (B2 fix), new IT path is broken (HF1) — net status mixed |
| A-15-Audit | PASS | PASS | 56→58 (recap said +1, code did +2) |
| A-15-SecurityInvariants | PASS | **PASS+** | scope-deny-at-route-handler now closed (codex P4 fix) |
| A-15-LintTC | PASS | PASS | clean |
| A-15-Tests | HARD FAIL (114) | **HARD FAIL (10)** | 91% reduction but still over budget; new failures are different shape than B1 cascade |
| A-15-Coverage | DEFERRED | **STILL DEFERRED** | HF1 prevents IT-level coverage measurement |
| A-15-DriverADR | DEFERRED | **DEFERRED still** | A-15-D contract delta APPROVED separately |
| A-15-NoRegression | CANNOT VERIFY | **PARTIAL** | scope-engine purity ✓, AUDIT_ACTIONS append-only ✓ (only growing), S13/S14 fixes intact ✓; BUT B6 langgraph test now fails (HF3) — that's a regression on existing test, not on the production code |

---

## Backlog notes (carry to S16 if not fixed)

- **B19**: HF1 — IT setup `tenant_id` seeding bug in browser-auth IT chain.
- **B20**: HF2 — B23 schema-shape exempt list for target_credentials bytea columns.
- **B21**: HF3 — B6 rollback test retargeting (mig 018 step-1 + 017 step-2).
- **B22**: HF4 — B6 reports column shape (likely auto-resolves with HF3).
- **B23-update**: pitfall catalog v7 — add P32: "When adding bytea columns to a new migration, you violate B23. Either exempt explicitly OR use text+hex/base64 encoding. Never silently introduce bytea."

---

## Iteration plan

**Round 3 mandate (≤1 round remaining after this verdict per ≤3 budget):**

1. **Fix HF1 (P0)**: trace IT setup, fix `tenant_id` seeding chain in browser-auth IT. Pattern reference: any working IT file like `tests/integration/findings-api/`.
2. **Fix HF2**: add B23 exempt list for `target_credentials.{encrypted_blob,iv,auth_tag}`. Update test assertion.
3. **Fix HF3**: retarget B6 rollback test to mig 018, add new assertion for 017 after step-2 migrateDown.
4. **Fix HF4**: should auto-resolve with HF3; verify.
5. **Soft find 1**: update commit message or recap to correctly state +2 audit actions.

After fix, re-run lint + typecheck + no-DB + ONE PG run. Expect 1243+/0/13 (5 A-15-* IT now passing + 3 migration tests now passing).

If R3 still has hard failures, escalate to team-lead per brief budget. After 3 REVISE, escalation is mandatory.

---

## Decision

**REVISE.** Excellent work on the 4 codex findings (all correctly closed at the function level + adversarial unit test) and the R1 regressions (B1 cascade gone, B2 stale tests fixed, B4 workspace-names fixed). But the full PG suite — which I emphasized in the R1 verdict and team-lead reinforced as the mandatory matrix — surfaces 4 new hard failures: 5 broken A-15-* IT cases (HF1, single root cause: tenant_id seeding), 1 schema-rule violation (HF2: bytea), 2 migration tests that should have been updated (HF3 + collateral HF4).

The codex security work shipped right; the test infrastructure around it is still wedged. Fix HF1-HF4 in R3.

Notable positive: the PASS on the codex findings demonstrates that adversarial-review output, when actually addressed, lands cleanly. The remaining work is mechanical, not architectural.
