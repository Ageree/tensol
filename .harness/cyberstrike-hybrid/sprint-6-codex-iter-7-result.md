# Sprint 6 — Codex iter-7 Evaluator Verdict

> Evaluator: evaluator (cyberstrike-sprint-6-fixes team, single session)
> Verified against: `.harness/cyberstrike-hybrid/sprint-6-codex-iter-7.md` (generator iter-7 self-report) + 4 codex round-4 findings (2 P1 + 2 P2)
> Repo state: HEAD `9f5a732` + uncommitted Sprint 6 working tree
> Date: 2026-04-28

---

## Final verdict: **PASS** — codex round-4 closure verified

All 4 codex round-4 findings (2 P1 + 2 P2) closed and source-verified at file:line. No engine regression. Single PG failure on first run was the documented pre-existing `A-Proj-1` pagination flake; PG 886/0 on re-run matches generator's claim exactly.

This is round-4 of the recursive codex review cycle. Sprint 6 cumulative codex findings: **18 semantic security defects across 4 rounds** (4 + 6 + 4 + 4).

---

## Iteration timeline (cumulative)

| Iter | Verdict | PG | Notes |
|---|---|---|---|
| iter-1 | FAIL (sprint baseline) | 749/0 | F1-F7 fixes |
| iter-2 | PASS (codex round-1: 4 findings) | 833/0 | P1×3 + P2×1 |
| iter-3 | PASS (codex round-2: 6 findings) | 846/0 | P1×5 + P2×1 |
| iter-4 | PASS (codex round-3: 4 findings) | 862/1-flake | P1×1 + P2×3 |
| iter-5 | FAIL (lint) → iter-6 PASS | 876/0 | round-3 closure |
| **iter-7** | **PASS (codex round-4: 4 findings)** | **886/0 on re-run** | P1×2 + P2×2 |

Cumulative PG: 566 (Sprint 5 floor) → **886** (+320 new tests across 4 codex rounds).

---

## §7 verification matrix (iter-7)

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors, 84ms |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **725 / 209 skip / 0 fail** (matches generator's claim) |
| `DATABASE_URL=… bun test` | PASS — **886 / 0 fail** on re-run (885/1-flake on first run = pre-existing `A-Proj-1`; matches generator's "first-run flake, clean re-run" claim) |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | PASS — 20 files, 0 changed_symbols, 0 affected_processes, risk=LOW |
| Independent codex-fix probe | PASS — **67 / 0** (cumulative round-1+2+3+4: 16+14+16+4 sanity+17 round-4) |

### A-Proj-1 flake re-confirmation

First full-suite PG run: 885/1 with `integration :: projects routes (A-Proj-1..6 + IDOR-2) > A-Proj-1 — list returns own-tenant projects only + pagination` failing. Re-ran the same suite → 886/0. Confirmed pre-existing pagination-ordering flake under full-suite contention; NOT introduced by iter-7. Generator pre-warned about it. Lead-tracked for follow-up sprint.

---

## Codex round-4 finding verification — file:line evidence + probe reproduction

### [I7-1] tool_invoke URL targetRef populates protocol — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/normalize/index.ts` (pre-fix) — when `tool_invoke.targetRef` parsed as URL, the resulting target omitted `protocol`. Protocol allow/deny rules never applied — a deny `protocol:'http'` could not block a `tool_invoke` to `http://...`.

**Source-level fix verified:** `packages/scope-engine/src/normalize/index.ts:215-237`. URL branch of tool_invoke now maps `url.scheme` to `Protocol` (mirrors `buildHttpTarget`); spread sets `protocol: urlProtocol` when http/https/ws/wss.

**Probe reproduction:** `probeI7_1` (3 assertions):
- `tool_invoke` with URL targetRef → `normalizedTarget.protocol === 'http'` (populated) ✓
- `deny protocol:http` rule → DENY `denied_by_rule` with `matchedDenyRuleIds` includes `deny-http` ✓
- Positive: https targetRef → `protocol='https'`, `effectivePort=443`, ALLOW ✓

### [I7-2] Rate-limit bucket tenant isolation — VERIFIED PASS (HARD INVARIANT)

**Codex finding:** `packages/scope-engine/src/decide.ts` (pre-fix) — `decide` passed raw `r.bucket` to `deps.rateLimit.consume()`. Process-global counter; two tenants using same bucket name (e.g. `'recon'`) shared tokens. Hard tenant-isolation invariant violated.

**Source-level fix verified:** `packages/scope-engine/src/decide.ts:413-433`:
```
const namespacedBucket = `${scope.tenantId}:${scope.assessmentId}:${r.bucket}`;
const consume = deps.rateLimit.consume(namespacedBucket, r.perSecond, r.burst);
```
Hard invariant comment at lines 414-418 — "never collapse the namespace".

**Probe reproduction:** `probeI7_2` (4 assertions) using a custom counter that records every key it sees:
- t1 first call → ALLOW (consume('t1:a1:recon', ...) → ok=true) ✓
- t1 second call → DENY `rate_limit_exceeded` (same key, exhausted) ✓
- t2 first call → ALLOW (consume('t2:a2:recon', ...) → distinct key, NOT shared) ✓
- Counter saw distinct keys `t1:a1:recon` AND `t2:a2:recon` (set membership check) ✓

The pre-fix would have shared tokens between t1 and t2 since both use `bucket: 'recon'`. With namespacing, t1's exhaustion does NOT propagate to t2. Tenant isolation hard invariant held.

### [I7-3] IPv6 strict per-group hex validation — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/normalize/ip.ts` (pre-fix) — `Number.parseInt('1zz', 16)` returns 1 (parses up to first invalid char). `2001:db8::1zz` was silently accepted as `2001:db8::1`.

**Source-level fix verified:** `packages/scope-engine/src/normalize/ip.ts:120-143`:
```
const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/i;
const validHexGroups = (parts) => parts.every((p) => HEX_GROUP_RE.test(p));
// In `::` short-form path: if (!validHexGroups(leftParts) || !validHexGroups(rightParts)) return null;
// In 8-group path: if (!validHexGroups(parts)) return null;
```
Both code paths gated.

**Probe reproduction:** `probeI7_3` (4 assertions):
- `2001:db8::1zz` (junk-suffix short-form) → REJECTED (throws) ✓
- `2001:db8:0:0:0:0:0:1zz` (junk in 8-group form) → REJECTED ✓
- `2001:db8::12345` (5-hex-digit group too long) → REJECTED ✓
- `2001:db8::1` (well-formed) → still accepted, canonical='2001:db8::1' ✓

### [I7-4] Audit query-key URL-encoding bypass — VERIFIED PASS

**Codex finding:** `apps/api/src/routes/assessments/scope-validate.ts` (pre-fix) — `?access%5Ftoken=secret` (encoded `_`) compared raw key `access%5Ftoken` against `SECRET_QUERY_KEYS` set (`access_token`). No match → token leaked.

**Source-level fix verified:** `apps/api/src/routes/assessments/scope-validate.ts:64-89`:
- Lines 64-74: `decodeQueryKey(raw)` wraps `decodeURIComponent` in try/catch (malformed encoding falls through to raw).
- Lines 79-86: `redactUrlQuery` lowercases BOTH `decoded` and `key.toLowerCase()`, redacts on either match.

**Probe reproduction:** `probeI7_4` (6 assertions — 2 structural + 4 behavioural via the route's contract re-implemented):
- `decodeQueryKey` helper wraps `decodeURIComponent` in try/catch (regex-checked) ✓
- `redactUrlQuery` checks `SECRET_QUERY_KEYS.has(decoded) || SECRET_QUERY_KEYS.has(key.toLowerCase())` (regex-checked) ✓
- Behavioural: `?access%5Ftoken=zzziter7encleak` → `access%5Ftoken=[redacted]`, leak token absent ✓
- Mixed-case `?Access%5FToken=zzzMixedCaseLeak` → `Access%5FToken=[redacted]` ✓
- Non-secret `other=safe` preserved verbatim ✓
- Sanity: raw `bearer=zzzbearleak` (no encoding) still redacted ✓

---

## Regression check

- **Engine purity**: 0 forbidden imports across `packages/scope-engine/src/**/*.ts` ✓
- **gitnexus_detect_changes**: 20 changed files, 0 changed_symbols, 0 affected_processes, risk=LOW ✓
- **All iter-3..6 codex-fix probes still PASS** in iter-7 (50 prior + 17 new = 67/0 cumulative)
- **Sprint 5 baseline 566 PG → 886** (+320 new). No engine-side regressions.
- **AUDIT_ACTIONS** unchanged at 28 entries.
- **DECISION_REASONS** unchanged at 17 entries (no new reasons in iter-7; existing `denied_by_rule` and `rate_limit_exceeded` reused).
- **No new migration. No new external dep.**

---

## §7 cumulative results table

| Surface | iter-6 | **iter-7 (PASS)** |
|---|---|---|
| `bun run lint` | 0 errors | 0 errors ✓ |
| `bun run typecheck` | clean | clean ✓ |
| `bun test` no-DB | 716/208-skip/0-fail | **725/209-skip/0-fail** (+9) |
| `DATABASE_URL=… bun test` | 876/0 | **886/0** on re-run (885/1-flake first run, A-Proj-1 documented) |
| Engine-purity grep | 0 forbidden | 0 forbidden ✓ |
| Independent probe | 50/0 | **67/0** (round-4 added 17 new) |

---

## Notes for team-lead

1. **Codex round-5 recommended.** Per "iterate until silent" protocol. Run `codex review --uncommitted --title "Sprint 6 final-4"`. If clean → commit. If findings → iter-8.

2. **Tenant-isolation invariant now load-bearing on rate-limit namespace.** Generator's hard-invariant comment in `decide.ts:414-418` is correct — any future change that short-circuits the `${tenantId}:${assessmentId}:${bucket}` key prefix breaks tenant isolation. Recommend adding this to mempalace pitfalls.

3. **Probe artifact at 67/0 cumulative.** `.harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts` covers all 4 codex rounds (16 round-1 + 14 round-2 + 16 round-3 + 4 sanity + 17 round-4 = 67 assertions). Permanent regression artifact for the engine's anti-bypass surface.

4. **A-Proj-1 flake confirmed pre-existing — non-deterministic.** Iter-7 first run shows it; re-run clean. Sprint 5 / 6 / 7 / 8 / 9 / 10 / 11 / 12 should NOT block on this. Lead-tracked for follow-up sprint task.

5. **Mempalace pitfall #9 amendment** (now spans 4 codex rounds):
   > Codex semantic-security review at sprint boundaries is RECURSIVE. Sprint 6 took 4 codex rounds (4+6+4+4=18 findings; cumulative iter count: 7). Each round caught NEW orthogonal bypasses on the surface extended by previous fixes. Rule: NEVER commit on a single codex pass — iterate until codex returns SILENT. Plus: independently measure all gates (lint, typecheck, tests) — generator self-report is helpful but not authoritative. Codex round-4 introduced a new tenant-isolation invariant (rate-limit bucket namespace `${tenantId}:${assessmentId}:${bucket}`) that future-sprint changes to `decide()` must preserve.

6. **No new schema delta in iter-7** — purely additive logic on existing types. The only behaviour-changing surface is `decide()` rate-limit consume key + normalize/index.ts protocol propagation.

---

## Files I produced (cumulative session)

- `.harness/cyberstrike-hybrid/sprint-6-codex-fixes-result.md` — iter-3 PASS verdict (round-1).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-4-result.md` — iter-4 PASS verdict (round-2).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-5-result.md` — iter-5/6 PASS verdict (round-3, with lint fix-of-fix).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-7-result.md` — this iter-7 PASS verdict (round-4).
- `.harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts` — 67-assertion cumulative probe (16+14+16+4+17).
- mempalace diary entries (evaluator wing).

---

## Final verdict: **PASS**

All 4 codex round-4 findings (I7-1 tool_invoke-protocol, I7-2 rate-limit-tenant-isolation, I7-3 IPv6-hex-strict, I7-4 audit-key-encoding) closed and source-verified. No engine regression. Recommend lead run codex round-5 review and proceed to mempalace + commit + gitnexus analyze + sprint shutdown if codex returns silent.
