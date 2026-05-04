# Sprint 27 Evaluator Result — Phase B (Lead-Issued Final, demo-able MVP gate)

**Reviewer:** team-lead (lead-issued; agent-team turnover mid-cycle)
**Date:** 2026-05-04
**Commits under review:** `00491ae` (initial S27) + `35f2205` (lead REVISE fixes)
**Base:** `37d7cd3` (S26 PASS_WITH_BACKLOG)

## Verdict: PASS_WITH_BACKLOG — DEMO-ABLE MVP GATE REACHED

S27 ships. End-to-end SaaS flow operational and verified via direct API smoke + 13 ITs:
**register → project → target → DB-verify ownership → scan(light) → progress(running, scan.launched audit) → findings(paginated, empty) → report/html (409 report_not_ready, demo expects user to trigger build) → history(items array) → /app/settings (profile-only)**.

S27 PASS_WITH_BACKLOG is the **demo-able MVP gate**. Lead escalates to user with full summary + git log.

---

## Pre-contract advisor (lead-dispatched per P50)

**Verdict:** APPROVE WITH CHANGES — 5 BLOCKERS, 4 HIGH, 6 MEDIUM.

**Q1 verdict: REVISE — DEFER api_tokens UI to S28.** saas-user-criteria.md:43 OUT OF SCOPE + Z.6 explicit defer + Z.5 audit math = +0 (assumes deferral). Two of three authoritative sources say defer; Z>body header rule supports defer.

**Q3 verdict: APPROVE proxy with 3 fixes:** B1 drop PDF (MIME-fraud — `reports` table has no PDF artifact); B5 status code 404→409 to match `reports.ts:239`; H4 add Build Report button (auto-build flow missing).

**Lead correctness audit:**
- BLOCKER-1 (idempotency missing on api_token POST): MOOT after Q1=defer
- B5 status code: APPLIED by generator
- B1 PDF drop: APPLIED by generator (z.enum `html|json|zip`)
- H1 TS cast: APPLIED by generator
- Q1 DEFER: PARTIALLY applied — generator deferred FE (SettingsPage profile-only) but left orphan files. **Lead deletes `apps/api/src/routes/auth/api-tokens.ts` + `apps/web/src/api/api-tokens.ts` in commit 35f2205.**

## Lead spike-verify caught 1 additional blocker

**Hono route pattern bug:** `/api/v1/scans/:id/report.:format` does NOT capture `:format` correctly — request to `/scans/<uuid>/report.html` returned 400 `invalid_format` (route matched but param=empty string). A-27-6 IT failed on first run.

**Fix:** Changed pattern to `/scans/:id/report/:format` (slash separator). Updated:
- `apps/api/src/routes/register-routes.ts:221`
- `tests/integration/scans/scan-findings.test.ts` (A-27-6 URL)
- `apps/web/src/pages/ScanReportPage.tsx` (3 download links + iframe)

Committed in `35f2205`.

---

## Verification Matrix

| Criterion | Method | Result |
|-----------|--------|--------|
| S27 endpoints exist + tenant-scoped | code-read scan-findings.ts + audit | PASS |
| GET /scans/:id/findings paginated + severity/kind filter | A-27-1..A-27-4 ITs + direct API smoke | PASS |
| GET /scans/:id/report/:format proxy with 409 not_ready + 404 not_found + tenant-isolation | A-27-5..A-27-6 ITs + direct API smoke (HTTP=409 confirmed) | PASS |
| Report formats = html\|json\|zip ONLY (PDF dropped per Opus B1) | z.enum at scan-findings.ts:99 | PASS |
| api_tokens UI DEFERRED to S28 (per Opus Q1 verdict) | SettingsPage = profile-only (29 lines); orphan handler+adapter files deleted in 35f2205 | PASS |
| Build Report button on ScanProgressPage (Opus H4) | code-read ScanProgressPage.tsx | PASS |
| ScanWizard reorder launch→checkout (B-26-wizard-order) | code-read ScanWizardPage.tsx | PASS |
| himportcleanup (B-26-himportcleanup) | tier-to-scope.ts now imports HIGH_IMPACT_CATEGORIES from @cyberstrike/contracts | PASS |
| AUDIT_ACTIONS = 96 (no new actions, report.downloaded reused) | audit.test.ts cardinality assertion | PASS |
| B6 K = 13 (no new mig 026) | migrations.test.ts loop literal | PASS |
| Frozen surfaces 0-line diff | `git diff 37d7cd3..35f2205 -- packages/scope-engine packages/decepticon-adapter packages/reports services/report-builder services/coordinator/src/payloads.ts services/validator-worker/src/{ssrf,lfi,rce}-validator.ts apps/api/src/routes/auth/register.ts` → empty | PASS |
| Frozen migrations 001-025 untouched | git diff name-only filter → empty | PASS |
| TypeCheck | `bun run typecheck` exit 0 (3 pre-existing TS4111 PORT/tier index-signature warnings, doesn't fail build) | PASS |
| Lint | `biome check .` 472 files, 0 issues | PASS |
| No-DB suite | `bun test` 1004 pass / 0 fail / 408 skip | PASS |
| **Full-PG suite (pristine schema, P51)** | **1281 pass / 15 fail / 19 skip / 1315 total** vs S26 baseline 1274/15/19 = **+7 pass, 0 fail delta, 0 net regressions** | PASS |
| All 13 S27 ITs (A-27-1..A-27-7 + extra) pass | scan-findings.test.ts under PG | PASS |
| End-to-end direct API smoke | register→project→target→DB-verify→scan→progress→findings→report→history all return 200/correct status | PASS |
| Pitfalls v8 P36 (no generator verdict in contract/summary) | grep | PASS |
| Pitfalls v8 P37 (code-verified values) | AUDIT 96, B6 K=13, mig 025 schema all verified | PASS |
| Pitfalls v9 P46 (no mocks in production) | grep `apps/api/src/{scans,routes/billing}` for `MOCK_\|hardcoded.*fixture\|process\.env.*MOCK` zero | PASS |
| Pitfalls v9 P50 (lead-dispatched advisor) | this very review fulfills it; documented verbatim Opus response in contract | PASS |
| Pitfalls v9 P51 (pristine schema for full-PG) | applied — got 1281/15/19 clean instead of polluted-state 80+ false fails | PASS |
| Pitfalls v9 P52 (navigation entry mandate) | ScanProgressPage now has "View Findings" + "View Report" buttons; App.tsx routes wired | PASS |

## Test counts

- **No-DB:** 1004 pass / 0 fail / 408 skip / 1412 total
- **Full-PG (pristine schema):** **1281 pass / 15 fail / 19 skip / 1315 total / 22010 expects**
- **Delta from S26 baseline (1274/15/19):** +7 pass, 0 fail delta, 0 skip delta, 0 net regressions
- **All 13 S27 ITs pass under live PG**
- **15 carry-over fails:** ALL pre-existing S23 admin-all-allow RBAC matrix (13 RBAC + 1 queue truncate + 1 report-builder RBAC). Same as S25/S26 baseline.

## Pitfalls v9 candidates surfaced this sprint

### P53 (candidate) — Hono route patterns with `.` separator do NOT capture suffix params

**Pattern:** `app.get('/scans/:id/report.:format', handler)` — request to `/scans/<uuid>/report.html` matches route, but `c.req.param('format')` returns empty string (or undefined). Likely Hono treats `:format` after literal `.` as something other than capture group.

**How to apply:** Use slash separator in route patterns: `/scans/:id/report/:format`. Predictable Hono behavior. Update FE links to match.

**Source:** S27 lead spike. A-27-6 IT failed with 400 `invalid_format` (handler validated `format=''`). Fixed in commit 35f2205 by changing route pattern + FE URLs + test URL.

### P54 (candidate) — Generator name collision when respawning team agents — old-named generator may pick up new sprint work

**Pattern:** S26 team had agent `generator`. After S26 PASS, lead respawned with agent `generator-s27`. The OLD `generator` (idle) somehow received S27 task signaling and proceeded to implement S27 in commit `00491ae` — without receiving the lead-dispatched Opus advisor verdict that was sent to `generator-s27`. Result: generator implemented original draft contract (api_tokens UI shipped + PDF MIME-fraud) instead of REVISE'd contract.

**How to apply:** When respawning agents:
1. Explicitly send shutdown_request to old-named agents BEFORE spawning new ones
2. Use distinct namespace per cycle (e.g., `generator-s26`, `generator-s27`) — current pattern correct
3. Lead must verify which agent actually committed work — `git log --author` and `git show` to spot inconsistencies

**Source:** S27 cycle. Old `generator` shipped commit 00491ae bypassing Opus verdict; lead caught at spike-verify and applied surgical fixes in 35f2205.

## Issues found

### CRITICAL
None.

### HIGH (advisor-flagged, deferred)
- **B-26-tenantfilter:** still open (S28 hardening sprint)
- **B-26-stateorch:** still open (S28 reconciler)
- **H4 (Opus): no auto-report-build flow.** Build Report button added on ScanProgressPage; live demo requires user click + wait. Acceptable for v1 demo. Backlog: enqueue report.build at scan completion in S28.

### MEDIUM
- All 6 Opus MEDIUMs from S27 advisor → backlog. Plus B-26 MEDIUMs still open.

### LOW
- All Opus LOWs accepted/deferred.

## Backlog (PASS_WITH_BACKLOG carry to S28)

| ID | Severity | Item | Disposition |
|----|----------|------|-------------|
| B-27-tokenuiS28 | MEDIUM | api_token CRUD + audit (97/98 cardinality bump) | S28 must ship if final demo includes token-based CLI |
| B-27-pdfgen | MEDIUM | PDF format requires report-builder unfreeze | S28+ |
| B-27-autobuild | MEDIUM | Auto-enqueue report.build at scan completion | S28 |
| B-27-tenantfilter (carry from B-26) | HIGH | Cross-tenant target SELECT no tenant_id predicate | S28 hardening |
| B-27-stateorch (carry from B-26) | HIGH | 3-tx scan-launch state-machine partial-failure orphan | S28 reconciler |
| B-27-himportcleanup | DONE | tier-to-scope imports HIGH_IMPACT_CATEGORIES | CLOSED in S27 |
| B-27-wizard-order | DONE | ScanWizard launch→checkout reorder | CLOSED in S27 |
| B-27-actor401 | PARTIAL | New S27 handlers return 401; S26 scans.ts still throws | S28 polish |
| B-27-envelope-unify (carry) | MEDIUM | API envelope inconsistency | dedicated sprint |
| B-27-progress-leak-test | DONE | A-27-13 cross-tenant findings_count leak test | CLOSED in S27 |
| **S25 carry-over** (4 items) | varies | Still open | S28 polish |

---

## Carry-over for S28 reviewer

### Active checks for S28 review

- **AUDIT_ACTIONS baseline = 96** (post-S27); S28 target depends on api_token decision
- **B6 K baseline = 13** (post-S27); S28 target = 13 unless mig 026 lands
- **api_tokens table** exists in mig 025 (DDL committed; routes deferred). S28 ships CRUD + audit
- **PORT TS4111 in serve.ts:** pre-existing from S24, doesn't fail build. S28 polish opportunity (`process.env['PORT']`)
- **`tier` index-signature TS4111** in scans.ts (S26 carry, doesn't fail build). S28 polish
- **Report auto-build flow** (B-27-autobuild) — recommend enqueue at scan-launch completion
- **Tenant defence-in-depth** (B-27-tenantfilter) — change A-26-3 expected status + add `.where('tenant_id', '=', ...)` to scan-launch target SELECT

### Frozen surfaces (re-verify every sprint)
- All previously frozen + migrations 001-025

### Test-count baseline at end of S27
- **No-DB:** 1004 pass / 0 fail / 408 skip / 1412 total
- **Full-PG (pristine schema):** **1281 pass / 15 fail / 19 skip / 1315 total**

### E2E paths walked

**Direct API smoke (lead, S27):** register → project create → target create → DB-write `ownership_status='verified'` → POST /scans tier=light → 200 `{scan_id, state:'running'}` → GET /progress → `{state, findings_count:0, recent_audit_events:[{action:'scan.launched'}]}` → GET /findings → `{findings:[], total:0, page:1, limit:20}` → GET /report/html → 409 `report_not_ready` → GET /scans → `{items:[{scan_id, state, tier:'light', project_id, created_at}], total:1}`. ALL green.

### Pitfalls v9 surfaced this sprint

- **P53 (NEW):** Hono route patterns with `.` separator don't capture suffix params — use slash
- **P54 (NEW):** Generator name collision risk on team respawn — old-named agent may pick up new sprint task

---

## Verdict line for harness routing

**PASS_WITH_BACKLOG** — S27 ships. **Demo-able MVP gate REACHED.** End-to-end SaaS flow operational. 11+ backlog items carry to S28 (deploy + remaining HIGH hardening).

Lead escalates to user with full summary + git log + screenshots.
