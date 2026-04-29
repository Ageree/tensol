# Sprint 6 — Codex Fixes (iter-7)

> Generator: post-codex iter-7 (2 P1 + 2 P2 fixes)
> Date: 2026-04-28
> Baseline: iter-6 PASS (lint-only fix-of-fix on iter-5 PG 876/0).
> Codex round-4 caught a tenant-isolation HARD INVARIANT breach + 3 functional regressions.

---

## Fixes applied

### Fix #1 (P1) — tool_invoke URL targetRef now populates protocol

**File:** `packages/scope-engine/src/normalize/index.ts`

**Bug:** When `tool_invoke.targetRef` parsed as URL, the resulting target
omitted `protocol`. Protocol allow/deny rules never applied — a deny
`protocol:'http'` could not block a `tool_invoke` to `http://...`.

**Fix:** In the URL branch of `tool_invoke`, populate `protocol` (mapped via
the same scheme→Protocol table used by `http_request` / `buildHttpTarget`)
when the parsed scheme is http/https/ws/wss. `effectivePort` was already
copied; verified.

**Test:** `decide.test.ts` — `iter-7 P1 — tool_invoke URL targetRef
populates protocol; deny http blocks tool over http` (deny matches), plus
positive case asserting `normalizedTarget.protocol === 'https'` and
`effectivePort === 443`.

### Fix #2 (P1) — Rate-limit bucket tenant isolation

**File:** `packages/scope-engine/src/decide.ts`

**Bug:** `decide` passed raw `r.bucket` to `deps.rateLimit.consume()`. The
production counter is process-global, so two tenants using the same bucket
name (e.g. `'recon'`) shared tokens — T1 exhausting `'recon'` propagated
to T2's actions. Hard tenant-isolation invariant violated.

**Fix:** Namespace the consume key by `tenantId:assessmentId:bucket`. The
injected counter still sees a single opaque string; only the contents
change. Documented in code as a hard invariant — "never collapse the
namespace".

**Test:** `decide.test.ts` — `iter-7 P1 — rate-limit bucket key namespaced
by tenantId+assessmentId; t1 exhaustion does NOT affect t2`. Custom
counter records each key separately. Two scopes with different tenantIds
+ same bucket name; t1 exhaustion → t1 denies, t2 still allows. Companion
test confirms same tenant + same assessment + same bucket exhaustion
still works.

### Fix #3 (P2) — IPv6 strict per-group hex validation

**File:** `packages/scope-engine/src/normalize/ip.ts`

**Bug:** `Number.parseInt('1zz', 16)` returns 1 (parses up to first invalid
char). `2001:db8::1zz` was silently accepted as `2001:db8::1`, so engine
matched rules against an IP that the input string did not represent.

**Fix:** Pre-validate every group against `/^[0-9a-f]{1,4}$/i` before
calling `Number.parseInt`. Reject the whole IPv6 if any group fails. Same
guard for both the `::` short-form path and the explicit 8-group path.

**Tests:** `normalize/ip.test.ts` 4 cases (`junk-suffix in IPv6 short-form
→ rejected`, `junk in 8-group form → rejected`, `5-hex-digit group too
long → rejected`, `well-formed IPv6 still accepted`). Property-based test
in `normalize/ip.property.test.ts` — generate well-formed IPv6, mutate one
group with non-hex suffix, expect throw across all `IP_RUNS=200` runs.

### Fix #4 (P2) — Audit query-key URL-encoding bypass

**File:** `apps/api/src/routes/assessments/scope-validate.ts`

**Bug:** `?access%5Ftoken=secret` (encoded `_`) compared raw key
`access%5Ftoken` against `SECRET_QUERY_KEYS` (`access_token`). No match
→ token leaked into audit metadata.

**Fix:** New `decodeQueryKey()` helper wraps `decodeURIComponent` in
try/catch. `redactUrlQuery` now lowercases the decoded value AND the raw
value, redacts on either match. Belt-and-suspenders: malformed encoding
falls through to raw match.

**Test:** `tests/integration/scope/scope-validate.test.ts` — `iter-7 P2 —
URL-encoded secret query keys are decoded then redacted`. URL with
`access%5Ftoken=zzziter7encleak&Access%5FToken=zzzMixedCaseLeak&other=safe`
→ audit row contains neither leak token; `other=safe` preserved.

---

## Verification

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **725 / 209 skip / 0 fail** (+9 vs iter-6 716) |
| `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` | PASS — **886 / 0 fail** (+10 vs iter-6 876; pre-existing A-Proj-1 flake on first run, clean on re-run) |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | risk=low, 0 changed_symbols, 0 affected_processes |

### Per-file coverage on §5 surfaces (no regression)

All §5-surface files ≥ 80% func+lines.

---

## Files touched

- `packages/scope-engine/src/decide.ts` — namespaced rate-limit bucket key.
- `packages/scope-engine/src/decide.test.ts` — +4 iter-7 tests (protocol propagation, tenant-isolated buckets, single-tenant exhaustion).
- `packages/scope-engine/src/normalize/index.ts` — `protocol` populated on tool_invoke URL targetRef.
- `packages/scope-engine/src/normalize/ip.ts` — `HEX_GROUP_RE` validates each group before `parseInt`.
- `packages/scope-engine/src/normalize/ip.test.ts` — +4 iter-7 cases.
- `packages/scope-engine/src/normalize/ip.property.test.ts` — +1 property test for junk-suffix rejection.
- `apps/api/src/routes/assessments/scope-validate.ts` — `decodeQueryKey` + decoded-or-raw match in `redactUrlQuery`.
- `tests/integration/scope/scope-validate.test.ts` — +1 IT test (`iter-7 P2 URL-encoded secret query key`).

Total: 8 files modified. No new files. No schema migration. No new dep.

---

## Notes for evaluator

1. **Tenant-isolation invariant is now load-bearing on the rate-limit
   namespace.** Any future change to `decide()`'s rate-limit step that
   short-circuits the `${scope.tenantId}:${scope.assessmentId}:${r.bucket}`
   key prefix breaks tenant isolation. Documented in code.

2. **HEX_GROUP_RE applies to every IPv6 path** — both `::` short-form and
   explicit 8-group expansion go through the same gate.

3. **redactUrlQuery is belt-and-suspenders** — checks both decoded and raw
   key against `SECRET_QUERY_KEYS`. Malformed percent-encoding falls
   through to raw. Worst case is "doesn't redact a malformed encoded key"
   which still keeps the existing redaction path intact.

4. **Pre-existing flake** `tests/integration/projects/A-Proj-1` continues
   to appear on first run under full-suite contention; clean on re-run.
   Lead has marked it for a follow-up sprint per directive.
