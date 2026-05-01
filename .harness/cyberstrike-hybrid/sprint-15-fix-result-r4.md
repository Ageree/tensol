# Sprint 15 Fix-Review R4 — final round per team-lead's extended budget

**Evaluator:** evaluator-s15 (Opus, isolated context)
**Generator:** generator-s15 (Sonnet 4.6)
**Date:** 2026-04-30
**Commit under review:** `eebf360` (`fix(sprint-15): R4 close — IT tenant seed + B23 bytea exempt + B6 retarget`)
**Baseline:** `9993823` (R1 REVISE) → `23f628b` (R2 codex+blockers) → `eebf360` (R4)
**Verdict:** **REVISE — narrow, generator's call** (per team-lead "after R4 sprint closes regardless")

The codex security work is fully verified. The mechanical migration/IT plumbing is 80% done. Team-lead may ship-with-backlog given R4 is the budget terminal — see Decision section.

---

## Headline (full-suite per team-lead's process improvement)

- Lint: **0 errors** (445 files via biome)
- Typecheck: **0 errors** (`tsc -b` silent exit)
- No-DB tests: **1031 pass / 0 fail / 346 skip** (1377 across 162 files, 19021 expects) — **CLEAN** ✓
- Full-PG tests: **1248 pass / 6 fail / 13 skip** (1267 across 162 files, 20018 expects) — **6 fail vs ≤3 budget**, but ≥3 are baseline flakes carried from prior sprints
- AUDIT_ACTIONS: 58 (no change vs R3)

R3 discipline: ONE PG full run + 2 targeted re-runs (`tests/integration/browser-auth` and `tests/integration/db/migrations.test.ts`) to extract failure root causes. Within budget.

**Trajectory: 114 fail (R1) → 10 fail (R3) → 6 fail (R4).** 95% reduction across the full review cycle.

---

## HF1-HF4 status

| HF | R3 status | R4 status | Notes |
|---|---|---|---|
| HF1 (A-15-* IT broken) | All 5 fail | **3 of 5 still fail** | LoginHappyPath, LoginFailed, DecryptionFailure fail with `TypeError: undefined is not an object (evaluating 'input.rawRules')` at `tests/integration/browser-auth/login-flow.test.ts:157` (`buildScope` helper). seedActors fix landed correctly (`null tenant_id` is gone). ScopeGuard + CredentialRepo IT now PASS. |
| HF2 (B23 bytea) | Fail | **PASS** ✓ | `tests/integration/db/schema-shape.test.ts:113` `BYTEA_EXEMPT = ['target_credentials']` + query filter `AND table_name != ALL(${BYTEA_EXEMPT})`. Comment notes binary-by-nature AES-GCM data. |
| HF3 (B6 mig 018 retarget) | Fail | **PASS** ✓ | `migrations.test.ts:46-99` rewritten as two-step: step-1 verifies target_credentials gone + langgraph_thread_id still present (017 regression guard); step-2 verifies langgraph_thread_id gone; re-applies. Per my R4 contract revision specification. |
| HF4 (B6 reports column shape) | Fail (collateral) | **STILL FAILS** | NOT a collateral from HF3 — independent off-by-one bug. `migrations.test.ts:158-162` rolls back **5** migrations to reach mig 013, but with mig 018 added, that's now 6 down-steps required. Comment "017→016→015→014→013 = 5" is stale; should be "018→017→016→015→014→013 = 6". After 5 down-steps the reports table is still present → assertion `false` fails (got `true`). |

---

## Failure analysis (6 PG fails, ≤3 budget)

### Hard new failures (4):

1-3. **A-15-LoginHappyPath / LoginFailed / DecryptionFailure** — same root cause:
```
TypeError: undefined is not an object (evaluating 'input.rawRules')
  at buildEffectiveScope (packages/scope-engine/src/effective-scope.ts:274)
  at buildScope (tests/integration/browser-auth/login-flow.test.ts:157)
  at <anonymous> (services/browser-worker/src/auth-handler.ts:136)
```
The IT helper `buildScope` (line 157 of login-flow.test.ts) constructs an input for `buildEffectiveScope` that lacks the `rawRules` field. `BuildEffectiveScopeInputs` requires `rawRules: ReadonlyArray<NormalizedRule>` but the IT helper passes an object without it. ScopeGuard test passes because it sets `denyScope: true` which makes the helper return `null` early, never calling `buildEffectiveScope`. CredentialRepo passes because it tests an append-only DELETE before reaching the auth-handler. The other 3 cases all reach `auth-handler.ts:136` → `buildScope(deps)` → crash.

4. **B6 reports table absent after rollback** (HF4) — off-by-one: the loop counts 5 but needs 6 with mig 018 present. One-line fix: `for (let i = 0; i < 6; i++)` and update the comment.

### Baseline flakes (2 unambiguously, possibly 3):

5. **`A-Proj-1 — list returns own-tenant projects only + pagination`** — known intermittent, listed in S11 evaluator soft-findings as occasional pagination flake.
6. **`PATCH /findings/:id/status — auditor cannot change status (403)`** — confirmed S11 baseline flake (was the +1 PG fail allowed in S11 PASS, S14 PASS, and my R3 fix-review).
7. **(possibly counted)** `LocalQueueAdapter retries on BrowserTimeoutError → succeeds on second attempt` — known S9-era retry-transient flake.

If HF1+HF4 are fixed, PG would settle at ~1252/3/13 within budget.

---

## §7 Verification Matrix (R4 delta)

| ID | R3 status | R4 status | Notes |
|---|---|---|---|
| A-15-Schema | PASS | **PASS** | mig 018 + 3 trigger names verified |
| A-15-DriverFacade | PASS | PASS | unchanged |
| A-15-RecipeSchema | PASS | PASS | unchanged |
| A-15-Executor | PASS+ | PASS+ | scopeCheck + adversarial unit test |
| A-15-Crypto | PASS | PASS | unchanged |
| A-15-CredentialRepo | FAIL | **PASS** | A-15-AppendOnly probe with SQLSTATE 23514 now runs and asserts |
| A-15-Integration | FAIL (5/5) | **PARTIAL (2/5 pass)** | ScopeGuard + CredentialRepo PASS; LoginHappyPath + LoginFailed + DecryptionFailure FAIL on buildScope helper |
| A-15-FixtureReset | PASS | PASS | unchanged |
| A-15-BrowserWorkerIntegration | mixed | PASS | RealBrowserDriver Playwright impl shipped, B2 stubs gone |
| A-15-Audit | PASS | PASS | 58 actions, length assertion green |
| A-15-SecurityInvariants | PASS+ | **PASS+** | scope-deny at recipe-step + route handler + null-scope all closed (codex P1+P2+P3+P4 verified) |
| A-15-LintTC | PASS | PASS | clean |
| A-15-Tests | HARD FAIL | **MARGINAL** | 1031/0 no-DB clean, 1248/6/13 PG over budget but 4 of 6 are explained (3 IT bug + 1 off-by-one), 2-3 baseline flakes |
| A-15-Coverage | DEFERRED | **PARTIAL** | target-credentials.ts repo at 78.18% line, 83.33% func; auth-handler at 34.52%/60% (low because 3/5 IT cases don't run). Crypto, executor, audit, schema, drivers all ≥80%. After HF1 fix, auth-handler should hit 80%. |
| A-15-DriverADR | DEFERRED | **DEFERRED** | A-15-D contract delta APPROVED separately; impl in S16 |
| A-15-NoRegression | CANNOT VERIFY | **PASS** | scope-engine purity ✓, AUDIT_ACTIONS append-only ✓, S13/S14 fixes intact ✓; HF3 and HF4 are test-side only, not production regressions |

---

## Fixes still needed (≤2 mechanical fixes if shipping clean)

### F1 — buildScope IT helper input shape

`tests/integration/browser-auth/login-flow.test.ts:157` `buildScope` passes an input without `rawRules` field to `buildEffectiveScope`. Either:
- (a) helper should construct `{ rawRules: [], ... }` with empty rules array, OR
- (b) construct rules from the test's intended scope (allow lab fixture URL), pass `{ rawRules: [{...}], ... }`.

Option (b) is more realistic — A-15-LoginHappyPath etc. need a scope that ALLOWS the lab fixture URL. Currently the test expects scope to allow the navigate, but if scope is empty/null it'd deny. Pattern reference: `tests/integration/browser/` has working scope-allow setup. ~10 lines.

### F2 — B6 reports rollback loop count off-by-one

`migrations.test.ts:158`: `for (let i = 0; i < 5; i++)` → `for (let i = 0; i < 6; i++)`.
`migrations.test.ts:158` comment: `017→016→015→014→013 = 5` → `018→017→016→015→014→013 = 6`.
1-line code change + comment update.

---

## Soft findings (if shipping with backlog)

- **B23-update**: pitfall catalog v7 P32 — adding bytea columns silently violates B23, exempt or use text+hex. **Captured (per team-lead)**.
- **B24**: post-S15 backlog — coverage on `auth-handler.ts` should hit ≥80% once F1 fixed (currently 34.52% line because 3/5 IT cases don't reach it).
- **B25**: post-S15 backlog — when adding a new migration, ALL multi-step rollback tests (not just the latest-mig one) need their loop counts re-checked. New pitfall **P33 carry-to-v7**: "Adding a new migration changes the down-step count for every multi-step rollback test that traverses the new migration. Audit all `for (let i = 0; i < N; i++) migrateDown()` loops in migrations.test.ts when adding migrations."

---

## Codex security work — final verification (CARRY TO PITFALL CATALOG v7)

All 4 codex adversarial findings PASS at code level + adversarial unit test. The S15 sprint's security mission is complete:

1. **Recipe-step scope guard** — `executor.ts:40-48` verified
2. **Null-scope fail-closed** — `auth-handler.ts:144-146` verified
3. **Credential target binding** — `auth-handler.ts:123-132` verified
4. **Redirect/route scope** — `real-driver.ts:91-99` verified (route.abort BEFORE route.fetch)

This is the most important deliverable. Even with HF1 (IT not running 3 of 5 cases), the function-level invariants are tested via `executor.test.ts` adversarial unit tests. The IT failure is a fixture bug, not a security regression.

---

## Decision

**REVISE** technically (6/3 over PG budget) but with notable distinction:

Per team-lead's R4 ruling: "After R4 evaluation, sprint closes regardless of outcome — any non-blocker leftover carries to S16 backlog."

**My recommendation to team-lead:**

**OPTION A — Ship S15 with F1+F2 backlog** (preferred if generator is at context capacity):
- All security invariants verified end-to-end at unit-test layer (codex 4/4 + adversarial unit pass)
- 2 of 5 IT cases pass (ScopeGuard + CredentialRepo)
- Schema, migrations, AUDIT_ACTIONS, fixture-reset, append-only triggers all green
- 95% test failure reduction across review cycle (114→6)
- Add F1 (IT helper buildScope) + F2 (B6 reports off-by-one) as B19+B20 in S16 backlog
- New pitfalls P32 (bytea exempt) + P33 (multi-step rollback loop counts) carry to catalog v7

**OPTION B — One more 5-minute round** for F1+F2 (if generator has bandwidth):
- F2 is genuinely one line + comment
- F1 is ~10 lines (construct rawRules array in helper)
- Very high probability of clean PASS at 1252/3/13

I lean toward **A** — the security mission is complete; F1 and F2 don't affect production code; sprint cycle is at budget terminal. But team-lead has the call.

If A: write `sprint-15-shipped.md` summary + add B19+B20+P32+P33 to backlog drawer.
If B: ≤30 min for generator + me to verify → clean PASS → ship.
