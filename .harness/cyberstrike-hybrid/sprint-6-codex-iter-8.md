# Sprint 6 — Codex Fixes (iter-8)

> Generator: post-codex iter-8 (2 P1 + 1 P2)
> Date: 2026-04-28
> Baseline: iter-7 PASS (PG 886/0). Codex round-5 caught 3 new findings.

---

## Fixes applied

### Fix #1 (P1) — Uncatalogued tool denies before rule matching

**File:** `packages/scope-engine/src/decide.ts`

**Bug:** When `tool_invoke.toolName` was absent from `scope.toolCatalog`,
`evaluateToolPolicy` recorded `inCatalog=false` but the engine never returned
`tool_not_in_catalog`. Broad `tool_category` allow + host/protocol allows
let an uncatalogued/misspelled tool slip through.

**Fix:** After `evaluateToolPolicy`, check
`action.kind === 'tool_invoke' && target.toolName !== undefined &&
inCatalog === false` → DENY with `reason: 'tool_not_in_catalog'`. Catalog
is the source of truth.

**Tests:** `decide.test.ts` (`iter-8 P1 — uncatalogued tool denies BEFORE
rule matching with tool_not_in_catalog`, `catalogued tool with same shape
ALLOWS`). Existing tests (`post_exploit without declaration`, `iter-7
tool_invoke URL with full allow set ALLOWS`, `iter-7 tool_invoke URL deny
http`) updated to seed `toolCatalog` so they exercise the intended branch.

### Fix #2 (P1) — Percent-encoded path normalization

**File:** `packages/scope-engine/src/normalize/url.ts`

**Bug:** `parsed.pathname` was only dot-collapsed before policy matching.
`/%61dmin` (encoded `a`) bypassed `/admin` deny rules.

**Fix:** New `decodePathUnreserved()` decodes RFC 3986 §2.3 unreserved
characters (`[A-Za-z0-9\-._~]`) BEFORE segment collapse. Reserved chars
stay encoded (uppercase-normalized per RFC §6.2.2.1). Single-pass decode
to avoid recursive-decode false positives. Malformed encoding (`%G0`,
`%2`) throws `UrlNormalizationError` → engine returns `normalization_error`.

`%2E%2E` (encoded `..`) decodes to `..` → path-traversal collapse runs
naturally (capped at root).

**Tests:**
- `decide.test.ts` 3 new cases: `/%61dmin` denied by path_pattern `/admin`,
  `/%2E%2E/etc` denied by path_pattern `/etc` (post-collapse), malformed
  `/%G0` → `normalization_error`.
- `normalize/url.property.test.ts` property test: 7 fixture forms of
  `admin` (varying `%xx` substitutions) all decode to literal `/admin`
  in normalized path across `URL_RUNS=1000` runs.

### Fix #3 (P2) — Malformed known-kind rules → `unknown_rule` fallback

**File:** `packages/scope-engine/src/effective-scope.ts`

**Bug:** Persisted `cidr` rule `8.8.8.0/bad` (or any malformed cidr/ip)
returned the original string and landed as a `cidr`/`ip` rule that never
matched. Overlapping allow then permitted traffic the deny was meant to
block.

**Fix:** `materializeStrict()` now returns `NormalizedRule | null`:
- `ip`: throws inside `try`, returns null on failure.
- `cidr`: new `canonicalizeCidrStrict()` validates slash position, prefix
  digit-only, prefix range (0-32 IPv4, 0-128 IPv6), and IP parse. Returns
  null on any failure.
- `decodeRule` checks for null and falls through to the existing
  `unknown_rule` fail-closed branch (effect coerced to `'deny'`).

**Tests:** `effective-scope.test.ts` 4 new cases:
- `ip: 'not-an-ip'` → unknown_rule, effect:'deny'
- `cidr: 'not-cidr'` → unknown_rule
- `cidr: '8.8.8.0/bad'` → unknown_rule
- `cidr: '192.168.0.0/64'` (IPv4 prefix overflow) → unknown_rule

Existing tests (`ip with un-normalizable IP preserves raw value`,
`cidr with un-canonical input preserves passthrough`) replaced — the old
behavior was the bug.

---

## Verification (fresh shell)

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **733 / 209 skip / 0 fail** (+8 vs iter-7 725) |
| `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` | PASS — **894 / 0 fail** (+8 vs iter-7 886; clean on first run) |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports |
| `gitnexus_detect_changes(scope=all)` | risk=low, 0 changed_symbols, 0 affected_processes |

All §5-surface files ≥ 80% func+lines (no regression).

---

## Files touched

- `packages/scope-engine/src/decide.ts` — uncatalogued-tool deny gate.
- `packages/scope-engine/src/decide.test.ts` — +5 iter-8 tests; 3 existing tests updated to seed toolCatalog.
- `packages/scope-engine/src/normalize/url.ts` — `decodePathUnreserved` + `UNRESERVED_RE`; `collapsePath` decodes before segment collapse.
- `packages/scope-engine/src/normalize/url.property.test.ts` — +1 property test for `/admin` encoding equivalence.
- `packages/scope-engine/src/effective-scope.ts` — `materializeStrict` returns nullable; new `canonicalizeCidrStrict`; legacy `canonicalizeCidr` removed (replaced).
- `packages/scope-engine/src/effective-scope.test.ts` — +4 fail-closed tests; 2 existing tests updated.

Total: 6 files modified. No new files. No schema migration. No new dep.

---

## Notes for evaluator

1. **Catalog is now strictly authoritative for tool_invoke.** Any
   `tool_invoke` action whose `toolName` isn't in the catalog denies BEFORE
   rule matching. Future test fixtures that exercise the high-impact gate,
   tool-category gate, or tool-name allow rules MUST seed `toolCatalog`
   appropriately or the test exits early with `tool_not_in_catalog`.

2. **Path-decoding is single-pass and non-recursive.** `%2541` decodes to
   `%41` (literal `%`, `4`, `1`), not to `A`. Most XSS sinks single-decode;
   recursive decode would create false positives where a path legitimately
   contains an encoded `%`.

3. **Reserved characters stay encoded with uppercase hex.** Lowercase `%6d`
   becomes uppercase `%6D` only when the byte represents a reserved char.
   For unreserved (which the property test exercises), it's converted to
   the literal char.

4. **Malformed known-kind rule semantics:** the rule still surfaces in
   `matchedDenyRuleIds` if any action would have matched it (since
   `unknown_rule` matches always when effect=deny). `rawRuleKind` field
   preserves the original ruleKind for debugging.
