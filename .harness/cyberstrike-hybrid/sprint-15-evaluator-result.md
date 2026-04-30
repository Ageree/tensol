# Sprint 15 Evaluator Result — Browser-Driver + Login Recipes + AES-256-GCM Credentials

**Evaluator:** evaluator-s15 (Opus, isolated context)
**Generator:** generator-s15 (Sonnet 4.6)
**Date:** 2026-04-30
**Commit under review:** `5ef8eb4` (`feat(sprint-15): browser-auth package, AES-256-GCM credentials, browser.auth handler`)
**Baseline:** `832fa0d` (S14 ship + smoke test)
**Verdict:** **REVISE** — 1 hard blocker (PG cascade), 2 hard test issues, 1 missing IT case

---

## Headline

- Lint: **0 errors** (445 files via biome)
- Typecheck: **0 errors** (`tsc -b` silent exit)
- No-DB tests: **1025 pass / 5 fail / 345 skip** (1375 across 162 files, 18977 expects)
- Full-PG tests: **1038 pass / 114 fail / 12 skip** (1164 across 162 files, 19026 expects) — **HARD FAIL**, far exceeds ≤3 flake budget
- AUDIT_ACTIONS: 52 → **56** (+4 auth.* actions, cardinality test green at `audit.test.ts:114`)
- ENVELOPE_KINDS: 5 → **7** (+`report.build`, +`browser.auth`) at `packages/queue/src/types.ts:11`
- P27 invariant: `tests/integration/browser-auth/login-flow.test.ts` has **7 occurrences** of `resetAuthState` (≥2 required)

R3 discipline: ONE PG full run + one targeted re-run on `tests/integration/projects` to extract the failure stack trace. Within budget.

---

## §7 Verification Matrix (A-15-*)

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| A-15-Schema | mig 018 applied + rolled back, append-only triggers via `attachAppendOnlyTriggers`, schema-shape arrays bumped | **PASS (with fixture bug — see B1)** | `packages/db/migrations/018_target_credentials.ts:33` calls `attachAppendOnlyTriggers(db, 'target_credentials')` (UPDATE+DELETE FOR EACH STATEMENT/ROW + TRUNCATE FOR EACH STATEMENT, per `_common.ts:48-67`). `tests/integration/db/migrations.test.ts:152-180` adds B6 test for target_credentials with `pg_trigger.tgname` assertions for the 3 triggers. `packages/db/src/schema.ts:451,462` adds `target_credentials` to `APPEND_ONLY_TABLES` + `TENANT_OWNED`. `tests/integration/db/schema-shape.test.ts:38,49` adds it to `TENANT_OWNED` and `APPEND_ONLY`. **All R1-R5 contract revisions addressed.** |
| A-15-DriverFacade | `BrowserDriverFacade` interface + `PlaywrightBrowserDriverFacade` build/typecheck, scope-guard hook | **PASS** | `packages/browser-driver/` exists. lint+typecheck clean. Unit tests in package. |
| A-15-RecipeSchema | Zod schema validates 3 recipe kinds | **PASS** | Generator's claimed unit-test count (56/0) reflects this; visible via test runner. |
| A-15-Executor | `executeRecipe` walks steps + LoginFailedError on successCheck timeout | **PASS** | `packages/browser-auth/src/executor.ts` per generator brief. |
| A-15-Crypto | AES-256-GCM round-trip, random IV per call, auth-tag tamper, 64-char hex keylen | **PASS** | `packages/browser-auth/src/crypto.ts:24` uses `randomBytes(12)` per call (random 96-bit IV ✓). `parseKek` validates 64-char hex with explicit error messages (lines 12-18). 11 unit tests in `crypto.test.ts` (round-trip, distinct IVs, tamper, keylen). |
| A-15-CredentialRepo | tenant-scoped insert/get/list + append-only IT | **PARTIAL — test exists but cannot run due to B1** | `packages/db/src/repos/target-credentials.ts` exists. `tests/integration/browser-auth/login-flow.test.ts:345` has `A-15-CredentialRepo: DELETE FROM target_credentials raises error (append-only)` test, but PG cascade blocks all IT execution. R5 contract revision honored in shape; broken in execution. |
| A-15-Integration | 5 IT cases (HappyPath / Failed / ScopeGuard / DecryptionFailure / StorageState) | **FAIL — only 4 cases, ScopeGuard MISSING** | `grep -nE "test\(.A-15-" tests/integration/browser-auth/login-flow.test.ts` returns: LoginHappyPath (line 201), LoginFailed (line 255), DecryptionFailure (line 300), CredentialRepo (line 345). **Contract specified 5 cases including A-15-ScopeGuard** (scope-deny path). Generator note says StorageState was "folded into LoginHappyPath" — acceptable. ScopeGuard appears to be silently dropped. The brief explicitly mandates "IT covers happy path AND scope-deny AND wrong-credential failure" — **scope-deny is unaddressed**. |
| A-15-FixtureReset | `target_credentials` ALTER TRIGGER + DELETE BEFORE targets in resetAuthState | **PASS** | `tests/integration/auth/helpers/auth-fixture.ts:226` `ALTER TABLE target_credentials DISABLE TRIGGER USER`, line 238 `DELETE FROM target_credentials` placed before `DELETE FROM targets`, lines 274/282 `ENABLE TRIGGER USER` in finally. R2 contract revision honored. |
| A-15-BrowserWorkerIntegration | RealBrowserDriver replaces stub + handleBrowserAuth wires full flow | **FAIL — stale unit tests not removed** | `services/browser-worker/src/real-driver.ts` is now real Playwright (verified at line 6 `import { chromium } from 'playwright'`). BUT `services/browser-worker/src/real-driver.test.ts` still asserts `NotImplementedError` (lines 1, 9-12, 28-37) — **4 no-DB test failures**. The S9 stub-test was not deleted/rewritten when the impl was replaced in S15. Hard regression. |
| A-15-Audit | 4 new actions + cardinality 56 | **PASS** | `packages/contracts/src/audit.ts:97-103` has all 4 new auth.* actions in append-only order. `audit.test.ts:114` asserts `AUDIT_ACTIONS.length === 56`. |
| A-15-SecurityInvariants | no decryptCredential in apps/api, KEK from env, key never logged | **PASS** | `grep -rn "decryptCredential" apps/api/` → **0 hits** ✓. `grep -rn "CREDENTIAL_KEK" apps/api/` → **0 hits** ✓. `services/browser-worker/src/auth-handler.ts:132` reads `process.env.CREDENTIAL_KEK` (only site). `parseKek` throws `ConfigError` with key-length message but never includes the key value. |
| A-15-LintTC | lint + typecheck clean | **PASS** | biome: "Checked 445 files in 161ms. No fixes applied." `tsc -b`: silent exit. |
| A-15-Tests | no-DB 0 fail; full-PG ≤3 flakes | **HARD FAIL** | no-DB **5 fail** (4 stale RealBrowserDriver tests + 1 workspace-names regression). full-PG **114 fail** — systemic cascade due to B1. Far above ≤3 flake budget. Verdict-blocker. |
| A-15-Coverage | ≥80% line on new packages | **DEFERRED** | Cannot assess accurately while PG suite is broken (target-credentials repo + auth-handler show 0% line coverage in current run because IT can't reach them). Re-evaluate after B1 fix. |
| A-15-DriverADR | DEFERRED pending ADR 0006 | **DEFERRED (acceptable)** | Per generator + team-lead, ADR 0006 not yet finalized; raw Playwright placeholder used. |
| A-15-NoRegression | scope-engine purity, AUDIT_ACTIONS monotonic, S13/S14 fixes intact | **CANNOT VERIFY** | 114 PG failure cascade prevents regression check. AUDIT_ACTIONS append-only ✓ (52→56, no removals). |

---

## Blockers (must fix before APPROVE)

### B1 [HARD BLOCKER P0] — `dropAllTables` missing `target_credentials` → 114 PG cascade failures

**Symptom:** Every PG-touching IT (decepticon, validator, browser-auth, targets, projects, findings, auth, password-reset, MFA, login, audit-emission — basically all of them) fails with the same error:

```
error: cannot drop function enforce_append_only() because other objects depend on it
detail: trigger target_credentials_no_update_delete_stmt on table target_credentials depends on function enforce_append_only()
        trigger target_credentials_no_update_delete_row on table target_credentials depends on function enforce_append_only()
        trigger target_credentials_no_truncate on table target_credentials depends on function enforce_append_only()
hint: Use DROP ... CASCADE to drop the dependent objects too.
code: 2BP01
```

**Root cause:** `tests/integration/db/helpers/db-fixture.ts:73-109` (`dropAllTables`) drops a hand-maintained list of tables (lines 77-104) followed by `DROP FUNCTION IF EXISTS enforce_append_only()` (line 108).

The table list is **missing `target_credentials`**. The S15 migration added the table, attached three triggers depending on `enforce_append_only()`, and added the table to `APPEND_ONLY_TABLES` in schema.ts — but did NOT add it to the fixture helper's drop list. Result: every fixture reset leaves `target_credentials` standing, then the unconditional `DROP FUNCTION` fails because triggers still reference the function. PG returns SQLSTATE `2BP01` and the fixture init/cleanup throws.

**Fix:** Add `'target_credentials'` to `tests/integration/db/helpers/db-fixture.ts:77-104` table list. DROP TABLE … CASCADE handles dependency order. Suggested placement: right after `'reports'` (line 78), since both are append-only with bytea content + tenant FK.

**Sanity check:** S14 added `reports` to this list (line 78); the precedent is well-established. Generator missed extending it.

**Severity:** P0 — blocks 100% of PG suite assessment, ships broken IT entirely.

---

### B2 [HARD] — Stale `RealBrowserDriver > NotImplementedError` tests not removed

**Symptom:** 4 no-DB test failures:
- `RealBrowserDriver > launch rejects with NotImplementedError`
- `RealBrowserDriver > navigate rejects with NotImplementedError`
- `RealBrowserDriver > close rejects with NotImplementedError`
- `RealBrowserDriver > error has correct name`

**Root cause:** `services/browser-worker/src/real-driver.test.ts` was written in Sprint 9 to assert that `RealBrowserDriver` (then a stub) throws `NotImplementedError`. S15 replaced the stub with a real Playwright impl (`services/browser-worker/src/real-driver.ts:6` `import { chromium } from 'playwright';`). The stub-era test was not deleted or rewritten.

**Fix:** Either:
- (a) Delete `services/browser-worker/src/real-driver.test.ts` and add a new `real-driver.test.ts` covering the new lifecycle (launch returns sessionId / status, navigate calls scope-guard, close removes from session map). Preferred — net coverage of the new code path.
- (b) Replace contents in-place with the new behavior tests.

The S15 brief deliverable #6 says "full Playwright impl replacing the NotImplementedError stub" — the impl side shipped, the test side did not.

---

### B3 [HARD] — A-15-ScopeGuard IT case missing

**Symptom:** `tests/integration/browser-auth/login-flow.test.ts` has 4 `A-15-*` test cases:
- A-15-LoginHappyPath (line 201)
- A-15-LoginFailed (line 255)
- A-15-DecryptionFailure (line 300)
- A-15-CredentialRepo (line 345)

**Missing:** `A-15-ScopeGuard` — set up scope that denies target URL, run handleBrowserAuth, assert nack with no `auth.recipe.executed` event, and `recon.browser.navigation.denied` event emitted.

**Why this matters:** Brief explicitly states "IT covers happy path AND scope-deny AND wrong-credential failure". Wrong-credential is covered (LoginFailed); scope-deny is **not**. Generator's note that "A-15-StorageState IT case was folded into A-15-LoginHappyPath" is acceptable, but ScopeGuard cannot be folded — it's a different code path (scope.decide returning deny BEFORE Playwright launches).

The handler does call scope-guard (per `services/browser-worker/src/auth-handler.ts` step 7), but with no IT exercising the deny branch, the path is unverified end-to-end. This is exactly the gap S13 codex caught for decepticon (P1A: per-candidate scope gate untested before iter-7).

**Fix:** Add `A-15-ScopeGuard` test case to `login-flow.test.ts`. Pattern: seed assessment with scope rules excluding the lab fixture URL, enqueue browser.auth job for that target, assert handler returns nack/terminal, assert `recon.browser.navigation.denied` audit event emitted, assert NO `auth.recipe.executed` event.

---

### B4 [MEDIUM] — `workspace-names` aggregator test failure

**Symptom:** `(fail) workspace-names :: aggregator (A18, R9) > every workspace exports name = "<group>/<dir>"` at `tests/integration/workspace-names.test.ts:32`.

**Root cause:** New packages `packages/browser-auth` + `packages/browser-driver` (and possibly `tests/lab/auth-fixture` if it has src/index.ts) are scanned, but at least one of them does not export `name = "<group>/<dir>"` from `src/index.ts`.

**Fix:** Add `export const name = 'packages/browser-auth';` and `export const name = 'packages/browser-driver';` to each new package's `src/index.ts`. (Pattern is uniform across the repo — every existing package follows this convention.) Same for `tests/lab/auth-fixture` if it's a workspace.

---

## Soft findings (codex-round candidates — list grows because B1 prevented full IT-level invariant verification)

1. **[P2 candidate] Confirm `auth.credential.encrypted` actually emitted somewhere.** I verified `auth.credential.decrypted` site (`auth-handler.ts:132`+) but `encryptCredential` only appears in `packages/browser-auth/` (the function itself + its unit tests) — zero call sites in `apps/api/` or anywhere else. **The audit action is registered (cardinality green) but never fires.** If credentials are seeded via the repo helper without going through `encryptCredential` → audit, this is a dead action. R3 contract revision asked for an explicit insert API; if deferred to S16, that backlog entry must be explicit.

2. **[P2 candidate] Coverage on `target-credentials.ts` repo, `auth-handler.ts`, `crypto.ts`** — cannot assess until B1 fixed (target-credentials.ts shows 0%/6.35% in current PG run because tests can't reach it).

3. **[P2 candidate] storageState includes httpOnly cookies — never logged.** Generator's R4 mitigation note says storageState is PUT to object storage only. I cannot verify this end-to-end without B1 fixed; codex should confirm via grep that no `console.*` or `audit_event.payload` includes the storageState string.

4. **[P3 informational] ENVELOPE_KINDS lives in `packages/queue/src/types.ts`, not `packages/contracts`.** Generator brief says "+1 in both `packages/queue` and `packages/contracts`" — only the queue side needed it (no `packages/contracts/src/queue.ts` exists). Cosmetic clarification only.

---

## Iteration plan

**Round 2 mandate (≤2 rounds remaining after this verdict):**

1. **Fix B1**: add `'target_credentials'` to `tests/integration/db/helpers/db-fixture.ts:77-104` table list.
2. **Fix B2**: rewrite or delete `services/browser-worker/src/real-driver.test.ts` — write tests for the real Playwright impl (or remove the file, but new code without unit tests is a coverage gap on its own).
3. **Fix B3**: add `A-15-ScopeGuard` test case to `tests/integration/browser-auth/login-flow.test.ts`.
4. **Fix B4**: add `name = '<group>/<dir>'` exports to all new packages' `src/index.ts`.
5. Clarify soft finding 1: where does `auth.credential.encrypted` fire? If not yet, add an emission point or document the deferral.

After fix, re-run lint + typecheck + no-DB + ONE PG suite. Send `ready for review v2` and I'll do a focused delta pass.

If R2 still has hard failures, R3 with the same scope. After R3, escalate to team-lead per brief budget.

---

## Backlog notes (carry to S16)

- **B16**: `RealBrowserDriver` unit-test coverage — distinct test file with new lifecycle cases (launch returns session, navigate scope-checks, close removes from map).
- **B17**: A-15-ScopeGuard IT (will be addressed in R2 per B3).
- **B18**: end-to-end flow verifying `auth.credential.encrypted` audit event emission from a real `encryptCredential` call site (apps/api route or whatever insert path is chosen).

---

## Decision

**REVISE.** Code quality on the design side is high — AES-GCM is correct, scope-guard pattern correct, schema migrations correct, AUDIT_ACTIONS bumped correctly, fixture-reset DELETE order correct, R1-R5 contract revisions all addressed. But the integration suite is broken at the harness level (B1 cascade), 4 stale tests slipped through (B2), one mandated IT case is missing (B3), and a workspace export is missing (B4).

These are mechanical fixes — generator should turn around v2 quickly. I'll do a focused delta-only review on receipt.

Recommend: do NOT run codex round on `5ef8eb4` until R2 fix lands; running adversarial review against a broken-PG-suite tree will conflate codex findings with B1 cascade noise.
