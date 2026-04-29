# ADR 0006 — Scope Engine: Effective Scope, Normalization, Enforcement

**Status:** Accepted (Sprint 6)
**Date:** 2026-04-28
**Drivers:** Generator (drafter), Evaluator (reviewer)
**Supersedes:** —
**Related:** ADR 0005 (Assessment State Machine), ADR 0004 (Auditability)

## Context

Sprint 5 stored scope rules; Sprint 6 evaluates them. The scope engine is the single source of truth for allow/deny decisions and is consumed by the API (now), coordinator pre-enqueue (Sprint 7), worker pre-execution (Sprint 9), validator replay (Sprint 10), and the report-publication guard (Sprint 12). Coordinator/worker/validator do not get to invent their own rules — they call `decide()` with the same `EffectiveScope` shape the API uses.

The engine MUST stay pure. Coordinator and worker processes will run in private namespaces under tightened egress; embedding `dns`/`fs`/`net` imports inside the engine package would bind it to a specific runtime and undermine future workers (browser worker on Playwright; cyberstrike worker in a sandbox).

## Decisions

**D1. Deny overrides allow.** A two-pass evaluator: every applicable deny rule fires first; if any matches → `allowed=false`. Allow rules are evaluated only if zero denies match. Conflicting overlapping rules (e.g. deny `cidr:10.0.0.0/8` + allow `cidr:10.1.0.0/16`) resolve to deny without exception.

**D2. Unknown rule kind → default deny.** Forward-compat: a persisted `assessment_scope_rules` row whose `rule_kind` is outside the 16-closed-set is mapped to a synthetic `unknown_rule` with effect=deny. Surfaces in `matchedDenyRuleIds` with the rule's id and `reason='unknown_rule_default_deny'`. Sprint 5 IT seeded rows with custom kinds; A-SE-Compat-1 verifies they decode and deny.

**D3. Platform metadata-IP guard default-on.** Cloud IMDS endpoints (`169.254.169.254/32`, `100.100.100.200/32`) are blocked by default with `metadata_ip_blocked`. Override requires both an explicit `ip` allow rule naming the address AND a `platformPolicy.allowMetadataIpExplicit=true` flag. The flag has no API surface to flip in this slice (Phase 9). The same default-on pattern applies to private/loopback/link-local IPs — explicit `ip` or `cidr` allow required to permit access.

**D4. DNS resolution via injected interface.** The engine declares `interface DnsResolver { resolveA(host); resolveAAAA(host) }` and never imports `node:dns`. The API ships `apps/api/src/scope-engine/dns-resolver.ts` (production wrapper around `node:dns/promises`) and an in-memory test resolver. Coordinator and worker processes will inject their own resolvers in Sprint 7+.

**D5. Audit deny event shape.** Every `decide` call that returns `allowed=false` from the API endpoint emits exactly one audit row with `action='scope.validate.denied'`, `outcome='denied'`, attribution per CF-8, `metadata = { reason, matchedDenyRuleIds, matchedAllowRuleIds, actionKind, normalizedTarget }`. `allowed=true` emits no audit row (read-only success; volume control). The 27th enumerated emission point is added to `c29-delta` regression.

**D6. Time window is half-open `[start, end)`.** Five boundary points tested per window (start-1ms, start, end-1ms, end, end+1ms). Clock is an injected interface mirroring `DnsResolver`; the engine never reads `Date.now()` directly. R2 — sequential `decide()` calls produce no retroactive mutation of a prior call's `Decision` object. R3 — the `[start, end)` convention is pinned in the engine and asserted in tests.

**D7. Mixed-script host default-deny.** OQ-8. Hosts whose labels contain mixed Latin + non-Latin scripts (Cyrillic-Latin homograph) are flagged via `hostHasMixedScript` and denied with `mixed_script_host_blocked` unless an explicit `domain` allow names the punycode form. Pure non-Latin (Cyrillic-only, CJK-only) is fine; only intra-label mixing is flagged.

**D8. IPv6 zone-id stripped from canonical.** R4. `normalizeIp(input)` returns `{canonical, zoneId?}`. Canonical does not include `%eth0`. Rule matchers (`ip`, `cidr`) compare against canonical only; `fe80::1%eth0` cannot smuggle past a deny on `fe80::1`.

**D9. Strict ScopeRule schema is additive.** Sprint 5's `scopeRuleSchema` (open record payload) stays — Sprint 5 callers (`assessmentCreateSchema`, `assessmentPatchSchema`) continue to use it for backward compat. Sprint 6 adds `strictScopeRuleSchema` (discriminated union over 16 ruleKinds). Persisted Sprint 5 rows whose ruleKind is outside the 16-set decode via the legacy schema → engine maps to `unknown_rule` (D2). New write paths (Sprint 6+) use the strict union.

## Consequences

- Coordinator (Sprint 7) imports `decide()` directly without parallel state graph; its DNS resolver injects with the same interface.
- Workers (Sprint 9) get the same `decide()` for pre-execution checks.
- Validator (Sprint 10) replays via `decide()` before re-running candidates.
- Report builder (Sprint 12) refuses publication of findings whose target falls outside effective scope.
- The 7 high-impact tool category gate stays consistent: if action's `tool_category` ∈ {`c2`,`post_exploit`,`ad`,`credential_audit`} and the assessment hasn't declared it, deny via `tool_category_high_impact_unverified_targets`.
- `RateLimitCounter` is in-process (per-bucket token bucket). Sprint 7+ may swap to Redis-backed; the engine doesn't change.

## Alternatives considered

- **DNS-as-direct-import** (rejected). Violates the I/O-free invariant. Browser worker and Playwright sandbox don't ship `node:dns`; engine couldn't be reused.
- **Allow overrides deny** (rejected). Spec §1.3 binds high-impact tooling to verified ownership; an "allow wins" engine would let an over-granted allow rule subvert that. Deny-overrides-allow is the conservative posture.
- **Unknown-rule-default-allow** (rejected). Forward-compat security risk: a typo in a persisted `rule_kind` would silently disable the rule. Default-deny fails closed.
- **Replace ScopeRule schema** (rejected, OQ-1). Sprint 5 IT created rows with arbitrary `rule_kind` strings + record payloads. Replacing `scopeRuleSchema` would force a migration sweep over those rows; additive `strictScopeRuleSchema` lets the engine evolve without breaking persisted state.
- **Sync `decide()` with caller pre-resolution** (rejected, OQ-2). Pre-resolving DNS at the call site would push I/O concerns into every consumer. Async + injected resolver keeps the engine pure and the call sites uniform.

## Test evidence

- **R1.** `RULE_KINDS.size === 16`; per-kind ≥1 positive + ≥1 negative matcher case (≥32 generated assertions).
- **R2.** Sequential `decide()` with injected Clock produces no retroactive mutation of decision #1 after decision #2 runs.
- **R3.** Half-open `[start, end)` boundary: 5-point matrix (start-1ms, start, end-1ms, end, end+1ms) → expected `{deny, allow, allow, deny, deny}`.
- **R4.** `fe80::1%eth0` action evaluates against deny rule on `fe80::1` and denies.
- **R6.** Sprint 5 IT-shape rule with custom `ruleKind` decodes via the legacy path, maps to `unknown_rule`, default-denies.
- **R7.** `tool_category` outside `TOOL_CATEGORIES` → 400 at the request boundary; engine never sees it.
- **R8.** URL property test = 1000 runs; IP property test = 200 runs; host/IDN property test = 200 runs.
- **R9.** p95 oracle test gated with `describe.skipIf(!hasDatabaseUrl())`.
- **R11.** Mixed resolution `[8.8.8.8, 192.168.1.5]` and `[192.168.1.5, 8.8.8.8]` produce identical deny decisions.
- **A-SE-Pure-1.** Walking grep over `packages/scope-engine/src/**/*.ts` finds zero forbidden imports (`dns`, `fs`, `net`, `http`, `https`, `tls`, `child_process`, `os`, `cluster`, `dgram`, `inspector`, `repl`, including `node:` prefixes).
- **A-SE-Pure-2.** `packages/scope-engine/package.json` lists only `zod` and `@cyberstrike/contracts` as runtime deps.
