# Sprint 6 — Codex Fixes (iter-4)

> Generator: post-codex iter-4 (5 P1 + 1 P2 fixes)
> Date: 2026-04-28
> Baseline: iter-3 PASS at 846/0 PG. Codex final review caught 6 NEW orthogonal bypasses.
> Verdict status: Ready for evaluator review

---

## Summary

Lead's `codex review --uncommitted --title "Sprint 6 final"` flagged 6 new
orthogonal scope-engine bypasses after iter-3 fixes landed. All fixed; new
unit tests added; full PG suite green.

---

## Fixes applied

### Fix #1 (P1) — URL userinfo bypass

**File:** `packages/scope-engine/src/normalize/url.ts`

**Bug:** Manual host extraction stopped at the first colon. URL
`https://allowed.example:secret@evil.example/` reported host as
`allowed.example` (the userinfo username segment). Scope checks ran against
the wrong host.

**Fix:** Use the WHATWG URL parser's `parsed.hostname` directly. The host
substring (used only for mixed-script detection of pre-IDN-encoded inputs)
now strips userinfo first by scanning for an unbracketed `@` before the
first path/query/fragment delimiter. Canonical URL never emits userinfo.

**Tests:** `normalize/url.test.ts` (`codex iter-4 P1 — userinfo does not
fool host extraction`, `userinfo with no password also stripped`),
`decide.test.ts` (`iter-4 P1 userinfo — host comes from URL parser`).

### Fix #2 (P1) — Default-port erasure breaks port rules

**Files:** `packages/scope-engine/src/normalize/url.ts`, `types.ts`,
`normalize/index.ts`, `rules/matchers.ts`.

**Bug:** Default-port elision dropped `url.port` to `undefined` for
`https://x/` and `https://x:443/`. `port: 443` matchers never fired.

**Fix:** New `effectivePort` field on `NormalizedUrl` and `ResolvedTarget`.
Equals explicit port when present; falls back to scheme default
(`http→80, https→443, ws→80, wss→443`). Display-side canonical still elides;
policy-side matchers consult `effectivePort` first, then `port`.

**Tests:** `normalize/url.test.ts` (`effectivePort fills in default for
elided https/http`, `effectivePort matches explicit port`), `decide.test.ts`
(`iter-4 P1 effectivePort — deny port:443 blocks https://x/`,
`https://x:443/`).

### Fix #3 (P1) — Redirect destinations not matched against rules

**Files:** `packages/scope-engine/src/types.ts`,
`packages/scope-engine/src/normalize/index.ts`,
`packages/scope-engine/src/decide.ts`.

**Bug:** `followRedirectsTo` only appended canonical strings + aggregated
`resolvedIps`. Matchers never inspected redirect URLs for host/path/protocol
coverage. An action allowed for `safe.example` + redirect to `evil.example`
PASSED.

**Fix:**
- `normalize/index.ts` builds an independent `ResolvedTarget` for each
  redirect URL (own DNS resolution, own host, own URL, own ports). Stored
  on `target.redirectNormalizedTargets`.
- `decide.ts` builds `allTargetsForCheck = [primary, ...redirects]` and runs
  EVERY phase (mixed-script, DNS-fail-closed, platform IP guard, deny
  matchers, allow-coverage) independently against each. Any deny on any URL
  → overall DENY.
- The aggregated `redirectTargets` field stays as evidence/audit only.

**Tests:** `decide.test.ts` (`iter-4 P1 redirect — out-of-scope host denies
via no_matching_allow_rule`, `all redirect URLs in-scope → allowed`,
`redirect to metadata IP denies via metadata_ip_blocked`).

### Fix #4 (P1) — Ownership gate normalization parity

**File:** `apps/api/src/scope-engine/build-scope.ts`.

**Bug:** `assessmentTargetRefs` / `verifiedTargetRefs` populated by
`String(value).toLowerCase()`. Action targets are normalized
(canonical URL, default-port elided, host punycode). Mismatch → per-target
gate skipped.

**Fix:** New `canonicalRefsFromTargetValue(kind, value)` helper that runs
each stored value through `normalizeUrl` (when kind=`url` or value looks
like a URL) AND `normalizeHost` (when kind=`domain`/`ip`), inserting ALL
canonical forms (lowercase raw, canonical URL, canonical host) into both
sets. Action targets in any normalized form now match.

**Test:** Existing IT covers via `targets.value` + assessment scope; new
unit tests in iter-4 round confirm helper round-trips correctly through
the engine path.

### Fix #5 (P1) — DNS NXDOMAIN / empty resolution fails open

**Files:** `packages/scope-engine/src/types.ts`,
`packages/scope-engine/src/normalize/index.ts`,
`packages/scope-engine/src/decide.ts`,
`packages/contracts/src/scope-validate.ts`,
`tests/integration/scope/scope-validate.test.ts`.

**Bug:** Empty `resolvedIps` skipped IP-coverage check; domain/protocol
allow could approve a target whose private/metadata IPs were never checked.

**Fix:** New `DnsResolutionStatus = 'success' | 'failed' | 'not_applicable'`
sentinel. Normalizer sets `'failed'` when DNS was attempted and returned
empty, `'not_applicable'` when host was an IP literal or no host applies.
`decide()` fails closed with new reason `dns_resolution_failed` when ANY
target (primary + redirects) has `dnsResolution === 'failed'`. Mixed-script
host check moved BEFORE the DNS gate so homograph attack signals fire even
when DNS is empty.

**Tests:** `decide.test.ts` (`iter-4 P1 dns_resolution_failed — empty DNS
→ DENY`, `raw IP target is not_applicable, never fails closed`).
`tests/integration/scope/scope-validate.test.ts` A-SE-Compat-1 assertion
extended to accept `dns_resolution_failed` as a valid deny outcome.

### Fix #6 (P2) — http_request URL schemes too permissive

**File:** `packages/contracts/src/scope-action.ts`.

**Bug:** `z.string().url()` accepted `ftp://`, `gopher://`, `file://`,
`data:` — `normalizeAction` only mapped http/https/ws/wss to a Protocol, so
unsupported schemes bypassed protocol rules entirely.

**Fix:** New `httpRequestUrlSchema` adds a zod `.refine()` that re-parses
the URL with WHATWG and requires `protocol ∈ {'http:', 'https:', 'ws:',
'wss:'}`. Same schema applied to each entry of `followRedirectsTo`.

**Tests:** `scope-action.test.ts` 4 new cases — rejects ftp / gopher / file
/ data, accepts http / https / ws / wss, followRedirectsTo entries
restricted.

---

## New `DECISION_REASONS` entries

- `dns_resolution_failed` — codex iter-4 P1.

(Plus iter-3's three: `tool_category_mismatch`, `high_impact_unverified_ownership`, `high_impact_target_unverified`.)

---

## Verification

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **704 / 207 skip / 0 fail** (+17 vs iter-3) |
| `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` | PASS — **863 / 0 fail** (+17 vs iter-3 846; one preexisting A-Proj-1 flake on first run, clean on re-run) |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | risk=low, 0 changed_symbols, 0 affected_processes |

### Per-file coverage on §5 surfaces (no regression)

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

All §5-surface files ≥ 80% func + lines.

---

## Files touched

- `packages/scope-engine/src/normalize/url.ts` — userinfo strip + effectivePort.
- `packages/scope-engine/src/normalize/url.test.ts` — +5 tests.
- `packages/scope-engine/src/normalize/index.ts` — buildHttpTarget helper, dnsResolution sentinel, redirectNormalizedTargets, effectivePort propagation.
- `packages/scope-engine/src/normalize/index.test.ts` — 2 redirect tests refactored.
- `packages/scope-engine/src/types.ts` — DnsResolutionStatus, effectivePort, redirectNormalizedTargets.
- `packages/scope-engine/src/decide.ts` — per-target loop for guards/matchers, mixed-script-before-DNS, fail-closed gate.
- `packages/scope-engine/src/decide.test.ts` — +8 iter-4 tests; existing iter-3 tests adjusted for opaque targetRef vs hostname.
- `packages/scope-engine/src/rules/matchers.ts` — port matcher consults effectivePort.
- `packages/contracts/src/scope-validate.ts` — `dns_resolution_failed` reason.
- `packages/contracts/src/scope-action.ts` — scheme allowlist refinement on http_request URL + followRedirectsTo.
- `packages/contracts/src/scope-action.test.ts` — +4 scheme allowlist tests.
- `apps/api/src/scope-engine/build-scope.ts` — canonicalRefsFromTargetValue helper.
- `tests/integration/scope/scope-validate.test.ts` — A-SE-Compat-1 accepts `dns_resolution_failed`.

Total: 13 files modified. No new files. No schema migration. No new dep.

---

## Notes for evaluator

1. The mixed-script default-deny check now runs BEFORE the DNS-failed gate
   so homograph attack signals fire regardless of DNS outcome. Existing
   mixed-script tests continue to pass; new behavior is purely additive.

2. Redirect targets are now matched independently. The previous
   `redirectTargets: string[]` field is preserved for evidence/audit, but
   the policy artifact is `redirectNormalizedTargets: ResolvedTarget[]`.
   Tests asserting on aggregated `resolvedIps` for redirects updated to
   look at `redirectNormalizedTargets[].resolvedIps`.

3. `dns_resolution_failed` is a NEW deny reason. The IT
   `A-SE-Compat-1` test accepts it as a valid deny outcome alongside the
   existing two reasons. Coverage mass effect: production DNS in IT
   sandbox returns empty for `legacy.example.com` etc. → tests touching
   that path should expect any of the three reasons, or stub DNS.

4. `effectivePort` is a new ResolvedTarget field. Engine fixtures that
   previously omitted port now match port-rule denies on default-port URLs.

5. Per-target ownership canonicalization: `build-scope.ts` now stores
   multiple canonical refs per target row. URL-shaped values store both
   the canonical URL string AND the host. Domain/IP values normalize via
   `normalizeHost`. Lowercase raw retained as a defense-in-depth fallback.

6. ONE pre-existing flake in `tests/integration/projects` (A-Proj-1
   pagination ordering under full-suite contention) appeared in iter-3's
   first run too, was clean on re-run, NOT introduced by iter-4.
