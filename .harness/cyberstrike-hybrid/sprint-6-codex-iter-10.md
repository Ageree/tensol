# Sprint 6 — Codex Fixes (iter-10)

> Generator: post-codex iter-10 (1 P1 + 2 P2)
> Date: 2026-04-28
> Baseline: iter-9 PASS (PG 903/0). Codex round-7 caught 3 new findings.

---

## Fixes applied

### Fix #1 (P1) — High-impact gate compares target IDs, not canonical refs

**Files:**
- `packages/scope-engine/src/types.ts`
- `packages/scope-engine/src/decide.ts`
- `apps/api/src/scope-engine/build-scope.ts`

**Bug:** `verifiedTargetRefs.has(...assessmentRefs)` operates on canonical
refs (a Set). When a verified URL target `https://example.com/` produces
canonical `example.com` AND an unverified `domain=example.com` target
also canonicalizes to `example.com`, set deduplication hides the unverified
target. Gate passed silently — high-impact tool allowed despite an
unverified assessment target.

**Fix:**
- New optional `assessmentTargetIds` and `verifiedTargetIds` fields on
  `AssessmentFlags`.
- `decide.evaluateToolPolicy` now uses ID-set inequality
  (`![...assessmentTargetIds].every((id) => verifiedTargetIds.has(id))`)
  as the primary all-targets-verified gate. The legacy ref-set check is
  retained as a belt-and-suspenders fallback for callers that omit ID
  sets.
- `build-scope.ts` populates both ID sets from the same
  `verifiedTargetRows` query that already produced `ownershipVerifiedTargetIds`.
  Purely additive, no migration.

**Tests:** `decide.test.ts` 3 new cases — collision URL+domain with only
URL verified → DENY; both verified → gate passes; 2 distinct refs both
verified → gate passes (sanity).

### Fix #2 (P2) — Legacy `{domain, matchSubdomains}` payload translates instead of falling closed

**File:** `packages/scope-engine/src/effective-scope.ts`

**Bug:** Sprint-5-era persisted `domain`/`subdomain` rows used `{domain: '...'}`
instead of the strict `{pattern}` / `{parent}` shape. Strict zod parse
failed → `unknown_rule` deny coercion. Existing legitimate `allow domain`
rules suddenly DENIED everything they used to permit (backward-compat
regression).

**Fix:** New `translateLegacyPayload(ruleKind, payload)` helper runs
BEFORE `strictScopeRuleSchema.safeParse`. For `domain` rows missing
`pattern` but having a string `domain`, rewrites to
`{pattern: payload.domain, matchSubdomains: payload.matchSubdomains ?? false}`.
Same translation for `subdomain` (`domain` → `parent`). Forward shape
wins when both are present.

**Tests:** `effective-scope.test.ts` 4 new cases — legacy domain,
legacy subdomain, both forms present (forward wins), neither present
(unknown_rule).

### Fix #3 (P2) — Inverted / zero-length `time_window` → unknown_rule

**File:** `packages/scope-engine/src/effective-scope.ts`

**Bug:** `time_window` rule with `start >= end` (or unparseable datetimes)
materialized as a normal rule whose `inWindow()` is always false → deny
never fires. Overlapping allow could permit traffic the deny was meant to
block.

**Fix:** `materializeStrict` for `time_window` now parses both bounds and
returns `null` when either is `NaN` or `start >= end`. `decodeRule`
routes null to the `unknown_rule` fail-closed branch (effect:'deny').
Mirrors iter-8 ip/cidr and iter-9 url_prefix patterns.

**Tests:** `effective-scope.test.ts` 4 new cases — inverted deny → unknown_rule,
zero-length → unknown_rule, inverted allow → unknown_rule deny (still
fail-closed), valid range still parses normally.

---

## Verification (fresh shell)

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **753 / 209 skip / 0 fail** (+11 vs iter-9 742) |
| `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` | PASS — **914 / 0 fail** (+11 vs iter-9 903; final clean run after one transient p95-oracle timeout under heavy contention) |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | risk=low, 0 changed_symbols, 0 affected_processes |

All §5-surface files ≥ 80% func+lines (no regression).

---

## Files touched

- `packages/scope-engine/src/types.ts` — `assessmentTargetIds` + `verifiedTargetIds` on `AssessmentFlags`.
- `packages/scope-engine/src/decide.ts` — ID-set primary gate; legacy ref-set fallback retained.
- `packages/scope-engine/src/decide.test.ts` — +3 iter-10 ID-vs-ref dedup tests.
- `packages/scope-engine/src/effective-scope.ts` — `translateLegacyPayload` helper; time_window range validation in `materializeStrict`.
- `packages/scope-engine/src/effective-scope.test.ts` — +8 iter-10 tests (legacy domain/subdomain + time_window range).
- `apps/api/src/scope-engine/build-scope.ts` — populate both ID sets.

Total: 6 files modified. No new files. No schema migration. No new dep.

---

## Notes for evaluator

1. **Target-ID gate is dominant when populated.** Callers that supply both
   `assessmentTargetIds`/`verifiedTargetIds` AND legacy refs use the ID
   gate. Callers that only supply refs still get the iter-9 ref-based
   coverage (for unit-test ergonomics). The build-scope adapter now
   always supplies both.

2. **Legacy payload translation is single-pass and forward-aware.** A row
   with both `domain` and `pattern` keys keeps `pattern` (the forward
   shape). Rows with neither fall through to unknown_rule. Subdomain rows
   follow the same rule.

3. **Time_window range check happens AFTER zod parse.** Zod accepts any
   string for start/end (per the existing schema). Range validity is a
   semantic invariant enforced by `materializeStrict` returning null —
   `decodeRule` then routes to `unknown_rule` deny.

4. **Round cadence:** r1=4 / r2=6 / r3=4 / r4=4 / r5=3 / r6=4 / r7=3.
   Cumulative 28 findings fixed across iter-3 through iter-10. Trend
   suggests convergence is close.

5. **Pre-existing A-Proj-1 flake** continues to be lead-tracked. Final
   PG run was clean.
