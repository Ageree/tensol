# Sprint 6 — Codex Fixes (iter-3)

> Generator: post-codex P1×3 + P2×1 fixes
> Date: 2026-04-28
> Baseline: Sprint 6 PASS at iter-2 (833/0 PG) — codex review caught 4 holes evaluator missed
> Verdict status: Ready for evaluator review

---

## Summary

Codex CLI 0.125.0 review of the uncommitted Sprint 6 working tree flagged 4
security defects in the scope-engine package that the prior evaluator's
ortho-probes did not catch (PG/coverage tests passed — these are *semantic*
SSRF / privilege-escalation holes, not test/coverage gaps). All four fixed,
new tests added, full PG suite green.

---

## Fixes applied

### Fix 1 (P1) — SSRF guards now run for `tool_invoke` URL/host targetRefs

**File:** `packages/scope-engine/src/normalize/index.ts`

**Bug:** The `tool_invoke` branch parsed targetRef into `host`/`url`/`path`
fields but never invoked the injected `DnsResolver`. `resolvedIps` stayed
empty, so the platform private/metadata-IP guards in `decide.platformIpGuard`
had nothing to compare against. A `tool_invoke` against
`https://internal.example.com/` whose DNS resolved to `192.168.1.10` passed
through with matching host/tool allow rules instead of being denied by the
private-IP guard.

**Fix:** When the `tool_invoke` targetRef parses as a URL or hostname, the
normalizer now calls `deps.dns.resolveA/resolveAAAA` (mirroring the
`http_request` / `dns_lookup` / `tcp_connect` paths) and populates
`resolvedIps`. IP literals continue to short-circuit (no DNS).

**Tests added:**
- `decide.test.ts` — three new cases under `codex P1 tool_invoke SSRF guards`:
  URL targetRef → private IP → DENY private_ip_blocked; hostname → metadata
  IP → DENY metadata_ip_blocked; explicit cidr allow permits private.
- `normalize/index.test.ts` — three new cases in `tool_invoke`: URL targetRef
  resolves DNS, hostname targetRef resolves DNS, IP-literal URL skips DNS.

### Fix 2 (P1) — `highImpact` + `category` derived from tool catalog

**File:** `packages/scope-engine/src/decide.ts`

**Bug:** `evaluateToolPolicy` used the caller-supplied `target.toolCategory`
to compute `highImpact`. The catalog was checked only for `inCatalog`
membership; its `category`/`highImpact` fields were never authoritative. A
caller could mark `metasploit` (catalog: post_exploit/highImpact:true) with
`toolCategory:'web'` and bypass `HIGH_IMPACT_CATEGORIES`.

**Fix:** When `inCatalog === true`, both `category` and `highImpact` are
sourced from `scope.toolCatalog.get(toolName)`. The caller-supplied
`toolCategory` is compared against the catalog; mismatch triggers a
hard-deny with reason `tool_category_mismatch`.

### Fix 3 (P1) — Verified-ownership enforcement for declared high-impact tools

**File:** `packages/scope-engine/src/decide.ts`, `apps/api/src/scope-engine/build-scope.ts`, `packages/scope-engine/src/types.ts`

**Bug:** Even when the requested high-impact category was declared in
`assessmentFlags.highImpactCategories`, the gate stayed `true` without
consulting `ownershipVerifiedTargetIds`. Product spec §1.1 invariant #4
requires *both* declared category AND verified ownership.

**Fix:** When `highImpact === true` and category is declared:
1. Require `ownershipVerifiedTargetIds.size > 0` (else
   `high_impact_unverified_ownership`).
2. Per-target check: extended `AssessmentFlags` with optional
   `assessmentTargetRefs` and `verifiedTargetRefs` (canonical target-ref
   strings: host/url/IP). When the action's targetRef collides with an
   assessment target that is NOT in the verified set → deny with reason
   `high_impact_target_unverified`.
3. `apps/api/src/scope-engine/build-scope.ts` populates both sets from
   `targets.{kind,value,ownership_status}` rows.

### Fix 4 (P2) — Unknown rules fail closed

**File:** `packages/scope-engine/src/effective-scope.ts`

**Bug:** Out-of-set persisted rule with `effect:'allow'` was preserved as
`{kind:'unknown_rule', effect:'allow'}` and landed in `allowRules`. Even
though it never matched, it broke the deny-overrides-allow contract — an
unknown rule must default to deny.

**Fix:** `decodeRule` now forces `effect:'deny'` for any row that fails the
strict decode, sending unknown rules to `denyRules`. Combined with
`matchers.matchRule({ kind:'unknown_rule', effect:'deny' })` returning
`true` (always-applicable), unknown rules now surface in `matchedDenyRuleIds`
on every action.

**Test added:** `decide.test.ts` — `codex P2 — unknown rule persisted with
effect:allow is fail-closed and denies any action`. Confirms an
`{id:'unknown-rule-id', ruleKind:'future_rule', effect:'allow'}` row appears
in `matchedDenyRuleIds` when the action would otherwise pass with full
allow-rule coverage.

---

## New `DECISION_REASONS` enum entries

Added to `packages/contracts/src/scope-validate.ts`:

- `tool_category_mismatch` — caller-supplied toolCategory disagrees with catalog.
- `high_impact_unverified_ownership` — declared category + zero verified targets.
- `high_impact_target_unverified` — action targetRef hits an assessment target whose ownership is not verified.

The pre-existing `tool_category_high_impact_unverified_targets` reason is
retained for the "category not declared at all" branch (legacy path covered
by existing tests).

---

## Verification

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **687 / 207 skip / 0 fail** / 17311 expect |
| `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` | PASS — **846 / 0 fail** / 17883 expect |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | risk=low, 0 changed_symbols, 0 affected_processes |

Cumulative delta vs Sprint 6 iter-2 baseline (`833 / 0`):
PG: 833 → 846 (+13 new tests).
No-DB: 674 → 687 (+13).

### Per-file coverage on §5 surfaces (post-fix)

| File | Func % | Lines % |
|---|---|---|
| `packages/scope-engine/src/decide.ts` | 90.00 | 95.03 |
| `packages/scope-engine/src/effective-scope.ts` | 100.00 | 99.32 |
| `packages/scope-engine/src/normalize/index.ts` | 100.00 | 100.00 |
| `packages/scope-engine/src/normalize/host.ts` | 100.00 | 96.49 |
| `packages/scope-engine/src/normalize/ip.ts` | 100.00 | 98.95 |
| `packages/scope-engine/src/normalize/url.ts` | 100.00 | 94.37 |
| `packages/scope-engine/src/rules/matchers.ts` | 93.75 | 96.53 |
| `packages/contracts/src/scope-validate.ts` | 100.00 | 100.00 |
| `apps/api/src/routes/assessments/scope-validate.ts` | 100.00 | 98.60 |

All §5-surface files ≥ 80% / 80%. No regression.

---

## Files touched

Engine + contracts:
- `packages/scope-engine/src/normalize/index.ts` — DNS path for tool_invoke.
- `packages/scope-engine/src/normalize/index.test.ts` — +3 tests.
- `packages/scope-engine/src/decide.ts` — catalog-driven tool policy + ownership gate.
- `packages/scope-engine/src/decide.test.ts` — +5 tests (3 SSRF, 1 unknown-rule, 4 ownership/catalog).
- `packages/scope-engine/src/effective-scope.ts` — fail-closed unknown_rule.
- `packages/scope-engine/src/effective-scope.test.ts` — +1 test.
- `packages/scope-engine/src/types.ts` — `AssessmentFlags.{verified,assessment}TargetRefs`.
- `packages/contracts/src/scope-validate.ts` — +3 reasons.

API:
- `apps/api/src/scope-engine/build-scope.ts` — populate verified/assessment target ref sets.

Total: 9 files modified (no new files; the only schema delta is two optional fields on AssessmentFlags).

---

## Notes for evaluator

1. `AssessmentFlags.{verifiedTargetRefs, assessmentTargetRefs}` are *optional*
   (`?:`). Existing in-memory test fixtures that omit them continue to work
   — the per-target check short-circuits to "no per-target rule applies"
   when `assessmentTargetRefs` is undefined or empty. Only the verified-set
   non-empty check fires unconditionally on declared high-impact categories.

2. The `tool_category_high_impact_unverified_targets` reason is retained for
   the "category was never declared in highImpactCategories" path so prior
   tests (`scope-engine :: decide — tool-category high-impact gate`) keep
   their existing assertion shape.

3. The unknown_rule deny branch is reached every time a non-empty unknown_rule
   exists in scope. Existing tests that seeded unknown_rule with
   `effect:'deny'` continue to pass; the new test seeds `effect:'allow'` to
   prove the coercion path.

4. No schema migration. No new external dep.
