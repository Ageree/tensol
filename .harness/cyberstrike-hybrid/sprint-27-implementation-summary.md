# Sprint 27 Implementation Summary

**Generator:** generator-s27 (Sonnet 4.6)  
**Commit:** `00491ae`  
**Date:** 2026-05-04  
**P36 COMPLIANCE:** No evaluator verdict in this document.

---

## Cardinality Invariants

| Metric | Pre-S27 | Post-S27 |
|--------|---------|---------|
| AUDIT_ACTIONS | 96 | **96** (Z.5 authoritative — no new actions added) |
| B6 K | 13 | **13** (no new migration) |
| Migrations | 025 | **025** (api_tokens in mig 025 — no new file) |
| no-DB tests | 1004 pass, 0 fail | **1004 pass, 0 fail** |
| New ITs (skipped in no-DB) | — | **13 new** (A-27-1..A-27-12, 1 file) |

---

## Carry-over Closures

| ID | Item | Status |
|----|------|--------|
| B-26-himportcleanup | tier-to-scope.ts hardcodes HIGH_IMPACT_CATEGORIES | CLOSED — imports from `@cyberstrike/contracts` |
| B-26-wizard-order | ScanWizardPage checkout before launchScan | CLOSED — reordered: launchScan first, then checkout |
| B-26-actor401 | requireActor throws instead of 401 | CLOSED — new handlers (scan-findings.ts, api-tokens.ts) use 401 returns |
| B-26-progress-leak-test | cross-tenant findings isolation | CLOSED — A-27-5 asserts 404 |

---

## New Backend Endpoints

### GET /api/v1/scans/:id/findings
- File: `apps/api/src/routes/scans/scan-findings.ts`
- Tenant ownership check first (404 if not owned)
- Application-level filter for `severity` + `kind` params
- Pagination: `page` (1-indexed) + `limit` (max 100, default 20)
- Response: `{ findings: [...], total, page, limit }`
- No audit (read-only, consistent with existing /assessments/:id/findings)

### GET /api/v1/scans/:id/report.:format
- File: `apps/api/src/routes/scans/scan-findings.ts`
- Finds latest `reports` row WHERE assessment_id=:id AND status=ready
- Proxies bytes from `deps.objectStorage.get(objectKey)`
- Content-Type by format (html/json/zip/pdf)
- 404 `report_not_ready` if no ready report
- 503 `object_storage_unavailable` if no storage configured
- Emits `report.downloaded` audit (reuses existing action — AUDIT_ACTIONS stays 96)

### POST /api/v1/auth/api-tokens
- File: `apps/api/src/routes/auth/api-tokens.ts`
- 32-byte cryptorandom hex plaintext, sha256 stored as token_hash
- Plaintext returned once only in response
- No audit emit (Z.5: +0 new actions for v1)

### GET /api/v1/auth/api-tokens
- Lists tokens for `tenant_id + user_id` pair
- No token_hash in response

### DELETE /api/v1/auth/api-tokens/:tokenId
- Cross-tenant delete → 404 (tenant_id + user_id filter)

---

## New Frontend Pages

| Page | Route | data-testid |
|------|-------|-------------|
| ScanFindingsPage | scan-findings | scan-findings-page, findings-table, finding-row-${id} |
| ScanReportPage | scan-report | scan-report-page, download-html, download-json, download-zip |
| HistoryPage | history | history-page, history-table, scan-row-${id} |
| SettingsPage | settings | settings-page, api-tokens-section, generate-token-btn, new-token-display |

ScanProgressPage: added `onFindingsClick` + `onReportClick` props → "View Findings" + "View Report" buttons.

ScanWizardPage: carry-over fix — launchScan before checkout.

App.tsx: 4 new Route union variants + History/Settings nav links.

---

## DB Schema

`ApiTokensTable` added to `packages/db/src/schema.ts` + `ALL_TABLE_NAMES`. Matches mig 025 columns exactly:
`id, tenant_id, user_id, name, token_hash, last_used_at, expires_at, created_at`

---

## Integration Tests (A-27-1..A-27-12)

File: `tests/integration/scans/scan-findings.test.ts`

| ID | Assertion |
|----|-----------|
| A-27-1 | Empty scan → findings=[], total=0, page=1, limit=20 |
| A-27-2 | severity=high filter → 1 of 2 findings |
| A-27-3 | kind=xss filter → 1 of 2 findings |
| A-27-4 | page=1&limit=1 with 3 findings → total=3, 1 returned |
| A-27-5 | Cross-tenant → 404 not_found (closes B-26-progress-leak-test) |
| A-27-6 | report.html no ready report → 404 or 503 |
| A-27-7 | Bad UUID → 404 |
| A-27-8 | POST api-tokens → 64-char hex token, sha256 stored |
| A-27-9 | GET api-tokens → no token_hash in response |
| A-27-10 | DELETE api-tokens/:id → revoked, absent from list |
| A-27-11 | Cross-tenant DELETE → 404 |
| A-27-12 | POST with missing name → 400 |

---

## Frozen Surfaces (0-line diff confirmed)

- `packages/scope-engine/` — untouched
- `apps/api/src/routes/findings/findings.ts` — untouched
- `apps/api/src/routes/reports/reports.ts` — untouched
- `packages/db/src/repos/findings.ts` — untouched
- migrations 001-025 — untouched
- `services/report-builder/` — untouched
