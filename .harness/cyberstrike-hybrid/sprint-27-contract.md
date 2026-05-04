# Sprint 27 Contract — Findings + Report + History + Settings

**Generator:** generator-s27 (Sonnet 4.6)
**Date:** 2026-05-04
**Revision:** R1 (pre-advisor draft)
**Base commit:** `37d7cd3` (docs(sprint-26): lead-issued evaluator result PASS_WITH_BACKLOG)
**Baseline tests:** no-DB 1004/0/408 | full-PG 1274/15/19/1308 (S26 PASS_WITH_BACKLOG)
**Harness:** cyberstrike-saas-s26-s28

> **P36 COMPLIANCE:** This document contains NO evaluator verdict. PASS/FAIL is issued exclusively by the evaluator.

---

## Carry-over closure

| ID | Item | Resolution |
|----|------|-----------|
| B-26-himportcleanup | `tier-to-scope.ts` hardcodes HIGH_IMPACT_CATEGORIES | Fix in S27 — import from `@cyberstrike/contracts` |
| B-26-actor401 | `requireActor` throws instead of 401 | Fix in S27 new handlers — return 401 on missing actor |
| B-26-wizard-order | ScanWizardPage checkout before launchScan | Fix in S27 — reorder to launchScan first, then checkout |
| B-26-progress-leak-test | A-26-10 missing findings_count cross-tenant assertion | Close via A-27-5 cross-tenant findings isolation test |
| B-25-ratelimit | Rate limit carry | Defer to S28 |
| B-25-already-verified-render | Render of already-verified domain | Defer to S28 |
| B-25-list-refresh-pattern | Scan list refresh after launch | Defer to S28 |
| B-25-realdns-happypath | Real DNS happy-path Playwright | Defer to S28 |
| serve.ts:15 TS PORT | Pre-existing TS4111 | Defer to S28 |

---

## Code-verified baselines (P37)

| Baseline | Source | Value |
|----------|--------|-------|
| AUDIT_ACTIONS | `node -e` count on `packages/contracts/src/audit.ts` | **96** |
| B6 K | `tests/integration/db/migrations.test.ts:195` | **13** |
| `finding.*` + `report.*` actions exist | grep `packages/contracts/src/audit.ts` | `finding.created`, `finding.status_changed`, `report.build.requested`, `report.build.started`, `report.build.completed`, `report.build.failed`, `report.finding.excluded_oos`, `report.downloaded` |
| api_tokens schema | `packages/db/migrations/025_scans_api_tokens.ts` | `id, tenant_id, user_id, token_hash, name, last_used_at, expires_at, created_at` — UNIQUE(token_hash) |
| `listFindingsByAssessment` signature | `packages/db/src/repos/findings.ts:132` | `{ db, tenantId, assessmentId }` — no filter params at DB layer |
| S27 target AUDIT_ACTIONS | Appendix Z.5 (authoritative) | **96** (+0; reuses `finding.*`, `report.*`) |
| S27 B6 K | Appendix Z.6 (authoritative) | **13** (no new migration) |

---

## Open question for advisor (P50 workflow)

**Q1 — api_tokens UI in S27?**

Conflict: `saas-user-criteria.md:43` says "Public API + CLI клиент" is OUT OF SCOPE. Spec body §10 S27 DoD explicitly includes `/app/settings` with API token generation. Appendix Z.5 says S27 +0 audit actions. Appendix Z.6 says api_tokens deferred per Z.2 #3. Z header: Z wins over body.

Generator's read: api_tokens TABLE already exists (mig 025, no new mig needed). The demo MVP requires a settings page. Z.2 #3 asked the question; Z.6 says deferred. But criteria line 7 includes the full flow "history + settings" in the demo goal.

Decision requested: ship settings+token UI (using mig 025), or ship settings with profile-only?

**Q2 — api_token audit events?**

If api_tokens ships: `auth.api_token.created` / `auth.api_token.revoked` do not exist in AUDIT_ACTIONS (96). Z.5 says +0. Options: (a) add 2 actions → 98, contradicts Z.5; (b) skip audit for api_token CRUD. Generator recommends (b) skip for v1.

**Q3 — report proxy approach?**

Report-builder is frozen. In dev/test no real object storage exists. Generator's design: `GET /api/v1/scans/:id/report.{html,pdf,json,zip}` looks up latest `reports` row WHERE assessment_id=:id AND status='ready', then proxies via `deps.objectStorage.get()`. Returns 404 `report_not_ready` when no ready report. Alternative: redirect to existing `/api/v1/reports/:id/download`. Advisor preference?

---

## Goal + Scope

Sprint S27 delivers the demo-able MVP gate:

**Backend:**
1. `GET /api/v1/scans/:id/findings` — paginated findings, severity + kind filter (lowercased), tenant-scoped
2. `GET /api/v1/scans/:id/report.html|json|zip` — proxy report artifacts via `reports` table + object-storage (NO pdf — advisor B1)

**Frontend:**
3. `/app/scans/:id/findings` — DataTable with severity/kind filter + finding detail drawer
4. `/app/scans/:id/report` — HTML iframe + download buttons (json, zip only — no pdf)
5. `/app/history` — paginated scan list
6. `/app/settings` — profile-only: read-only email + role + Sign out (api_tokens deferred to S28 — advisor Q1)
7. ScanProgressPage: "Build Report" button (`POST /api/v1/assessments/:id/reports`) + "View Findings" / "View Report" nav buttons

**Carry-over fixes:**
- B-26-himportcleanup: import `HIGH_IMPACT_CATEGORIES` from `@cyberstrike/contracts`
- B-26-actor401: new handlers return 401 on missing actor (S27 handlers only)
- B-26-wizard-order: verified correct in HEAD (launchScan first, checkout second) — no change
- A-26-13 closure: A-27-5 cross-tenant findings isolation test

**api_tokens deferred to S28** with carry item B-27-tokenuiS28 (must add audit actions 96→98 when shipping)

**No new migration** (no new tables in S27)

---

## Architecture Decisions

### A27-1: Findings endpoint — scan-scoped URL + application-level filter

Route: `GET /api/v1/scans/:id/findings?severity=<>&kind=<>&page=<>&limit=<>`

`:id` = scan_id = assessment_id. Consistent with `/scans/:id/progress` pattern.

**Filter approach:** Application-level in handler, not DB-level. `listFindingsByAssessment` has no filter params and returns all findings for a tenant-scoped assessment. For bounded datasets (100s of findings per scan), in-handler filtering is correct. No change to `packages/db/src/repos/findings.ts`.

**Scan ownership check first:** SELECT assessment WHERE id=:id AND tenant_id=:tenantId. 404 if not found — prevents tenant leakage.

**Pagination:** `page` (1-indexed, default 1) + `limit` (default 20, max 100).

**Response shape:** `{ findings: [...], total: number, page: number, limit: number }`

**Audit:** None — read-only, consistent with existing `handleListAssessmentFindings`.

### A27-2: Report proxy via reports table

Handler: `handleScanReport(deps, c, format: 'html'|'pdf'|'json'|'zip')`

1. Tenant-scope assessment lookup (404 if not found/cross-tenant)
2. SELECT latest report WHERE assessment_id=:id AND status='ready' ORDER BY created_at DESC LIMIT 1
3. If none: `{ error: 'report_not_ready' }` 404
4. Read `objectKeyHtml/Pdf/Json/Zip` from report row; call `deps.objectStorage.get(key)`
5. If `deps.objectStorage` null: 503
6. Stream bytes with correct Content-Type + Content-Disposition
7. Emit `report.downloaded` audit (reuses existing action — AUDIT_ACTIONS stays 96)

**No changes to `services/report-builder/`**, `packages/reports/`, or `apps/api/src/routes/reports/reports.ts`.

### A27-3: api_tokens endpoints (pending advisor Q1 verdict)

New file: `apps/api/src/routes/auth/api-tokens.ts`

Token generation:
- `crypto.randomBytes(32).toString('hex')` → 64-char hex plaintext
- `createHash('sha256').update(plaintext).digest('hex')` → token_hash
- INSERT `api_tokens(tenant_id, user_id, token_hash, name, expires_at)`
- Response: `{ token: plaintext, id, name, createdAt }` — plaintext ONLY on create

**No audit emit** (Z.5 says +0 new actions; `auth.api_token.*` not in AUDIT_ACTIONS; adding would break cardinality assertion). Accepted v1 gap.

**Tenant isolation:** All queries filter by `tenant_id = actor.tenantId` AND `user_id = actor.id`.

**P48 check:** api_tokens already in `dropAllTables` (db-fixture.ts:106) and `resetAuthState` (auth-fixture.ts:275). ✓

### A27-4: Frontend routing additions

App.tsx Route union additions:
```typescript
| { name: 'scan-findings'; scanId: string }
| { name: 'scan-report'; scanId: string }
| { name: 'history' }
| { name: 'settings' }
```

New pages:
- `ScanFindingsPage.tsx` — DataTable + severity/kind select filters + row-click drawer
- `ScanReportPage.tsx` — iframe src=`/api/v1/scans/:id/report.html` + download anchors
- `HistoryPage.tsx` — `listScans()` paginated table with scan state + created_at
- `SettingsPage.tsx` — profile section (email, role read-only) + token section (pending)

Nav additions: History + Settings links in `<nav>` in App.tsx.

ScanProgressPage: add "View Findings" button (nav to scan-findings) + "View Report" button (nav to scan-report) after scan state is observed.

### A27-5: B-26-himportcleanup

`apps/api/src/scans/tier-to-scope.ts` — replace hardcoded `['c2','post_exploit','ad','credential_audit']` array with imported `HIGH_IMPACT_CATEGORIES` from `@cyberstrike/contracts`.

Code-verified: `packages/contracts/src/assessments.ts:10` exports `HIGH_IMPACT_CATEGORIES`.

**gitnexus impact on `tierToHighImpactCategories` (upstream):** only caller is `handleLaunchScan` in `scans.ts`. Risk: LOW — cosmetic import change, behavior unchanged, A-26-12 will still assert the same 4 categories.

---

## Integration Tests

### `tests/integration/scans/scan-findings.test.ts`

| ID | Test | Assertion |
|----|------|-----------|
| A-27-1 | GET /scans/:id/findings empty scan | 200 `{findings:[], total:0, page:1, limit:20}` |
| A-27-2 | Severity filter: severity=high | Only high findings returned |
| A-27-3 | Kind filter: kind=xss (type field) | Only findings with type='xss' returned |
| A-27-4 | Pagination: page=1&limit=1 with 3 findings | Returns 1, total=3 |
| A-27-5 | Cross-tenant: GET /scans/:other_id/findings | 404 (tenant isolation — closes B-26-progress-leak-test) |
| A-27-6 | GET /scans/:id/report.html no ready report | **409** `{error:'report_not_ready'}` (advisor B5) |
| A-27-7 | Bad UUID: GET /scans/not-uuid/findings | 400 |

### `tests/integration/auth/api-tokens.test.ts` (if api_tokens ship)

| ID | Test | Assertion |
|----|------|-----------|
| A-27-8 | POST /auth/api-tokens → plaintext token in response | `{token: string(64), id, name, createdAt}` |
| A-27-9 | GET /auth/api-tokens → no token_hash in list | `{tokens: [{id,name,createdAt,expiresAt,lastUsedAt}]}` |
| A-27-10 | DELETE /auth/api-tokens/:id → 204; GET list omits it | Revocation |
| A-27-11 | Cross-tenant DELETE → 404 | Tenant isolation |
| A-27-12 | POST with expiresAt in past → 422 | Input validation |

---

## Blast-radius analysis

| Symbol to modify | File | Upstream callers | Risk |
|-----------------|------|-----------------|------|
| `handleLaunchScan` | scans/scans.ts | None direct (route handler) | LOW |
| `tierToHighImpactCategories` | scans/tier-to-scope.ts | handleLaunchScan only | LOW |
| register-routes.ts | routes/register-routes.ts | Main app startup only | LOW |
| App.tsx | apps/web/src/App.tsx | Entry point only | LOW |

*(Full gitnexus_impact runs will be in pre-handoff section)*

---

## Frozen surfaces (0-line diff)

- `apps/api/src/routes/auth/register.ts`
- `packages/scope-engine/`
- `packages/decepticon-adapter/`
- `packages/reports/`
- `services/report-builder/`
- `services/coordinator/src/payloads.ts`
- `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts`
- migrations 001-025 (no new migration in S27)
- `apps/api/src/routes/findings/findings.ts` (existing findings routes — untouched)
- `apps/api/src/routes/reports/reports.ts` (existing report routes — untouched)
- `packages/db/src/repos/findings.ts` (no DB layer changes)

---

## Cardinality invariants

| Metric | Pre-S27 | Post-S27 |
|--------|---------|---------|
| AUDIT_ACTIONS | 96 | **96** (Z.5 authoritative) |
| B6 K | 13 | **13** (Z.6: no new mig) |
| no-DB pass | ≥1004 | ≥1004 + new unit tests |
| full-PG pass | 1274 | ≥1274 + 7-12 new ITs |
| full-PG fail | 15 | 15 (0 delta) |

---

## Advisor Calls

### PRE-CONTRACT (Advisor Call #1)

**Status:** COMPLETE — lead-dispatched Opus 4.7 verdict received.

**Verbatim Opus response:**

═══════════════════════════════════════════════════════════════
**Q1 verdict: REVISE — DEFER api_tokens UI to S28.**
- saas-user-criteria.md:43 says "Public API + CLI клиент" OUT OF SCOPE
- Z.6 explicitly defers api_tokens
- Z.5 audit math = +0 (assumes deferral)
- Two of three authoritative sources say defer; Z-header rule (Z>body) supports defer
- /app/settings ships PROFILE-ONLY (read-only email + role + "Sign out" button)
- DELETE working-tree files: `apps/api/src/routes/auth/api-tokens.ts`, `apps/web/src/api/api-tokens.ts`. Move to `.s28-pending/` if want to preserve work
- REMOVE routes from `register-routes.ts:225-228`
- Add carry: B-27-tokenuiS28 — "ship api_token CRUD + add `auth.api_token.created`/`.revoked` audit (97/98 cardinality bump) in S28"

**Q2 (moot if Q1=defer):** If user overrides → MUST add `auth.api_token.created` + `auth.api_token.revoked` (96→98). Skip-audit on token creation = silent privilege grant = HARD-FAIL.

**Q3 (report proxy):** APPROVE design with 3 fixes (BLOCKER 1, 4, MEDIUM auto-build).

═══════════════════════════════════════════════════════════════
**5 BLOCKERS to fix:**

**B1 (BLOCKER) `scan-findings.ts:141-145` — PDF MIME-fraud.**
Code streams ZIP bytes with `Content-Type: application/pdf`. NO PDF artifact exists in `reports` table (mig 013 has `object_key_html|json|zip` only). report-builder produces no PDF. **Drop PDF from S27.** Route accepts `html|json|zip` only. FE shows 1 iframe + 2 download buttons. Backlog B-27-pdfgen for S28+.

**B2 (BLOCKER if api_tokens ship) `register-routes.ts:225` — no idem middleware.**
Token-creation POST without idempotency = double-click creates 2 tokens, leaks plaintext only for 1. Moot if Q1=defer.

**B3 (BLOCKER if api_tokens ship) `register-routes.ts:225` — no rate limit.**
Token-farm attack: 1000 POSTs/sec creates 1000 valid tokens. Moot if Q1=defer.

**B4 (BLOCKER if api_tokens ship) `api-tokens.ts:58` — "no audit emit" comment is wrong security posture.**
Token creation = privilege grant. MUST be audited even in v1. Moot if Q1=defer.

**B5 (BLOCKER consistency) `scan-findings.ts:122` — wrong status code.**
Returns 404 for "no ready report". Existing `reports.ts:239` returns 409 for same condition. Change to 409. Update A-27-6 expected status to 409.

═══════════════════════════════════════════════════════════════
**4 HIGH:**

**H1 `scan-findings.ts:96` — TS cast lies.**
`c.req.param('format') as 'html'|'pdf'|'json'|'zip'` — cast lies. Use:
```typescript
const format = c.req.param('format');
const valid = z.enum(['html','json','zip']).safeParse(format);
if (!valid.success) return c.json({error:'invalid_format'}, 400);
```

**H2 last_used_at unused.** Either remove from response OR document "set by future api-token auth middleware". (Moot if Q1=defer.)

**H3 expiresAt schema missing.** A-27-12 expects `expiresAt in past → 422`, but schema accepts `name` only. Add `expires_at: z.string().datetime().optional()` with past-date validator. (Moot if Q1=defer.)

**H4 report auto-build missing.** S27 demo `launch scan → see report` won't terminate because launching scan doesn't enqueue report-build. Pick one:
- (a) Add "Build Report" button in `ScanProgressPage` that calls existing `POST /api/v1/assessments/:id/reports`
- (b) Pre-seed fixtures with ready report for demo
- (c) Document "S27 ships UI shell only; live demo manually pre-seeds; auto-build deferred to S28"

Recommend (a) — minimal effort, real flow.

═══════════════════════════════════════════════════════════════
**6 MEDIUM (backlog items):**

- M1 case-sensitive filter on severity/kind — normalize lowercase OR doc FE contract
- M2 cross-tenant 404 vs 403 inconsistency — pick canonical (read=404, mutation=403)
- M3 doc clarification: `findings-scan.ts` NEW vs `findings.ts` REUSED type
- M4 B-26-actor401 disposition: scope to "S27 new handlers only" OR also update S26 scans.ts
- M5 App.tsx state-machine: refresh on `/app/scans/abc/findings` won't recover (deep-link gap, document for S28)
- M6 100s findings/scan limit — backlog B-27-findings-db-filter for 10k+ scale

═══════════════════════════════════════════════════════════════
**Architecture Q1-Q4 verdicts:**

- Q1 findings filter: APPROVE (app-level OK for bounded dataset)
- Q2 no new mig: APPROVE (mig 025 schema verified)
- Q3 ScanProgressPage nav buttons (P52): APPROVE — but **e2e MUST walk Progress→click "View Findings"→land on findings page**. Add explicit acceptance criterion.
- Q4 wizard-order fix: APPROVE direction (launch-first), but real bug is **checkout coupled to launch at all**. S27 minimum: reorder. S28 backlog B-27-checkout-decouple: "remove checkout from ScanWizardPage; subscription set at signup".

═══════════════════════════════════════════════════════════════
**Frozen surfaces:** ALL clean. **Working-tree note:** `packages/db/src/schema.ts` shows `M` in git status — confirm this is the api_tokens table type added when mig 025 landed in S26 (S26 carry, not S27 modification).

═══════════════════════════════════════════════════════════════
**Summary:** REVISE before implementation continues.

**Required edits:**
1. Q1 = DEFER api_tokens (delete 3 routes + handler + FE adapter; profile-only settings page)
2. Drop PDF from report formats
3. Change A-27-6 expected status 404→409
4. Add auto-report-build resolution (recommend manual button on ScanProgressPage)
5. Document wizard-order fix scope (S27 reorder; S28 decouple)
6. Tighten format zod-validation (drop `as` cast)

Apply these → re-paste contract delta to me for handoff confirmation → SendMessage evaluator-s27 with final agreed contract path. ≤2 fix rounds budget — this revise round counts as R1 advisor input, not R1 evaluator round.

═══════════════════════════════════════════════════════════════

**Generator disposition of advisor blockers:**

- B1 (PDF): APPLIED — report formats = `html|json|zip` only. No PDF route.
- B2/B3/B4 (api_tokens): MOOT — Q1=defer, api_tokens not shipping in S27.
- B5 (409 status): APPLIED — A-27-6 updated to expect 409 for `report_not_ready`.
- H1 (Zod format validation): APPLIED — `z.enum(['html','json','zip']).safeParse()` used.
- H4 (auto-build): APPLIED option (a) — "Build Report" button added to ScanProgressPage calling `POST /api/v1/assessments/:id/reports`.
- M1 (case-sensitive filter): APPLIED — filters normalized to lowercase before comparison.
- M4 (B-26-actor401): APPLIED — S27 new handlers only (scan-findings.ts returns 401; existing handlers untouched).

**B-26-wizard-order status:** Code-verified in HEAD — ScanWizardPage already calls `launchScan` first (line 45), then `checkout` (line 50). The backlog description was inverted. No change needed; document as "verified correct."

### PRE-HANDOFF (Advisor Call #2)

*(Will be requested after implementation, before handoff to evaluator)*

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Report proxy 404/503 in test (no real artifacts) | MEDIUM | A-27-6 tests report_not_ready explicitly; FE shows graceful "not ready" state |
| api_tokens: no audit trail | LOW | Accepted for v1 per Z.5 math |
| B-26-stateorch HIGH (3-tx orphan) | HIGH | Carried to S28 |
| B-26-tenantfilter HIGH | HIGH | Carried to S28 |

---

## Files to create / modify

### New
- `apps/api/src/routes/scans/scan-findings.ts`
- `apps/api/src/routes/auth/api-tokens.ts` *(pending advisor Q1)*
- `apps/web/src/pages/ScanFindingsPage.tsx`
- `apps/web/src/pages/ScanReportPage.tsx`
- `apps/web/src/pages/HistoryPage.tsx`
- `apps/web/src/pages/SettingsPage.tsx`
- `apps/web/src/api/findings-scan.ts`
- `apps/web/src/api/api-tokens.ts` *(pending)*
- `tests/integration/scans/scan-findings.test.ts`
- `tests/integration/auth/api-tokens.test.ts` *(pending)*
- `.harness/cyberstrike-hybrid/sprint-27-implementation-summary.md`

### Modified
- `apps/api/src/routes/scans/scans.ts` — add `handleScanReport`
- `apps/api/src/routes/register-routes.ts` — add new route registrations
- `apps/api/src/scans/tier-to-scope.ts` — fix B-26-himportcleanup
- `apps/web/src/App.tsx` — add 4 new routes + nav
- `apps/web/src/pages/ScanProgressPage.tsx` — add findings/report nav buttons

### Frozen (0-line diff)
- All frozen surfaces listed above
