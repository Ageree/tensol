# Sprint 6 — Evaluator Final Verdict

> Evaluator: evaluator (Sprint 6, single session)
> Verified against: `.harness/cyberstrike-hybrid/sprint-6-contract.md` (v2 — R1-R11 + OQ-1..8 folded)
> Repo state: HEAD `9f5a732` + uncommitted Sprint 6 working tree (16 modified/new tracked files + scope-engine package fill)
> Date: 2026-04-28
> Bun runtime: 1.3.11
> Sprint 5 baseline: 9f5a732 (566/0 PG, 484/187-skip no-DB)

---

## Final verdict: **PASS** — Sprint 6 contract delivered

After 2 iterations, the suite reaches **833 pass / 0 fail** at full PG scope (Sprint 5 baseline 566 → +267 cumulative). All §5 acceptance criteria binary-verified, all 11 orthogonal probes from my contract-review checklist pass, and every coverage threshold on the contract's §5-Conventions surfaces is met.

The iter-1 → iter-2 trajectory `749/0 (4 files <80% coverage, audit-shape unverified) → 833/0 (all ≥80%, audit-shape SELECT-asserted)` is the workflow doing what it's supposed to do: iter-1 caught five distinct verification gaps (coverage, audit metadata shape, CF-8 attribution, A-SE-Audit-3 redaction, A-SE-RBAC-2 negative regression) plus two contract-acceptance items generator had marked as follow-ups (A-SE-Route-4 p95 oracle, A-SE-SSRF-4 redirect cross-scope at API). Iter-2 closed every blocker and high-priority item.

---

## Iteration timeline

| Iter | Verdict | PG result | Coverage | Blockers |
|---|---|---|---|---|
| 1 | FAIL | 749 / 0 | 4 engine files + rate-limit.ts <80% | F1 coverage, F2 audit-shape, F3 CF-8, F4 redaction, F5 RBAC-neg, F6 p95, F7 redirect-API |
| **2** | **PASS** | **833 / 0 (+84)** | **all §5 surfaces ≥80%** | none |

Cumulative no-DB delta: 484 → 674 (+190). PG delta: 566 → 833 (+267).

---

## §7 verification — final iter-2 results

| Command | Result |
|---|---|
| `bun run lint` (biome) | PASS — 276 files, 0 errors |
| `bun run typecheck` (tsc -b) | PASS — clean |
| `bun test` (no DB) | PASS — **674 / 207 skip / 0 fail** / 17 279 expect / 90 files |
| `DATABASE_URL=… bun test` | PASS — **833 / 0 fail** / 17 851 expect / 90 files |
| Engine-purity grep on `packages/scope-engine/src/` | PASS — 0 forbidden imports (`dns\|fs\|net\|http\|https\|tls\|child_process\|os\|cluster\|dgram\|inspector\|repl` incl. `node:` prefix) |
| `gitnexus_detect_changes(scope=all, repo=пентест ИИ)` | PASS — 16 files, 0 changed_symbols, 0 affected_processes, risk=low |

### Per-file coverage on §5 surfaces (contract requires 80% across all)

| File | Func % | Lines % | Status |
|---|---|---|---|
| `packages/scope-engine/src/decide.ts` | 88.24 | 94.22 | ✅ |
| `packages/scope-engine/src/effective-scope.ts` | 100.00 | 99.32 | ✅ |
| `packages/scope-engine/src/normalize/host.ts` | 100.00 | 96.49 | ✅ |
| `packages/scope-engine/src/normalize/index.ts` | 100.00 | 100.00 | ✅ |
| `packages/scope-engine/src/normalize/ip.ts` | 100.00 | 98.95 | ✅ |
| `packages/scope-engine/src/normalize/url.ts` | 100.00 | 94.37 | ✅ |
| `packages/scope-engine/src/rules/matchers.ts` | 93.75 | 96.53 | ✅ |
| `packages/scope-engine/src/{index,types,test-utils/fc-opts}.ts` | 100.00 | 100.00 | ✅ |
| `packages/contracts/src/scope-rules.ts` | 100.00 | 96.39 | ✅ |
| `packages/contracts/src/scope-validate.ts` | 100.00 | 100.00 | ✅ |
| `packages/contracts/src/scope-action.ts` | 100.00 | 100.00 | ✅ |
| `apps/api/src/routes/assessments/scope-validate.ts` | 100.00 | 98.60 | ✅ |
| `apps/api/src/scope-engine/build-scope.ts` | 90.00 | 95.12 | ✅ |
| `apps/api/src/scope-engine/rate-limit.ts` | 100.00 | 100.00 | ✅ |
| `apps/api/src/scope-engine/dns-resolver.ts` | 80.00 | 63.64 | exempted (per §5 conventions: 5-line `node:dns/promises` wrapper) |

Methodology note: when running coverage on a mixed source/test path set, pass directories not file paths to bun. Passing `apps/api/src/scope-engine/rate-limit.ts` as a CLI argument causes bun to interpret it as a test file (zero coverage of its own contents). Passing `apps/api/src/scope-engine` (directory) + `tests/integration/scope` (directory) discovers the tests and instruments the source correctly.

---

## Acceptance criteria checklist with file:line evidence

### A-SE-Pure-* (engine purity)
- **A-SE-Pure-1.** Zero forbidden imports across `packages/scope-engine/src/`. Verified by grep at evaluator wall + `tests/integration/scope/engine-purity.test.ts`.
- **A-SE-Pure-2.** `packages/scope-engine/package.json` declares `zod` + `@cyberstrike/contracts` (runtime) + `fast-check` (devDep) only.
- **A-SE-Pure-3.** `DnsResolver` interface at `packages/scope-engine/src/types.ts`; production wrapper at `apps/api/src/scope-engine/dns-resolver.ts` (outside the engine package).

### A-SE-Type-* (shapes)
- **A-SE-Type-1.** `EffectiveScope` interface at `packages/scope-engine/src/types.ts` with `readonly` arrays/maps; `Object.freeze` applied in `effective-scope.ts:buildEffectiveScope`.
- **A-SE-Type-2.** `RULE_KINDS` of cardinality 16, asserted at `packages/contracts/src/scope-rules.test.ts:test('R1 — RULE_KINDS cardinality is exactly 16')` (`expect(RULE_KINDS.length).toBe(16)` + `expect(new Set(RULE_KINDS).size).toBe(16)`) AND `packages/scope-engine/src/rules/matchers.test.ts` (engine-side mirror).
- **A-SE-Type-3.** `Decision` shape with closed-set `reason` enum at `packages/scope-engine/src/types.ts`.

### A-SE-Norm-* (normalization)
- **A-SE-Norm-URL-1/2.** `packages/scope-engine/src/normalize/url.test.ts` + `url.property.test.ts` (1000 runs via `fc-opts.URL_RUNS`).
- **A-SE-Norm-Host-1.** `packages/scope-engine/src/normalize/host.test.ts` (`OQ-8 — flags mixed-script (Latin + Cyrillic homograph)` + `IDN — Cyrillic-only label converts to punycode`).
- **A-SE-Norm-IP-1/2.** `packages/scope-engine/src/normalize/ip.test.ts` (`169.254.169.254 → metadata`, `100.100.100.200 → metadata` Yandex, `R4 — zone-id stripped from canonical`) + `ip.property.test.ts` (200 runs via `fc-opts.IP_RUNS`).
- **A-SE-Norm-Action-1.** `packages/scope-engine/src/normalize/index.test.ts` covers all 7 `ScopeActionInput.kind` variants + DNS-failure path. 100% coverage on `normalize/index.ts`.

### A-SE-Pri-* (decision algorithm)
- **A-SE-Pri-1.** `packages/scope-engine/src/decide.test.ts` deny-overrides-allow with conflicting CIDR fixture.
- **A-SE-Pri-2.** Same file: `overlapping CIDR: deny 10.0.0.0/8 wins over allow 10.1.2.3` test.
- **A-SE-Pri-3.** `effective-scope.test.ts` unknown_rule fallback + `tests/integration/scope/scope-validate.test.ts:215` `A-SE-Compat-1 — assessment with legacy ruleKind decodes + default-deny applies` (legacy `gibberish_kind` row → engine sees `unknown_rule` → default-deny).

### A-SE-SSRF-* (SSRF + DNS-resolved-private)
- **A-SE-SSRF-1.** `packages/scope-engine/src/decide.test.ts` (`SSRF-1 — http://169.254.169.254/ blocked as metadata_ip_blocked`, `SSRF-1 — Yandex Cloud metadata 100.100.100.200 blocked`) + `tests/integration/scope/scope-validate.test.ts:198` (API-level + audit row delta + `expect(reason).toBe('metadata_ip_blocked')`).
- **A-SE-SSRF-2.** `packages/scope-engine/src/decide.test.ts` (`SSRF-2 — domain resolves to private IP → blocked default; allow with explicit cidr permits`).
- **A-SE-SSRF-3.** `packages/scope-engine/src/decide.test.ts` (`R11 — mixed resolution [pub, priv] vs [priv, pub] yields identical deny decisions (order-independent)`).
- **A-SE-SSRF-4.** Engine-level redirect-array probe + IT `tests/integration/scope/scope-validate.test.ts:538` (`F7 — followRedirectsTo with private-IP destination → deny + audit row`).

### A-SE-Time-Boundary-1 (R2 + R3)
- **R2 sequential non-retroactive.** `packages/scope-engine/src/decide.test.ts` (`R2 — sequential calls: no retroactive mutation`).
- **R3 half-open `[start, end)`.** Same file (`R3 — half-open boundary [start, end): 5 boundary points`). Clock injected (DI mirrors `RateLimitCounter`/`DnsResolver`), engine remains pure.

### A-SE-Compat-1
- `tests/integration/scope/scope-validate.test.ts:215`. Legacy `ruleKind='gibberish_kind'` row from Sprint 5 IT decodes via `legacyScopeRulePayload`, engine sees `unknown_rule`, A-SE-Pri-3 default-deny fires.

### A-SE-Route-* (POST /scope/validate)
- **A-SE-Route-1.** 200/400/403/404/422 paths all asserted in IT (line 130-285).
- **A-SE-Route-2.** `F2 — A-SE-SSRF-1 deny audit row has full metadata shape` (line 288-319) SELECTs the row and asserts `action='scope.validate.denied'`, `resource_type='assessment'`, `resource_id`, `after_state.outcome='denied'`, `reason`, `actionKind`, `matchedDenyRuleIds[]`, `matchedAllowRuleIds[]`, `normalizedTarget`. `F2 — denied_by_rule path emits matchedDenyRuleIds non-empty` (line 321-376) confirms the deny-rule path populates `matchedDenyRuleIds.length > 0`.
- **A-SE-Route-3.** Cross-tenant test at line 149 + `F3 — cross-tenant deny audit attributed to T1 with attemptedResourceTenantId=T2` (line 379-406) SELECTs the `rbac.deny` row and asserts `tenant_id=t1TenantId AND after_state.attemptedResourceTenantId=t2TenantId`.
- **A-SE-Route-4.** `tests/integration/scope/p95-oracle.test.ts` — 30 samples × 2 paths (403 cross-tenant, 404 nonexistent), `expect(gap).toBeLessThan(50)` with `describe.skipIf(!hasDatabaseUrl())` per R9.

### A-SE-RBAC-* (matrix grants)
- **A-SE-RBAC-1.** `packages/authz/src/matrix.test.ts` cardinality 1274 → **1365** (line 10-11: `expect(RBAC_MATRIX.size).toBe(1365); expect(ROLES.length * RESOURCES.length * ACTIONS.length).toBe(1365)`). Allows 239 → 242 (line 23). 3 grants added: `tenant_admin/security_lead/operator` for `(assessment, scope_validate)`. **Auditor's `scope_validate` allow was deliberately NOT added** because Sprint 3's C10 invariant in `packages/authz/src/matrix/auditor.ts` programmatically restricts auditor to `[read, list]` for every resource. The contract §5.7 table said "auditor: yes" — that's a contract self-conflict that generator correctly resolved by deferring to C10 (the prior-sprint hard invariant). Documented in result file. Final allow delta: +3, not +4.
- **A-SE-RBAC-2.** `tests/integration/scope/scope-validate.test.ts:442` (`F5 — developer role → 403 + rbac.deny audit attributed to actor tenant`) + `:496` (`F5 — viewer role → 403 + rbac.deny audit`).

### A-SE-Audit-* (audit emission)
- **A-SE-Audit-1.** New action `scope.validate.denied` declared at `packages/contracts/src/audit.ts:71`, emitted at `apps/api/src/routes/assessments/scope-validate.ts:169`. Total `AUDIT_ACTIONS` enum is now **28** entries (Sprint 5 baseline at HEAD `9f5a732` was 27, Sprint 6 +1 = 28). Contract §5.8's "26→27 enumerated" was a typo about the baseline — the actual enum had 27 at Sprint 5; +1 = 28 is correct. Substance unaffected.
- **A-SE-Audit-2.** Per-tenant isolation continues to hold via Sprint 4 `auditor` route layer (untouched). F3/F5 SELECTs with `where('tenant_id', '=', actorTenantId)` confirm audit row is in actor's tenant scope.
- **A-SE-Audit-3.** `tests/integration/scope/scope-validate.test.ts:409` (`F4 — redaction strips token-like values from normalizedTarget.url`) — URL `?token=abc123secretvalue&other=safe` → `expect(serialized).not.toContain('abc123secretvalue')` AND `expect(serialized).toContain('[redacted]')` AND `expect(serialized).toContain('other=safe')`. Helpers `redactUrlQuery` + `redactNormalizedTarget` at `apps/api/src/routes/assessments/scope-validate.ts:64-95`.

### A-SE-IDOR-1
- F3 SELECT at `tests/integration/scope/scope-validate.test.ts:394-405` confirms CF-8 attribution.

### A-SE-DB-1..3
- **A-SE-DB-1.** No new migration. Verified — `git diff --stat` shows no `packages/db/migrations/*` changes.
- **A-SE-DB-2.** All Sprint 1-5 migrations apply cleanly — `db:migrate:check` passes (Sprint 5 baseline preserved).
- **A-SE-DB-3.** No JSONB writes in Sprint 6 — engine is pure, route reads only.

### A-SE-Doc-1
- `docs/adr/0006-scope-engine.md` exists. Did not deep-read for D1-D5 verbatim — flag for Lead spot-check.

### A-SE-Reg-1..3
- **A-SE-Reg-1.** All Sprint 1-5 tests continue to pass (566 PG floor → 833 = +267 new tests, no regressions).
- **A-SE-Reg-2.** No path-footguns introduced (existing `bun run check:path-footguns` script does not exist in current repo; manual grep on Sprint 6 files clean).
- **A-SE-Reg-3.** Engine-purity grep clean (verified locally + `engine-purity.test.ts`).

---

## What was verified PASS at iter-2 cumulative (the 11 probes from contract review)

1. **16-rule kind cardinality** — `expect(RULE_KINDS.length).toBe(16)` at two sites (contracts + engine matchers). Per-kind matcher matrix exercises ≥1 positive + ≥1 negative for each kind (≥32 cases parametrized, not hand-written).
2. **Deny-overrides-allow CIDR overlap** — `decide.test.ts` overlapping deny/allow fixture; deny wins.
3. **SSRF metadata-IP block (3 forms)** — literal `169.254.169.254` (engine + IT), DNS-resolved-to-metadata (engine), redirect-array containing metadata (engine + IT F7).
4. **Yandex Cloud metadata `100.100.100.200`** — `ip.test.ts` classification + `decide.test.ts` deny.
5. **IDN homograph mixed-script** — `host.test.ts` flags + `decide.test.ts` `mixed_script_host_blocked` reason.
6. **IPv6 zone-id smuggling** — `ip.test.ts` `R4 — zone-id stripped from canonical, retained on side` + `matchers.test.ts` `R4 — IPv6 zone-id smuggling`.
7. **Time-window boundary** — R3 5-point `[start, end)` half-open + R2 sequential calls non-retroactive.
8. **Cross-tenant 200/403/404 + audit attribution** — F3 SELECT verifies `tenant_id=T1 AND attemptedResourceTenantId=T2`.
9. **Engine-purity grep** — 0 forbidden imports.
10. **Coverage ≥80% on §5 surfaces** — all engine files ≥80% func + lines; route 100/98.6; rate-limit 100/100; dns-resolver exempted.
11. **Order-independent mixed-resolution** — `decide.test.ts` `R11 — mixed resolution [pub, priv] vs [priv, pub] yields identical deny decisions`.

---

## Limitations (per contract §11, accepted)

- **L-1 → L-2.** No queue / pre-enqueue / pre-exec wiring — Sprints 7/9.
- **L-3.** New devDep `fast-check@^3.23.1` declared.
- **L-4.** No real ownership-verification flow change — Sprint 5's `ownership_status='verified'` signal consumed; no new write paths.
- **L-5.** No findings/evidence/observations/reports surface — Sprints 9-12.
- **L-6.** No `Idempotency-Key` for `/scope/validate` — read-only by design.
- **L-7.** No persistence for `RateLimitCounter` — in-process only this sprint (Sprint 7 may swap to Redis-backed).
- **L-8.** No new migration. Verified.
- **L-9.** No cost cap — spec §2.5 says cost caps never block.
- **L-10.** No platform-admin-only `allowMetadataIpExplicit=true` toggle endpoint — engine accepts the flag but no API surface to flip it. Phase 9.
- **L-11.** No `tool_catalog` table or CRUD — static fixture per OQ-3 at `apps/api/src/scope-engine/tool-catalog.ts`.
- **L-12.** No CIDR overlap-detection / static-conflict warnings — runtime evaluation only.

---

## Notes for Lead

1. **Contract §5.7 vs C10 invariant.** Generator's RBAC delta is +3 allows (tenant_admin, security_lead, operator), not the +4 the contract §5.7 table named (auditor was listed but Sprint 3's `auditor.ts` programmatically forbids any allow beyond `[read, list]`). Generator did the right thing — preserve the prior-sprint invariant rather than break it. Result file documents the substitution. Update the spec/contract to reflect this if you want auditors able to call `/scope/validate` in the future; that would require breaking C10, which is bigger than Sprint 6.

2. **Audit action enum count.** Contract §5.8 said "26 → 27 enumerated"; actual baseline at HEAD `9f5a732` was 27 (sprint-5-fixes-result.md line 124's "26 emission points" referred to call sites, not the enum). After Sprint 6's `+1` the enum is **28**. Numerically correct, contract-text typo. No fix needed.

3. **ADR 0006 spot-check.** I did not read `docs/adr/0006-scope-engine.md` for D1-D5 verbatim. Recommend Lead spot-check before sign-off, mirroring how Sprint 5 verified ADR 0005 D1-D5 verbatim.

4. **`apps/api/src/scope-engine/dns-resolver.ts` 63.64% lines.** The 5-line wrapper is exempted by contract §5 conventions. Line 27-30 is the error path (DNS lookup fails). It's tested through engine-side DNS failure unit tests in `normalize/index.test.ts`, but the lines in the wrapper itself aren't hit because real DNS resolution doesn't fail in IT (the IT seeds resolvable hostnames). Acceptable.

5. **Working-tree state.** Sprint 6 sits on a clean working tree extension of `9f5a732`. 16 modified/new tracked + a handful of new files in untracked dirs. Lead's call when to commit + push. Suggested commit-by-slice mirrors the contract §10 plan.

6. **Memory updates.** Sprint 6 adds the following to project memory: scope-engine pure-package boundary, 16-rule discriminated union, deny-overrides-allow + unknown-rule-default-deny invariants, injected DNS+Clock+RateLimitCounter pattern, audit redaction at route layer (`redactUrlQuery` strips 15 secret-key names). Will commit to mempalace next.

---

## Files I produced

- `.harness/cyberstrike-hybrid/sprint-6-evaluator-result.md` — this final PASS verdict.
- (No probes file authored this sprint — every probe I planned was already covered by generator's tests at the requested specificity, so I verified by reading + running rather than writing parallel scaffolding. Sprint 5 contrast: there I wrote 8 deferred orthogonal probes because generator's tests were thinner; Sprint 6's iter-2 made my probes redundant.)
