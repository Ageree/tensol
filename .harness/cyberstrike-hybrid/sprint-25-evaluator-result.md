# Sprint 25 Evaluator Result — Phase B (Lead Spike-Verify, agent-team respawned mid-cycle)

**Reviewer:** team-lead (lead spike, agents respawned post-compaction)
**Date:** 2026-05-04
**Commits under review:** `a5b7d58` (backend) + `ba5986c` (UI) + `10c4ef3` (R2 fixes + FK regression) + `77ad03c` (FE envelope drift + add-target UI)
**Base:** `796d191` (S24 carry-over closure)
**Round:** Phase B / lead-issued

## Verdict: PASS_WITH_BACKLOG

S25 implementation ships. Backend (mig 024 + domain-verify route + DI'd TxtDnsResolver) is correct, IT-tested green, and end-to-end walked through Playwright on a live API+Vite dev pair. Lead spike caught and surgically fixed two regressions before S26 respawn:

1. **FK fixture regression** — `auth-fixture.ts:resetAuthState` row-level cleanup didn't include `domain_verifications` (FK→targets), causing 14 cascade fails in S25 ITs against the same fixture pattern S24 carried. Fixed in `10c4ef3`. P44 reinforced.
2. **FE envelope drift** — `apps/web/src/api/{projects,targets}.ts` expected `{projects/targets, total}` but API serves `{data, nextCursor}` (and flat for getById/post). Pre-existing from S5; surfaced now because S25 needed a working /app/projects → project detail → domain-wizard demo. Fixed in `77ad03c` with adapters; added `AddTargetForm` component to make wizard reachable in UI.

Phase A contract (R1) passed evaluator gates after R2 with 3 blocker fixes (Optional vs Required RouteDeps, B6 prefix-pop missing r022pre, working-tree clarification). Generator's pre-contract Opus advisor verdict: APPROVE WITH CHANGES (M1+M2 fixed). Documented verbatim in `sprint-25-contract.md` lines 387-424.

---

## Verification Matrix

| Criterion | Method | Result |
|-----------|--------|--------|
| `domain_verifications` table mig 024 | code-read `packages/db/migrations/024_domain_verifications.ts` (29 lines, FK target_id→targets, UNIQUE(target_id), expires_at index) | PASS |
| Migration 024 BYTEA-free | code-read mig 024 — only `text`, `uuid`, `timestamptz`, `boolean` | PASS |
| Migration 024 down() reverses | code-read line 27-28 (`dropTable('domain_verifications')`) | PASS |
| `POST /api/v1/domains/verify/start` returns `{token, instructions, expires_at}` | code-read `apps/api/src/routes/domains/domain-verify.ts:start` + curl-walked in spike | PASS |
| `GET /api/v1/domains/verify/check` calls dns.resolveTxt('_cs-verify.<domain>') via DI'd TxtDnsResolver | code-read `domain-verify.ts:check` (uses `deps.dnsResolver.resolveTxt`) — NO env-flag, NO MOCK_ branches (P46) | PASS |
| TxtDnsResolver interface separate from scope-engine DnsResolver (frozen) | code-read `apps/api/src/routes/shared.ts` + `apps/api/src/factory.ts:dnsResolver: options.dnsResolver ?? realResolver` | PASS |
| RouteDeps.dnsResolver required, AppOptions.dnsResolver optional (test override) | code-read factory.ts + R2 contract Blocker-1 response | PASS |
| Atomic flip: domain_verifications.status + targets.ownership_status in single TX | code-read `domain-verify.ts:check` — `db.transaction().execute(async (trx) => ...)` wraps both UPDATEs | PASS |
| AUDIT_ACTIONS.length === 93 (88 + 5 domain.verify.*) | code-read `packages/contracts/src/audit.ts` (93 entries) + `audit.test.ts` cardinality assertion | PASS |
| 5 new audit actions: domain.verify.{requested, checked, confirmed, failed, expired} | code-read audit.ts entries + emit sites in domain-verify.ts | PASS |
| B6 K = 12 (was 11 post-S24) | code-read `tests/integration/db/migrations.test.ts:184` `for (let i = 0; i < 12; i++)` | PASS |
| All 8 B6 tests addressed | 6 prefix-pop tests with r024pre prepended + 1 loop count bump + 1 auto-rollback | PASS |
| Test #1 r022pre missing fix (R2 blocker-2) | code-read migrations.test.ts:46-78 — r024pre→r023pre→r022pre→r021pre→r020pre→step-1(019) | PASS |
| `dropAllTables` includes `domain_verifications` | code-read `tests/integration/db/helpers/db-fixture.ts:92` | PASS |
| `auth-fixture.ts:resetAuthState` includes DELETE FROM domain_verifications BEFORE targets | code-read after fix `10c4ef3` | PASS (lead fix) |
| Frontend domain wizard: token + DNS instructions + check button + verified/unverified badge | code-read `apps/web/src/pages/ProjectDetailPage.tsx:21-78` (DomainWizard component) | PASS |
| Frontend: project list refreshes after create | adapter fix in `77ad03c`, e2e walked | PASS (lead fix) |
| Frontend: AddTargetForm renders + POSTs new target | added in `77ad03c`, e2e walked | PASS (lead fix) |
| Tenant isolation in /domains/verify/* | code-read — every query filters by `req.user.tenantId`; cross-tenant returns 403 IDOR | PASS |
| Audit emit on every state-changing path | code-read — start success/failure/already-verified, check success/failure/expired all emit audit_event | PASS |
| TypeCheck | `bun run typecheck` (tsc -b) → 0 errors (S24 baseline carries 1 pre-existing PORT prop access TS4111 warning that doesn't fail build) | PASS |
| Lint | `biome check .` → 456 files, 0 issues | PASS |
| No-DB suite | `bun test` → 1004 pass / 0 fail / 408 skip / 1412 total | PASS (vs S24 1004/0/391; +17 skipped IT tests for S25) |
| Full-PG suite (initial S25 ship) | 1247/30/19 — 14 S25 IT regressions caught | FAIL → fixed in 10c4ef3 |
| Full-PG suite (after FK fix) | 1262 pass / 15 fail / 19 skip / 1296 total | PASS (vs S24 baseline 1246/16/19 = +16 pass, -1 fail, 0 net regressions) |
| Frozen surfaces 0-line diff | `git diff 1aa2bbf..HEAD -- packages/scope-engine packages/decepticon-adapter packages/reports services/report-builder services/coordinator/src/payloads.ts services/validator-worker/src/{ssrf,lfi,rce}-validator.ts apps/api/src/routes/auth/register.ts` → empty | PASS |
| Frozen migrations 001-022 untouched | `git diff 1aa2bbf..HEAD --name-only \| grep '^packages/db/migrations/0(0[1-9]\|1[0-9]\|2[0-2])'` → empty | PASS |
| Playwright e2e | live API:18080 + Vite:5174; register → projects → create project → add domain target → wizard → token issued → DNS check triggered (502 NXDOMAIN on example.com — production-correct, P46) | PASS |
| Pitfalls v8 P36 (no generator verdict) | sprint-25-implementation-summary.md / contract.md contain no PASS/FAIL evaluator labels (only "P36 COMPLIANCE: This document contains NO evaluator verdict" disclaimer) | PASS |
| Pitfalls v8 P37 (code-verified values) | mig 024 column types, audit cardinality 93, B6 K=12 all verified against source | PASS |
| Pitfalls v9 P46 (no mocks in prod) | grep `apps/api/src/routes/` for `MOCK_\|hardcoded.*fixture\|process\.env.*MOCK\|return \['cs-verify` → zero hits | PASS |
| Pitfalls v9 P42 (JSONB COMMENT) | mig 024 has no JSONB column; N/A | PASS |
| Pitfalls v9 P43 (rate-limiter DI) | no new rate-limiter introduced in S25; existing limiters unchanged | PASS |
| Pitfalls v9 P44 (new table → dropAllTables + resetAuthState) | INITIALLY VIOLATED → caught by lead spike → fixed in 10c4ef3 | PASS (lead fix) |

## Test counts

- **No-DB:** 1004 pass / 0 fail / 408 skip / 1412 total / 20801 expects
- **Full-PG (final, post-fix):** 1262 pass / 15 fail / 19 skip / 1296 total / 21933 expects
- **Delta from S24 baseline (1246/16/19):** +16 pass, -1 fail, 0 skip, 0 regressions
- **All 14 S25 IT tests (A-25-5..6) pass**
- **15 remaining fails:** ALL pre-existing S23 admin-all-allow RBAC carry-over (13 RBAC tests + 1 queue truncate + 1 report-builder RBAC). Same baseline as S24 ship minus 1 (one S24-era flake is now passing).

## Pitfalls v9 candidates surfaced this sprint

### P48 (candidate) — Every new table with FK→targets MUST be added to BOTH dropAllTables AND resetAuthState row-level cleanup

**Pattern:** Generator added `domain_verifications` to `dropAllTables` (DDL teardown via `DROP TABLE CASCADE`) but missed `resetAuthState` row-level `DELETE FROM` cleanup (which runs BETWEEN tests, not just afterAll). FK constraint fired during `DELETE FROM targets` because `domain_verifications.target_id` references it.

**How to apply:** Pre-handoff checklist:
1. `grep "REFERENCES targets\|REFERENCES tenants\|REFERENCES users" mig-N.ts` — list FK parents
2. For each FK parent X: ensure `DELETE FROM <new_table>` exists BEFORE `DELETE FROM X` in `tests/integration/auth/helpers/auth-fixture.ts:resetAuthState`
3. Doesn't suffice to add only to `dropAllTables` — that runs once per test file, not once per test

**Source:** S25 spike caught 14 cascade fails before S26 respawn. Fixed in commit 10c4ef3.

### P49 (candidate) — FE envelope drift surfaces only at demo time, not in unit tests

**Pattern:** FE TS interfaces declared `{projects, total}` shape, but API serves `{data, nextCursor}`. FE unit tests passed (used inline mocks matching FE shape). IT tests passed (don't exercise FE). Runtime call returned undefined → empty list. Discovered only when lead drove a live e2e walk.

**How to apply:** When adding new FE-consuming endpoint, the playwright e2e MUST exercise BOTH the create AND the list-refresh path. If list refresh shows empty after a known-success create, FE is reading the wrong field.

**Source:** S25 spike caught listProjects + listTargets drift. Fixed in commit 77ad03c.

## Issues found

### CRITICAL
None.

### HIGH
None.

### MEDIUM
- **B-25-realdns-happypath:** Playwright e2e cannot walk the verified-status flip without a controlled domain or test fixture override. Production-correct DNS resolver returns NXDOMAIN/502 for `_cs-verify.example.com` (no real TXT record). For S26+ scan-launch e2e, either (a) use a controlled domain like `cstest-2026.local` with hosts override + a local DNS test stub, OR (b) accept that e2e covers only the issuance path and rely on IT mocks for the verified-flip assertion. Decision deferred to S26 contract.

### LOW
- **L1 — Missing UI for ownership_status badge on already-verified targets:** DomainWizard renders `Verified` text only after a successful Check round. Pre-verified targets (e.g., from API direct creation) show as "Unverified" + Verify button until the user clicks Check. Cosmetic.
- **L2 — `targets.ownership_status` column not exposed in listTargets response shape:** `Target` interface in `apps/web/src/api/targets.ts` has `ownershipStatus`, but `DomainWizard` ignores it on first render — always shows the Verify button even if `ownershipStatus === 'verified'`. Polish for S27 history page.

## Backlog (PASS_WITH_BACKLOG carry)

| ID | Severity | Item | Defer rationale |
|----|----------|------|-----------------|
| B-25-realdns-happypath | MEDIUM | Playwright cannot walk the green-badge state without controlled DNS infra | S26 contract decides between hosts override stub + local DNS, or accepting issuance-only e2e |
| B-25-ratelimit | LOW | `/domains/verify/check` not rate-limited per spec §7 "10/min/tenant" | Spec L3 — generator's advisor already noted; deferred per pre-contract APPROVE |
| B-25-already-verified-render | LOW | DomainWizard ignores existing ownership_status on first render | Polish for S27 history/badge work |
| B-25-list-refresh-pattern | LOW | Other FE list pages may share envelope drift; audit not yet done across all FE list endpoints | S26 generator should grep all `api.get<{X[]; total}>` patterns and fix |

---

## Carry-over for next sprint reviewer (S26)

### Active checks still relevant for S26 review

- **Subscriptions + invoices tables** exist post-S24 in mig 023. **NOT in S25.** S26 mig 025 must NOT re-create them.
- **`domain_verifications`** table exists post-S25 in mig 024. S26 scan launch must check `targets.ownership_status === 'verified'` before allowing scan start (422 `target_unverified` if any target unverified).
- **AUDIT_ACTIONS baseline for S26 = 93** (post-S25); S26 target = 96 (+3: `scan.launched`, `billing.checkout.completed`, `billing.subscription.cancelled`).
- **B6 reports-loop K baseline for S26 = 12** (post-S25); S26 target K = 13.
- **All 8 B6 tests** will need another r025pre prefix-pop bump if mig 025 lands. S26 generator MUST enumerate all 8.
- **`AppOptions.dnsResolver` / `RouteDeps.dnsResolver`** two-layer DI pattern established. S26 should follow the SAME pattern for any new external client (e.g., the scan-launch wrapper has no external client, so likely no new DI).
- **`auth-fixture.ts:resetAuthState` FK ordering** now includes domain_verifications. S26 reviewer: verify any new FK→targets table is added before DELETE FROM targets in resetAuthState (P48).
- **TxtDnsResolver in `apps/api/src/routes/shared.ts`** — DO NOT delete/replace; it's the production binding for S25 + downstream.
- **Frontend envelope-shape adapters** in `apps/web/src/api/{projects,targets}.ts` now in place. S26 generator: when adding `apps/web/src/api/scans.ts` and `apps/web/src/api/findings.ts`, follow same envelope adapter pattern (P49).
- **AddTargetForm** component exists in ProjectDetailPage. S26 scan wizard reuses the same project detail page entry point.

### Frozen surfaces (re-verify every sprint)

- `apps/api/src/routes/auth/register.ts` (bootstrap-only)
- `packages/scope-engine/`
- `packages/decepticon-adapter/`
- `packages/reports/`
- `services/report-builder/`
- `services/coordinator/src/payloads.ts`
- `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts`
- migrations 001-022 (and now 023, 024 — base-locked post-ship)

### Test-count baseline at end of S25

- **No-DB:** 1004 pass / 0 fail / 408 skip / 1412 total
- **Full-PG:** 1262 pass / 15 fail / 19 skip / 1296 total
- **Coverage:** S25 added 375 lines of IT tests (`tests/integration/domains/domain-verify.test.ts` — 15 tests, all passing in full-PG)

### E2E paths walked by playwright

- **S25:** /register → /app/projects → create project (fixed envelope) → click into project → AddTargetForm (added) → create domain target → DomainWizard renders → Verify Domain → token issued → DNS check (502 NXDOMAIN on `_cs-verify.example.com`, production-correct per P46). Evidence: `.harness/cyberstrike-hybrid/sprint-25-e2e-evidence-wizard.png`.

### Risks under observation

- **B-25-realdns-happypath:** Without controlled DNS, S26 + S27 e2e cannot demonstrate the "verified domain → scan launch allowed" path live. S26 contract must decide: hosts override + local DNS stub for e2e session, OR accept issuance-only verification + IT-only happy-path. Recommend: hosts override stub.
- **15 carry-over fails:** S23 admin-all-allow RBAC mismatch (13 tests) + B6 3-step rollback flake + queue truncate edge-case + report-builder RBAC. NOT a v8 mandate to fix in S26 cycle. Hand off to S26 evaluator for re-verification.
- **PORT TS4111 in serve.ts:** pre-existing from S24, doesn't fail build. Cosmetic, can be fixed via `process.env['PORT']` whenever S28 polish lands.

### Pitfalls v8 → v9 candidates surfaced this sprint

- **P47 (already documented prior session):** Generator must SendMessage handoff after writing artifact, not just go idle.
- **P48 (NEW):** Every new table with FK→{targets, tenants, users} MUST be added to BOTH `dropAllTables` AND `auth-fixture.ts:resetAuthState`.
- **P49 (NEW):** FE envelope drift surfaces only at demo time, not in unit tests. Playwright e2e MUST exercise create + list-refresh path together.

---

## Verdict line for harness routing

**PASS_WITH_BACKLOG** — S25 ships. 4 backlog items carry to S26 (1 medium realdns-happypath + 3 LOW). Full team teardown + respawn per team-lead lifecycle mandate.
