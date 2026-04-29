# Sprint 6 — Codex iter-8 Evaluator Verdict

> Evaluator: evaluator (cyberstrike-sprint-6-fixes team, single session)
> Verified against: `.harness/cyberstrike-hybrid/sprint-6-codex-iter-8.md` (generator iter-8 self-report) + 3 codex round-5 findings (2 P1 + 1 P2)
> Repo state: HEAD `9f5a732` + uncommitted Sprint 6 working tree
> Date: 2026-04-28

---

## Final verdict: **PASS** — codex round-5 closure verified

All 3 codex round-5 findings (2 P1 + 1 P2) closed and source-verified at file:line. No engine regression. The single PG full-suite failure is the documented pre-existing A-Proj-1 pagination flake (passes 11/0 in isolation). NOT introduced by iter-8.

This is round-5 of the recursive codex review cycle. Sprint 6 cumulative: **21 semantic security defects across 5 rounds** (4 + 6 + 4 + 4 + 3). Convergence signal: 4→6→4→4→3 — round-5 had the smallest finding count yet, suggesting the engine's anti-bypass surface is approaching saturation.

---

## Iteration timeline (cumulative)

| Iter | Verdict | PG | Round findings |
|---|---|---|---|
| iter-2 | PASS (codex round-1) | 833/0 | 4 (P1×3 + P2×1) |
| iter-3 | PASS (codex round-2) | 846/0 | 6 (P1×5 + P2×1) |
| iter-4 | PASS (codex round-3) | 862/1-flake | 4 (P1×1 + P2×3) |
| iter-5/6 | PASS (lint fix-of-fix) | 876/0 | round-3 closure |
| iter-7 | PASS (codex round-4) | 886/0 on re-run | 4 (P1×2 + P2×2) |
| **iter-8** | **PASS (codex round-5)** | **894/0 expected; 893/1-flake measured** | 3 (P1×2 + P2×1) |

Cumulative: 566 PG (Sprint 5 floor) → **894** (+328 new tests across 5 codex rounds, 8 iterations).

---

## §7 verification matrix (iter-8)

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors, 83ms |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **733 / 209 skip / 0 fail** (matches generator's claim) |
| `DATABASE_URL=… bun test` (full suite) | **893 / 1-flake / 0 engine fail** — flake = `A-Proj-1`, reproduced across two consecutive runs in this session; passes 11/0 isolated |
| `DATABASE_URL=… bun test tests/integration/projects` (isolation) | PASS — **11 / 0 fail** (confirms flake is full-suite contention) |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | PASS — 20 files, 0 changed_symbols, 0 affected_processes, risk=LOW |
| Independent codex-fix probe | PASS — **81 / 0** (cumulative round-1+2+3+4+5: 16+14+16+4 sanity+17+14) |

### A-Proj-1 flake reproducibility

This iter the flake reproduced on two consecutive full-suite runs (iter-7 had it on first run only). Generator claimed 894/0 with no flake; my measurement consistently shows 893/1 in full suite. Projects suite in isolation always 11/0. The flake is pre-existing pagination ordering under full-suite contention — not introduced by iter-8 and not in scope-engine. This discrepancy in flake observability between sessions doesn't change verdict: scope-engine is fully verified, and the A-Proj-1 follow-up sprint task is already lead-tracked.

---

## Codex round-5 finding verification — file:line evidence + probe reproduction

### [I8-1] Uncatalogued tool denies before rule matching — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/decide.ts` (pre-fix) — when `tool_invoke.toolName` was absent from `scope.toolCatalog`, `evaluateToolPolicy` recorded `inCatalog=false` but the engine never returned `tool_not_in_catalog`. A broad `tool_category` allow + host/protocol allows let an uncatalogued/misspelled tool slip through.

**Source-level fix verified:** `packages/scope-engine/src/decide.ts:438-456`:
```
if (
  action.kind === 'tool_invoke' &&
  target.toolName !== undefined &&
  toolPolicyResult.inCatalog === false
) {
  return {
    allowed: false,
    reason: 'tool_not_in_catalog',
    matchedAllowRuleIds: [],
    matchedDenyRuleIds: [],
    normalizedTarget: target,
    toolPolicyResult,
    timeWindowResult: tw,
  };
}
```
This check fires AFTER `evaluateToolPolicy` populates `inCatalog` but BEFORE rule matching, so a broad tool_category allow cannot mask the missing-from-catalog signal.

**Probe reproduction:** `probeI8_1` (3 assertions):
- Catalog has `amass` only; action invokes `misspelled-tool` with broad allow rules covering ip+tool_category+tool_name → DENY `tool_not_in_catalog` ✓
- `decision.toolPolicyResult.inCatalog === false` ✓
- Sanity: catalogued `amass` with same shape → ALLOW ✓

### [I8-2] Percent-encoded path normalization — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/normalize/url.ts` (pre-fix) — `parsed.pathname` was only dot-collapsed before policy matching. `/%61dmin` (encoded `a`) bypassed `/admin` deny rules.

**Source-level fix verified:** `packages/scope-engine/src/normalize/url.ts:72-97` — `decodePathUnreserved`:
- Iterates path char-by-char.
- On `%`: requires 2 hex digits or throws `UrlNormalizationError`.
- Decodes hex byte; if RFC 3986 unreserved (`[A-Za-z0-9\-._~]`), inlines literal char; else preserves as `%XX` uppercase.
- Single-pass (non-recursive) to avoid `%2541 → A` false positives.

`collapsePath` at line 102 calls `decodePathUnreserved(path)` BEFORE segment splitting, so `/%2E%2E/etc` decodes to `/../etc` and segment-collapse caps at root → `/etc`.

**Probe reproduction:** `probeI8_2` (7 assertions):
- `normalizeUrl('https://x.example/%61dmin').path === '/admin'` ✓
- `normalizeUrl('https://x.example/%2E%2E/etc').path === '/etc'` ✓
- `normalizeUrl('https://x.example/%G0')` throws `UrlNormalizationError` ✓
- `normalizeUrl('https://x.example/%2')` (truncated) throws ✓
- Behavioural: `deny path_pattern:/admin` → DENY `denied_by_rule` on `/%61dmin` ✓
- Action with `%G0` → reason `normalization_error` ✓
- Non-recursive: `/foo%2541` does NOT collapse to `/fooA` (single-pass only) ✓

### [I8-3] Malformed known-kind rules → unknown_rule fail-closed — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/effective-scope.ts` (pre-fix) — persisted `cidr` rule `8.8.8.0/bad` (or any malformed cidr/ip) returned the original string and landed as a `cidr`/`ip` rule that never matched. Overlapping allow could permit traffic the deny was meant to block.

**Source-level fix verified:** `packages/scope-engine/src/effective-scope.ts:73-124`:
- `materializeStrict` now returns `NormalizedRule | null`.
- `ip` case (lines 111-118): try `normalizeIp`; throw → return null.
- `cidr` case (lines 120-123): `canonicalizeCidrStrict` validates slash position, prefix digit-only, prefix range (0-32 IPv4, 0-128 IPv6), and IP parse; returns null on any failure.
- `decodeRule` at line 52-53: if `materializeStrict` returns null, falls through to the `unknown_rule` fail-closed branch (lines 56-62) which forces `effect: 'deny'` regardless of caller's effect.

**Probe reproduction:** `probeI8_3` (4 cases):
- `ip: 'not-an-ip'` (effect:'allow') → lands in `denyRules` as `unknown_rule` with `effect:'deny'` ✓
- `cidr: 'not-cidr'` → unknown_rule deny ✓
- `cidr: '8.8.8.0/bad'` → unknown_rule deny ✓
- `cidr: '192.168.0.0/64'` (IPv4 prefix overflow) → unknown_rule deny ✓

All 4 cases confirm: malformed known-kind rules NEVER end up in `allowRules` and ALWAYS land in `denyRules` with `effect: 'deny'`. The fail-closed contract is honored.

---

## Regression check

- **Engine purity**: 0 forbidden imports across `packages/scope-engine/src/**/*.ts` ✓
- **gitnexus_detect_changes**: 20 changed files, 0 changed_symbols, 0 affected_processes, risk=LOW ✓
- **All iter-3..7 codex-fix probes still PASS** in iter-8 (67 prior + 14 new = 81/0 cumulative)
- **Sprint 5 baseline 566 PG → 894** (+328 new). No engine-side regressions.
- **AUDIT_ACTIONS** unchanged at 28 entries.
- **DECISION_REASONS** still 17 entries (`tool_not_in_catalog` was already in the closed set from earlier rounds).
- **No new migration. No new external dep.**

---

## §7 cumulative results table

| Surface | iter-7 | **iter-8 (PASS)** |
|---|---|---|
| `bun run lint` | 0 errors | 0 errors ✓ |
| `bun run typecheck` | clean | clean ✓ |
| `bun test` no-DB | 725/209-skip/0-fail | **733/209-skip/0-fail** (+8) |
| `DATABASE_URL=… bun test` | 886/0 on re-run | **893/1-flake** full / 11/0 isolated |
| Engine-purity grep | 0 forbidden | 0 forbidden ✓ |
| Independent probe | 67/0 | **81/0** (round-5 added 14 new) |

---

## Notes for team-lead

1. **Codex round-6 recommended.** Per "iterate until silent" protocol. Run `codex review --uncommitted --title "Sprint 6 final-5"`. Convergence signal: 4→6→4→4→3 findings per round; round-5 was the smallest. If round-6 returns silent → commit. If findings → iter-9.

2. **A-Proj-1 flake is now reproducible across multiple runs in this session** (vs iter-7 where it appeared on first run only). The flake is non-deterministic; generator and evaluator measurements can disagree on a given run. Regardless, it's pre-existing, NOT in scope-engine, NOT introduced by iter-8. Lead-tracked for follow-up.

3. **Probe artifact at 81/0 cumulative.** `.harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts` covers all 5 codex rounds (16+14+16+4 sanity+17+14 = 81 assertions). Permanent regression artifact.

4. **Catalog is now strictly authoritative for `tool_invoke`.** Future fixtures/tests must seed `toolCatalog` for tool_invoke actions or they'll exit with `tool_not_in_catalog`. Codex round-5 found that 3 prior tests had relied on the loose path; generator updated them to seed catalog. The catalog-source-of-truth invariant is now enforced at decide.ts:442-456.

5. **Path-decoding contract.** Single-pass non-recursive decode of unreserved chars; reserved chars stay encoded (uppercase hex per RFC §6.2.2.1); malformed encoding throws → action gets `normalization_error`. Documented in code at normalize/url.ts:62-71.

6. **Mempalace pitfall #9 amendment** (now spans 5 codex rounds):
   > Codex semantic-security review at sprint boundaries is RECURSIVE. Sprint 6 took 5+ codex rounds (4+6+4+4+3 = 21 findings; iter count: 8). Convergence signal: round-by-round finding count trended 4→6→4→4→3 (suggesting saturation). Rule: NEVER commit on a single codex pass — iterate until codex returns SILENT. Plus: independently measure all gates; generator self-report is helpful but not authoritative; flakes can vary across sessions/runs.

---

## Files I produced (cumulative session)

- `.harness/cyberstrike-hybrid/sprint-6-codex-fixes-result.md` — iter-3 PASS verdict (round-1).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-4-result.md` — iter-4 PASS verdict (round-2).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-5-result.md` — iter-5/6 PASS verdict (round-3 + lint fix-of-fix).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-7-result.md` — iter-7 PASS verdict (round-4).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-8-result.md` — this iter-8 PASS verdict (round-5).
- `.harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts` — 81-assertion cumulative probe.
- mempalace diary entries (evaluator wing).

---

## Final verdict: **PASS**

All 3 codex round-5 findings (I8-1 uncatalogued-tool-deny, I8-2 percent-encoded-path-normalization, I8-3 malformed-rule-fail-closed) closed and source-verified. No engine regression. Recommend lead run codex round-6 review and proceed to mempalace + commit + gitnexus analyze + sprint shutdown if codex returns silent.
