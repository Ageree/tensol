# Sprint 6 Contract — Scope Engine: Effective Scope, Normalization, Enforcement Integration Points (v2)

> **Author:** Generator (drafter)
> **Project:** cyberstrike-hybrid
> **Sprint:** 6 (spec §2 Sprint 6 + plan §5)
> **Source spec:** `.harness/cyberstrike-hybrid/product-spec.md` lines 305-340 (read-only)
> **Source plan:** `.omx/plans/implementation-cyberstrike-hybrid.md` §5 (read-only)
> **Reference spec:** `PROJECT-SPECS-cyberstrike-hybrid.md` §8.6 (read-only)
> **Baseline:** HEAD `9f5a732` (Sprint 5 PASS, 566/0 PG tests, 423/187-skip no-DB, coverage 93.97%, 0 lint, clean tsc)
> **Audience:** Generator (implementer = self), Evaluator (reviewer/verifier)
>
> **Revision history**
> - **v2 (2026-04-28):** Evaluator R1-R11 + OQ-1..8 resolutions folded in.
>   - **R1** explicit `expect(RULE_KINDS.size).toBe(16)` cardinality + table-driven `*.each` per-kind ≥1 positive + ≥1 negative case (cardinality ≥32). A-SE-Type-2 expanded.
>   - **R2** A-SE-Time-Boundary-1 promoted to binary criterion — sequential `decide()` calls with injected `Clock` interface; no retroactive mutation.
>   - **R3** time-window convention pinned to half-open `[start, end)`; clock = injected interface.
>   - **R4** IPv6 zone-id stripped from `canonical`; rule matchers compare against `canonical` only — `fe80::1%eth0` cannot smuggle past `fe80::1` deny.
>   - **R5** audit emission count math verified (26 + 1 = 27).
>   - **R6** A-SE-Compat-1 — Sprint 5 IT-seeded scope-rule rows parse via discriminated union; out-of-set `rule_kind` → `unknown_rule` default-deny per A-SE-Pri-3.
>   - **R7** zod `tool_category` enum validation at request boundary; engine never receives malformed category.
>   - **R8** property-test `numRuns` minima — URL=1000, IP=200, host/IDN=200; shared `fastCheckOpts` constant.
>   - **R9** A-SE-Route-4 p95 oracle gated by `describe.skipIf(!hasDatabaseUrl())`.
>   - **R10** §12 step 2 expanded — `gitnexus_impact` runs on shared symbols (`seedAssessment`, `assertOwnership`, `denyAudit`, RBAC matrix, `register-routes`) before edits.
>   - **R11** A-SE-SSRF-3 — engine iterates ALL resolved IPs, no short-circuit on first public; test asserts order-independence with `[pub,priv]` and `[priv,pub]` permutations.
>   - **OQ-1..OQ-8** resolved as drafted (extend ScopeRule schema; async decide; static tool catalog; AND-composed time windows; in-process RateLimitCounter; reason=closed-set code; 50ms p95; mixed-script default-deny).

---

## 1. Goal

Land a **pure, I/O-free, dependency-injected `packages/scope-engine`** as the single source of truth for allow/deny decisions across the platform. The package answers one question: *"may this candidate action proceed against this assessment's effective scope?"* — synthesised from tenant policy, platform policy, project targets, assessment targets, allow rules, deny rules, tool catalog, assessment flags, and time window.

Sprint 6 wires the engine into the API at `POST /api/v1/assessments/:id/scope/validate` and into the audit pipeline at the deny path (`denyAudit` event with matched deny rule IDs + normalized target + reason). Coordinator pre-enqueue (Sprint 7), worker pre-execution (Sprint 9), validator replay (Sprint 10), and report-publication guards (Sprint 12) all *consume* this same engine without rewrites — that is explicit non-goal coverage in §11.

Sprint 6 deliberately does **not** ship: queue dispatch (Sprint 7), real Decepticon adapter (Sprint 8), browser/HTTP workers (Sprint 9), validators (Sprint 10), findings UI (Sprint 11), or report builder (Sprint 12). DNS resolution itself is an *injected* interface — Sprint 6 ships a default in-memory test resolver and a thin Node-DNS production wrapper located **outside** the engine package, in `apps/api/src/scope-engine/`.

---

## 2. Hard invariants (carry-forward from spec §1.1, active surface in Sprint 6)

1. **Scope-first execution.** Every security-relevant action is gated by the scope engine BEFORE side effects. Sprint 6 makes this concrete for the validate endpoint; Sprints 7+ wire pre-enqueue, pre-exec, replay, and publish guards to the SAME `decide(action)`.
2. **Deny overrides allow.** `decide()` is a two-pass evaluator: every applicable deny rule fires first; if any matches → `allowed=false`. Allow rules are evaluated only if zero denies match. Documented in code comment + tested with conflicting fixtures (A-SE-Pri-1).
3. **Auditability.** Every `denied` decision emitted from the API endpoint produces exactly one `audit_events` row via `denyAudit` with `metadata.matchedDenyRuleIds`, `metadata.normalizedTarget`, and `metadata.reason`. The engine itself stays pure — audit emission is the API caller's responsibility.
4. **Tenant isolation.** The validate endpoint is gated by `tenantGuard`. The engine receives `tenantPolicy` + `assessmentTargets` already filtered to the actor's tenant by the route. The engine does no I/O.
5. **Findings only after validation.** Sprint 6 has no finding surface; carry-forward documented so future sprints don't accidentally short-circuit through `scope/validate`.
6. **Ownership-verified high-impact tools.** Sprint 6 enforces high-impact tool flags (`c2`, `post_exploit`, `ad`, `credential_audit`) at the engine layer: a candidate action invoking a `tool_category` flagged high-impact denies unless the assessment's `highImpactCategories` includes the same category AND every involved target has `ownership_status='verified'`. The verified-ownership signal is passed in via inputs (no engine I/O).
7. **Cost caps never block.** Out of Sprint 6 scope; documented as L-9 below so an evaluator does not flag absence.

---

## 3. Carry-forwards from prior sprints (locked in)

| #    | Carry-forward                                                                                                                              | Where it lands |
|------|--------------------------------------------------------------------------------------------------------------------------------------------|----------------|
| CF-1 | C29 `delta=1` invariant — every state-changing API action emits exactly one audit row via `emitAudit`/`denyAudit`; verified via `assertExactlyOneAuditRow`. Sprint 6 adds 1 deny emission point: `scope.validate.denied`. | A-SE-Audit-1   |
| CF-2 | `denyAudit` is the canonical helper for non-success outcomes (`denied` | `forbidden` | `cross_tenant`). Sprint 6 chooses `outcome='denied'` for engine deny. | A-SE-Audit-1   |
| CF-3 | `assertOwnership` + `RbacDenyError` already wired through `onError` to `rbac.deny` audit. Sprint 6's validate route calls `assertOwnership(tenantId, assessment)` after `findById` — re-uses Sprint 5 plumbing. | A-SE-Route-1   |
| CF-4 | `seedAssessment(db, opts)` from Sprint 5 IT lib accepts a `scopeRules` arg. Sprint 6 IT extends with helpers: `effectiveScopeFixture()` (pure fixture builder), `mockDnsResolver(table)` (deterministic resolver). | A-SE-Test-1    |
| CF-5 | New workspace `packages/scope-engine` already exists as a stub (Sprint 1 placeholder). Sprint 6 fills it. CI matrix auto-discovers `bun test` in `packages/*` — no CI YAML edits expected if Generator stays inside `packages/scope-engine` + `packages/contracts/src/...` + `apps/api/src/routes/assessments/`. | §4 |
| CF-6 | The 3 per-process LRUs (TOTP-replay, pre-auth-token, rate-limit) remain deferred to Sprint 7. Sprint 6 must not touch them. **However**, the scope engine's `rate_limit` rule type IS a per-process counter — it lives in `packages/scope-engine` as an injected `RateLimitClock`/`RateLimitCounter` interface (no global state in the engine itself). | A-SE-Rule-RateLimit |
| CF-7 | RBAC matrix changes phrased as "N allows added" not "cardinality A→B". Sprint 6 adds `(role, assessment, scope_validate)` allow grants. | A-SE-RBAC-1    |
| CF-8 | Cross-tenant deny audit row attributed to **actor's tenant** with targeted tenant in `metadata.attemptedResourceTenantId`. Sprint 6's IDOR test on `/scope/validate` must assert this attribution. | A-SE-IDOR-1    |
| CF-9 | Audit-write failure on a deny path returns 500, not the original status (Sprint 4 ADR 0004 §Decision rule #4). Sprint 6 inherits via `denyAudit`. | (implicit)     |
| CF-10 | **Kysely JSONB pitfall (Sprint 5 F5):** any new JSONB write on `assessments`/`assessment_scope_rules` MUST `JSON.stringify(arr)` wrap. Sprint 6 makes NO JSONB writes (engine is pure; route only reads). Documented so Generator does not regress. | (implicit)     |

---

## 4. Files / dirs touched (allowlist)

Generator may add or modify files under:

- `packages/scope-engine/` — **fill** the existing scaffold:
  - `src/types.ts` — input/output types; rule discriminated union (16 kinds); decision shape.
  - `src/normalize/url.ts` — URL normalization (lowercase scheme, punycode hostname, default-port elision, path-traversal collapse).
  - `src/normalize/host.ts` — domain canonicalization (lowercase, trailing-dot strip, IDN/punycode).
  - `src/normalize/ip.ts` — IPv4 dotted/leading-zero/octal/decimal canonicalization, IPv6 RFC 5952 compression, zone-id strip, mapped-IPv4 in IPv6, private/loopback/link-local/metadata classification.
  - `src/normalize/index.ts` — `normalizeAction(input, deps)` orchestrator; classifies, resolves DNS via injected `DnsResolver`, returns `NormalizedAction`.
  - `src/rules/index.ts` — rule-matcher dispatch table (one per rule kind).
  - `src/rules/url.ts`, `src/rules/host.ts`, `src/rules/ip.ts`, `src/rules/cidr.ts`, `src/rules/port.ts`, `src/rules/protocol.ts`, `src/rules/cloud.ts`, `src/rules/k8s.ts`, `src/rules/repo.ts`, `src/rules/time-window.ts`, `src/rules/rate-limit.ts`, `src/rules/tool.ts`, `src/rules/http.ts`, `src/rules/path.ts`.
  - `src/decide.ts` — `decide(scope, action) → Decision`. Two-pass deny-overrides-allow.
  - `src/effective-scope.ts` — `buildEffectiveScope(inputs) → EffectiveScope`. Deduplicates + normalizes rules. Pure.
  - `src/index.ts` — public surface (re-exports).
  - `src/**/*.test.ts` — co-located unit tests. `src/normalize/url.property.test.ts` and `src/normalize/ip.property.test.ts` use `fast-check`.
  - `package.json` — add `fast-check` devDep + `zod` dep + `@cyberstrike/contracts` workspace dep.
- `packages/contracts/src/` — **modify**:
  - `scope-rules.ts` — preserve the existing open-payload `scopeRuleSchema` (Sprint 5 callers `assessmentCreateSchema`/`assessmentPatchSchema` continue to use it for backward compat). ADD a new `strictScopeRuleSchema` (discriminated union over 16 `ruleKind` values) that the engine consumes. Sprint 5's `assessment_scope_rules` rows persisted with arbitrary `rule_kind` strings (outside the 16) parse via the legacy schema → engine maps to `unknown_rule` with `effect=deny` (defense-in-depth, A-SE-Compat-1). The discriminated union is *additive*, not replacing.
  - `scope-validate.ts` — **new** zod DTO for `POST /scope/validate` request + response (`ScopeValidateRequest`, `ScopeValidateResponse`).
  - `scope-action.ts` — **new** `ScopeActionInput` zod DTO (the candidate action shape).
  - `audit.ts` — **modify** `AUDIT_ACTIONS` array: add `'scope.validate.denied'` (single new action — no removals).
  - `index.ts` — re-export.
- `apps/api/src/routes/assessments/scope-validate.ts` — **new** route handler `handleScopeValidate(deps, c)`.
- `apps/api/src/routes/register-routes.ts` — wire `app.post('/api/v1/assessments/:id/scope/validate', tenantGuard(), ...)`.
- `apps/api/src/scope-engine/dns-resolver.ts` — **new** thin `DnsResolver` adapter that imports `node:dns/promises` and conforms to the engine's interface. Lives OUTSIDE the engine package precisely to keep the engine I/O-free (A-SE-Pure-1).
- `apps/api/src/scope-engine/build-scope.ts` — **new** loader: reads `assessment_scope_rules` + `assessment_targets` + project targets + tenant/platform policies for an assessment, returns `EffectiveScope`. Pure-ish (DB I/O at the route layer).
- `tests/integration/scope/` — **new** suite. Required test files:
  - `scope-validate.test.ts` — API endpoint integration (200/403/404, PASS allow, PASS deny + audit row, PASS SSRF metadata-IP, PASS DNS-resolves-private).
  - `scope-engine-precedence.test.ts` — fixtures with conflicting allow+deny rules.
  - `scope-engine-idor.test.ts` — cross-tenant + nonexistent assessment ID matrix.
- `packages/authz/src/matrix/*.ts` — **modify** to add the new `scope_validate` action grant per role.
- `packages/authz/src/matrix.test.ts` — update cardinality and per-role assertions.
- `docs/adr/0006-scope-engine.md` — **new** ADR documenting the deny-overrides-allow rule, the pure-package boundary, the injected-DNS pattern, and the unknown-rule deny default.

Generator **must not** touch:

- `.omx/plans/*`, `PROJECT-SPECS-*`, `STACK-*`, `.harness/cyberstrike-hybrid/product-spec.md` (read-only).
- `packages/db/migrations/0[0-1][0-6]_*.ts` (Sprints 1-5 frozen; **no migration in Sprint 6** — A-SE-DB-1 below).
- `packages/audit/` source — **only** consume; no edits.
- The 3 deferred LRUs (Sprint 7).
- `apps/api/src/routes/auth/*` (Sprint 3 frozen), `apps/api/src/routes/audit-events/*` (Sprint 4 frozen), `apps/api/src/routes/projects/*` and `/targets/*` (Sprint 5 frozen).
- Any new external dep beyond `fast-check` (declared in §11 L-3).

---

## 5. Acceptance criteria (binary, testable)

> **Conventions.**
> - Every `A-SE-*` is a single binary criterion.
> - Coverage threshold: **80% / 80% / 80% / 80%** on `packages/scope-engine/src/**`, `packages/contracts/src/{scope-rules,scope-validate,scope-action}.ts`, `apps/api/src/routes/assessments/scope-validate.ts`, `apps/api/src/scope-engine/build-scope.ts`. The DNS adapter (`dns-resolver.ts`) is exempted because it is a 5-line wrapper around `node:dns/promises` exercised in IT only.
> - Tenant-isolation, IDOR, and C29-delta tests must continue to pass at the full Sprint 1-5 cumulative scope. Sprint 6 adds 1 emission point.

### 5.1. Engine purity

**A-SE-Pure-1.** `packages/scope-engine/src/**/*.ts` contains **zero** import statements matching `from ['"](dns|fs|net|http|https|tls|child_process|os|cluster|dgram|inspector|repl|node:.*)['"]`. Verified by a grep test in CI: `tests/integration/scope/engine-purity.test.ts` walks the directory and parses each TS file's import graph; any forbidden import is a test failure.

**A-SE-Pure-2.** The engine declares its dependencies: `zod` (validation only — no I/O), `@cyberstrike/contracts` (workspace), and `fast-check` (devDep, test-only). No runtime deps with I/O. `package.json` is asserted: any future change adding `dns`/`fs`/`pg`/`kysely` to scope-engine `dependencies` fails `tests/integration/scope/engine-deps.test.ts`.

**A-SE-Pure-3.** DNS resolution is performed via a `DnsResolver` interface defined in the engine and **injected** at every call site:
```ts
export interface DnsResolver {
  resolveA(host: string): Promise<string[]>;       // IPv4
  resolveAAAA(host: string): Promise<string[]>;    // IPv6
}
```
The engine never imports a default implementation. Tests inject a deterministic in-memory resolver. Production injects `apps/api/src/scope-engine/dns-resolver.ts` which wraps `node:dns/promises`.

### 5.2. Effective scope shape

**A-SE-Type-1.** `EffectiveScope` is a frozen, pure record:
```ts
export interface EffectiveScope {
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly allowRules: readonly NormalizedRule[];
  readonly denyRules: readonly NormalizedRule[];
  readonly toolCatalog: ReadonlyMap<string, ToolPolicy>;       // toolName → policy
  readonly assessmentFlags: AssessmentFlags;                   // {highImpactCategories, ownershipVerifiedTargetIds, …}
  readonly timeWindow: TimeWindow | null;                       // {start, end} | null
  readonly platformPolicy: PlatformPolicy;                     // metadata-IP block default-on, etc.
  readonly tenantPolicy: TenantPolicy;
}
```
All arrays/maps are `readonly`/`ReadonlyMap`. `Object.freeze` applied recursively in `buildEffectiveScope` (test asserts attempting to mutate throws in strict mode).

**A-SE-Type-2.** `NormalizedRule` is a discriminated union over `ruleKind`:
```ts
type NormalizedRule =
  | { id: string; kind: 'domain';           effect: 'allow'|'deny'; pattern: string;  matchSubdomains: boolean }
  | { id: string; kind: 'subdomain';        effect: 'allow'|'deny'; parent: string }
  | { id: string; kind: 'url_prefix';       effect: 'allow'|'deny'; prefix: string /* normalized */ }
  | { id: string; kind: 'ip';               effect: 'allow'|'deny'; ip: string /* canonical */ }
  | { id: string; kind: 'cidr';             effect: 'allow'|'deny'; cidr: string /* canonical */ }
  | { id: string; kind: 'port';             effect: 'allow'|'deny'; port: number }
  | { id: string; kind: 'protocol';         effect: 'allow'|'deny'; protocol: 'http'|'https'|'tcp'|'udp'|'ws'|'wss' }
  | { id: string; kind: 'cloud_account';    effect: 'allow'|'deny'; provider: 'aws'|'gcp'|'azure'|'yandex'; accountId: string }
  | { id: string; kind: 'kubernetes_namespace'; effect: 'allow'|'deny'; cluster: string; namespace: string }
  | { id: string; kind: 'repository';       effect: 'allow'|'deny'; vcs: 'github'|'gitlab'|'bitbucket'; owner: string; name: string }
  | { id: string; kind: 'time_window';      effect: 'allow'|'deny'; start: string; end: string /* ISO-8601 */ }
  | { id: string; kind: 'rate_limit';       effect: 'allow'|'deny'; bucket: string; perSecond: number; burst: number }
  | { id: string; kind: 'tool_category';    effect: 'allow'|'deny'; category: 'recon'|'web'|'cloud'|'ad'|'c2'|'post_exploit'|'credential_audit' }
  | { id: string; kind: 'tool_name';        effect: 'allow'|'deny'; toolName: string }
  | { id: string; kind: 'http_method';      effect: 'allow'|'deny'; method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS' }
  | { id: string; kind: 'path_pattern';     effect: 'allow'|'deny'; glob: string };
```
Exactly **16 kinds**. The discriminated union is exported and zod-validated at the contracts boundary.

**R1 — cardinality + per-kind matcher matrix.** `packages/scope-engine/src/types.ts` exports a frozen `RULE_KINDS: ReadonlySet<NormalizedRule['kind']>` with all 16 entries. Test assertions:
- `expect(RULE_KINDS.size).toBe(16)` — fails CI if the union drifts.
- A generated table `RULE_KIND_FIXTURES: Record<RuleKind, { positive: NormalizedAction[]; negative: NormalizedAction[] }>` provides ≥1 positive (matcher returns true) + ≥1 negative (matcher returns false) per kind. Total cardinality ≥32.
- A `bun test`-time `for…of` (or `it.each`) walks `RULE_KINDS` and asserts the matcher table covers each kind in BOTH polarities. Drift in either direction (missing kind, missing polarity) fails the test. Hand-written single-case tests are not sufficient — generated table is the source of truth (mirrors Sprint 5 64-case state-machine pattern).

**R7 — `tool_category` zod enum at request boundary.** The 7-value closed set `'recon'|'web'|'cloud'|'ad'|'c2'|'post_exploit'|'credential_audit'` is encoded as a `z.enum([...])` in `packages/contracts/src/scope-action.ts` AND in `packages/contracts/src/scope-rules.ts`. Any request body containing a category outside the set → 400 `invalid_request_body` at the route layer; the engine NEVER receives a malformed `tool_category` value (no defense-in-depth string-equality check needed in the engine itself).

**A-SE-Type-3.** `Decision` shape (returned by `decide`):
```ts
export interface Decision {
  readonly allowed: boolean;
  readonly reason: string;                          // human-readable
  readonly matchedAllowRuleIds: readonly string[];
  readonly matchedDenyRuleIds: readonly string[];
  readonly normalizedTarget?: NormalizedAction;     // populated when applicable
  readonly toolPolicyResult?: ToolPolicyResult;     // populated for tool-bearing actions
  readonly timeWindowResult?: TimeWindowResult;     // populated if time_window evaluated
}
```
`reason` is a stable enum-like string from a closed set: `'no_matching_allow_rule'`, `'denied_by_rule'`, `'allowed'`, `'metadata_ip_blocked'`, `'private_ip_blocked'`, `'loopback_blocked'`, `'link_local_blocked'`, `'time_window_closed'`, `'rate_limit_exceeded'`, `'tool_not_in_catalog'`, `'tool_category_high_impact_unverified_targets'`, `'http_method_not_allowed'`, `'path_pattern_no_match'`, `'unknown_rule_default_deny'`. Documented in code + ADR.

### 5.3. Normalization

**A-SE-Norm-URL-1.** `normalizeUrl(input)` produces a canonical URL string by: lowercasing scheme, lowercasing host, IDN→punycode (`URL` API + manual fallback for browsers without ICU), trailing-dot strip on host, default-port elision (80 for http, 443 for https), path-traversal segment collapse (`/a/./b` → `/a/b`, `/a/../b` → `/b` capped at root so `/a/../../b` → `/b` not `/../b`), percent-encoding normalisation for unreserved chars, query-string preservation (no reordering — value order matters for some apps), fragment strip.

**A-SE-Norm-URL-2 (R8 — `numRuns` minima).** Property-based test: 1000 fast-check generated URL trees `(scheme, hostShape, port, path, query, fragment)`. Shared `fastCheckOpts` constant exported from `packages/scope-engine/src/test-utils/fc-opts.ts` (or co-located): `URL_RUNS=1000`, `IP_RUNS=200`, `HOST_RUNS=200`. Each property test reads the constant explicitly so the floor is audit-grep-able. Invariants:
- `normalizeUrl(normalizeUrl(u)) === normalizeUrl(u)` (idempotence).
- `normalizeUrl(u).startsWith(scheme.toLowerCase() + '://')`.
- Hostname is ASCII (post-punycode).
- No `..` segment in normalized path.
- Default port never present in normalized output.

**A-SE-Norm-Host-1.** `normalizeHost(input)` lowercases, strips trailing dot, IDN-encodes Unicode, rejects empty/`..`/whitespace, and produces a canonical lowercase ASCII string. Punycode round-trip preserved (e.g. `президент.рф` → `xn--d1abbgf6aiiy.xn--p1ai`). Homograph defense: any host containing characters from mixed scripts beyond `[a-z0-9.-]` after IDN encoding triggers `effect: deny` upstream — the *normalizer* canonicalizes faithfully and the *engine* applies a default-deny on hosts with mixed-script segments unless an explicit `domain` allow rule names the punycode form.

**A-SE-Norm-IP-1.** `normalizeIp(input)` accepts IPv4 (dotted, octal `0177.x.x.x`, leading-zero `192.168.001.1`, hex `0xc0.0xa8.0x01.0x01`, integer `3232235777`) and IPv6 (full, compressed, mapped IPv4 `::ffff:192.0.2.1`, with zone identifier `fe80::1%eth0`). Returns `{family: 'ipv4'|'ipv6', canonical: string, zoneId?: string, classification: 'public'|'private'|'loopback'|'link_local'|'metadata'|'reserved'}`. RFC 5952 compression for IPv6.

**A-SE-Norm-IP-2 (R4 — IPv6 zone-id stripped from canonical).** Property test: random IPv4/IPv6 generated; `normalizeIp(normalizeIp(x).canonical)` is idempotent; classification matches RFC 1918 / RFC 4193 / RFC 6890. **The `zoneId` is returned in a side field but is NOT included in `canonical`.** Rule matchers (`ip`, `cidr`) compare against `canonical` only — an action with target `fe80::1%eth0` MUST NOT smuggle past a deny rule on `fe80::1`. Test fixture (`tests/integration/scope/scope-engine-precedence.test.ts`): seed deny rule on `fe80::1`; submit action against `fe80::1%eth0` → `allowed:false, matchedDenyRuleIds includes fe80::1 rule id`. Specific oracle:
- `127.0.0.0/8` → `loopback`.
- `169.254.0.0/16` → `link_local`.
- **`169.254.169.254/32` → `metadata`** (cloud-IMDS canonical).
- `100.100.100.200/32` → `metadata` (Yandex Cloud IMDS).
- `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12` → `private`.
- `::1` → `loopback`. `fe80::/10` → `link_local`. `fc00::/7` → `private`.

**A-SE-Norm-Action-1.** `normalizeAction(input, deps)` is the single entry. Input is a discriminated union (`{kind:'http_request', url, method?}` | `{kind:'dns_lookup', host}` | `{kind:'tcp_connect', host, port}` | `{kind:'tool_invoke', toolName, toolCategory, targetRef}` | `{kind:'cloud_call', provider, accountId, op}` | `{kind:'k8s_call', cluster, namespace, op}` | `{kind:'repo_op', vcs, owner, name, op}`). For network-bearing actions whose target is a hostname, `normalizeAction` calls `deps.dns.resolveA/resolveAAAA` and attaches resolved IPs into `NormalizedAction.resolvedIps[]`. Returns the canonical normalized form OR a `NormalizationError` (e.g. invalid URL). Errors short-circuit `decide` to `allowed:false, reason:'normalization_error'`.

### 5.4. Decision algorithm

**A-SE-Pri-1 (deny overrides allow).** `decide(scope, action)`:
1. Normalize action via `normalizeAction` (DNS may execute here).
2. Apply platform-policy guards FIRST (default-on): metadata-IP → deny `metadata_ip_blocked`; private/loopback/link-local IP → deny unless an explicit `cidr` or `ip` allow rule names that range. (The default-on guard is the SSRF defense.)
3. Evaluate every deny rule against the normalized action. Collect IDs of all matchers. If `matchedDenyRuleIds.length > 0` → `allowed: false`, `reason: 'denied_by_rule'`, return.
4. Evaluate every allow rule. Collect IDs. If at least one matches AND every required dimension (host/url/ip/port/protocol/tool/method/path) is covered by allows → `allowed: true`, `reason: 'allowed'`.
5. If no deny matched but no allow covers all required dimensions → `allowed: false`, `reason: 'no_matching_allow_rule'`.
6. Time window applies as a ROUTE-WIDE gate before allow evaluation: `now ∉ scope.timeWindow` → `allowed: false, reason: 'time_window_closed'` (regardless of allow rules). `time_window` rules within the rule list are an additional layer (per-action windows, e.g. "allow recon only between 02:00-06:00").
7. Tool category high-impact gate: `tool_category` ∈ {`c2`,`post_exploit`,`ad`,`credential_audit`} AND any target's ownershipStatus≠'verified' → `allowed: false, reason: 'tool_category_high_impact_unverified_targets'`.
8. Rate-limit rule: counter from injected `RateLimitCounter.consume(bucketKey, perSecond, burst)` returns `{ok, retryAfterMs}`. `ok=false` → deny `rate_limit_exceeded`.

**A-SE-Pri-2.** Conflicting overlapping rules (deny CIDR `10.0.0.0/8` + allow IP `10.1.2.3`): deny wins by §A-SE-Pri-1 step 3. Test fixture in `scope-engine-precedence.test.ts`.

**A-SE-Pri-3.** Unknown rule kind (forward-compat): `effect=deny`, `reason=unknown_rule_default_deny`. Surfaces in `matchedDenyRuleIds` with the rule's id.

**A-SE-Time-Boundary-1 (R2 + R3 promoted to binary criterion).** `decide()` accepts a `Clock` interface in its dependency bag (`{ now(): Date }`), parallel to `DnsResolver` and `RateLimitCounter`. Two binary assertions:
- **No retroactive mutation** — fixture: assessment-window `[start, end)` with a single allow rule covering all dimensions. Inject a clock that returns `T = end - 1ms` for call #1 and `T = end + 1ms` for call #2. Assert: call #1 returns `allowed:true`; call #2 returns `allowed:false reason:'time_window_closed'`. Call #1's returned `Decision` object is captured before call #2 runs and asserted byte-identical (deep-equal) AFTER call #2 — proves no shared mutable state.
- **Half-open boundary `[start, end)`** — five test points per assessment window: `T ∈ {start-1ms, start, end-1ms, end, end+1ms}` → expected `{deny, allow, allow, deny, deny}`. Same five-point matrix for any `time_window`-kind rule (rule-level window). Convention pinned and documented in ADR 0006 §Decision D6.

**A-SE-Compat-1 (R6 — schema migration compat).** Sprint 5 IT seeded `assessment_scope_rules` rows via `seedScopeRule(db, opts)` with `rule_kind ∈ {'domain','ip','cidr','url_prefix',...}` and a `payload` shaped to match the legacy open record. Test `tests/integration/scope/scope-rule-compat.test.ts`:
- Seeds a Sprint-5-shape row with `rule_kind='domain'` + `payload={domain:'example.com',matchSubdomains:true}` → new `scopeRuleSchema` (strict discriminated union) parses → engine sees a strongly-typed `domain` rule.
- Seeds a row with `rule_kind='garbage_unknown'` → `legacyScopeRulePayload` accepts (record-shape preserved); engine maps it to `unknown_rule` → A-SE-Pri-3 default-deny.
- Asserts `legacyScopeRulePayload` is *exported* from `@cyberstrike/contracts` for read-side compatibility but is *not used* on the new write path (write path uses `scopeRuleSchema`).

### 5.5. SSRF + DNS-resolved-private hardening

**A-SE-SSRF-1.** Action `{kind:'http_request', url:'http://169.254.169.254/...'}` → `decide` returns `allowed:false, reason:'metadata_ip_blocked'` regardless of allow rules. To override, the scope must contain an explicit `ip` allow rule with `ip='169.254.169.254'` AND a `platformPolicy.allowMetadataIpExplicit=true` flag (set only by platform_admin in a future sprint; default false).

**A-SE-SSRF-2.** Action against a domain whose `resolveA` returns `192.168.1.10`:
- Default platform policy → `allowed:false, reason:'private_ip_blocked'`.
- Override: scope contains an explicit `cidr` allow `192.168.0.0/16` → resolver-returned IP matched against allow → `allowed:true`.

**A-SE-SSRF-3 (R11 — exhaustive iteration, order-independent).** Mixed-resolution: domain resolves to two IPs `[8.8.8.8, 192.168.1.5]`. Default → deny on the private one (any-private-IP-in-resolution = deny). Override requires explicit allow for the private range; if explicit allow covers the public IP only → still deny (cannot leak via private leg). **Engine iterates ALL resolved IPs with no short-circuit on the first public one.** Test asserts order-independence: same fixture run with `[8.8.8.8, 192.168.1.5]` AND `[192.168.1.5, 8.8.8.8]` produces byte-identical `Decision` objects (modulo IP-list ordering — assertion is deep-equal on `{allowed, reason, matchedDenyRuleIds, matchedAllowRuleIds}`, set-equal on `normalizedTarget.resolvedIps`).

**A-SE-SSRF-4.** Cross-scope redirect simulation: caller passes `{kind:'http_request', url:'https://allowed.example.com/r', followRedirectsTo: ['https://attacker-controlled.org/']}`. Engine evaluates EACH URL independently. The redirect destination is denied → overall `allowed:false`, `matchedDenyRuleIds` includes the redirect-denying rule, `metadata.redirect_target` populated. Audited.

### 5.6. The `POST /api/v1/assessments/:id/scope/validate` endpoint

**A-SE-Route-1.** `POST /api/v1/assessments/:id/scope/validate` accepts:
```ts
ScopeValidateRequest = {
  action: ScopeActionInput,        // discriminated union per §5.3 A-SE-Norm-Action-1
}
```
Returns:
```ts
ScopeValidateResponse = Decision    // §5.2 A-SE-Type-3
```
Status codes:
- 200 — engine produced a decision (allow OR deny). Body is the `Decision`.
- 400 — request body fails zod validation.
- 403 — `assertOwnership` denies (cross-tenant assessment id).
- 404 — assessment not found in any tenant.
- 422 — assessment is in a terminal state (`completed`/`cancelled`/`failed`) — engine refuses to evaluate against a closed scope. Body: `{error:'assessment_terminal', state}`.

RBAC: `security_lead`, `tenant_admin`, `operator`, `auditor`. Read-only to actor — does not mutate state. **No `Idempotency-Key` required** (read-only by design; see CF-6 / Sprint 5 R6 — Idempotency-Key is for state-transition POSTs only).

**A-SE-Route-2.** Audit emission rules:
- `Decision.allowed === true` → **no audit row** (read-only success; volume control).
- `Decision.allowed === false` → exactly one `denyAudit` row with `action='scope.validate.denied'`, `outcome='denied'`, `actorType='user'`, attribution per CF-8, `metadata = { matchedDenyRuleIds, normalizedTarget, reason, actionKind }`.

**A-SE-Route-3.** Cross-tenant + nonexistent precedence: same as Sprint 5 A-IDOR-2:
- T1 cookie + T1 assessment → 200.
- T1 cookie + T2 assessment → 403 + `rbac.deny` audit (T1's tenant, `attemptedResourceTenantId=T2`).
- T1 cookie + nonexistent UUID → 404 (no audit emission).

**A-SE-Route-4 (R9 — DB-gated).** Existence-oracle test: p95(403) and p95(404) within 50ms over N≥30 measurements (mirrors Sprint 5 A-IDOR-2 pattern). **Test gated by `describe.skipIf(!hasDatabaseUrl())`** at file `tests/integration/scope/p95-oracle.test.ts`. No-DB CI run skips this suite cleanly.

### 5.7. RBAC matrix changes

**A-SE-RBAC-1.** Add `(role, assessment, scope_validate)` allow grants. **Note:** auditor's C10 invariant ("read+list on every resource, nothing else") is preserved — auditor does NOT get `scope_validate` (it's not a read/list action; it's a side-effect-bearing pre-flight that may emit a deny audit row). Auditors observe denies via the existing `audit_log` access path and `assessment.timeline` (Sprint 5 A-Asm-11).

| Role            | Has `scope_validate`? |
|-----------------|------------------------|
| platform_admin  | (no change)            |
| tenant_admin    | yes                    |
| security_lead   | yes                    |
| operator        | yes                    |
| developer       | no                     |
| auditor         | no (C10 invariant)     |
| viewer          | no                     |

**3 new allows** (tenant_admin, security_lead, operator). Phrased "3 allows added" per CF-7. `packages/authz/src/matrix.test.ts` cardinality assertion updated; per-role explicit assertions added. Resource × action growth: 13 × 14 = 182 → 13 × 15 = 195 cells per role × 7 roles = 1365 total (was 1274 → +91 cells, of which 3 are allow flips).

**A-SE-RBAC-2.** Negative regression: `developer` and `viewer` calling `POST /scope/validate` → 403 + single `rbac.deny` audit row attributed to actor's tenant.

### 5.8. Audit emission (CF-1)

**A-SE-Audit-1.** Sprint 6 adds **1** new emission point: `scope.validate.denied`. The `assertExactlyOneAuditRow` regression test extends to enumerate this. Combined with Sprint 5's 26 → expected **27** enumerated entries. Final count recorded in `sprint-6-result.md`.

**A-SE-Audit-2.** Per-tenant isolation test: T1 deny → only T1's auditor sees the row. T2 auditor does not. `__platform__` rows continue hidden.

**A-SE-Audit-3.** `redact()` (Sprint 4 A16) is applied to `metadata.normalizedTarget` before insert: any header-like / token-like substring is REDACTED. Test fixture: a URL with `?token=abc123secret` → audit row's `metadata.normalizedTarget.url` shows `?token=REDACTED`.

### 5.9. IDOR + tenant isolation

**A-SE-IDOR-1.** Mirror Sprint 5 A-IDOR-1: every cross-tenant attempt produces a `rbac.deny` row attributed to actor's tenant per CF-8.

### 5.10. Database

**A-SE-DB-1.** **No new migration in Sprint 6.** Migration 004 already provides `assessment_scope_rules`; Sprint 5 migration 016 added `assessment_targets`, `idempotency_keys`, `target_ownership_claims`, `assessment_approvals`. The engine reads from these tables via the route layer (`apps/api/src/scope-engine/build-scope.ts`); no new persistence is introduced.

**A-SE-DB-2.** All Sprint 1-5 migrations continue to apply cleanly (`bun run db:migrate:check`).

**A-SE-DB-3.** No JSONB writes in Sprint 6 — the engine is pure, the route reads only. CF-10 documented but not exercised.

### 5.11. Documentation

**A-SE-Doc-1.** `docs/adr/0006-scope-engine.md` contains:
- §Context — single source of truth across API, coordinator, workers, validator, report-builder. Why pure / why DI.
- §Decision — D1 deny-overrides-allow; D2 unknown-rule-default-deny; D3 platform metadata-IP guard default-on; D4 DNS via injected interface; D5 audit deny event shape.
- §Consequences — Sprints 7+ consume `decide()` directly without rewrites; the per-process LRU concern stays out of the engine (rate_limit counter injected too, A-SE-Rule-RateLimit).
- §Alternatives — including DNS-as-direct-import (rejected: violates I/O-free invariant); allow-overrides-deny (rejected: §A-SE-Pri-1 + spec §1.3); unknown-rule-default-allow (rejected: forward-compat security risk).

### 5.12. Cumulative regression

**A-SE-Reg-1.** All Sprint 1-5 tests continue to pass at the full PG-backed scope. `bun run lint`, `bun run typecheck`, `bun run db:migrate:check`, `bun test` (no DATABASE_URL), and `DATABASE_URL=… bun test` all green. Sprint 5 baseline 566 PG tests becomes the floor; Sprint 6 reports the new total in `sprint-6-result.md`.

**A-SE-Reg-2.** Path-footguns grep extended to `packages/scope-engine/src/`, `apps/api/src/routes/assessments/scope-validate.ts`, `apps/api/src/scope-engine/`, `tests/integration/scope/`. Zero hits required for the existing footgun list.

**A-SE-Reg-3.** **Engine-purity grep test** (A-SE-Pure-1) lives in `tests/integration/scope/engine-purity.test.ts`. Walks `packages/scope-engine/src/**/*.ts`, asserts zero forbidden imports.

---

## 6. Open questions (Evaluator to resolve)

- **OQ-1.** Should the Sprint 5 `ScopeRule` schema in `packages/contracts/src/scope-rules.ts` (open `payload: Record<...>`) be *replaced* or *extended* with the discriminated union? Generator recommends **extend**: keep the loose schema as `legacyScopeRulePayload` for migration-compatibility reads, ship the strict discriminated union as `scopeRuleSchema` (the active write path). Sprint 5 IT created scope rules with `ruleKind: 'domain'` and a record-shaped payload that the new union also accepts (the new schema is strictly tighter for the same shape).
- **OQ-2.** Should `decide()` be **async** (because `normalizeAction` may call DNS) or **sync with pre-resolved IPs**? Generator recommends **async** — caller passes a fully-resolved `NormalizedAction` only when DNS pre-resolution is desired; the engine itself awaits the injected resolver. Sync purity is preserved: `decide` performs no I/O; the awaited call goes through the injected interface.
- **OQ-3.** Tool catalog source-of-truth for Sprint 6 — is there an existing `tool_catalog` table, or do we synthesize the catalog from a static fixture? Sprint 5 did not ship one. Generator recommends: **static fixture in `apps/api/src/scope-engine/tool-catalog.ts`** (a hard-coded list with the 7 categories + a placeholder set of tools). Sprint 8 (fake Decepticon) and Sprint 10 (validators) refine this. Until then, the engine accepts whatever `toolCatalog` map is passed; the API loader hands it the static fixture.
- **OQ-4.** Time-window precedence — assessment-level `scope.timeWindow` (single window) vs `time_window`-kind rules. Generator recommends **both gate independently, AND-composed**: out-of-assessment-window → deny; in-assessment-window but out-of-rule-window → still deny if rule is `allow` and `now ∉ rule.window`; rule with `effect=deny` AND `now ∈ rule.window` → deny. Conservative.
- **OQ-5.** Rate-limit counter persistence. Generator recommends **in-process `RateLimitCounter` interface** that the engine receives. Sprint 6 ships an in-memory implementation (test + dev). Sprint 7+ may swap to a Redis-backed one. The engine itself stores nothing.
- **OQ-6.** Should `Decision` carry a stable diagnostic `code` field separate from `reason`? Generator says no — `reason` IS the closed-set diagnostic code per §5.2 A-SE-Type-3. Adds simplicity; tests assert on string equality.
- **OQ-7.** Existence-oracle p95 threshold. Sprint 5 used 50ms. Generator recommends same 50ms for parity.
- **OQ-8.** Mixed-script host policy (homograph) — should the engine *block* or *flag*? Generator recommends **block by default** (deny) unless explicit `domain` allow names the punycode form. Cleaner security posture.

---

## 7. Verification commands (Evaluator copy-paste)

```bash
cd "/Users/saveliy/Documents/пентест ИИ"

bun run bun:assert-version
bun run lint
bun run typecheck

docker compose -f infra/docker/docker-compose.local.yml up -d
bun run db:migrate:check

bun test  # no DB

DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test  # full

DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test --coverage \
  packages/scope-engine \
  packages/contracts/src/scope-rules.ts \
  packages/contracts/src/scope-validate.ts \
  packages/contracts/src/scope-action.ts \
  apps/api/src/routes/assessments/scope-validate.ts \
  apps/api/src/scope-engine/build-scope.ts \
  tests/integration/scope

bun run check:path-footguns

# Manual probe — engine purity grep
grep -rE "from ['\"](dns|fs|net|http|https|tls|child_process|os|cluster|dgram|node:dns|node:fs|node:net|node:http|node:https|node:tls|node:child_process|node:os)['\"]" packages/scope-engine/src/ && echo "FORBIDDEN IMPORT FOUND" || echo "engine purity OK"

# Manual probe — SSRF metadata-IP block
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/scope/scope-validate.test.ts -t 'SSRF metadata-IP'

# Manual probe — DNS-resolved-private deny
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/scope/scope-validate.test.ts -t 'dns resolves private'
```

---

## 8. Dependencies

- Sprints 1-5 PASS (HEAD `9f5a732`).
- New external dep: **`fast-check@^3.23.1`** as a devDep on `packages/scope-engine` (already in `packages/audit/package.json` at the same version — re-use).
- No new prod deps. No new migration.

---

## 9. Test strategy

| Layer                        | Tooling                     | Where |
|------------------------------|-----------------------------|-------|
| Unit (normalize URL)         | `bun test`                  | `packages/scope-engine/src/normalize/url.test.ts` + `url.property.test.ts` |
| Unit (normalize host)        | `bun test`                  | `packages/scope-engine/src/normalize/host.test.ts` (incl. IDN homograph) |
| Unit (normalize IP)          | `bun test`                  | `packages/scope-engine/src/normalize/ip.test.ts` + `ip.property.test.ts` |
| Unit (rules — 16 kinds)      | `bun test`                  | `packages/scope-engine/src/rules/*.test.ts` (one per rule kind, table-driven) |
| Unit (decide priority)       | `bun test`                  | `packages/scope-engine/src/decide.test.ts` (deny-overrides-allow matrix) |
| Unit (build effective scope) | `bun test`                  | `packages/scope-engine/src/effective-scope.test.ts` |
| Engine purity (grep)         | `bun test`                  | `tests/integration/scope/engine-purity.test.ts` |
| Engine deps (manifest)       | `bun test`                  | `tests/integration/scope/engine-deps.test.ts` |
| Integration (PG-backed)      | `bun test` w/ `DATABASE_URL`| `tests/integration/scope/{scope-validate,scope-engine-precedence,scope-engine-idor}.test.ts` |
| C29-delta regression         | extend                      | `tests/integration/audit/c29-delta.test.ts` (+1 emission point) |
| IDOR + tenant isolation      | extend                      | `tests/integration/idor/scope-validate.test.ts` |
| Cumulative regression        | full PG-backed run          | floor 566 → target 566 + (new) |

---

## 10. Sliced delivery (Generator's call)

1. **Slice 1** — `packages/contracts/src/{scope-rules,scope-validate,scope-action}.ts` strict zod DTOs + audit action constant + ADR 0006. Tests pass.
2. **Slice 2** — `packages/scope-engine/src/types.ts` + `normalize/{url,host,ip,index}.ts` with property tests. Tests pass.
3. **Slice 3** — `packages/scope-engine/src/rules/*.ts` (all 16 kinds) + matcher dispatch + `effective-scope.ts`. Tests pass.
4. **Slice 4** — `packages/scope-engine/src/decide.ts` with the priority algorithm + SSRF/DNS hardening. Property + matrix tests pass.
5. **Slice 5** — `apps/api/src/scope-engine/{build-scope,dns-resolver}.ts` + `apps/api/src/routes/assessments/scope-validate.ts` route handler + register-routes wiring + RBAC matrix grants. IT pass.
6. **Slice 6** — IDOR matrix + audit emission + path-footguns + engine-purity test + `sprint-6-result.md`.

Slices are advisory.

---

## 11. Limitations (explicitly out of scope; Evaluator must not flag)

- **L-1.** No queue dispatch on engine deny — coordinator pre-enqueue lands Sprint 7.
- **L-2.** No worker pre-execution guard — Sprint 9.
- **L-3.** New devDep `fast-check@^3.23.1` declared (already used in `packages/audit`).
- **L-4.** No real ownership-verification flow change. Sprint 5's `ownership_status='verified'` signal is consumed; no new write paths.
- **L-5.** No findings, evidence, observations, reports surface. Sprints 9-12.
- **L-6.** No `Idempotency-Key` for `/scope/validate` — read-only by design.
- **L-7.** No persistence for `RateLimitCounter` — in-process only this sprint (Sprint 7 may swap).
- **L-8.** No new migration. Tables already exist from Sprints 2/4/5.
- **L-9.** No cost cap — spec §2.5 says cost caps never block.
- **L-10.** No platform-admin-only `allowMetadataIpExplicit=true` toggle endpoint — engine accepts the flag but no API surface to flip it. Phase 9 / future sprint.
- **L-11.** No `tool_catalog` table or CRUD — static fixture per OQ-3.
- **L-12.** No CIDR overlap-detection / static-conflict warnings — runtime evaluation only. Future sprint.

---

## 12. Workflow

1. Evaluator reviews this contract; resolves OQ-1 through OQ-8; sends revisions or approval.
2. Generator implements per the slice plan. TDD throughout. Each slice: `bun run lint && bun run typecheck && bun test` green before moving on. **R10 — pre-edit gitnexus_impact:** before editing each shared symbol, Generator runs `gitnexus_impact({target, direction:'upstream', repo:'пентест ИИ'})` and reports the blast radius. Symbols on the impact-must-run list:
   - `seedAssessment` (extended for new IT helpers).
   - `assertOwnership` (consumed by scope-validate route).
   - `denyAudit` (consumed for `scope.validate.denied`).
   - The RBAC matrix array exports in `packages/authz/src/matrix/*.ts` (per-role).
   - `register-routes` (new mount point added).
   - `scopeRuleSchema` and `auditActionSchema` (in contracts).
   Any HIGH/CRITICAL risk warning surfaces in `sprint-6-result.md`; Generator does not silently override.
3. Before claiming done: full PG-backed run, coverage gate ≥80% on the §5 surfaces, engine-purity grep clean, gitnexus_detect_changes() shows only the §4 allowlist scope.
4. Generator writes `sprint-6-result.md` with cumulative test count, RBAC allow delta count (CF-7 phrasing), path-footguns scan, audit emission count (27), and any open follow-ups.
5. Evaluator runs §7 commands + writes `evaluator-probe-sprint6.ts` with orthogonal probes targeting:
   - 16-rule-kind matcher matrix (one probe per kind).
   - Deny-overrides-allow with overlapping CIDRs.
   - SSRF metadata-IP block (3 forms: literal IP, DNS-resolved, redirect target).
   - IDN homograph deny on a Cyrillic-Latin mixed-script host.
   - IPv6 zone-identifier handling.
   - Time-window expiry on next action (not retroactive).
   - Cross-tenant + nonexistent precedence with audit attribution.
   - Engine-purity grep on the source tree.
   - Coverage threshold met on the §5 surfaces.
6. PASS → Lead clears Sprint 7 (queue + assessment.start envelope).
7. FAIL → up to 3 Generator↔Evaluator iterations, then escalate.

---

End of contract.
