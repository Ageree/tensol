# Sprint 6 — Codex Fixes (iter-9)

> Generator: post-codex iter-9 (1 P1 + 3 P2)
> Date: 2026-04-28
> Baseline: iter-8 PASS (PG 894/0). Codex round-6 caught 4 new findings.

---

## Fixes applied

### Fix #1 (P1) — All assessment targets must be verified for high-impact tools

**File:** `packages/scope-engine/src/decide.ts`

**Bug:** `verifiedIds.size === 0` was the only zero-trust failure. With ANY
unverified target on the assessment, the gate could pass — especially for
opaque/CIDR targetRefs that don't exact-match `assessmentTargetRefs`.
Product-spec invariant #4 requires ALL assessment targets verified.

**Fix:** When `highImpact === true` AND `declared`, additionally check
`![...assessmentRefs].every((r) => verifiedRefs.has(r))` — fail closed if
any assessment target ref is not also a verified ref. This runs BEFORE the
per-target check so opaque/CIDR action targetRefs don't bypass it.

**Tests:** `decide.test.ts` 3 new cases — 1-of-2 verified (DENY), 2-of-2
verified (ALLOW), opaque CIDR action targetRef + 1-of-2 verified (DENY).

### Fix #2 (P2) — `effectivePort` in `allowCoversAllDimensions`

**File:** `packages/scope-engine/src/decide.ts`

**Bug:** `normalizeUrl` populated `effectivePort` for default-port-elided
URLs (e.g. `https://x/` → effectivePort=443) but `allowCoversAllDimensions`
only checked `target.port`. Default-port URLs bypassed port-dimension
coverage.

**Fix:** Coverage check now triggers on
`(target.effectivePort !== undefined || target.port !== undefined)`. Port
restrictions apply to both elided and explicit-port URL forms uniformly.

**Tests:** `decide.test.ts` 3 new cases — `https://x/` denied without
port allow, `https://x:443/` denied without port allow, both ALLOW with
`port:443` allow added. Existing `SSRF-2`, `R2`, `R3`, redirect-all-in-scope
fixtures updated to include `port:443` allow rule.

### Fix #3 (P2) — Unknown_rule deny → `unknown_rule_default_deny` diagnostic

**File:** `packages/scope-engine/src/decide.ts`

**Bug:** When deny matches were entirely unknown_rule sentinels, the
return reason collapsed to generic `denied_by_rule`. Audit consumers
couldn't tell "real deny rule fired" vs "fallback caught unknown rule".

**Fix:** Inspect the matched deny rules' kinds. If ALL are `'unknown_rule'`,
return `reason: 'unknown_rule_default_deny'`. Mixed (any real rule + any
unknown) keeps `'denied_by_rule'` (real rule fired; that's the more
specific diagnostic). `matchedDenyRuleIds` always preserved.

**Tests:** `decide.test.ts` — existing `legacy-shape rule with out-of-set
ruleKind denies` and `codex P2 — unknown rule persisted with effect:allow`
updated to expect `unknown_rule_default_deny`. New `iter-9 P2 — mixed
unknown+real deny matches → real-rule diagnostic wins` covers the mixed
path.

### Fix #4 (P2) — Malformed `url_prefix` rules → `unknown_rule`

**File:** `packages/scope-engine/src/effective-scope.ts`

**Bug:** `url_prefix` rule with malformed prefix (`example.com/admin` no
scheme) was preserved as a no-op `url_prefix` rule. Overlapping allows
permitted traffic the deny was meant to block.

**Fix:** Mirror iter-8 P2 pattern for ip/cidr — when `normalizeUrl(prefix)`
throws, `materializeStrict` returns null. `decodeRule` routes null to the
`unknown_rule` fail-closed branch (effect:'deny').

**Tests:** `effective-scope.test.ts` 3 cases — un-normalizable URL prefix
→ unknown_rule, no-scheme prefix → unknown_rule, valid prefix still parses
normally. Existing `url_prefix with un-normalizable URL preserves raw
prefix` test replaced (old behavior was the bug).

---

## Verification (fresh shell)

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **742 / 209 skip / 0 fail** (+9 vs iter-8 733) |
| `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` | PASS — **903 / 0 fail** (+9 vs iter-8 894; pre-existing A-Proj-1 flake on first run, clean on re-run) |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | risk=low, 0 changed_symbols, 0 affected_processes |

All §5-surface files ≥ 80% func+lines (no regression).

---

## Files touched

- `packages/scope-engine/src/decide.ts` — all-targets-verified gate, effectivePort coverage, unknown_rule_default_deny diagnostic.
- `packages/scope-engine/src/decide.test.ts` — +7 iter-9 tests; 4 existing tests updated for new port/diagnostic semantics.
- `packages/scope-engine/src/effective-scope.ts` — url_prefix returns null on normalize failure (falls through to unknown_rule).
- `packages/scope-engine/src/effective-scope.test.ts` — +3 iter-9 url_prefix tests; 1 legacy test replaced.

Total: 4 files modified. No new files. No schema migration. No new dep.

---

## Notes for evaluator

1. **All-targets-verified is the dominant high-impact rule.** With
   `assessmentRefs` populated, the engine no longer accepts ANY unverified
   target on the assessment. `ownershipVerifiedTargetIds` size check (>0)
   stays as the precondition. Per-target action-ref check is retained
   belt-and-suspenders but is largely redundant when `assessmentRefs` is
   provided.

2. **effectivePort is the canonical port dimension for coverage** —
   `target.port` only fires when the URL was explicit OR the target is
   `tcp_connect`. Tests asserting on default-port URLs now MUST include a
   `port` (or `url_prefix`) allow.

3. **`unknown_rule_default_deny` is now distinguishable from `denied_by_rule`**
   in audit metadata and decision shape. Audit consumers/SOC tooling can
   filter for forward-compat fallback events vs real-rule events.

4. **Pre-existing A-Proj-1 flake** appeared on first run, clean on re-run.
   Lead-tracked for follow-up sprint.
