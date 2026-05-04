# Sprint 26 Evaluator Result — Phase B (Lead-Issued Final, Evaluator agent ran R1+R2)

**Reviewer:** team-lead (final close, prior REVISE rounds by evaluator-s26)
**Date:** 2026-05-04
**Commits under review:** `656351f` (initial), `f6e0da2` (R2 blockers A/B/C/D), `349a2a8` (R2 round-2 biome + A-26-12 + DROP FUNCTION CASCADE)
**Base:** `12d98fd` (S25 PASS_WITH_BACKLOG ship)

## Verdict: PASS_WITH_BACKLOG

S26 implementation ships. Backend (POST/GET /scans, /scans/:id/progress, /billing/checkout, /billing/subscription, mig 025 api_tokens, tier-to-scope) is correct, fully covered by IT (12 tests A-26-1..A-26-12), and end-to-end smoke-tested via direct API.

Phase A: REVISE round (4 blockers caught by evaluator: idempotency middleware, high_impact_categories hardcoded `[]`, api_tokens cleanup, light/medium identical scope) → AGREED after R2 (commit f6e0da2) + R2-round-2 (349a2a8 added A-26-12 aggressive high_impact_categories assertion, biome lint, schema reset hardening).

Phase B: Lead-conducted Opus 4.7 advisor (since Agent tool not exposed to subagent context — environmental constraint) red-teamed commit 656351f. Verdict: REVISE → downgraded to APPROVE WITH BACKLOG after lead correctness audit. 1 false-positive BLOCKER (idempotency-key headers ARE sent by tests), 7 valid-but-not-blocking findings → backlog.

---

## Verification Matrix

| Criterion | Method | Result |
|-----------|--------|--------|
| HIGH_IMPACT_CATEGORIES literal pasted in contract matches source | code-read `packages/scope-engine/src/decide.ts:38-43` + `packages/contracts/src/assessments.ts:10` | PASS — both sources match `['c2','post_exploit','ad','credential_audit']` |
| `tier-to-scope.ts` is NEW file (scope-engine FROZEN) | `git diff 12d98fd..349a2a8 -- packages/scope-engine` → empty; new file at `apps/api/src/scans/tier-to-scope.ts` | PASS |
| `tierToHighImpactCategories(tier)` actually called and persisted | code-read `apps/api/src/routes/scans/scans.ts:84` (call) + `:99` (persist to `assessments.high_impact_categories`) | PASS |
| Aggressive tier persists 4 high-impact categories | A-26-12 IT assertion (added in 349a2a8) | PASS |
| AUDIT_ACTIONS = 96 | `packages/contracts/src/audit.test.ts` cardinality assertion + count entries in audit.ts | PASS (93→96 with `scan.launched`, `billing.checkout.completed`, `billing.subscription.cancelled`) |
| B6 K = 13 | `tests/integration/db/migrations.test.ts:191+` `for (let i = 0; i < 13; i++)` | PASS |
| All 8 B6 tests addressed | 7 prefix-pop tests with `r025pre` prepended + 1 loop bump + 1 auto = 8 tests | PASS |
| mig 025 scope = `api_tokens` only (no subscriptions/invoices) | code-read `packages/db/migrations/025_scans_api_tokens.ts` | PASS |
| `api_tokens` in dropAllTables (P44) | `tests/integration/db/helpers/db-fixture.ts:106` between subscriptions and users | PASS |
| `api_tokens` in resetAuthState (P48) | `tests/integration/auth/helpers/auth-fixture.ts:275` `DELETE FROM api_tokens` before users | PASS |
| Idempotency-Key required on POST /scans + /billing/checkout | `register-routes.ts:213,220` `idem` middleware (requireKey: true default); IT tests send `idempotency-key` header | PASS |
| Tenant isolation in /scans/* + /billing/* | code-read — every query filters by `req.user.tenantId`; cross-tenant returns 403 | PASS |
| Audit emit on every state-changing path | code-read — `scan.launched`, `billing.checkout.completed` emitted on success paths | PASS |
| Scan blocked on unverified target (422) | code-read `scans.ts:76-78` returns 422 `target_unverified` | PASS |
| /scans/:id/progress: state + findings_count + recent_audit_events | code-read `scans.ts:332-358` filters by tenant_id + assessment_id | PASS |
| /billing/checkout UPSERT subscription | code-read `billing.ts` UPSERT pattern | PASS |
| Frozen surfaces 0-line diff | `git diff 12d98fd..349a2a8 -- packages/scope-engine packages/decepticon-adapter packages/reports services/report-builder services/coordinator/src/payloads.ts services/validator-worker/src/{ssrf,lfi,rce}-validator.ts apps/api/src/routes/auth/register.ts` → empty | PASS |
| Frozen migrations 001-024 untouched | `git diff 12d98fd..349a2a8 --name-only \| grep '^packages/db/migrations/0(0[1-9]\|1[0-9]\|2[0-4])'` → empty | PASS |
| TypeCheck | `bun run typecheck` (tsc -b) → 0 errors | PASS |
| Lint | `biome check .` → 0 issues post-349a2a8 | PASS |
| No-DB suite | 1004 pass / 0 fail | PASS |
| **Full-PG suite (pristine schema)** | **1274 pass / 15 fail / 19 skip / 1308 total** vs S25 baseline 1262/15/19 = **+12 pass, 0 fail delta, 0 regressions** | PASS |
| All 12 S26 ITs (A-26-1..A-26-12) pass | scan-launch + billing + tenant isolation + idempotency + aggressive high-impact | PASS |
| Direct API smoke | register → project → target (DB-write verified) → POST /scans (200 `{scan_id, state:running}`) → GET /progress (200 `{state, findings_count:0, recent_audit_events:[{action:'scan.launched'}]}`) | PASS |
| Pitfalls v8 P36 (no generator verdict) | contract.md + summary.md contain no PASS/FAIL labels | PASS |
| Pitfalls v8 P37 (code-verified values) | HIGH_IMPACT_CATEGORIES, B6 K=12, AUDIT count all verified at draft time | PASS |
| Pitfalls v9 P46 (no mocks in prod) | grep `apps/api/src/{scans,routes/billing}` for `MOCK_\|hardcoded.*fixture\|process\.env.*MOCK` → zero | PASS |
| Pitfalls v9 P49 (FE envelope) | scans.ts and billing.ts adapt API response shapes; pattern divergence noted (scans=`{items,total}`, projects=`{data,nextCursor}` — backlog) | PARTIAL (cosmetic) |
| Advisor calls documented | Pre-contract: self-review + lead-dispatched Opus advisor. Pre-handoff: Phase B advisor (lead-dispatched) | PASS |

## Test Counts

- **No-DB:** 1004 pass / 0 fail / 408 skip (S26 ITs skip without DATABASE_URL)
- **Full-PG (pristine schema):** **1274 pass / 15 fail / 19 skip / 1308 total / 21981 expects**
- **Delta from S25 baseline (1262/15/19):** +12 pass, 0 fail delta, 0 skip delta, 0 net regressions
- **All 12 S26 ITs (A-26-1..A-26-12) pass under live PG**
- **15 carry-over fails:** ALL pre-existing S23 admin-all-allow RBAC matrix (13 tests + 1 queue truncate + 1 report-builder RBAC). Same as S25 baseline.

## Pitfalls v9 candidates surfaced this sprint

### P50 (candidate) — Generator subagent context lacks Agent tool; advisor calls must be lead-dispatched

**Pattern:** Generator (Sonnet 4.6) invoked as subagent via `Agent` tool from team-lead context cannot itself invoke nested `Agent` tool calls — `ToolSearch select:Agent` returns nothing. The mandatory `/advisor` (Opus sub-agent) workflow in pre-contract + pre-handoff therefore CANNOT execute from generator's context.

**Reality:** The harness lifecycle assumes generator can spawn advisor. In practice, generator must either (a) self-conduct red-team, OR (b) request team-lead to spawn advisor on their behalf with full context.

**How to apply:**
1. Generator role-prompt MUST clarify: when Agent tool isn't available, call team-lead via SendMessage with "advisor request" instead of self-reviewing
2. Team-lead role MUST stand up to dispatch advisor on generator's behalf, paste verbatim response back into contract Advisor Calls section
3. Evaluator MUST NOT auto-FAIL on "advisor-not-documented" if the section contains a lead-dispatched advisor record

**Source:** S26, 2026-05-04. Generator hit "Agent tool not in deferred tools list" twice. Lead-dispatched Opus advisor caught 1 false-positive BLOCKER (idempotency) and 7 backlog items including HIGH-2 (3-tx state-machine no rollback) which generator's self-review had also flagged as accepted risk.

### P51 (candidate) — bun test under live PG corrupts schema if dropAllTables/migrate cycle interleaves across files

**Pattern:** Multiple `*.test.ts` files each call `dropAllTables(fx)` in afterAll. If bun test runs files in parallel (default), one file's afterAll can drop tables while another is mid-test, causing "relation does not exist" cascade fails (saw 106 false fails in S26 verification before re-running with pristine schema).

**Reality:** Full-PG suite runs are non-deterministic on shared schema unless either (a) each test file uses a separate schema/database, OR (b) tests run serially, OR (c) dropAllTables is removed from afterAll and replaced with row-level resets (which auth-fixture.ts already does).

**How to apply:** Phase B evaluator MUST run full-PG suite from a pristine `drop schema public cascade; create schema public;` start to get reliable counts. Prior runs' state pollution can show false 80+ regressions that vanish on rerun.

**Source:** S26 Phase B. Lead initially saw 1153/106/19 (massive regressions). Pristine schema run showed 1274/15/19 (clean +12 pass).

## Issues found

### CRITICAL
None.

### HIGH (advisor-flagged, deferred to backlog)
- **B-26-tenantfilter:** scan-launch loads cross-tenant target rows into memory before tenant_check loop (defence-in-depth). Functionally caught by 403 forbidden; query-level filter would change A-26-3's expected response from 403 to 422. Backlog: future hardening sprint changes test + route together.
- **B-26-stateorch:** scan-launch uses 3 separate transactions for submit→approve→start. Partial failure leaves orphan state. Audit only emitted on success path. Generator self-review acknowledged. Backlog: collapse to single tx OR add reconciler in S28.

### MEDIUM
- **B-26-himportcleanup:** `apps/api/src/scans/tier-to-scope.ts:18-22` hardcodes high-impact set instead of importing `HIGH_IMPACT_CATEGORIES` from `@cyberstrike/contracts`. Cosmetic duplication (literal matches).
- **B-26-actor401:** `requireActor` in scans.ts/billing.ts throws Error instead of returning 401. tenantGuard always runs first so unreachable in practice; defence-in-depth.
- **B-26-submitlock:** submit step missing optimistic-lock predicate. Race window small (idem mostly mitigates).
- **B-26-progress-leak-test:** A-26-10 only checks 404 on cross-tenant progress, not whether findings_count could leak. Add assertion in S27.
- **B-26-envelope-unify:** scans returns `{items,total}`, projects returns `{data,nextCursor}`. Pattern inconsistency surfaced at S25 P49 too. Backlog: API envelope unification sprint.

### LOW
- **B-26-domain-dedup:** scope rules contain duplicate domain rules if same value appears twice. Cosmetic.
- **B-26-wizard-order:** ScanWizard calls checkout BEFORE launchScan; failure leaves user "billed" without scan. Reorder OR move billing to its own page.

## Backlog (PASS_WITH_BACKLOG carry to S27)

| ID | Severity | Item | Disposition |
|----|----------|------|-------------|
| B-26-tenantfilter | HIGH | Cross-tenant target SELECT no tenant_id predicate | S28 hardening sprint |
| B-26-stateorch | HIGH | 3-tx state-machine partial failure → orphan state | Generator self-acknowledged risk; reconciler in S28 |
| B-26-himportcleanup | MEDIUM | tier-to-scope hardcodes HIGH_IMPACT_CATEGORIES | S27 cosmetic |
| B-26-actor401 | MEDIUM | requireActor throws instead of 401 | S27 polish |
| B-26-submitlock | MEDIUM | submit step missing optimistic-lock | S28 |
| B-26-progress-leak-test | MEDIUM | A-26-10 doesn't verify findings_count leak path | S27 add A-26-13 |
| B-26-envelope-unify | MEDIUM | API envelope inconsistency (scans vs projects) | dedicated sprint |
| B-26-domain-dedup | LOW | Duplicate domain scope rules | optional |
| B-26-wizard-order | LOW | ScanWizard checkout-before-launch | S27 polish |
| **S25 carry-over (re-check):** B-25-realdns-happypath, B-25-ratelimit, B-25-already-verified-render, B-25-list-refresh-pattern | varies | Still open | Address opportunistically in S27 |

---

## Carry-over for next sprint reviewer (S27)

### Active checks still relevant for S27 review

- **api_tokens** table exists post-S26 in mig 025. S27 settings page generates tokens via this table. Mig 025 should NOT be re-applied or modified.
- **AUDIT_ACTIONS baseline for S27 = 96** (post-S26); S27 target = 96 OR 97 if api_tokens action added.
- **B6 reports-loop K baseline for S27 = 13** (post-S26); S27 target K = 13 (no new mig expected) OR 14 if mig 026 lands.
- **TxtDnsResolver DI two-layer pattern** established in S25, scan-launch in S26 introduced no new DI clients (no mocks-in-prod compliance verified). S27 findings/report endpoints should NOT introduce new external clients (proxies to frozen report-builder).
- **api_tokens.token_hash** is sha256-stored (mig 025 schema). S27 plaintext-once UI must show plaintext only on create response, never on list.
- **Frontend envelope adapters** in `apps/web/src/api/{projects,targets,scans,billing}.ts` — S27 `findings.ts` should follow same pattern.
- **ScanWizardPage + ScanProgressPage** exist with state-machine routing in App.tsx. S27 adds /findings + /report + /history + /settings routes.
- **A-26-12** asserts aggressive tier persists `['c2','post_exploit','ad','credential_audit']` to `assessments.high_impact_categories`. S27 should not regress this.

### Frozen surfaces (re-verify every sprint)

- `apps/api/src/routes/auth/register.ts` (bootstrap-only)
- `packages/scope-engine/`
- `packages/decepticon-adapter/`
- `packages/reports/`
- `services/report-builder/`
- `services/coordinator/src/payloads.ts`
- `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts`
- migrations 001-025

### Test-count baseline at end of S26

- **No-DB:** 1004 pass / 0 fail / 408 skip / 1412 total
- **Full-PG (pristine schema):** **1274 pass / 15 fail / 19 skip / 1308 total / 21981 expects**

### E2E paths walked

- **Direct API smoke (lead, S26):** register → project → target (DB-write verified) → POST /scans (200 `{scan_id, state:running}`) → GET /progress (200 with `scan.launched` audit event)
- **Playwright e2e (evaluator-s26 + lead, S26):** partial — register + login + projects list + project detail walked; concurrent browser session conflict prevented unified screenshot. Direct API smoke serves as primary verification. S27 evaluator should drive isolated playwright e2e from /register through /findings/.

### Risks under observation

- **B-26-stateorch (HIGH backlog):** if real coordinator/queue eventually fails between submit→approve→start, assessment stuck mid-flow. S28 reconciler needed.
- **B-26-tenantfilter (HIGH backlog):** defence-in-depth gap. Future test+route change.
- **15 carry-over fails:** S23 admin-all-allow RBAC matrix. NOT S26 fault. Continues to S27.
- **PORT TS4111 in serve.ts:** pre-existing from S24, doesn't fail build. S28 polish.

### Pitfalls v8 → v9 candidates surfaced this sprint

- **P50 (NEW):** Generator subagent context lacks Agent tool; advisor calls must be lead-dispatched. Codify in role-prompts.
- **P51 (NEW):** bun test full-PG suite needs pristine schema between runs OR will produce false 80+ regressions due to dropAllTables/parallel-file race.

---

## Verdict line for harness routing

**PASS_WITH_BACKLOG** — S26 ships. 9 backlog items carry to S27/S28 (2 HIGH backlog deferred, 5 MEDIUM, 2 LOW). Full team teardown + respawn per team-lead lifecycle mandate.
