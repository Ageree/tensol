# Sprint 14 Contract — Minimal Report Builder

**Generator:** generator-s14 (Sonnet 4.6)
**Evaluator:** evaluator-s14 (Opus, isolated)
**Date:** 2026-04-30

---

## Scope

`services/report-builder`, `packages/reports`, `apps/api/src/routes/reports`,
`packages/db` (migration 013 rewrite + schema.ts + repos), `packages/contracts/src/audit.ts`,
`packages/authz` (matrix if needed), `tests/integration/reports/`.

Frozen surfaces (must not change): `packages/scope-engine`, `packages/decepticon-adapter`,
`services/browser-worker`, `services/coordinator`, `services/validator-worker`.

---

## Implementation Plan (file-level)

### packages/contracts/src/audit.ts
- Add 6 new actions: `report.build.requested`, `report.build.started`,
  `report.build.completed`, `report.build.failed`, `report.finding.excluded_oos`,
  `report.downloaded`
- AUDIT_ACTIONS 46 → 52

### packages/contracts/src/audit.test.ts
- Update cardinality assertion: 46 → 52, add 6 new action strings to expected array

### packages/db/migrations/013_reports.ts
- **Rewrite** (no prod data): replace one-row-per-format schema with one-snapshot-per-report
- New columns: `id`, `tenant_id`, `assessment_id`, `idempotency_key` (text, unique per
  tenant+assessment+key), `status` CHECK(`queued|building|ready|failed`),
  `object_key_html`, `sha256_html`, `size_bytes_html` (nullable until ready),
  `object_key_json`, `sha256_json`, `size_bytes_json` (nullable until ready),
  `object_key_zip`, `sha256_zip`, `size_bytes_zip` (nullable until ready),
  `failure_reason` (text nullable), `created_at`, `completed_at` (nullable)
- Append-only trigger: `enforce_append_only()` FOR EACH STATEMENT (deny UPDATE/DELETE)
- Indexes: `(tenant_id)`, `(tenant_id, assessment_id)`, UNIQUE `(tenant_id, idempotency_key)`

### packages/db/src/schema.ts
- Replace `ReportsTable` interface with new column shape matching migration rewrite
- Add `reports` to `APPEND_ONLY_TABLES`

### packages/db/src/repos/reports.ts (NEW)
- `ReportsRepo` extends `AppendOnlyRepository` — insert-only, no update/delete methods
- `insertReport(input)` — inserts queued row, returns `{ id }`
- `markBuilding(id, tenantId)` — raw SQL UPDATE (bypasses append-only by design for status
  machine; the trigger blocks external UPDATE, but internal worker status updates need a
  controlled escape hatch — use trigger exception or separate status_updates table approach)
  **Decision needed**: use a separate `report_status_events` table OR use FOR EACH STATEMENT
  trigger that only blocks DELETE (not UPDATE) — see R1 below.
- `markReady(id, tenantId, keys)` — sets status=ready + object keys + sha256 + completed_at
- `markFailed(id, tenantId, reason)` — sets status=failed + failure_reason + completed_at
- `findById(id, tenantId)` — returns row or null
- `findByIdCrossTenant(id)` — for cross-tenant guard (returns tenantId without filter)

### packages/db/src/index.ts
- Export `ReportsRepo` and `ReportRow` type

### packages/reports/src/models.ts (NEW)
- Zod schemas: `ReportSnapshotSchema`, `ReportBuildEnvelopeSchema`, `ReportRowSchema`

### packages/reports/src/template.ts (NEW)
- `renderHtml(snapshot: ReportSnapshot): string` — eta template render
- Template file: `packages/reports/src/templates/report.html.eta`

### packages/reports/src/redaction.ts (NEW)
- Re-export/wrap `packages/audit/src/redaction` — apply to finding reproduction/evidence metadata

### packages/reports/src/sha256.ts (NEW)
- `computeSha256(buf: Buffer): string` — hex sha256

### packages/reports/src/zip.ts (NEW)
- `buildZip(snapshot, htmlBytes, jsonBytes, evidenceBlobs): Promise<Buffer>`
- Nested structure: `report/report.html`, `report/report.json`,
  `report/findings/{findingId}/screenshot.png`, `report/findings/{findingId}/har.json`,
  `report/findings/{findingId}/trace.json`

### packages/reports/src/index.ts
- Export all from models, template, sha256, zip

### services/report-builder/src/payload-schema.ts (NEW)
- `ReportBuildPayloadSchema` — `{ tenantId, assessmentId, reportId, traceId, projectId? }`

### services/report-builder/src/worker.ts (NEW)
- `handleReportBuild(deps, envelope): Promise<HandlerOutcome>`
- Flow:
  1. Parse payload (defence in depth)
  2. Mark report row `building` + emit `report.build.started`
  3. Load assessment, scope, confirmed findings (status='confirmed' filter on findings table)
  4. **Scope guard**: for each finding, call `decide(scope, {kind:'http_request', url: finding.affectedUrl, method:'GET'}, deps.scopeDeps)` — null-guard if scopeDeps not injected. Excluded findings emit `report.finding.excluded_oos`
  5. Load per-finding evidence (finding_evidence rows + object bytes)
  6. Redact secrets
  7. Render HTML via eta template
  8. Build JSON payload
  9. Build ZIP (nested structure)
  10. Compute sha256 for each format
  11. Put to object storage (html, json, zip)
  12. markReady with keys + sha256s
  13. Emit `report.build.completed`
  14. Return `{ kind: 'ack' }`
- On any throw: markFailed + emit `report.build.failed` + return `{ kind: 'nack' }`
- Idempotency: if row is already `ready`, ack immediately (no re-render)

### services/report-builder/src/index.ts (UPDATE)
- Export `handleReportBuild`, worker types

### apps/api/src/routes/reports/reports.ts (NEW)
- `handleBuildReport(deps, c)` — POST /assessments/:id/reports
  - assertCan(actor, 'create', 'report')
  - Read Idempotency-Key (required)
  - Load assessment, check tenant ownership
  - Check for existing report row with same (tenant_id, idempotency_key) → return existing if found (idempotency replay)
  - Insert report row (status=queued)
  - Enqueue `report.build` job with payload
  - Emit `report.build.requested`
  - Return 202 { reportId, status: 'queued' }
- `handleGetReport(deps, c)` — GET /reports/:id
  - assertCan(actor, 'read', 'report')
  - Load report row (cross-tenant guard)
  - If status=ready: include downloadUrl (`/api/v1/reports/:id/download`)
  - Return status + metadata
- `handleDownloadReport(deps, c)` — GET /reports/:id/download
  - assertCan(actor, 'read', 'report')
  - Stream bytes from object storage
  - Emit `report.downloaded`

### apps/api/src/routes/register-routes.ts
- Wire report routes with `tenantGuard()` and `idem` middleware on POST

### apps/api/src/routes/shared.ts
- Add `ReportsRepo` to `RouteDeps` if not already present via `Repositories`

### tests/integration/auth/helpers/auth-fixture.ts
- Add `DELETE FROM reports;` to `resetAuthState` (BEFORE assessments, after finding_evidence)
- Add `ALTER TABLE reports DISABLE TRIGGER USER` / `ENABLE TRIGGER USER` around DELETE
  (because reports will be append-only with trigger)

### packages/db/migrations/index.ts
- Verify `013_reports` re-export is present (migration already listed)

### packages/db/migrations/index.test.ts (B6 rollback test)
- Add assertion: `reports` table present after up, absent after down

### tests/integration/reports/ (NEW directory)
- `reports-api.test.ts` — IT covering: POST enqueue, GET status, concurrent POST, empty findings, idempotency replay
- `reports-e2e.test.ts` — full pipeline: assessment.start → decepticon fake → confirmed finding → POST /reports → worker builds → GET ready → ZIP sha256 verified
- `reports-oos.test.ts` — scope guard: synthetic out-of-scope confirmed finding excluded + audit
- Each IT file MUST have `await resetAuthState(fx.db)` ≥ 2 occurrences (P27)

---

## Risk Register

| ID | Risk | Mitigation |
|----|------|-----------|
| R1 | reports table append-only trigger blocks worker status updates | Use FOR EACH STATEMENT trigger blocking DELETE only (not UPDATE), OR use a controlled bypass: the trigger fires on DELETE/UPDATE from external callers but worker uses a direct SQL path. **Resolved**: block only DELETE via trigger; UPDATE allowed (status machine needs it). Report spec says "regeneration creates new row" — snapshot is immutable but build status is mutable. |
| R2 | eta template engine CJS/ESM compat in Bun | Use `eta` v3 (ESM-native). If import fails, fallback: template literal with manual HTML escaping helper. |
| R3 | ZIP library in Bun | `fflate` (ESM-native, no native bindings). Alternative: `jszip`. |
| R4 | Object storage presign not implemented | Use direct download route streaming bytes — same pattern as evidence.ts `?download=1`. No presign needed for S14 slice. |
| R5 | findingByCandidateId loads from findings table but need affectedUrl | findings table has `affected_url` column — load directly. |
| R6 | resetAuthState DELETE order: reports FK→assessments | reports.assessment_id FK — must DELETE reports BEFORE assessments. |

---

## Design Decisions (pending advisor confirmation)

1. **Template engine**: eta v3 (ESM-native, auto-escapes, Bun compatible) — awaiting advisor
2. **Migration 013**: rewrite in-place (no prod data) — awaiting advisor
3. **Scope guard placement**: inside worker handler (mirrors S13 P1-A pattern) — awaiting advisor
4. **ZIP structure**: nested (`report/report.html`, `report/findings/{id}/...`) — awaiting advisor
5. **Append-only trigger**: blocks DELETE FOR EACH STATEMENT only; UPDATE allowed for status machine
6. **Download route**: direct stream (no presign), same pattern as evidence.ts

---

## Acceptance Criteria

### A-14-Schema
`reports` migration applied + rolled back cleanly. B6 rollback test in
`tests/integration/db/migrations.test.ts` has assertion for `reports` table presence/absence.
Trigger blocks DELETE FOR EACH STATEMENT.

### A-14-Queue
`report.build` queue subscriber:
- Happy path: acks + emits `report.build.started` + `report.build.completed`
- Transient error: nacks (retryable)
- Emits `report.build.failed` on terminal failure

### A-14-Render
HTML template renders confirmed XSS finding from Sprint 10 lab fixture. JSON payload
schema-validates against `ReportSnapshotSchema`. ZIP contains `report/report.html`,
`report/report.json`, `report/findings/{id}/screenshot.png` (or stub if no screenshot),
`report/findings/{id}/har.json`, `report/findings/{id}/trace.json`.

### A-14-Scope
Synthetic out-of-scope confirmed finding (test fixture, affectedUrl outside scope) is EXCLUDED
from rendered report. Emits `report.finding.excluded_oos` audit event with
`metadata.affectedUrl`. Uses `decide(scope, {kind:'http_request', url, method:'GET'}, scopeDeps)`
with null-guard (gate skipped if scopeDeps not injected).

### A-14-Immutable
Second `POST /assessments/:id/reports` (different Idempotency-Key) creates a NEW reports row
with NEW id and NEW sha256. First and second reports both persist. Append-only DELETE
trigger verified: direct `DELETE FROM reports WHERE ...` raises error (or rows=0 after
trigger, but prefer PG error path).

### A-14-API-RBAC
- `auditor` role: GET /reports/:id → 200 (read allowed per C10)
- `auditor` role: POST /assessments/:id/reports → 403 (create denied per C10 auditor invariant)
- Cross-tenant: GET /reports/:id for report owned by tenant B, actor from tenant A → 404
  (we return 404 not 403 to avoid leaking existence — document this choice)

### A-14-Audit
All 6 new actions emitted in correct scenarios:
- `report.build.requested` — on POST /assessments/:id/reports (before enqueue)
- `report.build.started` — on worker pickup
- `report.build.completed` — on worker success
- `report.build.failed` — on worker error
- `report.finding.excluded_oos` — on scope-guard exclusion
- `report.downloaded` — on GET /reports/:id/download
AUDIT_ACTIONS.length === 52 (asserted in contracts test).

### A-14-Coverage
≥80% line coverage on:
- `services/report-builder/src/`
- `packages/reports/src/`
- `apps/api/src/routes/reports/`

### A-14-LintTC
`bun run lint` → 0 errors. `bun run typecheck` → 0 errors.

### A-14-Tests
- No-DB suite: 0 failures
- Full-PG suite (single run, R3 discipline): 0 failures OR ≤3 known flakes
  (carrying: findings-api auditor 403 + browser retry baseline)

### A-14-FixtureReset
P27 invariant: every new IT file in `tests/integration/reports/*.test.ts` has
`grep -c resetAuthState` ≥ 2. `reports` table in DELETE chain of `resetAuthState`
(BEFORE assessments).

### A-14-Idempotency
Same Idempotency-Key on POST /assessments/:id/reports returns same `reportId` (202 replay).
Different Idempotency-Key creates a new row (A-14-Immutable).

### A-14-Concurrent
Concurrent POST for same assessment with different keys → both produce DISTINCT immutable
snapshots. Asserted via Promise.all in IT.

### A-14-Empty
Empty confirmed-findings list → report still generated with explicit "No confirmed findings"
section in HTML and `findings: []` in JSON. Status reaches `ready`. ZIP contains report files.

### A-14-IT-E2E
Full pipeline IT:
1. assessment.start (fake decepticon, S13 pattern)
2. fake-decepticon emits candidate
3. validate.finding (xss validator, S10 pattern)
4. confirmed finding in DB
5. POST /assessments/:id/reports
6. worker processes `report.build` queue job
7. GET /reports/:id → status=ready
8. GET /reports/:id/download → ZIP bytes
9. sha256 of downloaded ZIP matches `sha256_zip` in reports row

---

## Edge Cases

- **Build failure mid-stream**: worker nacks transient, retries. If row already `building`,
  worker must not re-emit `report.build.started` (check status before emit).
- **Concurrent build requests same assessment**: each produces distinct snapshot (no row reuse).
- **Empty findings**: report generated with "no confirmed findings" section.
- **OOS finding with null scopeDeps**: gate skipped (null-guard), finding included (back-compat).
- **Finding evidence missing from object storage**: include finding in report but skip evidence
  bytes for that finding; emit warning in metadata.

---

## AUDIT_ACTIONS Delta (46 → 52)

```
report.build.requested   — POST /assessments/:id/reports accepted
report.build.started     — worker pickup
report.build.completed   — worker success
report.build.failed      — worker terminal/transient failure
report.finding.excluded_oos — scope guard excluded finding
report.downloaded        — download route hit
```
