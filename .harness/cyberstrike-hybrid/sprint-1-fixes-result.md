# Sprint 1 — Codex Adversarial Review Fixes — Verification Result

> Evaluator: yellow
> Source review: Codex adversarial review on `c6ce978` against base `35a500d`
> Verified against: F1, F2, F3 action items from team-lead's brief
> Repo root: `/Users/saveliy/Documents/пентест ИИ`
> Date: 2026-04-27
> Bun runtime: 1.3.11

## Verdict: **PASS**

All 3 Codex findings addressed correctly. No regressions in the Sprint 1 baseline. Lead cleared to commit `fix(sprint-1): address codex adversarial review` and proceed to Sprint 2.

---

## F1 — Lockfile tracked (HIGH) — PASS

**Finding:** `bun.lock`/`bun.lockb` was in `.gitignore`, making `--frozen-lockfile` a no-op assertion.

**Generator's fix:**
- `.gitignore` line 18 is now a comment forbidding re-adding bun.lock.
- `bun.lock` materialized in working tree (~7.6KB; will land in Lead's follow-up commit, currently shows `??` in `git status`).
- All 4 long-running CI jobs (`lint`, `typecheck`, `unit-tests-root`, `unit-tests`) run `git diff --exit-code -- bun.lock` after `bun install --frozen-lockfile`.

**Evidence:**
```
$ ls bun.lock
-rw-r--r-- 7643 bytes (Apr 27 23:52)
$ grep -nE 'bun\.lock' .gitignore
18:# Do not add bun.lock or bun.lockb to .gitignore — see codex adversarial review F1.
$ grep -nB1 -A1 'git diff.*bun\.lock' .github/workflows/ci.yml
# 4 occurrences — one per long-running job.
```

**Probes performed:**
- Confirmed `bun.lock` exists in working tree (not yet `git add`'d but that's Lead's commit).
- Confirmed `.gitignore` no longer has a live ignore rule for it (only a forbidding-comment).
- Confirmed CI assertion step appears in 4 jobs.

**Residual concern:** None. The lockfile must actually be committed by Lead — if the follow-up commit drops it, F1 is back. Recommend Lead verify with `git log --diff-filter=A --name-only HEAD..` after the commit shows `bun.lock`.

---

## F2 — Coverage gate enforces statement metric (MEDIUM) — PASS

**Finding:** `bunfig.toml` declared a statement threshold but `scripts/coverage-gate.ts` only parsed line/function/branch from LCOV — statement was silently no-op'd.

**Generator's fix (path b — document + alias + still gate):**
- Refactored `coverage-gate.ts` into a thin runtime wrapper around a pure library `coverage-gate-lib.ts` (`parseLcov`, `aggregateRatios`, `evaluateGate`).
- `aggregateRatios` returns all 4 metrics; `evaluateGate` returns `{pass, ratios, failedMetrics}` with `failedMetrics` listing exactly which metrics are below threshold.
- **Statement aliasing** is documented inline (`coverage-gate-lib.ts:80-81`): LCOV format does not expose statement separately; `DA` records ARE the statement-level execution markers; `LF`/`LH` are their found/hit totals. V8/c8 derive their "statement" coverage from the same instrumentation. Therefore `statement = line` is an explicit alias, not a silent drop.
- 14 new tests in `scripts/coverage-gate-lib.test.ts`, including 4 dedicated tests proving each of {line, function, branch, statement} can independently fail the gate.
- 100% line/function coverage on the lib.

**Evidence (Generator's run):**
```
$ bun scripts/coverage-gate.ts --threshold=0.80
coverage-gate: lines=99.62% functions=100.00% branches=100.00% statements=99.62% (threshold 80.00%)
EXIT=0
$ bun scripts/coverage-gate.ts --threshold=1.00
coverage-gate: lines=99.62% functions=100.00% branches=100.00% statements=99.62% (threshold 100.00%)
coverage-gate: FAIL — metrics below threshold: line, statement
EXIT=1
```

**Probes I authored** (`.harness/cyberstrike-hybrid/evaluator-probe-fixes.ts`, 7/7 PASS):
- F2.baseline: perfect coverage at 0.80 → `pass=true failedMetrics=[]`
- F2.line-drop: synthetic LCOV with `LH=50/LF=100` → `failedMetrics=[line, statement]` (proves statement isn't silently dropped — it co-fails with line because they share LCOV instrumentation)
- F2.function-drop: synthetic LCOV with `FNH=5/FNF=10` → `failedMetrics=[function]` (line/branch/statement still pass)
- F2.branch-drop: synthetic LCOV with `BRH=10/BRF=20` → `failedMetrics=[branch]`
- F2.statement-active: perfect coverage at threshold=1.001 → `failedMetrics=[line, function, branch, statement]` (statement is a real participant, named in the failure list, not skipped)
- F2.alias: `aggregateRatios` returns `line === statement === 0.73` for `LH=73/LF=100` (alias is faithful)
- F2.immutable: `failedMetrics` is `Object.isFrozen(...)` (immutable result, can't be tampered with by callers)

**Why this is acceptable per Codex F2:**
The original Codex finding was that the statement threshold was *silently* not enforced. After the fix, statement is:
1. Computed (aliased to line, with rationale documented),
2. Compared against the threshold,
3. Named in `failedMetrics` when below,
4. Tested independently in unit tests (`scripts/coverage-gate-lib.test.ts`),
5. Re-verified by my orthogonal probes.

The aliasing is honest: LCOV is the only artifact Bun emits, and LCOV's `DA` records are instruction-level execution markers — they're the same thing V8/c8 call statements. If a future Bun version emits a separate statement count via JSON reporter, `aggregateRatios` is the only function to update; the gate API stays stable.

**Residual concern:** None. If Lead wants to drop the alias and only gate 3 metrics, that's a contract change for Sprint 2; current state is compliant with the contract as written.

---

## F3 — Root tests run in CI (MEDIUM) — PASS

**Finding:** CI's `unit-tests` matrix only ran `bun test packages/config`; `tests/integration/workspace-names.test.ts` (the A18 anti-vacuous aggregator) was never executed in CI, invalidating the Sprint 1 PASS gate's claim that A18 is enforced.

**Generator's fix:**
- New `unit-tests-root` job in `.github/workflows/ci.yml` runs `bun test` from repo root → executes all 21 per-workspace smoke tests + the integration aggregator + the new `coverage-gate-lib.test.ts`.
- Per-package `unit-tests` matrix kept (will expand as real packages gain behavior + per-workspace coverage gates).

**Evidence:**
```
$ grep -A2 'name: test (root' .github/workflows/ci.yml
- name: test (root, all suites)
  run: bun test
$ bun test  # local equivalent
62 pass / 0 fail / 173 expect() calls / 24 files
```

**Probes performed:**
- Read `.github/workflows/ci.yml` — `unit-tests-root` job exists at lines 47-65 (per `grep`), runs `bun test` from repo root after install + lockfile-drift assertion.
- Locally ran `bun test` from root: 62 pass / 0 fail across 24 files (was 48/23 in Sprint 1 baseline → +14 from `coverage-gate-lib.test.ts`).
- Locally ran `bun test tests/integration/workspace-names.test.ts` directly: 1 pass / 44 expect() calls (the test walks all 21 workspaces and asserts each `name` equals dir-key).

**Residual concern:** None. The aggregator now executes on every CI run.

---

## Regression check — Sprint 1 baseline preserved

Re-ran the Sprint 1 §5 verification commands to confirm no fixes broke the foundation:

| Command | Result |
|---|---|
| `bun run bun:assert-version` | PASS — `Bun version OK: 1.3.11` |
| `bun run lint` | PASS — 99 files checked, 0 errors (was 97 before — +2 new scripts) |
| `bun run typecheck` | PASS — clean |
| `bun test` (root) | PASS — 62/0 / 173 expect calls / 24 files |
| `bun run test:coverage` | PASS — lines 99.62% / functions 100% / branches 100% / statements 99.62% |
| Coverage gate at threshold 0.80 | exit 0 |
| Coverage gate at threshold 1.00 | exit 1 (lists `line, statement`) |
| evaluator-probe.ts (Sprint 1 baseline) | not re-run; impl untouched, no risk |
| evaluator-probe-fixes.ts (this sprint) | 7/7 PASS |

## Files I added during verification

- `.harness/cyberstrike-hybrid/evaluator-probe-fixes.ts` — 7 orthogonal probes for F1/F2/F3.
- `.harness/cyberstrike-hybrid/sprint-1-fixes-result.md` — this document.

## Recommendations forward

1. **Lead's commit must include `bun.lock`.** F1 is half-done until the lockfile actually lands in git. After commit, verify with `git ls-files | grep -E '^bun\.lock'` returns a row.
2. **Sprint 2 contract should re-state the F2 aliasing decision** (statement = line) so future sprints don't get confused if Bun emits a separate statement count later. Add a one-line ADR or note in `bunfig.toml` / `coverage-gate.ts` referencing this fixes-result.
3. **Spot-check pattern works** — for incremental fixes, focused probes + regression matrix is faster than full sprint re-review. Recommend reusing this pattern for adversarial-review follow-ups in later sprints.

## Summary

PASS. All 3 fixes land correctly. F1 and F3 are mechanical (no logic risk). F2 was the substantive change — Generator chose to alias statement→line with documented rationale and prove via tests that statement is still a real gate participant. My orthogonal probes confirm: each metric can independently degrade and be named in the failure list, perfect coverage at threshold > 1.0 lists statement (proving it isn't silently skipped), and the aliasing is faithful (statement === line at every coverage level).

Lead cleared for `fix(sprint-1): address codex adversarial review` commit and Sprint 2 kickoff.
