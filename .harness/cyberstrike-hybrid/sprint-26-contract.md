# Sprint 26 Contract — Scan Launch + Live Progress + Billing Stub

**Author:** generator-s26 (Sonnet 4.6)  
**Date:** 2026-05-04  
**Base commit:** `12d98fd` (Sprint 25 PASS_WITH_BACKLOG)  
**P36 COMPLIANCE:** This document contains NO evaluator verdict labels (PASS/FAIL/SHIP). Only the Evaluator may issue those.

---

## 0. Pre-Contract Verification (P37 + Z.1.4 mandatory)

### HIGH_IMPACT_CATEGORIES — code-verified from `packages/scope-engine/src/decide.ts:38-43`

```typescript
// LITERAL VALUE at packages/scope-engine/src/decide.ts:38-43:
const HIGH_IMPACT_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
  'c2',
  'post_exploit',
  'ad',
  'credential_audit',
]);
```

**Note:** spec body §6 lists the same set. `packages/contracts/src/assessments.ts:10` also has:
```typescript
export const HIGH_IMPACT_CATEGORIES = ['c2', 'post_exploit', 'ad', 'credential_audit'] as const;
```
Both sources match. P37 satisfied.

### B6 K — code-verified from `tests/integration/db/migrations.test.ts:191`

```
for (let i = 0; i < 12; i++) {
```
Current K = **12**. S26 adds mig 025 → K becomes **13**. All 8 B6 tests need `r025pre` prefix-pop added.

### AUDIT_ACTIONS — code-verified from `packages/contracts/src/audit.ts:38-159`

Current count = **93** (lines 38-159 inclusive, 93 string entries). S26 adds +3 = **96**.

### HEAD commit verified
```
12d98fd docs(sprint-25): lead-issued evaluator result PASS_WITH_BACKLOG + e2e evidence
```

---

## 1. S26 Scope

### Backend (new files + edits)

| File | Action | Purpose |
|------|--------|---------|
| `apps/api/src/scans/tier-to-scope.ts` | NEW | Tier→StrictScopeRule[] mapping; builds scope rules for each tier |
| `apps/api/src/routes/scans/scans.ts` | NEW | Handlers: POST /scans, GET /scans, GET /scans/:id, GET /scans/:id/progress |
| `apps/api/src/routes/billing/billing.ts` | NEW | Handlers: POST /billing/checkout, GET /billing/subscription |
| `packages/db/migrations/025_scans_api_tokens.ts` | NEW | api_tokens table (no subscriptions/invoices — already in 023) |
| `packages/contracts/src/audit.ts` | EDIT | +3 AUDIT_ACTIONS: scan.launched, billing.checkout.completed, billing.subscription.cancelled |
| `packages/contracts/src/audit.test.ts` | EDIT | Update cardinality assertion 93→96 |
| `apps/api/src/routes/register-routes.ts` | EDIT | Register 6 new routes (/scans + /billing) |
| `tests/integration/db/migrations.test.ts` | EDIT | All 8 B6 tests: add r025pre prefix-pop, bump loop 12→13 |
| `tests/integration/db/helpers/db-fixture.ts` | EDIT | Add `api_tokens` to dropAllTables (reverse-FK order: after users, before tenants — actually api_tokens FK→tenants+users) |
| `tests/integration/auth/helpers/auth-fixture.ts` | EDIT | Add `DELETE FROM api_tokens` before `DELETE FROM users` in resetAuthState |
| `tests/integration/scans/scan-launch.test.ts` | NEW | Integration tests: scan launch happy path, unverified target 422, billing checkout, subscription read, progress poll |

### Frontend (new files + edits)

| File | Action | Purpose |
|------|--------|---------|
| `apps/web/src/api/scans.ts` | NEW | Envelope adapter for /scans endpoints (pattern from projects.ts) |
| `apps/web/src/api/billing.ts` | NEW | Envelope adapter for /billing endpoints |
| `apps/web/src/pages/ScanWizardPage.tsx` | NEW | `/app/projects/:id/scan/new` — select targets + tier + launch |
| `apps/web/src/pages/ScanProgressPage.tsx` | NEW | `/app/scans/:id` — live progress, 2s polling |
| `apps/web/src/App.tsx` | EDIT | Add routes for /app/projects/:id/scan/new and /app/scans/:id |

---

## 2. Migration 025 Decision

**Decision: YES, mig 025 lands in S26.**

Reason: spec body §3 + Z.6 math both place `api_tokens` in mig 025. The S26 spec says "api_tokens deferred to S27" in Z but Z.6 table shows mig 025 as S26. The spec body §3 SQL is explicit (`025_scans_api_tokens.ts` creates `api_tokens`). Per Z.6: "S26 mig 025 → K=13". Generator chooses to land mig 025 with `api_tokens` table only.

**What mig 025 does NOT contain:**
- No `scans` view/table (assessments serves as scans)
- No `subscriptions`/`invoices` (already in mig 023)

**B6 K math:** 12 (post-S25) + 1 (mig 025) = **13**. All 8 B6 tests updated.

---

## 3. Tier → Scope Rule Mapping (code-verified)

Source: `packages/scope-engine/src/types.ts` TOOL_CATEGORIES = `['recon', 'web', 'cloud', 'ad', 'c2', 'post_exploit', 'credential_audit']`

**Note:** contracts exports `ToolCategory` as `'recon' | 'web' | 'cloud' | 'ad' | 'c2' | 'post_exploit' | 'credential_audit'`. The spec body uses `web_scan` and `vuln_scan` but the actual code uses `web` (for web scanning) and the scope engine has no `web_scan` or `vuln_scan`. Generator uses the real contract values.

### Tier rule sets in `tier-to-scope.ts`

```typescript
// light — recon + web
allowedToolCategories: ['recon', 'web']
highImpactCategories: []  // gate disabled

// medium — recon + web + cloud (cloud added in REVISE round; intentional differentiation from light)
allowedToolCategories: ['recon', 'web', 'cloud']
highImpactCategories: []  // no high-impact categories for medium (recon/web/cloud not in HIGH_IMPACT_CATEGORIES set)

// aggressive — all categories including c2/post_exploit/ad/credential_audit
allowedToolCategories: ['recon', 'web', 'cloud', 'ad', 'c2', 'post_exploit', 'credential_audit']
highImpactCategories: ['c2', 'post_exploit', 'ad', 'credential_audit']  // from HIGH_IMPACT_CATEGORIES
```

**Blocker D resolution (REVISE round):** Medium tier now includes `cloud` to differentiate it from light. Light vs medium previously produced identical scope rules (both ['recon','web']); this was a silent UX lie — medium billed as "more capable." Adding `cloud` to medium is the minimal differentiation that makes tier semantics honest without adding high-impact categories.

**Scope rules built per tier** (StrictScopeRule[]):
- One `tool_category` allow rule per allowed category with `effect: 'allow'`
- One `domain` allow rule for each target domain with `effect: 'allow'`

---

## 4. API Contracts

### POST /api/v1/scans
**Body:** `{ project_id: uuid, tier: 'light'|'medium'|'aggressive', target_ids: uuid[] }`  
**Auth:** session (tenantGuard)  
**Flow:**
1. Validate body
2. Load project (tenant-scoped 404 if missing)
3. Load targets — cross-tenant → 403, not-found/wrong-project → 422
4. Check all targets have `ownership_status = 'verified'` → 422 `{ error: 'target_unverified', target_id }` for first unverified
5. Create assessment (state=draft), insert assessment_targets, insert scope rules from tier-to-scope
6. Auto-submit: transition draft→submitted
7. Auto-approve: transition submitted→approved (insert assessment_approvals row)
8. Auto-start: transition approved→running (enqueue assessment.start job via existing queue)
9. Emit audit `scan.launched`
10. Return `{ scan_id: assessment.id, state: 'running' }`

**Note:** `assessmentCreateSchema` requires scopeRules.length >= 1 — the scan launch handler does NOT use assessmentCreateSchema; it uses its own Zod schema for body validation.

**Note on testing window:** SaaS scans have no testing window constraint (null/null). R8 gate in `handleStartAssessment` only blocks if `testing_window_end` is non-null and expired.

### GET /api/v1/scans
Alias over assessments, filtered by `tenant_id`. Returns paginated list with `scan_id`, `state`, `tier` (from `assessments.metadata.tier`), `projectId`, `createdAt`.

### GET /api/v1/scans/:id
Assessment detail + tier field from metadata.

### GET /api/v1/scans/:id/progress
Returns `{ state, findings_count, recent_audit_events: [...5] }`.
- `state` from `assessments.state`
- `findings_count` = COUNT from findings WHERE assessment_id = id AND tenant_id
- `recent_audit_events` = last 5 audit_events WHERE assessment_id = id AND tenant_id ORDER BY created_at DESC

### POST /api/v1/billing/checkout
**Body:** `{ tier: 'light'|'medium'|'aggressive' }`  
UPSERT `subscriptions` for tenant: set `tier=tier`, `status='active'`. Returns `{ success: true, tier }`.  
Emit audit `billing.checkout.completed`.

### GET /api/v1/billing/subscription
SELECT from `subscriptions` WHERE `tenant_id = actor.tenantId`. Returns `{ tier, status }` or `{ tier: null, status: 'none' }` if no subscription row.

---

## 5. AUDIT_ACTIONS Cardinality Math

| Sprint | Additions | Cumulative |
|--------|-----------|------------|
| Post-S25 baseline | — | 93 |
| S26 (+3) | `scan.launched`, `billing.checkout.completed`, `billing.subscription.cancelled` | **96** |

`packages/contracts/src/audit.test.ts` cardinality assertion: 93 → 96.

---

## 6. B6 Migration Tests — All 8 Tests Updated

When mig 025 lands, every B6 test that pops from latest must add `r025pre` before the existing `r024pre`.

Tests that need `r025pre` added (all 7 prefix-pop tests + 1 loop):
1. `B6 — rollback removes the latest migration (three-step)` — add `r025pre` before `r024pre`
2. `B6 — reports table has expected column shape after migration 013` — loop bump 12→13
3. `B6 — observations_browser SPA columns present after migration 019` — add `r025pre`
4. `B6 — target_credentials table present after migration 018` — add `r025pre`
5. `B6 — mig 020: target_credentials.name` — add `r025pre`
6. `B6 — oob_callbacks table present after migration 021` — add `r025pre`
7. `B6 — mig 022: recipe_text column present` — add `r025pre`
8. `B6 — full rollback to empty schema works` — no prefix pops needed (uses rollbackAllMigrations)

---

## 7. Pitfalls Compliance

| Pitfall | Compliance |
|---------|------------|
| **P36** — no generator verdict | This document contains no PASS/FAIL evaluator label |
| **P37** — code-verified pure-fn values | HIGH_IMPACT_CATEGORIES pasted verbatim from decide.ts:38-43; B6 K=12 verified at migrations.test.ts:191 |
| **P38** — B6 K literal count | K=12 at line 191, bumped to 13 with mig 025 |
| **P39** — find-and-replace stale references | All 7 B6 prefix-pop tests get r025pre; loop comment updated |
| **P42** — JSONB COMMENT | mig 025 has no JSONB columns; api_tokens uses only uuid/text/timestamptz. N/A |
| **P43** — rate-limiter DI | No new rate-limiter in S26; existing middleware unchanged |
| **P44** — new table → dropAllTables | api_tokens FK→{tenants, users} → added to dropAllTables before users |
| **P46** — no mocks in prod | No external clients in scan launch or billing; no DI pattern needed |
| **P47** — SendMessage handoff | Generator will SendMessage evaluator after implementation |
| **P48** — new FK→targets tables + resetAuthState | api_tokens has FK→tenants+users, NOT targets. Must add before users in resetAuthState |
| **P49** — FE envelope drift | apps/web/src/api/scans.ts and billing.ts follow envelope adapter pattern from projects.ts |

---

## 8. Frozen Surfaces (0-line diff mandate)

These files MUST NOT appear in `git diff HEAD -- <path>`:
- `apps/api/src/routes/auth/register.ts`
- `packages/scope-engine/` (entire directory)
- `packages/decepticon-adapter/`
- `packages/reports/`
- `services/report-builder/`
- `services/coordinator/src/payloads.ts`
- `services/validator-worker/src/ssrf-validator.ts`
- `services/validator-worker/src/lfi-validator.ts`
- `services/validator-worker/src/rce-validator.ts`
- `packages/db/migrations/001_tenants.ts` through `024_domain_verifications.ts`

---

## 9. Blast Radius (gitnexus_impact before edits)

| Symbol | Direction | Risk | Action |
|--------|-----------|------|--------|
| `AUDIT_ACTIONS` | upstream | LOW | contracts/audit.ts — only audit.test.ts asserts count; update atomically |
| `registerRoutes` | upstream | LOW | register-routes.ts only imported by factory.ts and serve.ts |
| `dropAllTables` | upstream | LOW | only used by migrations.test.ts |
| `resetAuthState` | upstream | LOW | used by auth IT test helpers |
| `assessments` (table, via new scans routes) | upstream | LOW | new scan route creates assessment rows; no changes to existing handlers |

Note: `buildScopeForAssessment` is called from within the new scan launch handler (via the queue coordinator), NOT directly from the scans route — the scans route calls the existing assessment state machine handlers which enqueue the job, which the coordinator picks up and calls `buildScopeForAssessment`. Zero changes to `buildScopeForAssessment`.

---

## 10. S25 Carry-Over Disposition

### B-25-realdns-happypath
**Decision for S26 e2e:** Use direct DB write to set `ownership_status='verified'` for test target before scan-launch Playwright demo. DNS resolution is tested in S25 ITs; S26 e2e goal is the scan-launch flow. Production-correct DNS (P46) remains unchanged.

### B-25-ratelimit / B-25-already-verified-render / B-25-list-refresh-pattern
Carry to S27 (LOW severity, no S26 blocking).

---

## 11. Integration Test Plan

File: `tests/integration/scans/scan-launch.test.ts`

Tests:
- `A-26-1`: POST /scans happy path — verified target, light tier → 200 `{ scan_id, state: 'running' }`
- `A-26-2`: POST /scans — unverified target → 422 `{ error: 'target_unverified', target_id }`
- `A-26-3`: POST /scans — cross-tenant target → 403
- `A-26-4`: GET /scans — returns paginated list filtered by tenant
- `A-26-5`: GET /scans/:id — returns assessment detail with tier in metadata
- `A-26-6`: GET /scans/:id/progress — returns `{ state, findings_count, recent_audit_events }`
- `A-26-7`: POST /billing/checkout — sets subscription tier+status=active, returns `{ success: true, tier }`
- `A-26-8`: GET /billing/subscription — returns current tier+status
- `A-26-9`: POST /billing/checkout then GET /billing/subscription — round-trip consistency
- `A-26-10`: Tenant isolation — scan from tenantA not visible to tenantB
- `A-26-11`: POST /scans idempotent — same Idempotency-Key returns same scan_id, exactly 1 assessment row (added in REVISE round per Blocker A fix)

---

## 12. DoD Checklist (§10 S26)

- [ ] `POST /api/v1/scans` creates assessment + tier rules + auto-approves + starts. Returns `{ scan_id, state: 'running' }`
- [ ] Scan launch blocked if any target unverified. 422 `{ error: 'target_unverified', target_id }`
- [ ] `GET /api/v1/scans/:id/progress` returns `{ state, findings_count, recent_audit_events: [...] }`
- [ ] `/app/projects/:id/scan/new` wizard: select targets → select tier → billing stub → launch
- [ ] `/app/scans/:id` shows live progress (2s polling): state, findings count, last 5 audit events
- [ ] `POST /api/v1/billing/checkout` sets subscription. No payment
- [ ] IT tests: scan launch + progress poll flow. 0 fail
- [ ] B-23-c3 deferred: browser crawl not called for v1 SaaS (documented)
- [ ] tsc 0, lint 0
- [ ] AUDIT_ACTIONS = 96
- [ ] B6 K = 13

---

## Advisor Calls

**REVISE round (2026-05-04):** Evaluator REVISE phase returned 4 blockers. Agent tool not available in this agent context (tool-routing error, confirmed via ToolSearch — tool not in deferred tools list). Team-lead was notified; evaluator waived auto-fail for this round. Self-review below covers all 4 blockers raised by evaluator.

### REVISE Round Blocker Resolution

**Blocker A — Idempotency-Key missing from POST /scans + POST /billing/checkout:**
Fixed. Both routes now carry `idem` middleware (requireKey: true, default). All 10 existing tests updated to include `idempotency-key` headers. A-26-11 added to verify idempotent behavior (same key → same scan_id, 1 assessment row).

**Blocker B — high_impact_categories hardcoded [] for all tiers:**
Fixed. `tier-to-scope.ts` exports `tierToHighImpactCategories(tier)`. Aggressive returns `['c2','post_exploit','ad','credential_audit']`; light/medium return `[]`. `handleLaunchScan` now derives value from tier and writes it to `assessments.high_impact_categories` JSONB column.

**Blocker C — api_tokens missing from dropAllTables + resetAuthState:**
Evaluator's claim is stale — both fixtures were already edited in the original S26 commit (656351f). Verified by reading current state: `dropAllTables` has `'api_tokens'` before `'users'` at line 106; `resetAuthState` has `DELETE FROM api_tokens` before `DELETE FROM users` at line 275.

**Blocker D — light/medium identical scope rules:**
Fixed by adding `cloud` to medium tier (see §3 above). Alternative (contract-documents-intentional-collapse) rejected — the UX promises medium > light; silent equivalence is a product defect.

### Red-team analysis (original, pre-REVISE)

**Q1 — Inline scan launch calling state machine handlers:**
Risk identified: `handleApproveAssessment` calls `verifyTargetDomains` internally which does DB reads. Calling inline within a single HTTP request means all 3 transitions (submit→approve→start) run in one Express handler. The `handleStartAssessment` enqueues the BullMQ job rather than running it synchronously, so no long-running work blocks the response. However, if the queue enqueue fails, we'll have an assessment stuck in `approved` state with a 500 returned to the client. **Decision:** Accept this risk for v1 SaaS — the contract documents it. The scan launch handler wraps all transitions in a try/catch; on error it returns 500. No silent state corruption.

**Q2 — Medium tier [recon, web] same as light:**
Correct. `web_scan` and `vuln_scan` do not exist in TOOL_CATEGORIES. Medium tier adding `cloud` would be a valid design choice but the spec does not specify it and there is no `vuln_scan` to add. Using `[recon, web]` for both light and medium is safe — the difference between tiers is communicated via the `tier` metadata field on the assessment, not by categories alone. In v1 aggressive is the only tier with high-impact categories.

**Q3 — api_tokens dropAllTables order:**
CRITICAL CATCH: The contract says "add before users" but must verify position relative to tenants too. FK chain: `api_tokens.tenant_id → tenants.id` AND `api_tokens.user_id → users.id`. Since `users` has FK→`tenants`, the order is: `api_tokens` (delete first) → `users` → `tenants`. As long as `api_tokens` appears before BOTH `users` AND `tenants` in dropAllTables, it is correct. The contract must be amended: add `api_tokens` before `users` (which is already before `tenants`) = correct. No issue if current dropAllTables already deletes users before tenants.

**Q4 — B6 loop comment update:**
The loop itself (`for (let i = 0; i < 13; i++)`) is the authoritative count. If there is a comment like `// 12 migrations` above the loop, it must also be updated to `// 13 migrations` to avoid confusing the evaluator. **Decision:** Update both the loop variable AND any inline comment referencing the migration count.

**Q5 — Other red flags:**
- `billing.subscription.cancelled` is in AUDIT_ACTIONS +3 but no endpoint in S26 triggers a cancellation. This is fine — pre-registering the action key is valid; it will be emitted in a future sprint.
- `ScanProgressPage` uses 2s polling with `setInterval`. Must clear interval on component unmount to avoid memory leak.
- The `scan_id` returned by POST /scans is `assessment.id` (uuid). The frontend `GET /scans/:id` must use the same uuid — no mismatch risk.
- P48 compliance: api_tokens FK→tenants+users (NOT targets). resetAuthState must DELETE api_tokens before DELETE users. Confirmed in contract §7.
- `assessmentCreateSchema` requires `scopeRules.length >= 1` — scan launch handler does NOT use this schema. Generator builds scope rules inline from tier-to-scope.ts. No schema conflict.
