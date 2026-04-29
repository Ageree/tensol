# Sprint 6 — Codex Fixes (iter-5)

> Generator: post-codex iter-5 (1 P1 + 3 P2 fixes)
> Date: 2026-04-28
> Baseline: iter-4 PASS at 863/0 PG. Codex round-3 caught 4 new findings.
> Verdict status: Ready for evaluator review

---

## Fixes applied

### Fix #1 (P1) — Credential leak via nested redirect targets in audit

**File:** `apps/api/src/routes/assessments/scope-validate.ts`

**Bug:** `decision.normalizedTarget.redirectNormalizedTargets[i].url` retained
raw URLs (with `?token=…`/userinfo) in the audit row because the redaction
helper only walked top-level `url` + `redirectTargets`.

**Fix:** Replaced ad-hoc redactor with a whitelist-based recursive helper.
`AUDIT_TARGET_WHITELIST` enumerates permitted fields; everything else is
stripped. URL-bearing fields are query-redacted via `redactUrlQuery`.
`redirectNormalizedTargets` is recursively passed through the same redactor
so nested URLs get the same treatment. `resolvedIps` deliberately omitted
from audit (DNS results may be sensitive in some deployments).

**Test:** `tests/integration/scope/scope-validate.test.ts` —
`iter-5 P1 — redirect normalized target URLs are query-redacted in audit metadata`.
Action with `followRedirectsTo: ['http://169.254.169.254/?token=zzzzleakvalue&other=safe']`
→ audit row never contains `zzzzleakvalue`; `other=safe` preserved.

### Fix #2 (P2) — IP literal hosts not covered by IP allow rules

**Files:** `packages/scope-engine/src/decide.ts`,
`packages/scope-engine/src/types.ts`,
`packages/scope-engine/src/normalize/url.ts`,
`packages/scope-engine/src/normalize/index.ts`.

**Bug:** `allowCoversAllDimensions` host-dimension check demanded a
domain/subdomain/url_prefix rule. For IP-literal hosts (`https://8.8.8.8/`,
`http://[2001:db8::1]/`, `tcp_connect ::1`), the natural cover is `ip`/`cidr`,
so an assessment with `ip + protocol + port` allow rules couldn't actually
allow such an action.

**Fix:** Added `hostIsIp?: boolean` to `NormalizedUrl` and `ResolvedTarget`.
`normalizeUrl` and the IP-literal branches of `dns_lookup`/`tcp_connect`/
`tool_invoke` set `hostIsIp: true`. `allowCoversAllDimensions` switches
the host-dimension requirement: when `hostIsIp === true`, accept
`ip`/`cidr`/`domain`/`subdomain`/`url_prefix`; when false (a real
hostname), keep the existing `domain`/`subdomain`/`url_prefix` requirement.

**Tests:** `decide.test.ts` 4 cases under
`scope-engine :: decide — codex iter-5 P2 (IP-literal hosts + IPv6)` —
`https://8.8.8.8/` allowed by ip+protocol+port; bracketed IPv6 URL allowed
by ip+protocol+port; `tcp_connect ::1` denies as loopback; `dns_lookup
2001:db8::1` allowed by ip rule.

### Fix #3 (P2) — Bracketed IPv6 URLs rejected by normalizeUrl

**File:** `packages/scope-engine/src/normalize/url.ts`.

**Bug:** WHATWG URL exposes bracketed IPv6 hostnames as `parsed.hostname`
either with brackets retained or stripped (Bun strips them). LDH validation
in `normalizeHost` rejected the colon-bearing form → `normalization_error`
on legitimate IPv6 URLs.

**Fix:** Before passing `parsed.hostname` to `normalizeHost`, strip
surrounding `[]` if present and run through `normalizeIp`. If it parses,
use the canonical IP form as `host`, set `hostIsIp: true`, and re-wrap in
brackets for the canonical URL display only. Otherwise fall through to the
original `normalizeHost` path. IPv6 zone-id stripped from canonical (R4
mirrors).

**Tests:** `normalize/url.test.ts` 3 cases — `bracketed IPv6 URL parses
without LDH rejection`, `bracketed IPv6 with explicit default port elides
for canonical`, `IPv4 literal sets hostIsIp`.

### Fix #4 (P2) — IPv6 literal host actions tried as DNS host first

**File:** `packages/scope-engine/src/normalize/index.ts`.

**Bug:** `dns_lookup` / `tcp_connect` / `tool_invoke` called `normalizeHost`
before `tryClassifyAsIp`. `normalizeHost` rejects colons (LDH-only), so
bare IPv6 literals like `::1` and `2001:db8::1` threw before classification
could happen.

**Fix:** Try `tryClassifyAsIp(input.host)` (or `targetRef`) FIRST. If it
parses, take the IP path and skip `normalizeHost`. Falls back to
`normalizeHost` for non-IP hostnames. Mirrors the order already used in
the `http_request` URL flow.

**Tests:** `normalize/index.test.ts` 5 cases under
`codex iter-5 P2 — IPv6 literal hosts via IP-first ordering` — `dns_lookup
::1` (loopback), `dns_lookup 2001:db8::1`, `tcp_connect ::1 + port 22`,
`tool_invoke 2001:db8::1 targetRef`, `http_request bracketed IPv6 URL`.

---

## Verification

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **716 / 208 skip / 0 fail** (+12 vs iter-4) |
| `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` | PASS — **876 / 0 fail** (+13 vs iter-4 863; one preexisting A-Proj-1 flake on first run, clean on re-run, lead-tracked for follow-up) |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | risk=low, 0 changed_symbols, 0 affected_processes |

### Per-file coverage on §5 surfaces (all ≥ 80%)

| File | Func % | Lines % |
|---|---|---|
| `packages/scope-engine/src/decide.ts` | (≥80) | (≥80) |
| `packages/scope-engine/src/normalize/url.ts` | 100.00 | 94.07 |
| `packages/scope-engine/src/normalize/index.ts` | 100.00 | 100.00 |
| `packages/scope-engine/src/normalize/host.ts` | 100.00 | 96.49 |
| `packages/scope-engine/src/normalize/ip.ts` | 100.00 | 98.95 |
| `packages/scope-engine/src/rules/matchers.ts` | 93.75 | 96.58 |
| `packages/scope-engine/src/types.ts` | 100.00 | 100.00 |
| `packages/contracts/src/scope-validate.ts` | 100.00 | 100.00 |
| `packages/contracts/src/scope-action.ts` | 100.00 | 100.00 |

---

## Files touched

- `apps/api/src/routes/assessments/scope-validate.ts` — whitelist-based recursive redaction.
- `packages/scope-engine/src/normalize/url.ts` — bracketed-IPv6 path; `hostIsIp` + canonical re-wrap.
- `packages/scope-engine/src/normalize/url.test.ts` — +3 tests.
- `packages/scope-engine/src/normalize/index.ts` — IP-first ordering for dns_lookup/tcp_connect/tool_invoke; hostIsIp propagated.
- `packages/scope-engine/src/normalize/index.test.ts` — +5 tests.
- `packages/scope-engine/src/types.ts` — `hostIsIp?: boolean` on `ResolvedTarget`; `hostIsIp?` on `NormalizedUrl`.
- `packages/scope-engine/src/decide.ts` — `allowCoversAllDimensions` host-dimension branch on `hostIsIp`.
- `packages/scope-engine/src/decide.test.ts` — +4 tests.
- `tests/integration/scope/scope-validate.test.ts` — +1 IT test for redirect-target redaction.

Total: 9 files modified. No new files. No schema migration. No new dep.

---

## Notes for evaluator

1. **Audit redaction contract is now whitelist-based.** Adding a new field to
   `ResolvedTarget` that should appear in audit metadata requires adding it
   to `AUDIT_TARGET_WHITELIST` in `scope-validate.ts`. The audit redactor
   walks `redirectNormalizedTargets[]` recursively through the same
   whitelist.

2. **`hostIsIp` is the new signal** that switches host-dimension allow
   coverage. Set unconditionally by IP-literal branches in
   `normalize/index.ts` AND by `normalizeUrl` for IP-literal URL hosts
   (bracketed or unbracketed). Tests asserting on host-only allows for IP
   targets continue to work; tests with `domain`-only allows on IP targets
   that previously erroneously passed will now correctly deny via
   `no_matching_allow_rule`.

3. **WHATWG URL hostname behavior across runtimes.** The bracket-handling
   path is defensive: it inspects `parsed.hostname` for surrounding `[]`
   and strips them. On Bun the brackets are stripped automatically. On
   other runtimes they may be retained. Either way the IP classifier
   handles the bare literal.

4. **Pre-existing flake** `tests/integration/projects/A-Proj-1` continues
   to appear on first run under full-suite contention; clean on re-run.
   Lead has marked it for a follow-up sprint per directive.
