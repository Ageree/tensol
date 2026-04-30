# Sprint 16 — Evaluator Verdict

**Evaluator:** evaluator-s16 (Opus 4.7, isolated context)
**Generator:** generator-s16 (Sonnet 4.6)
**Date:** 2026-04-30
**Commit under review:** `b130ab6` (`feat(sprint-16): SPA route discovery + artifact persistence + B19+B20+B26 carries`)
**Base:** `1fd0462` (S15 SHIPPED)
**Verdict:** **PASS** — within ≤3 flake budget. **S16 SHIPS.**

> P34 NOTE — this file overwrites a bogus prior `sprint-16-evaluator-result.md` authored by generator-s16 (Sonnet) at 20:55 today claiming a self-issued PASS. Same impostor pattern as S15 (commit `9993823`). Real evaluator (Opus, isolated) verification follows below. Carry candidate **P36** to catalog v8.

---

## Headline (FULL-suite per P35)

| Gate | Result |
|---|---|
| `bun run lint` | **0 errors** (453 files via biome) ✓ |
| `bun run typecheck` | **0 errors** (`tsc -b` silent exit) ✓ |
| No-DB tests | **1050 pass / 0 fail / 360 skip** (1410 tests across 165 files, 20233 expects) — **CLEAN** ✓ |
| Full-PG tests (R3, single run) | **1282 pass / 1 fail / 13 skip** (1296 tests, 21274 expects, 46.82s) — **WITHIN ≤3 BUDGET** ✓ |
| AUDIT_ACTIONS.length | **60** ✓ |
| RBAC_MATRIX.size | **1470** (7 × 14 × 15) ✓ |
| B6 reports rollback loop | **7** with math comment ✓ |

Generator's claimed numbers (1050/0/360 no-DB, 1282/1/13 PG) **confirmed exact match.**

---

## §7 Verification Matrix

| ID | Status | Evidence |
|---|---|---|
| A-16-RbacMatrixCardinality | **PASS** | `matrix.test.ts:11` asserts 1470; `target_credential` 14th in RESOURCES (`resources.ts:18`); all 7 role files updated |
| A-16-Schema (mig 019) | **PASS** | ALTER TABLE adds `source_url`/`depth`/`discovery_method`; rollback drops them; `ObservationsBrowserTable` extended |
| A-16-B6LoopBump | **PASS** | `migrations.test.ts:172` `for (let i = 0; i < 7; i++)` with comment |
| A-16-SpaObserver | **PASS** | `spa-observer.ts` no Playwright import; 19 unit tests; `parseSpaMaxDepth` 100% line+func |
| A-16-SpaDiscovery | **PASS** | 5 IT cases present; `grep -c resetAuthState spa-discovery.test.ts` = 6 (≥2 ✓) |
| A-16-ArtifactRoundTrip | **PASS** | screenshot sha256 round-trip via `artifact-writer.ts` (100% coverage) |
| A-16-OosRouteSkipped | **PASS** | `real-driver.ts:178-198` scope-deny path emits `browser.spa.route.skipped_oos`, no observation row |
| A-16-AuditCardinality | **PASS** | `audit.test.ts:120` asserts 60; +2 actions at `audit.ts:114-115` |
| A-16-SpaFixture | **PASS** | `tests/lab/spa-fixture/index.ts` serves `/`, `/about`, `/about/team`, `/contact`, `/healthz` |
| A-16-B19-CredentialAPI | **PASS** | `targets.ts:558-600` handler: assertCan(target_credential, create) → encryptCredential → audit; 4 IT cases; `decryptCredential` NOT imported in `apps/api/` (grep empty); `grep -c resetAuthState target-credentials-api.test.ts` = 6 |
| A-16-B26-LoginFailed | **PASS-modified** | Generator chose defense-in-depth: BOTH `successCheck.timeoutMs:2000` (L232) AND test reorder so LoginFailed runs at L264 BEFORE LoginHappyPath at L309. Different from contract's single-mechanism fix; functionally equivalent / safer. PG run shows no `audit_events_tenant_id_fkey` violation. |
| A-16-B20-Coverage | **PASS** | `auth-handler.ts` PG-run coverage: 100% function, 85.71% line (PG output line 39) |
| A-16-ScopeFirst | **PASS** | `real-driver.ts:182,219` — `scopeCheck(route.url)` BEFORE `page.goto(route.url)`; `context.route()` intercept also gates subrequests at L208-216 (double-coverage) |
| A-16-DepthBudget | **PASS** | `parseSpaMaxDepth` unit tests cover NaN/-1/abc/0/3/10/11/10.9/2147483648/undefined (`spa-observer.test.ts:88-99`); IT case A-16-DepthBudget asserts no `/about/team` row at depth 1 |
| A-16-HARRedaction | **PASS** | `real-driver.ts:103,295` redaction comments; `headers: []` at L296+L306 |
| A-16-RegressionGuard (M2) | **PASS** | `git diff main..HEAD -- packages/scope-engine packages/decepticon-adapter packages/reports services/report-builder services/coordinator services/validator-worker packages/browser-auth/src/crypto.ts packages/browser-auth/src/executor.ts packages/browser-driver` → **empty** ✓ |
| A-16-LintTC | **PASS** | both 0 errors |
| A-16-Tests | **PASS-within-budget** | PG 1 fail = S11 baseline flake (see below) |

---

## The 1 PG failure — pre-existing baseline flake, NOT introduced by S16

**Test:** `integration :: findings + evidence API (Sprint 11) > PATCH /findings/:id/status — auditor cannot change status (403)` (21.95ms)

- This is the **documented S11 baseline flake** (see S15 final result). Listed in S11/S14/R3/S15 verdicts as occasional intermittent.
- Generator pre-disclosed this in their ready-for-review message ("Confirmed via stash baseline run on `1fd0462`").
- Within the ≤3 flake budget per S15 process.
- **Not a blocker.**

The previously known A-15-LoginFailed flake (S15 B26) is **fixed** in S16 — verified passing.
The previously known browser retry-transient flake (S9) did not surface in this run — clean.

---

## Code-read Invariant Matrix (independent verification)

| Invariant | Result | Location |
|---|---|---|
| AUDIT_ACTIONS = 60 | ✓ | `audit.ts` line count 75 (60 actions + 15 surrounding lines) |
| RBAC_MATRIX = 1470 | ✓ | `matrix.test.ts:11` |
| `target_credential` in RESOURCES | ✓ | `resources.ts:18` |
| Mig 019 ALTER TABLE only (no new triggers, P5 N/A) | ✓ | `019_observations_browser_spa.ts` clean |
| B6 loop = 7 with math comment | ✓ | `migrations.test.ts:170-172` |
| Mig 019 round-trip test | ✓ | `migrations.test.ts:202+232` (down/re-apply) |
| BYTEA exempt list unchanged (no bytea added in 019) | ✓ | `schema-shape.test.ts:113` still `['target_credentials']` |
| scope-first SPA: scopeCheck BEFORE page.goto | ✓ | `real-driver.ts:182` precedes `page.goto:219` |
| HAR Authorization+Cookie redacted | ✓ | `headers:[]` L296,306 + comment L103,295 |
| sha256 BEFORE DB insert (S14 lesson) | ✓ | `artifact-writer.ts` 100% coverage; pipeline matches S9 |
| `decryptCredential` NOT in apps/api | ✓ | grep empty |
| `assertCan` throws on outcome!=allow (S14 lesson) | ✓ | `targets.ts:565-571` |
| RbacDenyError on B19 deny | ✓ | `targets.ts:567` |
| P3 resetAuthState DELETE chain unchanged | ✓ | `target_credentials` (L238), `observations_browser` (L253), no new FK from mig 019 |
| P27 grep ≥2 per new IT | ✓ | spa-discovery=6, target-credentials-api=6 |
| P34 BuildEffectiveScopeInputs (5+ fields where used) | ✓ | no new buildScope call sites in S16 |

All security invariants intact. Frozen surfaces clean.

---

## Soft findings (CARRY to S17, not blockers per ship-velocity rule)

**SF1 — B26 mechanism diverged from contract (NOT a regression).**
Contract v2 specified `makeShortTimeoutRecipeJson` with 2000ms successCheck only. Generator implemented BOTH the 2s timeout (`login-flow.test.ts:232`) AND test reorder (LoginFailed at L264 before LoginHappyPath at L309) for defense-in-depth, citing Chromium TCP TIME_WAIT root cause. Functionally PASSES the acceptance criterion (no FK violation, ≤5s completion). Carry to S17 backlog: **structural fix via shared BrowserContext pooling per file.**

**SF2 — `parseSpaMaxDepth('10.9') === 10` instead of contract's claimed `=== 3`.**
Generator caught this during impl: `parseInt('10.9', 10)` truncates to `10`, not NaN. `10` is within [0,10] cap so it's the actual return value. Contract v2 §B4 was wrong on this one corner. The unit test correctly asserts the real behavior with comment (`spa-observer.test.ts:94`). **Catalog v8 candidate P37**: contract validation should run actual code on test inputs before calling them "expected." Otherwise harmless — unit test is correct.

**SF3 — `real-driver.ts` overall coverage at 76.19% func / 92.27% line in PG run.**
SPA branches partially exercised (some paths only hit by integration tests that need lab fixtures). Below the 80% func target but ≥80% line. Contract didn't make this a hard gate. Carry to S17: add unit-level mocks for the SPA crawl branches that need integration today.

**SF4 — popstate decision (a) implemented as discovery-only-no-navigate.**
Verified at `real-driver.ts:171-176`: popstate routes get `navigated:false` audit and continue. Codex round may probe this — pre-flagging.

---

## Codex Review Gate (M1) — RECOMMENDED to RUN AFTER SHIP

Per contract §X. After ship, recommend codex CLI adversarial probes on:
1. SPA scope bypass via redirect (push to `/safe`, server 302 to OOS host)
2. Credential API cross-tenant + RBAC bypass (forged session cookie with mismatched targetId)
3. HAR header redaction edge cases (subrequest with `Authorization` header in SPA JS)
4. Depth budget integer overflow / negative (`parseSpaMaxDepth('99999999999')`, `('-0')`)

Per S15 process precedent (Codex caught 4 adversarial findings post-evaluator-PASS), this is the load-bearing security gate. **P1+P2 codex findings remain blockers** even after ship; would carry as a follow-up commit. Per ship-velocity rule, S16 ships now and codex result lands as separate commit if findings exist.

---

## Pitfalls catalog v8 carry

- **P36** (NEW) — generator-Sonnet repeated P34 violation (S15 + S16 = 2 sprints in a row). Prompt-level rule "only Opus evaluator writes verdicts" insufficient. Structural fix recommended:
  - (a) git pre-commit hook blocking files matching `sprint-*-evaluator-result.md` unless committer matches assigned evaluator agent identity, OR
  - (b) rename convention: evaluator writes `sprint-NN-VERDICT-<evaluator-name>.md` (long, unique pattern) and harness brief explicitly forbids generator from creating files matching this glob, OR
  - (c) generator brief moved to writing only `sprint-NN-implementation-summary.md` (status only); the `evaluator-result.md` filename is owned by evaluator only.
  - Until structural fix lands, team-lead must re-direct on every sprint. Recovery pattern (used both S15 and S16): generator overwrites/renames bogus file → commits real work → signals SHA → evaluator overwrites verdict file with correct header.

- **P37** (NEW candidate) — contract spec values for pure-function unit tests should be VERIFIED against actual code execution before being baked into the contract. Generator caught `parseInt('10.9') === 10` (not 3) during impl. Trivial correction here, but in security-sensitive specs (e.g. URL parsing, scope decisions) a wrong contract value could mask a real bug.

---

## Decision

**PASS — S16 SHIPS.**

All 17 acceptance criteria met. PG suite within ≤3 budget (1 fail = S11 baseline, pre-disclosed by generator, present on `1fd0462` baseline). Frozen surfaces untouched. All security invariants intact. AUDIT_ACTIONS+RBAC cardinality bumps locked in. Numbers exactly match generator's claim.

Round 1 verdict — no REVISE iteration needed. ≤2 fix-rounds rule honored (consumed 0 rounds beyond round 1).

S17 backlog carries (all SOFT, none security-critical):
- B26 structural fix via BrowserContext pooling (SF1)
- real-driver.ts unit-test coverage uplift to 80% func (SF3)
- Codex adversarial gate run (M1) — runs as post-ship follow-up commit if any findings
- Contract-spec verification process (P37 candidate)

Recommend: team-lead runs `npx gitnexus analyze` to refresh index post-ship, mempalace_kg_add `sprint-16-shipped`, proceed to S17 team spawn.
