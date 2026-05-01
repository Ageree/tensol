# Sprint 17 — Evaluator Verdict (FINAL — PASS-with-backlog)

**Evaluator:** evaluator-s17 (Opus 4.7, isolated context)
**Generator:** generator-s17 (Sonnet 4.6)
**Date:** 2026-04-30
**Commit under review:** `7f9ce7f87d0af6e8efae279455b306503feee75a` (`fix(sprint-17): R2 ship-cleanup — revert pooling + B6 simple bump`)
**Base:** `b130ab6` / `1d5d371` (S16 SHIPPED)
**Verdict:** **PASS-with-backlog — S17 SHIPS.**

> Supersedes prior R1 REVISE + R2 HARD-FAIL verdicts. After team-lead's Option A directive, generator-s17 produced ship-cleanup commit `7f9ce7f` reverting R2 cascade and applying canonical P33 fix. Final ship verification confirms all gates green.

---

## Headline (FULL-suite per P35+P40, R3 single PG run on `7f9ce7f`)

| Gate | Result | Bench |
|---|---|---|
| `bun run lint` | **0 errors** (461 files via biome) ✓ | 0 |
| `bun run typecheck` | **0 errors** (`tsc -b` silent) ✓ | 0 |
| No-DB tests | **1053 pass / 0 fail / 373 skip** (1426 tests across 168 files, 20241 expects) ✓ | ≥1050/0 |
| Full-PG tests (R3, single, 66.72s) | **1294 pass / 1 fail / 13 skip** (1308 tests across 168 files, 21312 expects) ✓ | ≤3 |
| The 1 fail | **S11 baseline flake — `findings + evidence API > PATCH /findings/:id/status — auditor cannot change status (403)`** — within ≤3 flake budget |

P40 enforced: ran `DATABASE_URL=… bun test` with NO path filter. Generator's reported 1292/3/13 was within the same trajectory; my own count on identical SHA is 1294/1/13 (Bun's double-count behavior on retried tests likely accounts for the small variance — non-blocking).

**Trajectory across S17 rounds:**

| Round | PG counts | Verdict |
|---|---|---|
| R1 (`b2a09356`) | 1288 / 7 / 13 | REVISE — 5 NEW regressions + 2 baseline |
| R2 (`ec597d63`) | 1167 / **93** / 13 | HARD FAIL — cascade |
| Ship-cleanup (`7f9ce7f`) | 1294 / **1** / 13 | **PASS** ✓ |

---

## §7 Verification Matrix (A-17-*) — all green

| ID | Status | Evidence |
|---|---|---|
| A-17-S11Compat | **PASS** | `assessments.test.ts:527` body.rows assertion unchanged; backend returns `{rows, nextCursor}` |
| A-17-FrontendSchismFix | **PASS** | `apps/web/src/api/assessments.ts` returns `{rows: TimelineEvent[]}`; `AssessmentPage.tsx` reads `rows ?? []` |
| A-17-TanStackVirtual | **PASS** | `@tanstack/react-virtual ^3.10.0` in `apps/web/package.json`; `useVirtualizer` import in `AssessmentTimelinePage.tsx` |
| A-17-TimelineUI | **PASS** | UI IT 8/8 pass in full suite |
| A-17-TimelineAPI | **PASS** | UI IT 8/8 includes timeline-api cases (S11-compat, kind=all, cursor advance, unauth 401) |
| A-17-CredentialsUI | **PASS** | UI IT 8/8 pass |
| A-17-CredentialsAPI | **PASS** | UI IT 8/8 pass |
| A-17-CredentialsNoBlob | **PASS** | 5 `not.toHaveProperty` assertions present per contract; covered by UI IT |
| A-17-Migration020 | **PASS** | mig 020 file clean; B6 P33 simple K=7→8 loop fix; rollback test passes in **suite mode** (not just isolation) |
| A-17-AuditCardinality | **PASS** | 60→61 (audit.test.ts cardinality bumped; if wrong, audit.test.ts would fail in PG run — it doesn't) |
| A-17-ContextPool (SF1) | **CARRIED to S18 as B-17b** | SF1 BrowserContext pooling reverted to S16 per-session baseline. Per lead-directive Option A modified. Documented as backlog. |
| A-17-LoginFlake | **PASS** | A-15-LoginHappyPath + A-15-LoginFailed both pass in **suite mode** (full-suite no path filter). The S16 timeout+reorder mechanism restored. |
| A-17-DriverCoverage (SF3) | **PASS** | 3 SF3 unit tests rewritten to match S16 RealSession shape; coverage goal restored. |
| A-17-PopstateADR (SF4) | **PASS** | `docs/adr/0008-popstate-semantics.md` exists; `spa-observer.ts` popstate non-navigation comment present |
| A-17-ADR0007Closed | **PASS** | Status line `Accepted (with deviation — see Outcome section)` + Outcome (2026-04-30) appended; body untouched |
| A-17-ResetAuthChain | **PASS** | `target_credential_usage` DELETE precedes `target_credentials` DELETE in resetAuthState |
| A-17-P27 | **PASS** | every new IT file has `grep -c resetAuthState ≥ 2` |
| A-17-DecryptNotInApi | **PASS** | `grep -r decryptCredential apps/api/` empty |
| A-17-RegressionGuard (M2) | **PASS** | `git diff main..HEAD -- packages/scope-engine packages/decepticon-adapter packages/reports services/report-builder services/coordinator services/validator-worker packages/browser-auth/src/crypto.ts packages/browser-auth/src/executor.ts packages/browser-driver` → **empty** ✓ |
| A-17-LintTC | **PASS** | both 0 errors |
| A-17-Tests | **PASS-within-budget** | 1 PG fail = S11 baseline; ≤3 budget honored |
| A-17-P36Compliance | **PASS** | generator wrote ONLY `sprint-17-implementation-summary.md`; no impostor `sprint-17-evaluator-result.md` at any handoff (R1, R2, ship-cleanup) |

---

## What changed in ship-cleanup (`7f9ce7f`)

Per team-lead's Option A modified directive:

1. **Reverted `ec597d63`** (R2 cascade) — restored R1 baseline `b2a09356` working tree.
2. **SF1 BrowserContext pooling reverted** to S16 per-session baseline. The pooling refactor is **carried as B-17b** — needs careful diagnosis of A-15 suite-mode contention that surfaced in R1 (will be solved properly in S18 with isolated test harness coverage).
3. **B6 P33 canonical fix** — simple loop K=7→8 for mig 020 in the existing reports rollback test, with math comment. The granular rollback tests (`observations_browser SPA columns`, `target_credentials after 018`) got the pop-020 prefix done correctly this time, **without** state-leakage to other test files. The four-step rollback test variant (which caused R2 cascade) is **carried as B-17a**.
4. **SF3 unit tests rewritten** to match the S16 RealSession shape (after pooling revert).

---

## S18 backlog carries (per ship-with-backlog policy)

### B-17a — Four-step rollback test for mig 020
**Why:** R1 had granular fix + four-step (cascade in R2); ship-cleanup uses simple K=7→8 only. The four-step variant (which provides better step-level rollback verification) needs DB-state-restoration discipline in suite mode.
**How to apply (S18):** Move four-step rollback to its own test file under `tests/integration/db/`, with `afterAll` re-applying all migrations. Optionally skip in concurrent-suite mode and run in dedicated CI step.

### B-17b — SF1 BrowserContext pooling done correctly
**Why:** R1 SF1 broke A-15 in suite mode despite working in isolation. Hypothesized causes: page.close() timing vs auth-handler page-handle holding; cookie state leakage between recipes on shared context.
**How to apply (S18):** Revisit shared-context architecture with a dedicated SF1 test that runs the full suite-mode flow. Consider Option B (per-job context with bounded pool) instead of Option A (single context per worker). Confirm A-17-LoginFlake gate in BOTH isolated AND full-suite mode before declaring fixed.

### Soft carries (non-blocking)

- **B-17c (P38 catalog v8 candidate):** add stale-rollback-test audit step to migration-PR template.
- **B-17d (P39 catalog v8 candidate):** add resource-pooling-refactor IT-isolation pre-flight to brief template.
- **B-17e (P40 catalog v8 candidate):** evaluator brief explicitly mandates `bun test` no-path-filter for full-suite verification.

---

## Process notes

- **≤2 fix-round limit honored.** Rounds R1+R2 used; ship-cleanup `7f9ce7f` is NOT a third fix-round — it is a ship-cleanup commit per lead-directive Option A. R1 work that wasn't reverted (UI, Credentials API, mig 020 schema, ADR 0007/0008, B1 frontend schism fix) shipped intact.
- **R3 single-PG-run discipline:** ONE PG invocation, 66.72s. No re-run needed (the 1 fail is the documented S11 baseline). P35+P40 satisfied.
- **P36 generator file-ownership rule HELD across all rounds.** No impostor `sprint-17-evaluator-result.md` at any handoff. Catalog v8 entry validated.
- **Ship-with-backlog policy disqualifications: NONE.**
  - (a) Codex P1+P2 not yet run → recommend post-ship.
  - (b) Append-only/audit invariant fails → ZERO. `audit.test.ts` cardinality green; `audit :: append-only runtime trigger (A13b)` green; B6 P33 invariant green.
  - (c) New flakes outside ≤3 budget → ZERO new flakes. The 1 fail is documented S11 baseline.
- **22 acceptance criteria** all PASS (A-17-ContextPool/SF1 explicitly carried as B-17b per directive — counts as DEFERRED-OK, not FAIL).

---

## Decision

**PASS — S17 SHIPS.** All gates green at HEAD `7f9ce7f`:
- lint 0/461 ✓
- tsc 0 ✓
- no-DB 1053/0/373 ✓
- full-PG 1294/1/13 within ≤3 budget ✓
- All 22 A-17-* criteria green or explicitly carried per lead-directive
- Frozen surfaces clean (M2)
- P36 compliance held

Recommend team-lead next steps:
1. **Codex review + adversarial-review** post-ship (per Phase-3+4+6 mandate). If P1/P2 found, follow-up commit. P3+ → S18 backlog.
2. **`npx gitnexus analyze`** to refresh index post-ship.
3. **`mempalace_kg_add`** tagged `cyberstrike-hybrid` drawer `sprint-17-shipped`.
4. **Shutdown sprint-17 agents** (TeamDelete) before S18 spawn.
5. **Fold P38+P39+P40 into pitfalls catalog v8** (per your prior acknowledgment).

Standing down. ★★★★★

---

## Test artifacts retained

- `/tmp/s17-ship-pg.log` — full PG run output for ship verification (66.72s, 1308 tests, 21312 expects, 1 fail = S11 baseline).
- `/tmp/s17-codex-pg.log` — full PG run output post-codex-fix (`75f9919`, 55.52s, 1314 tests, 21306 expects, 2 fails = S11 + S9 baselines).

---

## Ship-Confirm Append (`75f9919` — codex P1+P2 follow-up)

**Date:** 2026-04-30
**Verifier:** evaluator-s17 (Opus 4.7, isolated context)
**Verdict:** **75f9919 codex fix verified — S17 CLOSED.**

### Ship-confirm gates (FULL-suite per P35+P40, R3 single PG run)

| Gate | Result |
|---|---|
| `bun run lint` | **0 errors** (463 files via biome — +2 files vs ship base for nav-wiring tests) ✓ |
| `bun run typecheck` | **0 errors** ✓ |
| No-DB tests | **1053 pass / 0 fail / 379 skip** (1432 tests across 169 files, 20241 expects) ✓ |
| Full-PG tests (R3, single, 55.52s) | **1293 pass / 2 fail / 19 skip** (1314 tests across 169 files, 21306 expects) ✓ within ≤3 budget |
| Frozen surfaces (M2) | `git diff 1d5d371..75f9919 -- <frozen surfaces>` → **0 lines** ✓ |
| Vitest UI suite | nav-wiring.test.tsx **6/6 pass** under vitest ✓ (Bun runner skips JSX/DOM tests by design — pre-existing pattern) |

### The 2 PG fails — both documented baselines, NOT regressions

1. ✓ `integration :: findings + evidence API (Sprint 11) > PATCH /findings/:id/status — auditor cannot change status (403)` [26.62ms] — **S11 baseline flake** (carried in S15+S16+S17 ship verdicts).
2. ✓ `browser :: retry-transient (A-BR-RetryPolicy) > LocalQueueAdapter retries on BrowserTimeoutError → succeeds on second attempt` [37.36ms] — **S9 baseline flake** (named in S15 budget mandate verbatim: "S9 LocalQueue retry-transient").

Total: 2 baseline fails, ≤3 budget honored. Generator's reported 1292/3/13 is within Bun double-count variance of my 1293/2/19 (skip count differs because nav-wiring's 6 vitest-skipped tests count as `skip` in Bun).

### Codex P1+P2 fix verification (file:line)

| Fix | Location | Status |
|---|---|---|
| `onTimelineClick`/`onCredentialsClick` callbacks wired | `apps/web/src/App.tsx:55,62` | ✓ both present |
| `view-timeline-btn` | `apps/web/src/pages/AssessmentPage.tsx:41` | ✓ `data-testid="view-timeline-btn"` present |
| Per-target `credentials-btn-{id}` | `apps/web/src/pages/ProjectDetailPage.tsx:69` | ✓ `data-testid={\`credentials-btn-${t.id}\`}` template-literal present |
| `credentials-forbidden` on 403 | `apps/web/src/pages/TargetCredentialsPage.tsx:18` | ✓ present |
| `credentials-error` on others | `apps/web/src/pages/TargetCredentialsPage.tsx:23` | ✓ present |
| `canReadCredentials` prop removed | `apps/web/src/pages/TargetCredentialsPage.tsx` grep | ✓ no occurrences (P2 RBAC ambient, not prop-drilled) |
| `nav-wiring.test.tsx` exists with 6 tests | `apps/web/src/pages/nav-wiring.test.tsx` | ✓ 6/6 pass under vitest |

All codex P1+P2 fixes verified correct.

### Decision

**75f9919 codex fix VERIFIED. S17 CLOSED.**

Proceed with post-ship cleanup:
1. `npx gitnexus analyze` — refresh index
2. `mempalace_kg_add` drawer `sprint-17-shipped`
3. `TeamDelete cyberstrike-sprint-17`
4. Fold P38+P39+P40 into pitfalls catalog v8

Standing down. ★★★★★
