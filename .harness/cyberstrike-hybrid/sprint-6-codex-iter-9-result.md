# Sprint 6 — Codex iter-9 Evaluator Verdict

> Evaluator: evaluator (cyberstrike-sprint-6-fixes team, single session)
> Verified against: `.harness/cyberstrike-hybrid/sprint-6-codex-iter-9.md` (generator iter-9 self-report) + 4 codex round-6 findings (1 P1 + 3 P2)
> Repo state: HEAD `9f5a732` + uncommitted Sprint 6 working tree
> Date: 2026-04-28

---

## Final verdict: **PASS** — codex round-6 closure verified

All 4 codex round-6 findings (1 P1 + 3 P2) closed and source-verified at file:line. **PG 903/0 on first run** (clean — no A-Proj-1 flake this session, matches generator). No engine regression.

This is round-6 of the recursive codex review cycle. Sprint 6 cumulative: **25 semantic security defects across 6 rounds** (4+6+4+4+3+4). Round cadence: 4→6→4→4→3→4 — rebounded slightly after round-5's low. Convergence not yet reached; round-7 needed to confirm saturation.

---

## Iteration timeline (cumulative)

| Iter | Verdict | PG | Round findings |
|---|---|---|---|
| iter-2 | PASS (codex r-1) | 833/0 | 4 |
| iter-3 | PASS (codex r-2) | 846/0 | 6 |
| iter-4 | PASS (codex r-3) | 862/1-flake | 4 |
| iter-5/6 | PASS (lint fix-of-fix) | 876/0 | r-3 closure |
| iter-7 | PASS (codex r-4) | 886/0 on re-run | 4 |
| iter-8 | PASS (codex r-5) | 893/1-flake / 11/0 isolated | 3 |
| **iter-9** | **PASS (codex r-6)** | **903/0** | 4 |

Cumulative: 566 PG (Sprint 5 floor) → **903** (+337 new tests across 6 codex rounds, 9 iterations).

---

## §7 verification matrix (iter-9)

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors, 94ms |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **742 / 209 skip / 0 fail** (matches generator's claim) |
| `DATABASE_URL=… bun test` | PASS — **903 / 0 fail** on first run (no A-Proj-1 flake this session — matches generator exactly) |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | PASS — 20 files, 0 changed_symbols, 0 affected_processes, risk=LOW |
| Independent codex-fix probe | PASS — **92 / 0** (cumulative round-1+2+3+4+5+6: 16+14+16+4 sanity+17+14+11) |

### Probe regression note (iter-9 broke 2 prior probes — by design)

Iter-9 fix #1 (all-targets-verified) tightened the high-impact gate. Two prior probe fixtures became stale because they used `assessmentTargetRefs={refX,refY}` with `verifiedTargetRefs={refX}` only — pre-iter-9 this was an ALLOW path; post-iter-9 it correctly DENIES because refY is unverified. Updated both:

- `P1-C(c)`: changed fixture to `assessmentTargetRefs={refX}, verifiedTargetRefs={refX}` (still tests the original fix, with the iter-9 tightening preserved).
- `I4-4`: added `port:443` allow rule (iter-9 fix #2 made effectivePort coverage required for default-port URLs); the test still verifies normalized URL canonical form matches verifiedRefs.

Both updates preserve the original probe intent while accommodating the new (correct) deny-path.

---

## Codex round-6 finding verification — file:line evidence + probe reproduction

### [I9-1] All assessment targets must be verified for high-impact tools — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/decide.ts:evaluateToolPolicy` (pre-fix) — `verifiedIds.size === 0` was the only zero-trust failure. With ANY unverified target on the assessment, the gate could pass — especially for opaque/CIDR targetRefs that don't exact-match `assessmentTargetRefs`. Product-spec invariant #4 requires ALL assessment targets verified.

**Source-level fix verified:** `packages/scope-engine/src/decide.ts:196`:
```
![...assessmentRefs].every((r) => verifiedRefs.has(r))
```
Runs BEFORE the per-target check (line 196 vs the per-target loop further down) so opaque/CIDR action targetRefs cannot bypass it. Product-spec §1.1 invariant #4 enforced.

**Probe reproduction:** `probeI9_1` (3 sub-assertions):
- (a) 1-of-2 assessment targets verified, action targets the verified one → DENY (the OTHER target is unverified, gate fires globally) ✓
- (b) 2-of-2 verified → ALLOW ✓
- (c) Opaque action targetRef + 1-of-2 verified → DENY (opaque ref doesn't bypass since gate fires before per-target check) ✓

### [I9-2] effectivePort in allowCoversAllDimensions — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/decide.ts:allowCoversAllDimensions` (pre-fix) — port-dimension check only triggered on `target.port`. Default-port URLs (`https://x/` → effectivePort=443, port=undefined) bypassed port-dimension coverage entirely.

**Source-level fix verified:** `packages/scope-engine/src/decide.ts:282`:
```
(target.effectivePort !== undefined || target.port !== undefined) && ...
```
Trigger now fires on either port form. Coverage check requires `port` or `url_prefix` rule.

**Probe reproduction:** `probeI9_2` (3 sub-assertions):
- (a) `https://x.example/` (effectivePort=443, port=undefined) WITHOUT `port:443` allow → DENY `no_matching_allow_rule` ✓
- (b) `https://x.example:443/` (effectivePort=443) WITHOUT `port:443` allow → DENY ✓
- (c) Add `port:443` allow → both URL forms ALLOW ✓

### [I9-3] unknown_rule_default_deny diagnostic — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/decide.ts` deny step (pre-fix) — when ALL matched deny rules were `unknown_rule` sentinels, the engine returned generic `denied_by_rule`. Audit consumers couldn't distinguish "real deny rule fired" vs "fallback caught unknown rule".

**Source-level fix verified:** `packages/scope-engine/src/decide.ts:536`:
```
reason: allUnknown ? 'unknown_rule_default_deny' : 'denied_by_rule',
```
ALL-unknown → `unknown_rule_default_deny`; any real rule mixed in → `denied_by_rule` (real-rule diagnostic wins; more specific). `matchedDenyRuleIds` always preserved.

**Probe reproduction:** `probeI9_3` (2 sub-assertions):
- (a) Persisted `{ruleKind:'future_rule', effect:'deny'}` only, action `tcp_connect 8.8.8.8:443` → reason `unknown_rule_default_deny`, matchedDenyRuleIds includes `unk-1` ✓
- (b) Mixed `{future_rule}` + `{port:443 deny}`, action denies on port → reason `denied_by_rule`, matchedDenyRuleIds includes BOTH `unk-1` and `deny-port` (real-rule diagnostic wins) ✓

### [I9-4] Malformed url_prefix → unknown_rule fail-closed — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/effective-scope.ts` (pre-fix) — `url_prefix` rule with malformed prefix (`example.com/admin` no scheme) was preserved as a no-op `url_prefix` rule. Overlapping allows could permit traffic the deny was meant to block.

**Source-level fix verified:** `packages/scope-engine/src/effective-scope.ts:url_prefix` branch in `materializeStrict` — when `normalizeUrl(prefix)` throws, `materializeStrict` returns null. `decodeRule` (line 52) routes null to `unknown_rule` fail-closed branch with `effect: 'deny'`. Mirrors iter-8 ip/cidr pattern.

**Probe reproduction:** `probeI9_4` (3 cases):
- (a) `url_prefix: 'example.com/admin'` (no scheme) → unknown_rule, effect:'deny', in denyRules ✓
- (b) `url_prefix: 'not://valid::url'` (malformed) → unknown_rule deny ✓
- (c) Sanity: valid `url_prefix: 'https://example.com/admin'` still parses as `url_prefix` (NOT unknown_rule) ✓

---

## Regression check

- **Engine purity**: 0 forbidden imports across `packages/scope-engine/src/**/*.ts` ✓
- **gitnexus_detect_changes**: 20 changed files, 0 changed_symbols, 0 affected_processes, risk=LOW ✓
- **All iter-3..8 codex-fix probes still PASS** in iter-9 (81 prior + 11 new = 92/0 cumulative; 2 fixture updates required for the gate-tightening, both updated to preserve original test intent)
- **Sprint 5 baseline 566 PG → 903** (+337 new). No engine-side regressions.
- **AUDIT_ACTIONS** unchanged at 28 entries.
- **DECISION_REASONS** still 17 entries (`unknown_rule_default_deny` was already in the closed set; iter-9 just routes more cases to it).
- **No new migration. No new external dep.**

---

## §7 cumulative results table

| Surface | iter-8 | **iter-9 (PASS)** |
|---|---|---|
| `bun run lint` | 0 errors | 0 errors ✓ |
| `bun run typecheck` | clean | clean ✓ |
| `bun test` no-DB | 733/209-skip/0-fail | **742/209-skip/0-fail** (+9) |
| `DATABASE_URL=… bun test` | 893/1-flake (893→11/0 isolated) | **903/0** clean first run ✓ |
| Engine-purity grep | 0 forbidden | 0 forbidden ✓ |
| Independent probe | 81/0 | **92/0** (round-6 added 11 new) |

---

## Notes for team-lead

1. **Codex round-7 recommended.** Round cadence 4→6→4→4→3→4 — round-5 dipped to 3 then round-6 rebounded to 4. Convergence not yet confirmed. Run `codex review --uncommitted --title "Sprint 6 final-6"`. If silent → commit. If findings → iter-10.

2. **High-impact gate is now strictly all-targets-verified.** Per product-spec §1.1 invariant #4. Any future change that allows partial-verification high-impact actions breaks the invariant. Documented in code at decide.ts:196.

3. **effectivePort is the canonical port dimension for coverage.** `target.port` is only set for explicit-port URLs OR `tcp_connect`. Default-port URLs (`https://x/`) populate `effectivePort` only. Future tests for default-port URL coverage MUST include `port` (or `url_prefix`) allows.

4. **`unknown_rule_default_deny` is now a distinguishable audit diagnostic.** SOC tooling can filter forward-compat fallback events vs real-rule denies. Mempalace pitfall recorded.

5. **No A-Proj-1 flake this iter.** Both iter-9 PG runs clean (903/0). Generator's first-run/re-run pattern aligns with mine. The flake is non-deterministic (varies by timing/load). Lead-tracked for follow-up.

6. **Probe artifact at 92/0 cumulative.** `.harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts` covers all 6 codex rounds with 92 assertions. Permanent regression artifact.

7. **Mempalace pitfall #9 amendment** (now spans 6 codex rounds):
   > Codex semantic-security review at sprint boundaries is RECURSIVE. Sprint 6 took 6+ codex rounds (4+6+4+4+3+4 = 25 findings; iter count: 9). Convergence: round cadence 4→6→4→4→3→4. Rule: NEVER commit on a single codex pass — iterate until codex returns SILENT. Iter-9 introduced new invariants: (a) all-assessment-targets-verified for high-impact, (b) effectivePort coverage, (c) unknown_rule_default_deny distinguishable diagnostic, (d) malformed-rule fail-closed extends to url_prefix.

---

## Files I produced (cumulative session)

- `.harness/cyberstrike-hybrid/sprint-6-codex-fixes-result.md` — iter-3 PASS verdict (round-1).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-4-result.md` — iter-4 PASS verdict (round-2).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-5-result.md` — iter-5/6 PASS verdict (round-3 + lint fix-of-fix).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-7-result.md` — iter-7 PASS verdict (round-4).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-8-result.md` — iter-8 PASS verdict (round-5).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-9-result.md` — this iter-9 PASS verdict (round-6).
- `.harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts` — 92-assertion cumulative probe.
- mempalace diary entries (evaluator wing).

---

## Final verdict: **PASS**

All 4 codex round-6 findings (I9-1 all-targets-verified, I9-2 effectivePort coverage, I9-3 unknown_rule_default_deny diagnostic, I9-4 malformed url_prefix fail-closed) closed and source-verified. No engine regression. Recommend lead run codex round-7 review and proceed to mempalace + commit + gitnexus analyze + sprint shutdown if codex returns silent.
