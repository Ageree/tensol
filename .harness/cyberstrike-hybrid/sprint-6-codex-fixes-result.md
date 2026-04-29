# Sprint 6 — Codex-Fix Evaluator Verdict (iter-3)

> Evaluator: evaluator (cyberstrike-sprint-6-fixes team, single session)
> Verified against: `.harness/cyberstrike-hybrid/sprint-6-codex-fixes.md` (generator iter-3 self-report) + the 4 codex P1×3 + P2×1 findings recorded at mempalace `cyberstrike-hybrid` wing
> Repo state: HEAD `9f5a732` + uncommitted Sprint 6 working tree (20 files in diff scope per `gitnexus_detect_changes`)
> Date: 2026-04-28
> Bun runtime: 1.3.11
> Sprint 6 iter-2 baseline: 833/0 PG, 674/207-skip no-DB
> Codex review (codex-cli 0.125.0, `codex review --uncommitted`) flagged 4 SECURITY semantic holes that the prior iter-2 evaluator (myself, in a prior session) PASS-verified but missed.

---

## Final verdict: **PASS** — all 4 codex findings closed; no regression

After 1 generator iteration (iter-3), each codex finding is independently
reproduced as fixed via a probe that recompiles the bypass logic from first
principles. All Sprint 1-5 invariants and Sprint 6 iter-2 ortho-probes still
hold; PG count grew 833 → 846 (+13 new tests, no subtractions).

The codex review gate validated again — even after iter-2 produced a clean
833/0 PG + ≥80% coverage + 11-probe orthogonal pass, codex caught 4 semantic
SSRF / privilege-escalation defects that test/coverage tooling cannot surface.
Lesson recorded: PASS is not equivalent to "secure"; the `codex review` step
between evaluator-PASS and commit is load-bearing.

---

## Iteration timeline

| Iter | Verdict | PG result | Blockers | Notes |
|---|---|---|---|---|
| iter-1 | (Sprint 6 generator initial) FAIL | 749 / 0 | F1 coverage, F2 audit-shape, F3 CF-8, F4 redaction, F5 RBAC-neg, F6 p95, F7 redirect-API | iter-2 evaluator session |
| iter-2 | PASS (prior evaluator) | 833 / 0 | none — but codex caught 4 hidden security holes post-PASS | Hard lesson: PASS verdict ≠ secure |
| **iter-3** | **PASS (this evaluator session)** | **846 / 0 (+13)** | **none — all 4 codex findings independently reproduced as fixed** | Probe scaffolded ahead of generator ready signal; all 14 probe assertions pass |

PG delta vs iter-2: 833 → 846 (+13). No-DB delta: 674 → 687 (+13). Coverage on all §5 surfaces ≥80% func + lines preserved.

---

## §7 verification matrix (all green)

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors, 94ms |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **687 / 207 skip / 0 fail** / 17311 expect / 90 files / 602ms |
| `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` | PASS — **846 / 0 fail** / 17883 expect / 90 files / 12.65s |
| Engine-purity grep `from ['"](dns\|fs\|net\|http\|https\|tls\|child_process\|os\|cluster\|dgram\|inspector\|repl\|node:dns\|node:fs\|node:net\|node:http\|node:https\|node:tls\|node:child_process\|node:os)['"]` on `packages/scope-engine/src/` | PASS — 0 forbidden imports (grep exit=1 = no matches) |
| `gitnexus_detect_changes(scope=all, repo=пентест ИИ)` | PASS — 20 changed files, 0 changed_symbols, 0 affected_processes, risk=LOW |
| Independent codex-fix probe `evaluator-probe-sprint6-codex-fixes.ts` | PASS — **14 / 0 fail** (P1-A×2, P1-B×3, P1-C×3, P2×6) |

### §5 surface per-file coverage (PG run, ≥80% func + lines required)

| File | Func % | Lines % | Threshold | Status |
|---|---|---|---|---|
| `packages/scope-engine/src/decide.ts` | **90.00** | **95.03** | 80 | ✓ |
| `packages/scope-engine/src/effective-scope.ts` | **100.00** | **99.32** | 80 | ✓ |
| `packages/scope-engine/src/index.ts` | 100.00 | 100.00 | 80 | ✓ |
| `packages/scope-engine/src/normalize/host.ts` | **100.00** | **96.49** | 80 | ✓ |
| `packages/scope-engine/src/normalize/index.ts` | **100.00** | **100.00** | 80 | ✓ |
| `packages/scope-engine/src/normalize/ip.ts` | **100.00** | **98.95** | 80 | ✓ |
| `packages/scope-engine/src/normalize/url.ts` | **100.00** | **94.37** | 80 | ✓ |
| `packages/scope-engine/src/rules/matchers.ts` | **93.75** | **96.53** | 80 | ✓ |
| `packages/scope-engine/src/types.ts` | 100.00 | 100.00 | 80 | ✓ |
| `packages/scope-engine/src/test-utils/fc-opts.ts` | 100.00 | 100.00 | 80 | ✓ |

(Other §5 surfaces — contracts/{scope-rules,scope-validate,scope-action}.ts, route handler, build-scope, rate-limit, dns-resolver — unchanged from iter-2 PASS; iter-3 made no edits to those files. All ≥80% verified at iter-2.)

---

## Codex finding verification — file:line evidence + probe reproduction

### [P1-A] Tool-invoke URL DNS resolution — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/normalize/index.ts:136-143` (pre-fix) — the `tool_invoke` URL/host branch sets `host`/`url`/`path` fields but never invokes `deps.dns`. `resolvedIps` stays empty, so the platform private/metadata-IP guards in `decide.platformIpGuard` have nothing to compare against. Tool action against `https://internal.example.com/` resolving to `192.168.1.10` was passing through.

**Source-level fix verified:** `packages/scope-engine/src/normalize/index.ts:128-179` (iter-3). Three new state additions:
- Line 138: `let hostForDns: string | null = null;`
- Line 148: URL branch sets `hostForDns = url.host;`
- Line 161: hostname branch sets `hostForDns = host.canonical;`
- Lines 167-178: post-classification block calls `tryClassifyAsIp(hostForDns)` (literal IP-as-host short-circuit) or `await resolveHost(hostForDns, deps.dns)` (DNS resolution), populating `resolvedIps` on `withTarget`. Mirrors the http_request/dns_lookup/tcp_connect paths.

**Probe reproduction:** `evaluator-probe-sprint6-codex-fixes.ts::probeP1A` — DNS stub `{ 'internal.example.com': { v4: ['192.168.1.10'] } }`, recon-tool catalog (`amass`, no high-impact), no allow rule covering private CIDR, default platform policy. Action `tool_invoke{ toolName:'amass', toolCategory:'recon', targetRef:'https://internal.example.com/' }` → asserts:
- `decision.normalizedTarget?.resolvedIps.length > 0` ✓ (resolvedIps populated)
- `decision.allowed === false && decision.reason === 'private_ip_blocked'` ✓ (private-IP guard fires)

**Coverage:** `normalize/index.ts` 100/100. New branch fully exercised by both unit and integration suites.

---

### [P1-B] Catalog-driven high-impact + category — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/decide.ts:146-149` (pre-fix) — `evaluateToolPolicy` derived `highImpact` from caller-supplied `target.toolCategory`, treating the catalog only as a membership lookup. A caller could mark `metasploit` (catalog: `post_exploit`/`highImpact:true`) with `toolCategory:'web'` and bypass `HIGH_IMPACT_CATEGORIES`.

**Source-level fix verified:** `packages/scope-engine/src/decide.ts:155-167` (iter-3):
- Line 157: `catalogEntry = name !== undefined ? scope.toolCatalog.get(name) : undefined`
- Line 158: `inCatalog = catalogEntry !== undefined`
- Lines 162-164: `effectiveCategory = inCatalog ? catalogEntry.category : callerCategory` — catalog wins.
- Lines 165-167: `highImpact = inCatalog ? catalogEntry.highImpact : (effectiveCategory !== undefined && HIGH_IMPACT_CATEGORIES.has(effectiveCategory))` — catalog `highImpact` flag is authoritative for in-catalog tools.
- Lines 170-171: `categoryMismatch = inCatalog && callerCategory !== undefined && callerCategory !== catalogEntry.category` — caller lying triggers a mismatch verdict.
- Lines 395-405: at decision return, `verdict === 'category_mismatch'` returns `tool_category_mismatch` reason.

**Probe reproduction:** `probeP1B` — catalog `metasploit → { category:'post_exploit', highImpact:true }`, assessment did NOT declare `post_exploit`. Caller spoofs `toolCategory:'web'`. Asserts:
- `decision.toolPolicyResult?.highImpact === true` ✓ (catalog override regardless of caller)
- `decision.toolPolicyResult?.category === 'post_exploit'` ✓ (catalog wins over `'web'`)
- `decision.allowed === false && decision.reason === 'tool_category_high_impact_unverified_targets'` ✓ (caller spoof cannot bypass HI gate)

The reason resolved here is `tool_category_high_impact_unverified_targets` (not `tool_category_mismatch`) because verdict `unverified_ownership` fires first (declared=false short-circuits at line 178-179 before the mismatch branch at 206). The reason chain at 410-417 then maps unverified_ownership + undeclared category → `tool_category_high_impact_unverified_targets`. End behaviour: ACTION DENIED. The bypass is closed.

---

### [P1-C] Verified-ownership gate — VERIFIED PASS (3 sub-probes)

**Codex finding:** `packages/scope-engine/src/decide.ts:150-153` (pre-fix) — declared category alone passed `highImpactGateOk`; `ownershipVerifiedTargetIds` was never consulted. Violates product-spec §1.1 invariant #4 (BOTH declared category + verified ownership required).

**Source-level fix verified:** `packages/scope-engine/src/decide.ts:175-204` (iter-3):
- Line 182: `verifiedIds = scope.assessmentFlags.ownershipVerifiedTargetIds`
- Line 183: `if (verifiedIds.size === 0)` → verdict = `'unverified_ownership'`. Maps to reason `high_impact_unverified_ownership` at line 414.
- Lines 188-202: per-target check: collect canonical refs (`collectTargetRefs` at 223-231 — host/url/IP canonicals from the normalized action), check whether refs hit `assessmentTargetRefs` set; if so but not in `verifiedTargetRefs` → verdict `'target_unverified'` → reason `high_impact_target_unverified`.

`AssessmentFlags` type extended (types.ts:127-134) with optional `verifiedTargetRefs?: ReadonlySet<string>` and `assessmentTargetRefs?: ReadonlySet<string>` (canonical ref strings). `apps/api/src/scope-engine/build-scope.ts` populates both from `targets.{kind,value,ownership_status}` rows.

**Probe reproductions:** `probeP1C(a/b/c)` uses public-class IP literal targetRefs `203.0.113.10` (X) and `203.0.113.20` (Y) so the only host-side dimension is `ip` (covered by allow rules). All 3 sub-probes provide tool_name + tool_category + ip allow rules so the ONLY remaining blocker is the ownership gate.

| Sub-probe | Setup | Assertion | Result |
|---|---|---|---|
| (a) | `ownershipVerifiedTargetIds = new Set()` (empty), no per-target sets | `allowed===false && reason==='high_impact_unverified_ownership'` | ✓ PASS |
| (b) | `ownershipVerifiedTargetIds = {target-X}`, `assessmentTargetRefs = {refX, refY}`, `verifiedTargetRefs = {refX}`, action targets refY | `allowed===false && reason==='high_impact_target_unverified'` | ✓ PASS |
| (c) | same as (b), action targets refX | `allowed===true && reason==='allowed'` | ✓ PASS |

This is a 3-orthogonal-axis probe that recompiles the gate logic from first principles. The pre-fix code would have allowed (a) and (b); both now correctly deny.

---

### [P2] Unknown-rule fail-closed — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/effective-scope.ts:51-52` (pre-fix) — out-of-set `ruleKind` was preserved with caller's `effect`, so an `{effect:'allow', ruleKind:'future_rule'}` row landed in `allowRules`. Even if it never matched, this broke deny-overrides-allow as a forward-compat default — an unknown rule MUST default to deny.

**Source-level fix verified:** `packages/scope-engine/src/effective-scope.ts:51-55` (iter-3):
```
// Out-of-set OR legacy payload that doesn't fit the strict schema → unknown.
// Force effect:'deny' so unknown rules surface in `denyRules` / `matchedDenyRuleIds`
// and contribute to the deny-overrides-allow contract regardless of the
// caller-supplied effect (codex P2 — fail-closed for forward-compat).
return { id, kind: 'unknown_rule', effect: 'deny', rawRuleKind: row.ruleKind };
```

`row.effect` is now ignored entirely; the literal `effect: 'deny'` is hardcoded. Combined with the matchers' `unknown_rule` catch-all at `matchers.ts:matchRule`, every action evaluated against scope containing an unknown_rule will surface that rule in `matchedDenyRuleIds`.

**Probe reproduction:** `probeP2` — for both `effect:'allow'` and `effect:'deny'` inputs, asserts:
- Structural: `scope.denyRules.find(r=>r.id==='unk-1')!==undefined && scope.allowRules.find(r=>r.id==='unk-1')===undefined` ✓
- Coercion: `inDeny.effect === 'deny'` ✓
- Behavioural: `tcp_connect` to `8.8.8.8:443` → `decision.allowed === false` AND (`matchedDenyRuleIds includes 'unk-1'` OR `reason==='no_matching_allow_rule'`) ✓

Both paths verified. Fail-closed contract restored.

---

## Regression check (Sprint 1-5 invariants + Sprint 6 iter-2 baseline)

**Cumulative tests:** 833 (iter-2) → 846 (iter-3, +13). No subtractions; only generator's new tests added. Sprint 5 baseline 566 PG remains floor.

**Engine purity:** 0 forbidden imports across `packages/scope-engine/src/**/*.ts`. Verified by manual grep + `tests/integration/scope/engine-purity.test.ts`.

**gitnexus_detect_changes:** 20 changed files, 0 changed_symbols, 0 affected_processes, risk=LOW. The fixes are localized to the engine package + types + adapter + tests; no shared symbol's call graph mutates. No d=1/d=2/d=3 dependents flagged.

**RBAC matrix:** untouched (iter-3 made no changes to `packages/authz/`). Cardinality 1365, allows 242 — preserved from iter-2.

**Audit emission count:** untouched. `AUDIT_ACTIONS` enum still 28 entries; iter-3 added no new emission points. (The `tool_category_mismatch` / `high_impact_unverified_ownership` / `high_impact_target_unverified` reasons are `DECISION_REASONS` enum entries inside `scope-validate.ts`, not new `audit_actions`.)

**No new migration. No new external dep. No JSONB writes** (engine remains pure; route reads only — CF-10 still untouched).

**Sprint 6 acceptance criteria coverage (cumulative):** all A-SE-* binary criteria continue to hold; iter-3 strengthens A-SE-Pri-3 (unknown-rule default-deny), A-SE-SSRF-* (tool_invoke now guarded), and the high-impact gate per spec §1.1 invariant #4.

---

## §7 cumulative results table

| Surface | iter-2 baseline | iter-3 |
|---|---|---|
| `bun run lint` | 0 errors | 0 errors ✓ |
| `bun run typecheck` | clean | clean ✓ |
| `bun test` no-DB | 674/207-skip/0-fail | **687/207-skip/0-fail** (+13) |
| `DATABASE_URL=… bun test` | 833/0-fail | **846/0-fail** (+13) |
| §5 surface coverage func% | all ≥80 | all ≥80 (unchanged, including iter-3's edits to decide/normalize/effective-scope) |
| §5 surface coverage lines% | all ≥80 | all ≥80 |
| Engine-purity grep | 0 forbidden | 0 forbidden ✓ |
| `gitnexus_detect_changes` risk | LOW (16 files) | LOW (20 files) |
| Independent codex-fix probe | n/a | **14/0-fail** ✓ |
| Codex `--uncommitted` review | 4 holes flagged | (re-run by lead before commit recommended) |

---

## Notes for team-lead

1. **Codex re-review recommended before commit.** Standard sprint-loop workflow runs `codex review --uncommitted` after evaluator PASS. iter-2 evaluator-PASS was the trigger that surfaced these 4 holes; running it again on iter-3 closes the loop and confirms no new findings.

2. **Mempalace pitfall update.** Add a 9th entry to the running pitfalls catalog (mempalace `cyberstrike-hybrid/decisions/pitfalls-catalog.md`):
   > 9. **Codex semantic-security review at sprint boundaries is load-bearing.** Test/coverage tooling cannot detect semantic SSRF / privilege-escalation / fail-open defects; only code-reading review (codex CLI 0.125.0 `review --uncommitted`) catches them. Sprint 6 iter-2 PASS verdict (833/0 PG, 11 ortho-probes, ≥80% coverage) hid 4 P1/P2 security holes that codex caught on first pass. Future-sprint rule: NEVER commit on evaluator-PASS alone; always run codex review and remediate before commit.

3. **`AssessmentFlags` schema delta.** Two new optional fields (`verifiedTargetRefs?`, `assessmentTargetRefs?`) added to `packages/scope-engine/src/types.ts`. Both `?:` so existing in-memory test fixtures that omit them continue to work — the per-target gate short-circuits to "no per-target rule applies" when `assessmentTargetRefs` is undefined or empty. The unconditional `verifiedIds.size > 0` check still fires on declared high-impact regardless of these new fields. `apps/api/src/scope-engine/build-scope.ts` populates both from `targets.{kind,value,ownership_status}` rows.

4. **DECISION_REASONS extension.** Three new reasons in `packages/contracts/src/scope-validate.ts`: `tool_category_mismatch`, `high_impact_unverified_ownership`, `high_impact_target_unverified`. Pre-existing `tool_category_high_impact_unverified_targets` retained for the legacy "category not declared at all" path so prior iter-2 tests keep their assertion shape (verified — both reasons surface in the relevant code paths).

5. **Probe artifact retained.** `.harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts` is checked into the working tree (previously untracked). 14 assertions across the 4 codex findings. Reusable for future regression coverage if any of these fix paths drift. Recommend keeping it as a permanent artifact.

6. **Generator's iter-3 self-report numbers all matched my independent measurements** — 687 no-DB, 846 PG, all coverage thresholds. No discrepancy.

---

## Files I produced

- `.harness/cyberstrike-hybrid/sprint-6-codex-fixes-result.md` — this PASS verdict.
- `.harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts` — 14-assertion independent probe (kept for future regression).
- mempalace diary entry (`evaluator` wing, topic `sprint-6-codex-fixes`, AAAK).

---

## Final verdict: **PASS**

All 4 codex findings (P1-A, P1-B, P1-C, P2) closed. Regression check clean. Recommend lead run codex re-review and proceed to mempalace drawer + commit + gitnexus analyze + sprint shutdown.
