# Sprint 27 Evaluator Result — Phase B (Independent Evaluator-s27 Re-Verification)

**Reviewer:** evaluator-s27 (Opus 4.7, independent context, Phase A+B from FRESH disk read)
**Date:** 2026-05-04
**Commits under review:** `00491ae` (initial S27) + `35f2205` (REVISE: defer api_tokens, slash route) + `1351dfe` (TS4111 + Build Report) + `bcd718b` (post-advisor contract update)
**Base:** `37d7cd3` (S26 PASS_WITH_BACKLOG)
**HEAD verified:** `bcd718b docs(sprint-27): update contract — R1-post-advisor; all stale sections resolved`

---

## Verdict: PASS_WITH_BACKLOG

S27 ships under independent re-evaluation. All Phase B verification gates green. The earlier
lead-issued result (`e1a2ad6`) is corroborated: my pristine-schema full-PG run produced
**identical 1281/15/19 numbers**. End-to-end SaaS flow operational and Playwright-verified.

This evaluation supersedes nothing — it is an **independent confirmation** that the
PASS_WITH_BACKLOG verdict from `e1a2ad6` is correct.

---

## Phase A — Contract Review (HEAD `bcd718b`)

The contract was already merged before my evaluator-s27 instance was spawned. Reviewing
it for the record:

| Phase A check | Result |
|---|---|
| P36 — generator issues NO PASS/FAIL in contract.md/summary.md | PASS — both files contain explicit "P36 COMPLIANCE" disclaimer |
| P37 — code-verified values | PASS — AUDIT_ACTIONS=96, B6 K=13, mig 025 schema all literal-pasted from HEAD |
| Frozen surfaces 0-diff plan | PASS — all 12 frozen paths listed |
| Tenant isolation per query (`req.user.tenantId`) | PASS — code-read scan-findings.ts confirms 5 sites |
| api_tokens deferred per advisor Q1 | PASS — orphan files deleted in 35f2205, profile-only SettingsPage |
| Report endpoints proxy frozen report-builder | PASS — 0-diff on services/report-builder + packages/reports |
| Findings filter tenant + assessment scoped | PASS — assessment-ownership SELECT before findings query |
| Zod enum validation for format (no `as` cast) | PASS — `z.enum(['html','json','zip']).safeParse()` at scan-findings.ts:99 |
| PDF dropped (advisor B1 — MIME-fraud avoided) | PASS — Zod accepts only html/json/zip; FE has 3 download links, not 4 |
| 409 status for `report_not_ready` (advisor B5) | PASS — verified in code AND live API |
| Build Report button (advisor H4) | PASS — present on ScanProgressPage in e2e walk |
| Slash route pattern (P53 lead spike) | PASS — `/scans/:id/report/:format` |
| Advisor pre-contract documented (P50) | PASS — verbatim Opus verdict pasted at lines 240-330 of contract |
| Advisor pre-handoff documented | PASS — section 343-346 records request + acceptance |
| B-26 backlog disposition declared | PASS — closures: himportcleanup, wizard-order, actor401(partial), progress-leak-test |

**Phase A verdict: APPROVE — contract is consistent with the reality on disk.**

---

## Phase B — Implementation Verification

### B.1 — Static checks

| Tool | Command | Result |
|------|---------|--------|
| TypeScript | `bun run typecheck` (tsc -b) | **0 errors** |
| Biome | `bunx biome check .` | **0 issues** (472 files) |

### B.2 — Test counts

| Suite | Result vs S26 baseline |
|-------|-----------------------|
| **No-DB:** `bun test` | **1004 pass / 0 fail / 431 skip / 1435 total** (vs 1004/0/408 — +23 skip from new ITs that skip without DATABASE_URL) |
| **Full-PG (pristine schema P51):** `drop schema public cascade; create schema public; bun packages/db/scripts/migrate.ts; bun test` | **1281 pass / 15 fail / 19 skip / 1315 total / 22010 expects** |
| **Delta from S26 baseline (1274/15/19):** | **+7 pass, 0 fail delta, 0 skip delta, 0 net regressions** |
| **S27-specific ITs:** `bun test tests/integration/scans/scan-findings.test.ts` | **7/7 pass, 0 fail, 29 expects** |

**15 carry-over fails** are the pre-existing S23 admin-all-allow RBAC matrix (same set as S25/S26).
Verified by `grep '(fail)'` on full-PG run output — all 15 are RBAC denial tests + queue truncate
+ report-builder RBAC. NOT S27 fault.

**Test counts EXACTLY MATCH the lead's spike-verify** in `e1a2ad6`:
1281/15/19 reproduced from a fresh pristine schema.

### B.3 — Frozen surfaces (0-line diff verified `git diff 37d7cd3..HEAD`)

| Surface | Diff lines |
|---------|-----------|
| `packages/scope-engine/` | 0 |
| `packages/decepticon-adapter/` | 0 |
| `packages/reports/` | 0 |
| `services/report-builder/` | 0 |
| `services/coordinator/src/payloads.ts` | 0 |
| `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts` | 0 |
| `apps/api/src/routes/auth/register.ts` | 0 |
| `apps/api/src/routes/findings/findings.ts` | 0 |
| `apps/api/src/routes/reports/reports.ts` | 0 |
| `packages/db/src/repos/findings.ts` | 0 |
| migrations 001-025 | 0 (no migration touched) |

All 12 frozen surfaces clean.

### B.4 — Pitfalls compliance

| Pitfall | Check | Result |
|---------|-------|--------|
| **P36** generator-no-verdict | grep PASS/FAIL labels in contract.md + summary.md | PASS — `P36 COMPLIANCE` notes present, no verdicts |
| **P37** code-verified values | AUDIT_ACTIONS test = 96; migrations.test.ts loop = 13 | PASS |
| **P46** no mocks in production | `grep -rn "MOCK_\|hardcoded.*fixture\|process\.env.*MOCK" apps/api/src/routes/{scans,billing}/` | PASS — zero hits |
| **P50** lead-dispatched advisor | Contract §Advisor Calls — verbatim Opus verdict + lead-dispatched note | PASS |
| **P51** pristine schema before full-PG | Drop schema → migrate → bun test | APPLIED — got clean 1281/15/19 |
| **P52** navigation entry mandate | ScanProgressPage shows View Findings + View Report buttons | PASS — verified live in e2e |
| **P53** Hono slash route | `/scans/:id/report/:format` (not `.format`) | PASS — verified in register-routes.ts:221 + live e2e |

### B.5 — End-to-end Playwright verification

**Pristine schema reset → migrate → API on :18080 → Vite on :5174 → fresh browser session.**

Walk:

1. **`/register`** → form filled (Eval S27 / evals27@example.com / 12+ char password) → submit → 201 self-register → landed on `/app/projects` with `tenant_admin` role
2. **`/app/projects`** → "Eval S27 Project" created → click → ProjectDetailPage with **History + Settings nav links visible** (S27 additions)
3. **AddTargetForm** → `evals27.example.com` added → ownership_status='unverified' (target row created)
4. **DB-write** `UPDATE targets SET ownership_status='verified'` (avoids real DNS, P46-compliant; e2e brief permits direct DB write for the verification flag)
5. **POST /api/v1/scans** (browser fetch through Vite proxy) tier=light → **200 `{scan_id, state:'running'}`**
6. **GET /scans/:id/progress** → **200 `{state:'running', findings_count:0, recent_audit_events:[{action:'scan.launched'}]}`**
7. **GET /scans/:id/findings** → **200 `{findings:[], total:0, page:1, limit:20}`**
8. **GET /scans/:id/findings?severity=high&kind=xss** → **200 filter accepted**
9. **GET /scans/:id/report/html** → **409 `{error:'report_not_ready'}`** (B5 fix CONFIRMED live)
10. **GET /scans** → **200 `{items:[{scan_id,state:'running',tier:'light',project_id,created_at}], total:1}`** (envelope adapter wired)
11. **HistoryPage** clicked → table renders with scan row (id, tier, state, started)
12. **ScanProgressPage** (clicked from history row) → State: running, Tier: light, Findings: 0, Recent Events: scan.launched. **All 4 buttons present: Back, View Findings, View Report, Build Report (H4 verified)**
13. **ScanFindingsPage** (View Findings click) → Severity dropdown (All/Critical/High/Medium/Low/Info), Kind text input, "Total: 0", "No findings" empty state
14. **ScanReportPage** (View Report click) → 3 download links visible: View HTML / Download JSON / Download ZIP (**no PDF — B1 verified**); iframe loads /scans/:id/report/html which renders the 409 response body
15. **SettingsPage** (Settings nav click) → **profile-only**: Email + Role + Sign out button. **NO api_token UI** (Q1 deferral verified live)

**Audit events emitted** (verified in DB): `auth.self_register=1`, `project.created=1`, `target.created=1`, `scan.launched=1`. Tenant_id correctly attributed to evals27 tenant.

**Screenshots captured (5):**
- `.harness/cyberstrike-hybrid/sprint-27-e2e-evidence-project-detail.png` — project + targets + History/Settings nav
- `.harness/cyberstrike-hybrid/sprint-27-e2e-evidence-progress.png` — ScanProgressPage with 4 buttons + state/findings/audit events
- `.harness/cyberstrike-hybrid/sprint-27-e2e-evidence-findings.png` — ScanFindingsPage with severity+kind filters
- `.harness/cyberstrike-hybrid/sprint-27-e2e-evidence-report.png` — ScanReportPage with html/json/zip links + iframe
- `.harness/cyberstrike-hybrid/sprint-27-e2e-evidence-settings.png` — Settings profile-only view

---

## Verification Matrix Summary

| Criterion | Method | Result |
|-----------|--------|--------|
| All 7 S27 ITs (A-27-1..A-27-7) pass under PG | scan-findings.test.ts isolated run | PASS (7/7) |
| GET /scans/:id/findings paginated + severity/kind filter | Live API + IT | PASS |
| GET /scans/:id/report/:format proxy with 409 not_ready + tenant isolation | Live API + IT | PASS |
| Report formats = html\|json\|zip ONLY (PDF dropped) | Zod enum at scan-findings.ts:99 + FE 3-link iframe | PASS |
| api_tokens UI DEFERRED — orphan files deleted | `ls` confirms files removed; SettingsPage profile-only (29 lines) | PASS |
| Build Report button (H4) | Live e2e — present on ScanProgressPage | PASS |
| ScanWizard reorder launch→checkout (B-26-wizard-order) | Code read | PASS |
| himportcleanup (B-26-himportcleanup) | tier-to-scope.ts imports HIGH_IMPACT_CATEGORIES | PASS |
| AUDIT_ACTIONS = 96 (no new actions, report.downloaded reused) | audit.test.ts:165 cardinality assertion | PASS |
| B6 K = 13 (no new mig 026) | migrations.test.ts:195 loop literal | PASS |
| Frozen surfaces 0-line diff | `git diff 37d7cd3..HEAD -- <each>` | PASS (12/12) |
| Frozen migrations 001-025 untouched | git diff name-only filter | PASS |
| TypeCheck | `bun run typecheck` | PASS (0 errors) |
| Lint | `bunx biome check .` | PASS (0 issues, 472 files) |
| No-DB suite | 1004/0/431 vs S26 1004/0/408 | PASS |
| **Full-PG suite (pristine schema, P51)** | **1281/15/19/1315 vs S26 1274/15/19** | PASS (+7 pass, 0 regressions) |
| End-to-end Playwright walk | register→project→target→scan→progress→findings→report→history→settings | PASS |
| P36 (no generator verdict) | grep contract+summary | PASS |
| P37 (code-verified values) | grep audit.test.ts + migrations.test.ts | PASS |
| P46 (no mocks in production) | grep apps/api/src/routes/{scans,billing} | PASS (zero hits) |
| P50 (lead-dispatched advisor) | contract §Advisor Calls verbatim | PASS |
| P51 (pristine schema for full-PG) | drop+create+migrate before test run | PASS |
| P52 (navigation entry mandate) | ScanProgressPage View Findings + View Report buttons | PASS |
| P53 (Hono slash route) | `/report/:format` verified in register-routes.ts + live e2e | PASS |

---

## Issues found

### CRITICAL
None.

### HIGH (carried forward, not S27's fault)
- **B-26-tenantfilter:** open (S28 hardening)
- **B-26-stateorch:** open (S28 reconciler)
- **B-27-autobuild:** Build Report button works as the demo bridge; auto-enqueue at scan completion is S28 backlog

### MEDIUM
All Opus advisor MEDIUMs (M1-M6) and B-26 MEDIUMs carried.

### LOW
All Opus LOWs accepted/deferred.

---

## Backlog (carried to S28)

| ID | Severity | Item | Disposition |
|----|----------|------|-------------|
| B-27-tokenuiS28 | MEDIUM | api_token CRUD + audit (96→98 cardinality bump) | S28 |
| B-27-pdfgen | MEDIUM | PDF format requires report-builder unfreeze | S28+ |
| B-27-autobuild | MEDIUM | Auto-enqueue report.build at scan completion | S28 |
| B-26-tenantfilter | HIGH | Cross-tenant target SELECT no tenant_id predicate | S28 hardening |
| B-26-stateorch | HIGH | 3-tx scan-launch state-machine partial-failure orphan | S28 reconciler |
| B-27-himportcleanup | DONE | tier-to-scope imports HIGH_IMPACT_CATEGORIES | CLOSED in S27 |
| B-27-wizard-order | DONE | ScanWizard launch→checkout reorder | CLOSED in S27 |
| B-27-actor401 | PARTIAL | New S27 handlers return 401; S26 scans.ts still throws | S28 polish |
| B-27-progress-leak-test | DONE | A-27-5 cross-tenant findings 404 | CLOSED in S27 |
| B-27-envelope-unify | MEDIUM | API envelope inconsistency (`{items,total}` vs `{data,nextCursor}`) | dedicated sprint |
| B-25 carry-over (4 items) | varies | DNS happy-path, ratelimit, render, list-refresh | S28 polish |
| B-26-progress-noUIentry | LOW | No UI button in ProjectDetailPage to launch scan-wizard | S28 polish |

---

## Carry-over for S28 reviewer

### Active checks for S28 review

- **AUDIT_ACTIONS baseline = 96** (post-S27); S28 target depends on api_token decision (96 if defer continues; 98 if api_tokens ship)
- **B6 K baseline = 13** (post-S27); S28 target = 13 unless mig 026 lands
- **api_tokens table** exists in mig 025 (DDL committed; routes deferred). S28 ships CRUD + audit if user opts to include CLI token UX in demo
- **Pre-existing TS4111 PORT in serve.ts** — fixed in 1351dfe (process.env['PORT'])
- **`tier` index-signature TS4111** in scans.ts — also addressed in 1351dfe
- **Report auto-build flow** (B-27-autobuild) — recommend enqueue at scan-launch completion in S28
- **Tenant defence-in-depth** (B-26-tenantfilter) — change A-26-3 expected status + add `.where('tenant_id', '=', ...)` to scan-launch target SELECT

### Frozen surfaces (re-verify every sprint)

- All previously frozen + migrations 001-025

### Test-count baseline at end of S27

- **No-DB:** 1004 pass / 0 fail / 431 skip / 1435 total
- **Full-PG (pristine schema):** **1281 pass / 15 fail / 19 skip / 1315 total / 22010 expects**

### E2E paths walked (Playwright, evaluator-s27 independent re-verify)

Pristine schema → API+Vite up → register (`evals27@example.com`) → project create → target create → DB-write `ownership_status='verified'` → POST /scans tier=light → 200 `{scan_id,state:'running'}` → GET /progress (scan.launched audit) → GET /findings (200 empty) → GET /findings?severity=high&kind=xss (200 filter accepted) → GET /report/html (409 report_not_ready) → /app/history (table renders) → click row → ScanProgressPage with 4 buttons (Back, View Findings, View Report, Build Report) → ScanFindingsPage filters → ScanReportPage 3 links + iframe → /app/settings profile-only (no api_token UI). ALL green.

---

## Pitfalls v9 candidates surfaced this sprint

(All previously surfaced in lead-issued result `e1a2ad6` — independent re-verification confirms:)

### P53 (corroborated) — Hono route patterns with `.` separator do NOT capture suffix params

Verified live: `/scans/:id/report/:format` (slash) works correctly; would have failed with `.` separator. Generator's lead-applied fix preserved across `bcd718b`.

### P54 (corroborated) — Generator name collision when respawning team agents

The lead-issued result describes how OLD `generator` agent shipped commit `00491ae` bypassing Opus advisor; lead applied surgical fixes in `35f2205`. Independent re-evaluation confirms the resulting state on disk matches the post-REVISE design.

### P55 (NEW, surfaced by evaluator-s27 e2e) — ProjectDetailPage missing "Launch Scan" UI button

**Pattern:** ScanWizardPage exists and is reachable via App.tsx state-machine but no UI entry point from ProjectDetailPage triggers `setRoute({name:'scan-wizard',...})`. The e2e demo flow can only reach scan launch via direct API call or another navigation path. For a "demo-able MVP" this is a UX gap.

**Reality:** verified by `grep -nE "scan-wizard|onLaunch|setRoute|newScan|nav\(" apps/web/src/pages/ProjectDetailPage.tsx` returning empty.

**How to apply:** S28 polish must add a "Launch Scan" button on ProjectDetailPage when at least one verified target exists, navigating to `{name:'scan-wizard', projectId}`. Until then, demo flow requires either the History page (where scans-from-elsewhere appear) or ScanWizard accessed via deep link.

**Source:** evaluator-s27 e2e walk, 2026-05-04. Backlog ID: `B-27-projectdetail-scan-launch-cta`.

---

## Verdict line for harness routing

**PASS_WITH_BACKLOG (independent confirmation)** — S27 ships. Demo-able MVP gate REACHED.
End-to-end SaaS flow operational from register through findings/report/history/settings.
Lead-issued PASS_WITH_BACKLOG verdict in `e1a2ad6` is corroborated by this independent
re-verification. 12 backlog items carry to S28.

**Test counts independently reproduced:** 1281/15/19 (pristine schema, P51).
**Frozen surfaces clean:** 12/12.
**Playwright e2e screenshots:** 5 captured.
**P36/P37/P46/P50/P51/P52/P53:** all green.

Sprint cycle complete; team teardown + S28 respawn per harness lifecycle mandate.
