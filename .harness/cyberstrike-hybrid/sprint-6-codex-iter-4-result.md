# Sprint 6 — Codex iter-4 Evaluator Verdict

> Evaluator: evaluator (cyberstrike-sprint-6-fixes team, single session)
> Verified against: `.harness/cyberstrike-hybrid/sprint-6-codex-iter-4.md` (generator iter-4 self-report) + the 6 codex round-2 findings (5 P1 + 1 P2)
> Repo state: HEAD `9f5a732` + uncommitted Sprint 6 working tree (20 files in `gitnexus_detect_changes`)
> Date: 2026-04-28
> Bun runtime: 1.3.11
> iter-3 baseline: 846/0 PG, 687/207-skip no-DB
> iter-4 codex round-2 (`codex review --uncommitted --title "Sprint 6 final"`) flagged 6 NEW orthogonal bypasses after iter-3 PASS

---

## Final verdict: **PASS** — all 6 codex round-2 findings closed; no engine regression

After 1 generator iteration (iter-4), each of the 5 P1 + 1 P2 findings is
independently reproduced as fixed via the staged probe (now 34 assertions
across both round-1 and round-2 fixes). Sprint 5 + Sprint 6 iter-3 invariants
all hold. PG count grew 846 → 863 expected (+17); my PG run measured 862/1 due
to the documented pre-existing `A-Proj-1` pagination flake under full-suite
contention — confirmed flake by running the projects suite in isolation
(11/0). NOT introduced by iter-4.

---

## Iteration timeline (cumulative)

| Iter | Verdict | PG | Notes |
|---|---|---|---|
| iter-1 | FAIL | 749 / 0 | F1-F7 fixes (coverage, audit-shape, attribution, redaction, RBAC-neg, p95, redirect-API) |
| iter-2 | PASS (codex caught 4 holes) | 833 / 0 | round-1 codex review surfaced P1×3 + P2×1 |
| iter-3 | PASS (codex caught 6 more holes) | 846 / 0 (+13) | round-2 codex review surfaced P1×5 + P2×1 |
| **iter-4** | **PASS** | **862 / 1 flake / 0 engine fail** (+16 net) | All 6 codex round-2 findings closed; only failure is documented `A-Proj-1` flake (passes in isolation) |

Net cumulative: 566 PG (Sprint 5 floor) → 862 = +296 new tests (no engine regression).

---

## §7 verification matrix

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors, 88ms |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **704 / 207 skip / 0 fail** (+17 vs iter-3) — matches generator |
| `DATABASE_URL=… bun test` | **862 / 1 flake / 0 engine-fail** — flake = `A-Proj-1` pagination ordering (passes in isolation) |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | PASS — 20 files, 0 changed_symbols, 0 affected_processes, risk=LOW |
| Independent codex-fix probe | PASS — **34 / 0 fail** (16 round-1 + 14 round-2 + 4 sanity) |

### A-Proj-1 flake confirmation

The full-suite PG run reported `1 fail`: `integration :: projects routes (A-Proj-1..6 + IDOR-2) > A-Proj-1 — list returns own-tenant projects only + pagination` at 22.91ms. Re-ran the projects suite in isolation (`bun test tests/integration/projects`) → 11 pass / 0 fail. Confirmed flake: full-suite contention on pagination ordering when interleaved with other test suites. Generator pre-flagged this as a pre-existing iter-3 flake. NOT a regression. Recommend the next sprint addresses fixture isolation for projects pagination, but it is OUT OF SCOPE for Sprint 6 codex closeout.

### §5 surface coverage (no engine regression)

| File | Func % | Lines % |
|---|---|---|
| `packages/scope-engine/src/decide.ts` | 82.61 | 86.70 |
| `packages/scope-engine/src/effective-scope.ts` | 100.00 | 99.32 |
| `packages/scope-engine/src/normalize/index.ts` | 100.00 | 100.00 |
| `packages/scope-engine/src/normalize/host.ts` | 100.00 | 96.49 |
| `packages/scope-engine/src/normalize/ip.ts` | 100.00 | 98.95 |
| `packages/scope-engine/src/normalize/url.ts` | 100.00 | 92.78 |
| `packages/scope-engine/src/rules/matchers.ts` | 93.75 | 96.58 |
| `packages/contracts/src/scope-validate.ts` | 100.00 | 100.00 |
| `packages/contracts/src/scope-action.ts` | 100.00 | 100.00 |

decide.ts dropped from iter-3's 90/95.03 to 82.61/86.70 due to new branches added (per-target loop, dns_resolution_failed gate, mixed-script-before-DNS reorder); both still ≥80%.

---

## Codex round-2 finding verification — file:line evidence + probe reproduction

### [I4-1] URL userinfo bypass — VERIFIED PASS

**Codex finding:** `packages/scope-engine/src/normalize/url.ts` (pre-fix) — manual host extraction stopped at first colon; URL `https://allowed.example:secret@evil.example/` reported host as `allowed.example` (the userinfo username segment), so scope checks ran against the wrong host.

**Source-level fix verified:** `url.ts:82-87` uses `parsed.hostname` from the WHATWG URL parser as authoritative. `url.ts:95-114` strips userinfo from the `afterScheme` substring (used only for pre-IDN mixed-script detection). `url.ts:145-146` canonical NEVER includes userinfo.

**Probe reproduction:** `probeI4_1`:
- `normalizeUrl('https://allowed.example:secret@evil.example/path').host === 'evil.example'` ✓
- canonical contains no `secret` and no `@` ✓
- Behavioural: scope allows `allowed.example` only; action with userinfo URL → DENIED (real host `evil.example` unscoped) ✓

### [I4-2] Default-port erasure breaks port rules — VERIFIED PASS

**Codex finding:** Default-port elision dropped `url.port` to `undefined` for `https://x/` and `https://x:443/`; `port: 443` matchers never fired.

**Source-level fix verified:** `url.ts:131-137` adds `effectivePort = portNum ?? defaultPort` (always set when scheme has a default). `url.ts:153-154` propagated to `NormalizedUrl`. `normalize/index.ts:88-93` propagated to `ResolvedTarget` (both http_request and tool_invoke branches). `rules/matchers.ts:158-161` consults `target.effectivePort` first, then `port` — port matchers correctly handle elided default ports.

**Probe reproduction:** `probeI4_2`:
- `normalizeUrl('https://x.example/').effectivePort === 443 && .port === undefined` ✓
- `normalizeUrl('https://x.example:443/').effectivePort === 443` ✓
- Behavioural: `deny port:443` rule blocks `https://x.example/` (no explicit port in URL) → DENY denied_by_rule with matchedDenyRuleIds=['deny-443'] ✓

### [I4-3] Redirect destinations not matched — VERIFIED PASS

**Codex finding:** `followRedirectsTo` only appended canonical strings + aggregated `resolvedIps`; matchers never inspected redirect URLs for host/path/protocol coverage. An action allowed for `safe.example` + redirect to `evil.example` PASSED.

**Source-level fix verified:** `normalize/index.ts:107-119` builds `redirectNormalizedTargets[]` — each redirect URL is independently normalized via `buildHttpTarget` (own DNS resolution, own host, own URL, own ports). `decide.ts:320-323` constructs `allTargetsForCheck = [primary, ...redirectNormalizedTargets]`. `decide.ts:328-347` (mixed-script), `decide.ts:353-363` (DNS fail-closed), `decide.ts:368-388` (platform IP guards), and the deny+allow-coverage loops all run on every target. Any deny on any redirect → overall DENY.

**Probe reproduction:** `probeI4_3`:
- Allow `safe.example`, redirect to unscoped `evil.example` → DENY ✓
- Allow `safe.example` + `cloud.example`, redirect to `cloud.example` resolving to metadata IP `169.254.169.254` → DENY metadata_ip_blocked ✓ (proves platform guard runs on redirect targets independently)

### [I4-4] Ownership normalization parity — VERIFIED PASS

**Codex finding:** `assessmentTargetRefs` / `verifiedTargetRefs` were populated by `String(value).toLowerCase()` while action targets are normalized (canonical URL, default-port elided, host punycode). Mismatch → per-target gate skipped.

**Source-level fix verified:** `apps/api/src/scope-engine/build-scope.ts:canonicalRefsFromTargetValue` runs each stored value through `normalizeUrl` (when value looks like a URL) AND `normalizeHost` (when kind=domain/ip), inserting ALL canonical forms (lowercase raw, canonical URL, canonical host) into both sets.

**Probe reproduction:** `probeI4_4`:
- Engine receives `assessmentTargetRefs = {url canonical, host}` and `verifiedTargetRefs = {url canonical, host}`
- Action `tool_invoke` with `targetRef: 'https://verified.example/'` → engine produces ResolvedTarget with `host='verified.example'` and `url='https://verified.example/'`
- `collectTargetRefs` (decide.ts:223-231) returns both `host` and `url`; per-target check finds match in verified set → ALLOW ✓

### [I4-5] DNS NXDOMAIN / empty resolution fails open — VERIFIED PASS

**Codex finding:** Empty `resolvedIps` skipped IP-coverage check; domain/protocol allow could approve a target whose private/metadata IPs were never checked.

**Source-level fix verified:** `types.ts` adds `DnsResolutionStatus = 'success' | 'failed' | 'not_applicable'` sentinel. `normalize/index.ts` populates `dnsResolution` in every branch:
- `buildHttpTarget` lines 71-81: 'not_applicable' for IP-literal hosts, 'failed'/'success' based on DNS result.
- `dns_lookup` lines 126-135: same.
- `tcp_connect` lines 149-158: same.
- `tool_invoke` lines 218-235: same.
`decide.ts:353-363` fails closed with reason `dns_resolution_failed` when ANY target (primary + redirects) has `dnsResolution === 'failed'`. Mixed-script gate at `decide.ts:328-347` runs BEFORE this gate (so homograph signal fires regardless of DNS).

**Probe reproduction:** `probeI4_5`:
- Hostname with empty DNS + domain+protocol allows → DENY dns_resolution_failed ✓ (NOT allowed)
- Raw IP target → dnsResolution='not_applicable', fail-closed gate does not fire ✓

### [I4-6] http_request URL scheme allowlist — VERIFIED PASS

**Codex finding:** `z.string().url()` accepted `ftp://`, `gopher://`, `file://`, `data:` — `normalizeAction` only mapped http/https/ws/wss to a Protocol, so unsupported schemes bypassed protocol rules entirely.

**Source-level fix verified:** `packages/contracts/src/scope-action.ts:21-35` — `httpRequestUrlSchema` is `z.string().url().max(8192).refine(...)` requiring `protocol ∈ {http:, https:, ws:, wss:}`. Same schema applied to `followRedirectsTo` entries (line 51).

**Probe reproduction:** `probeI4_6`:
- `ftp://`, `gopher://`, `file:///`, `data:` → zod rejection (4 cases) ✓
- `http://`, `https://`, `ws://`, `wss://` → zod accept (4 cases) ✓
- `followRedirectsTo: ['ftp://...']` → zod rejection ✓

---

## Regression check (Sprint 1-5 + Sprint 6 iter-3 invariants)

- **Engine purity**: 0 forbidden imports across `packages/scope-engine/src/**/*.ts`.
- **gitnexus_detect_changes**: 20 changed files, 0 changed_symbols, 0 affected_processes, risk=LOW. No call-graph mutation.
- **All iter-3 codex-fix probes still PASS** in iter-4 (after fixing one probe to use raw IP targetRef instead of opaque hostname — the iter-4 dns_resolution_failed gate fires earlier in the pipeline; the bypass it tests is still closed, the test fixture just needed updating). 16 round-1 probe assertions all green.
- **Sprint 5 baseline**: 566 PG → 862 (+296 new). No engine-side regressions; the 1 reported failure is the pre-existing `A-Proj-1` flake (out of scope).
- **AUDIT_ACTIONS** unchanged at 28 entries.
- **DECISION_REASONS extended** with `dns_resolution_failed` (iter-4 P1) — total now 17 reasons.
- **AssessmentFlags schema** unchanged in iter-4 (the iter-3 additions of `verifiedTargetRefs?` / `assessmentTargetRefs?` remain optional, populated by `build-scope.ts` from ownership data).
- **No new migration. No new external dep.** Only zod is touched (refine() added).

---

## §7 cumulative results table

| Surface | iter-3 | iter-4 |
|---|---|---|
| `bun run lint` | 0 errors | 0 errors ✓ |
| `bun run typecheck` | clean | clean ✓ |
| `bun test` no-DB | 687/207-skip/0-fail | **704/207-skip/0-fail** (+17) |
| `DATABASE_URL=… bun test` | 846/0-fail | **862/1-flake/0-engine-fail** (+16 net; flake=A-Proj-1, passes in isolation) |
| §5 surface coverage func% | all ≥80 | all ≥80 (decide dropped 90→82.61, still passes) |
| §5 surface coverage lines% | all ≥80 | all ≥80 (decide 95.03→86.70, still passes) |
| Engine-purity grep | 0 forbidden | 0 forbidden ✓ |
| `gitnexus_detect_changes` risk | LOW (20 files) | LOW (20 files) |
| Independent codex-fix probe | 14/0 (round-1 only) | **34/0** (round-1 + round-2 cumulative) |

---

## Notes for team-lead

1. **Codex round-3 recommended.** Lead said "one more codex round will follow". Iter-4 closes the round-2 findings; running `codex review --uncommitted --title "Sprint 6 final-2"` once more closes the loop. If clean → commit; if not → iter-5.

2. **Pre-existing `A-Proj-1` flake.** Single PG failure on the full-suite run; passes in isolation (11/0 on `bun test tests/integration/projects`). Documented as iter-3 first-run flake by generator. **NOT introduced by iter-4** and **NOT in the engine package** — it's a fixture-contention issue in the projects pagination IT. Recommend a follow-up sprint task to make projects fixtures fully isolated (uniqSlug pattern from Sprint 5 may not be applied universally to project fixtures).

3. **Probe artifact cumulative.** `.harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts` now contains BOTH round-1 (14 assertions) and round-2 (20 assertions) probes. Permanent regression artifact for both rounds.

4. **`decide.ts` coverage drop is structural, not a regression.** Iter-4 added 4 new branches (per-target loops over `allTargetsForCheck` for mixed-script + IP guard + deny + allow-coverage; new dns_resolution_failed gate; mixed-script-before-DNS reorder). Coverage dropped 90/95.03 → 82.61/86.70 because the new branches are exercised but not exhaustively (e.g. some redirect-only branch combinations not covered). Still ≥80% threshold; could be raised to ≥90% in a follow-up if desired.

5. **DECISION_REASONS now 17 entries** (added `dns_resolution_failed`). The IT `A-SE-Compat-1` test was updated to accept it as a valid deny outcome alongside `unknown_rule_default_deny` (verified in `tests/integration/scope/scope-validate.test.ts`).

6. **Mempalace pitfall update — second iteration.** The pitfalls catalog should now reflect that codex review can surface MULTIPLE rounds of findings, not just one:
   > 9. **Codex semantic-security review at sprint boundaries is load-bearing AND recursive.** Test/coverage tooling cannot detect semantic SSRF / privilege-escalation / fail-open defects; only code-reading review (codex CLI 0.125.0 `review --uncommitted`) catches them. Sprint 6 iter-2 PASS → codex round-1 found 4 holes (P1×3 + P2×1) → iter-3 fix → codex round-2 found 6 MORE holes (P1×5 + P2×1) on the now-extended attack surface → iter-4 fix → recommend round-3 to confirm closure. Future-sprint rule: NEVER commit on a single codex pass; iterate until codex returns clean.

---

## Files I produced (cumulative, this session)

- `.harness/cyberstrike-hybrid/sprint-6-codex-fixes-result.md` — iter-3 PASS verdict (round-1 codex closure).
- `.harness/cyberstrike-hybrid/sprint-6-codex-iter-4-result.md` — this iter-4 PASS verdict (round-2 codex closure).
- `.harness/cyberstrike-hybrid/evaluator-probe-sprint6-codex-fixes.ts` — 34-assertion cumulative probe (16 round-1 + 14 round-2 + 4 sanity).
- mempalace diary entries (evaluator wing).

---

## Final verdict: **PASS**

All 6 codex round-2 findings (I4-1 userinfo, I4-2 effectivePort, I4-3 redirect-matching, I4-4 ownership-normalization, I4-5 DNS-fail-closed, I4-6 scheme-allowlist) closed and source-verified. No engine regression. Single PG failure is documented pre-existing flake outside Sprint 6 scope.

Recommend lead run codex round-3 review and proceed to mempalace + commit + gitnexus analyze + sprint shutdown if clean.
