# Sprint 17 Contract v2 — Recon Timeline UI + Auth State UI + SF1/SF3/SF4/ADR-0007

**Generator:** generator-s17 (Sonnet 4.6)
**Evaluator:** evaluator-s17 (Opus, isolated)
**Date:** 2026-04-30
**Base commit:** `b130ab6` (S16 SHIPPED)
**Phase:** Phase 3 sprint 3 — final Phase 3 sprint
**Contract round:** v2 (addresses evaluator r1 blockers B1–B6 + soft S1–S3)

---

## B1 Resolution — S11 Timeline Shape Schism (P37)

**Verified facts (code-read):**

| Location | Shape |
|---|---|
| `apps/api/src/routes/assessments/queries.ts:122` | Returns `{ rows: [...], nextCursor }` |
| `apps/web/src/api/assessments.ts:36` | Types response as `{ events: TimelineEvent[] }` |
| `apps/web/src/pages/AssessmentPage.tsx:32` | Reads `timelineData?.events ?? []` |
| `tests/integration/assessments/assessments.test.ts:527` | Asserts `body.rows.length > 0` and `body.rows.some(r => r.action === 'assessment.submitted')` |

**The schism:** Backend returns `rows`; frontend client types it as `events`. The `?? []` fallback silently hides the mismatch — timeline section always renders empty. The IT tests the backend correctly via `body.rows`, so the backend is authoritative.

**S17 resolution — fix the frontend client, keep the backend key:**

- `apps/web/src/api/assessments.ts:36` — change `getAssessmentTimeline` return type from `{ events: TimelineEvent[] }` to `{ rows: TimelineEvent[]; nextCursor: string | null }`.
- `apps/web/src/pages/AssessmentPage.tsx:32` — change `timelineData?.events ?? []` to `timelineData?.rows ?? []`.

**No backend key rename.** The existing `rows` key stays in `GET /assessments/:id/timeline` for all S11 callers. `assessments.test.ts:527` is NOT modified.

**Cursor field name:** Existing cursor encodes `{ createdAt: ISO, id: UUID }` per `pagination.ts`. Browser observation rows map `created_at` → `occurredAt` in the payload. Cursor field names stay `createdAt`/`id` — no rename to `emittedAt`.

---

## B2 Resolution — append-only conflict with last_used_at (P5)

**Verified fact:** `018_target_credentials.ts` calls `attachAppendOnlyTriggers(db, 'target_credentials')`. BEFORE UPDATE/DELETE triggers (statement-level + row-level) + BEFORE TRUNCATE. Any UPDATE is blocked at DB level.

**S17 decision: sibling mutable table (Option B).**

Migration 020 does NOT alter the append-only guarantee of `target_credentials`. Specifically:
- `target_credentials`: ADD COLUMN `name text NOT NULL DEFAULT ''` only. This is INSERT-compatible (new rows get the default; no UPDATE of existing rows). Append-only trigger is not violated by ADD COLUMN.
- New mutable table `target_credential_usage` (keyed by `credential_id` FK → `target_credentials.id`): stores `last_used_at`, `use_count`. No append-only triggers.
- **`last_used_at` lives exclusively in `target_credential_usage`** — never in `target_credentials`.
- `status` is NOT stored as a column. API returns `status: 'ready'` always in S17 (no expiry logic). Future: derived from `target_credential_usage` or an `expires_at` column.

`resetAuthState` chain: `DELETE FROM target_credential_usage` BEFORE `DELETE FROM target_credentials` (FK ordering).

---

## B3 Resolution — generator file ownership (P36)

Explicit rules baked into this contract:

1. **Generator writes ONLY `sprint-17-implementation-summary.md`** — never creates or overwrites `sprint-17-evaluator-result.md`.
2. **Ready-for-review SendMessage to evaluator-s17 MUST include:** HEAD commit SHA, exact filename `sprint-17-implementation-summary.md`, full-suite counts (lint/tsc/no-DB pass/fail/skip/full-PG pass/fail/skip), and the explicit statement: "I have not written sprint-17-evaluator-result.md".
3. **If `sprint-17-evaluator-result.md` exists at handoff** → P36 violation; generator must delete it before sending ready-for-review.

---

## B4 Resolution — AUDIT_ACTIONS exhaustiveness (P9)

**60 → 61 only. No other additions in S17.**

New action: `'auth.credential.read.viewed'` — emitted on `GET /targets/:id/credentials` success.

SF1 BrowserContext pooling emits NO new audit actions (internal worker telemetry only).

`audit.test.ts` cardinality: 60 → **61**.

---

## B5 Resolution — ADR 0007 status update convention

**Do NOT rewrite the ADR body.** Change only the Status header line, then APPEND an Outcome section at the bottom.

**Status line change (only this line changes):**
```
- **Status:** Accepted (with deviation — see Outcome section)
```

**Append at end of file:**
```markdown
---

## Outcome (2026-04-30)

**Actual implementation:** Sprints 15 and 16 shipped recipe-driven auth and SPA route
discovery using raw Playwright APIs (`page.goto`, `page.evaluate`, `context.route`,
`page.addInitScript`) without `@browserbasehq/stagehand`.

**Deviation from ADR recommendation:** The ADR recommended adopting Stagehand v3.
Actual sprints chose raw Playwright because:
1. S15 auth recipes were implementable with selector-based Playwright steps.
2. S16 SPA observer injection (`page.addInitScript`) needed no semantic act() layer.
3. Stagehand v3 was weeks old at ADR authoring time — deferred for stability.

**Current state:** `RealBrowserDriver` (raw Playwright) is the active production driver.
`StagehandBrowserDriver` remains unimplemented (Phase 4 scope).

**Phase 4 reconsider:** When multi-step semantic form interaction beyond simple recipe
steps is required, revisit Stagehand v3 adoption per this ADR's Option A rationale.
```

---

## B6 Resolution — credentials DTO mapper (security)

**Mapper function:** `mapCredentialRowToListItem(row: TargetCredentialRow): CredentialListItem` in `apps/api/src/routes/targets/targets.ts`. This is the single gate — encrypted fields never reach the serializer.

```typescript
interface CredentialListItem {
  readonly id: string;
  readonly name: string;
  readonly recipeId: string;
  readonly createdBy: string;
  readonly createdAt: string;       // ISO
  readonly fingerprintHex: string;  // first 16 hex chars of sha256(encrypted_blob)
  readonly status: 'ready';         // S17: always 'ready' (no expiry logic yet)
  // encrypted_blob, iv, authTag deliberately absent
}

const mapCredentialRowToListItem = (row: TargetCredentialRow): CredentialListItem => ({
  id: row.id,
  name: row.name,
  recipeId: row.recipeId,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  fingerprintHex: new Bun.CryptoHasher('sha256').update(row.encryptedBlob).digest('hex').slice(0, 16),
  status: 'ready',
});
```

**A-17-CredentialsNoBlob (mandatory sub-criterion):**
```typescript
expect(cred).not.toHaveProperty('encrypted_blob');
expect(cred).not.toHaveProperty('encryptedBlob');
expect(cred).not.toHaveProperty('iv');
expect(cred).not.toHaveProperty('auth_tag');
expect(cred).not.toHaveProperty('authTag');
```
All five assertions present in `credentials-api.test.ts`.

---

## Soft Notes (S1–S3)

**S1 — resetAuthState chain:** `target_credential_usage` DELETE added BEFORE `target_credentials` DELETE in every IT file that touches credentials. `grep -c resetAuthState` ≥ 2 per new IT file.

**S2 — pin `@tanstack/react-virtual ^3.10.0`:** React 19 peerDep compatible. Install: `bun add @tanstack/react-virtual@^3.10.0` in `apps/web/`.

**S3 — dual route invariant:** `POST /assessments/:id/target-credentials` (S16 B19) inserts rows using `assessmentId` for ownership/audit only — `assessment_id` is NOT stored in `target_credentials`. `GET /targets/:id/credentials` reads those same rows by `(tenantId, targetId)`. Documented in handler comment.

---

## Scope

**New / changed surfaces:**

- `apps/web/package.json` (add `@tanstack/react-virtual@^3.10.0`)
- `apps/web/src/api/assessments.ts` (B1: `events` → `rows` in return type)
- `apps/web/src/pages/AssessmentPage.tsx` (B1: `events` → `rows` in read)
- `apps/web/src/api/timeline.ts` (NEW — typed client + mapper for extended timeline)
- `apps/web/src/api/credentials.ts` (NEW — typed client for credentials list)
- `apps/web/src/pages/AssessmentTimelinePage.tsx` (NEW)
- `apps/web/src/pages/TargetCredentialsPage.tsx` (NEW)
- `apps/web/src/App.tsx` (extend Route union + navigation)
- `apps/api/src/routes/assessments/queries.ts` (extend `handleAssessmentTimeline` with `kind` param + `observations_browser` union + `items` key)
- `apps/api/src/routes/targets/targets.ts` (add `GET /targets/:id/credentials` + `mapCredentialRowToListItem`)
- `apps/api/src/routes/register-routes.ts` (register new GET route)
- `tests/integration/ui/timeline-api.test.ts` (NEW)
- `tests/integration/ui/credentials-api.test.ts` (NEW)
- `packages/db/migrations/020_target_credentials_meta.ts` (NEW)
- `packages/db/src/schema.ts` (add `name` to `TargetCredentialsTable`; add `TargetCredentialUsageTable`; add to `Database` + `ALL_TABLE_NAMES`)
- `packages/db/src/repos/target-credentials.ts` (include `name` in `listTargetCredentials` select + `TargetCredentialRow`)
- `packages/contracts/src/audit.ts` (60 → 61)
- `packages/contracts/src/audit.test.ts` (cardinality 60 → 61)
- `tests/integration/db/migrations.test.ts` (B6 loop 7 → 8 + mig 020 test)
- `services/browser-worker/src/worker.ts` (SF1 shared BrowserContext)
- `services/browser-worker/src/real-driver.ts` (SF1 injected context dep + SF3 hooks)
- `tests/unit/browser/real-driver-coverage.test.ts` (NEW — SF3 unit tests)
- `services/browser-worker/src/spa-observer.ts` (SF4 comment on popstate branch)
- `docs/adr/0007-browser-agent-driver.md` (Status line + Outcome append only)
- `docs/adr/0008-popstate-semantics.md` (NEW)

**Frozen surfaces (must not change):**
`packages/scope-engine`, `packages/decepticon-adapter`, `packages/reports`,
`services/report-builder`, `services/coordinator`, `services/validator-worker`,
`packages/browser-auth/src/crypto.ts`, `packages/browser-auth/src/executor.ts`,
`packages/browser-driver`.

---

## A — Recon Timeline UI

### API Extension: `GET /assessments/:id/timeline`

**No `kind` param (S11 compat):** Returns `{ rows: [...], nextCursor }` exactly as today. `assessments.test.ts:527` is NOT modified.

**With `kind` param:**
- `kind=audit` — audit_events only, same rows, response includes both `rows` and `items` keys (identical content).
- `kind=browser` — `observations_browser` rows for this assessment, ordered by `created_at DESC`.
- `kind=all` — union of both sources ordered by `(occurredAt DESC, id DESC)`.

**Response when `kind` specified:**

```typescript
interface TimelineItem {
  readonly id: string;
  readonly kind: 'audit' | 'browser';
  readonly action: string;        // audit: action; browser: 'browser.observation'
  readonly occurredAt: string;    // ISO; audit: occurred_at; browser: created_at
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly outcome: string;       // audit: outcome; browser: discovery_method
  readonly metadata: Record<string, unknown>;
}
// Response always includes both keys for compat:
{ rows: TimelineItem[]; items: TimelineItem[]; nextCursor: string | null }
```

Cursor: `encodeListCursor({ createdAt: occurredAt_ISO, id })` — existing helper, unchanged field names.

`observations_browser` query: `WHERE assessment_id = $assessmentId AND tenant_id = $tenantId ORDER BY created_at DESC`. Direct `assessment_id` column confirmed at `schema.ts:233`.

RBAC: `assertCan(actor, 'read', 'assessment')` — R7 unchanged.

### Frontend: `AssessmentTimelinePage`

File: `apps/web/src/pages/AssessmentTimelinePage.tsx`

1. `useInfiniteQuery` — `?kind=all&cursor=<base64>&limit=50`. `getNextPageParam` returns `lastPage.nextCursor ?? undefined`.
2. `useVirtualizer` from `@tanstack/react-virtual`. Container `height: 600px`, `estimateSize: () => 56`, `overscan: 5`.
3. Load-more: when last virtual item index >= total items - 5, call `fetchNextPage()` if `hasNextPage`.
4. Row: `occurredAt | kind badge | action | outcome`. `audit` → `bg-gray-100`, `browser` → `bg-blue-100` Tailwind.
5. Kind filter `<select>` options `all / audit / browser`. On change: reset infinite query.
6. `data-testid`: `timeline-loading`, `timeline-empty`, `timeline-error`, `timeline-row-{id}`.

**Routing:** Add `{ name: 'assessment-timeline'; assessmentId: string }` to `Route` union. `AssessmentPage` gets `<button data-testid="view-timeline-btn">View Timeline</button>`.

**Unit test:** `apps/web/src/api/timeline.ts` exports `mapTimelineItem`. Sibling `.test.ts` (no-DB) verifies audit row and browser row mapping.

### IT: `tests/integration/ui/timeline-api.test.ts`

`skipIf(!hasDatabaseUrl())`. `resetAuthState` ≥ 2. 4 cases:

1. **A-17-TimelineAPIAudit** — no `kind` param → `body.rows` present, `body.rows.length > 0`, `body.rows[0].action` present (S11 compat).
2. **A-17-TimelineAPIKindAll** — `?kind=all` → both `body.items` and `body.rows` keys present.
3. **A-17-TimelineAPICursor** — seed 3 audit events → `?kind=audit&limit=2` → `nextCursor` non-null → advance with cursor → additional rows.
4. **A-17-TimelineAPIUnauth** — no cookie → 401.

---

## B — Auth State UI

### API: `GET /targets/:id/credentials`

(Check first: `grep "GET.*credentials"` in `targets.ts`. Add only if not present.)

**Handler flow:**
1. `requireActor(c)`.
2. `assertCan(actor, 'read', 'target_credential')` — deny → `RbacDenyError`.
3. Validate `targetId` UUID.
4. Load target, `assertOwnership`.
5. `listTargetCredentials(db, actor.tenantId, targetId)`.
6. Map each row through `mapCredentialRowToListItem` (B6 gate — no encrypted fields in output).
7. Emit `auth.credential.read.viewed`.
8. Return `{ credentials: [...mapped...], total: number }`.

RBAC: `target_credential:read` — `tenant_admin`, `security_lead`, `operator`, `developer`, `auditor` → 200. `viewer` → 403.

### Frontend: `TargetCredentialsPage`

File: `apps/web/src/pages/TargetCredentialsPage.tsx`

1. `useQuery` — `GET /targets/:id/credentials`.
2. Table: `ID (8 chars) | Name | Recipe | Created By | Created At | Fingerprint`.
3. 403 → `<p data-testid="credentials-forbidden">Access denied</p>`.
4. `data-testid`: `credentials-loading`, `credentials-empty`, `credentials-table`.
5. "Add Credential" button visible when `user.role` in `['tenant_admin', 'security_lead', 'operator']`. `data-testid="add-credential-btn"`. Stub — no modal in S17.

**Routing:** Add `{ name: 'target-credentials'; targetId: string }` to `Route` union.

### IT: `tests/integration/ui/credentials-api.test.ts`

`skipIf(!hasDatabaseUrl())`. `resetAuthState` ≥ 2 (chain includes `target_credential_usage` BEFORE `target_credentials`). 4 cases:

1. **A-17-CredentialsList** — insert via `insertTargetCredential` → GET as `security_lead` → 200, row present, `auth.credential.read.viewed` audited.
2. **A-17-CredentialsNoBlob** — same response → all 5 `not.toHaveProperty` assertions (B6 mandatory).
3. **A-17-CredentialsList403** — GET as `viewer` → 403.
4. **A-17-CredentialsListCrossTenant** — T2 cookie on T1 target → 403 or 404.

---

## C — Migration 020

File: `packages/db/migrations/020_target_credentials_meta.ts`

```sql
-- Up
ALTER TABLE target_credentials
  ADD COLUMN name text NOT NULL DEFAULT '';

CREATE TABLE target_credential_usage (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id  uuid        NOT NULL REFERENCES target_credentials(id),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  use_count      integer     NOT NULL DEFAULT 1,
  UNIQUE (credential_id)
);
CREATE INDEX idx_tcu_tenant ON target_credential_usage (tenant_id);

-- Down
DROP TABLE IF EXISTS target_credential_usage;
ALTER TABLE target_credentials DROP COLUMN IF EXISTS name;
```

No BYTEA → P32 N/A. `target_credentials` append-only trigger not affected by ADD COLUMN.

**B6 loop:** 7 → **8**. Comment:
```typescript
// 8 = down(020)→down(019)→down(018)→down(017)→down(016)→down(015)→down(014)→down(013); reports table dropped at 013-down.
```

**B6 test for mig 020:** Assert `name` column + `target_credential_usage` table present after apply, absent after rollback, present after re-apply.

**Schema updates:**
- `TargetCredentialsTable`: add `name: string`.
- New `TargetCredentialUsageTable` interface.
- Add `target_credential_usage: TargetCredentialUsageTable` to `Database`.
- Add `'target_credential_usage'` to `ALL_TABLE_NAMES`.

**`listTargetCredentials`:** add `name` to select projection and `TargetCredentialRow`.

---

## SF1 — BrowserContext Pooling

**Decision: Option A — single context per worker process lifetime.**

Rationale: browser-worker is single-job-at-a-time. One shared context eliminates TCP TIME_WAIT. Per-job page isolation via `context.newPage()` + `page.close()`.

**`worker.ts` changes:**
- Lazy-init one `BrowserContext` on first job.
- Each job: `context.newPage()` → fresh page.
- After job: `page.close()`.
- Worker shutdown: `context.close(); browser.close()`.
- Comment: `// Single BrowserContext per worker instance — eliminates TCP TIME_WAIT between jobs. Isolation via newPage()/page.close() per job. SF1 S17.`

**`real-driver.ts` changes:**
- `RealBrowserDriverDeps` gains optional `readonly browserContext?: BrowserContext` for unit testability.
- When injected: skip `browser.newContext()`.

**Frozen surface note:** `packages/browser-driver` is frozen. Only `worker.ts` + `real-driver.ts` change.

---

## SF3 — real-driver.ts Function Coverage ≥80%

3 new unit tests in `tests/unit/browser/real-driver-coverage.test.ts` (no-DB):

1. **Redirect post-nav scope re-check:** mock `page.goto` resolves, `page.url()` returns OOS URL → `scopeCheck` throws → `browser.spa.route.skipped_oos` emitted, no observation row.
2. **`context.route()` intercept deny path:** mock route request URL returns OOS → `scopeCheck` throws → `route.abort('blockedbyclient')` called, not `route.fetch()`.
3. **Popstate non-navigation:** inject `method='popstate'` route via `parseSpaRoutes` mock → no `page.goto` call, `emitAudit` called with `navigated: false`.

---

## SF4 — popstate ADR 0008

File: `docs/adr/0008-popstate-semantics.md`

```markdown
# ADR 0008 — SPA popstate Event Semantics

- **Status:** Accepted
- **Date:** 2026-04-30
- **Tags:** spa-observer, browser-worker, s16-spa-discovery, s17-sf4

## Context

Sprint 16 implemented SPA route discovery via History.pushState observer injection.
The observer also captures popstate events (back/forward navigation). A decision was
needed: should popstate-discovered URLs be navigated (page.goto'd) or recorded only?

## Decision

popstate routes are discovery-only: recorded in `browser.spa.route.discovered` audit
with `navigated: false`, but NOT navigated via `page.goto()`.

## Rationale

1. Loop prevention: popstate fires when navigating *back* to a previously visited URL.
   Re-navigating would re-trigger pushState observers, creating infinite discovery loops.
2. Redundancy: the URL was reachable via the pushState chain; content already captured.
3. No new observations: popstate represents a return to prior state, not new content.
4. Audit completeness: recording popstate preserves full route history without duplicate work.

## Consequences

- `browser.spa.route.discovered` fires for both pushstate (navigated: true) and
  popstate (navigated: false).
- No `observations_browser` row created for popstate-only routes.
- `real-driver.ts` and `spa-observer.ts` carry explicit comments per this ADR.
- Unit test: method='popstate' route → no page.goto, navigated: false in audit.
```

**`spa-observer.ts` comment addition** on popstate listener:
```typescript
// popstate = back/forward navigation to a previously visited URL.
// Discovery-only: recorded for audit completeness, not re-navigated.
// Navigating would re-trigger pushState observers and create crawl loops. See ADR 0008.
```

---

## ADR 0007 Closure (B5)

**Only two changes to `docs/adr/0007-browser-agent-driver.md`:**
1. Status line: `Proposed` → `Accepted (with deviation — see Outcome section)`
2. Append Outcome section (verbatim from B5 resolution above) at end of file.
Body content is NOT rewritten.

---

## AUDIT_ACTIONS Delta (60 → 61, no other additions)

```
'auth.credential.read.viewed'
```

SF1 emits NO new audit actions.

---

## Acceptance Criteria

| ID | Gate |
|---|---|
| **A-17-S11Compat** | `body.rows` key present when no `kind` param. `assessments.test.ts:527` assertion passes unchanged. |
| **A-17-FrontendSchismFix** | `assessments.ts` return type uses `rows`. `AssessmentPage.tsx` reads `rows`. |
| **A-17-TanStackVirtual** | `@tanstack/react-virtual@^3.10.0` in `apps/web/package.json`. `useVirtualizer` in `AssessmentTimelinePage.tsx`. |
| **A-17-TimelineUI** | `AssessmentTimelinePage` renders. `timeline-row-{id}`, kind `<select>`, mapper unit test pass. |
| **A-17-TimelineAPI** | 4 IT cases: S11-compat, kind=all both keys, cursor advance, unauth 401. |
| **A-17-CredentialsUI** | `TargetCredentialsPage` renders, 403 → `credentials-forbidden`, add-btn RBAC-gated. |
| **A-17-CredentialsAPI** | 4 IT cases: list 200 + audit, no-blob (B6), viewer 403, cross-tenant 403/404. |
| **A-17-CredentialsNoBlob** | All 5 `not.toHaveProperty` assertions present in IT (encrypted_blob, encryptedBlob, iv, auth_tag, authTag). |
| **A-17-Migration020** | Mig 020 applies + rolls back. B6 test passes. B6 loop 7→8 with comment. |
| **A-17-AuditCardinality** | `AUDIT_ACTIONS.length === 61`. Only `auth.credential.read.viewed` added. |
| **A-17-ContextPool** | Single `BrowserContext` per worker instance. `A-17-ContextIsolation` unit test: two jobs, `newPage()` ×2, `page.close()` ×2, no cookie leakage. |
| **A-17-LoginFlake** | `login-flow.test.ts` passes in isolation AND full suite, ≤5s, no FK violation. |
| **A-17-DriverCoverage** | `real-driver.ts` function coverage ≥80% in no-DB run. 3 unit test cases present. |
| **A-17-PopstateADR** | `docs/adr/0008-popstate-semantics.md` exists, Status: Accepted. `spa-observer.ts` has popstate non-navigation comment. Popstate unit test passes. |
| **A-17-ADR0007Closed** | `0007` Status line contains `Accepted (with deviation`. Outcome section appended. Body not rewritten. |
| **A-17-ResetAuthChain** | `target_credential_usage` DELETE precedes `target_credentials` DELETE in resetAuthState. |
| **A-17-P27** | `grep -c resetAuthState` ≥ 2 per new IT file. |
| **A-17-DecryptNotInApi** | `grep -r 'decryptCredential' apps/api/` → empty. |
| **A-17-RegressionGuard** | `git diff main..HEAD -- <frozen surfaces>` → empty. |
| **A-17-LintTC** | `bun run lint` 0 errors. `bun run typecheck` 0 errors. |
| **A-17-Tests** | No-DB: 0 fail. Full-PG: 0 fail OR ≤3 known flakes. `login-flow.test.ts` A-15-LoginFailed MUST pass. |
| **A-17-P36Compliance** | `sprint-17-evaluator-result.md` does NOT exist at handoff. Generator wrote only `sprint-17-implementation-summary.md`. Ready-for-review message includes SHA + counts + explicit "not written" statement. |

---

## Pitfalls Catalog v8 Applied

| # | Applied |
|---|---------|
| P1 | No new JSONB array writes. N/A. |
| P2 | Tenant slugs in new IT fixtures. |
| P3 | `target_credential_usage` added to `resetAuthState` DELETE chain BEFORE `target_credentials`. |
| P5 | `target_credentials` append-only preserved. `last_used_at` in sibling mutable table. No UPDATE on append-only rows. |
| P9 | AUDIT_ACTIONS 60→61. |
| P27 | `grep -c resetAuthState` ≥ 2 per new IT file. |
| P32 | No bytea in mig 020. N/A. |
| P33 | B6 loop bumped 7→8 with math comment. |
| P34 | No new `buildEffectiveScope` call sites. N/A. |
| P35 | Full-suite counts mandatory in ready-for-review message. |
| P36 | Generator writes ONLY `sprint-17-implementation-summary.md`. Abort rule if evaluator-result.md found at handoff. |
| P37 | All values code-verified: `rows` key at `queries.ts:123`, IT assertion key at `assessments.test.ts:527`, append-only trigger in `018_target_credentials.ts:8`, `assessment_id` direct column at `schema.ts:233`. |

---

## Baselines

| Metric | S16 | S17 target |
|---|---|---|
| No-DB pass | 1050 | ≥1050 |
| No-DB fail | 0 | 0 |
| Full-PG pass | 1282 | ≥1282 |
| Full-PG fail | 1 (S11 baseline) | ≤3 |
| AUDIT_ACTIONS | 60 | 61 |
| B6 loop | 7 | 8 |
| RBAC_MATRIX | 1470 | 1470 (unchanged) |

---

## Risk Register

| ID | Risk | Mitigation |
|----|------|-----------|
| R1 | `observations_browser` join to assessment | RESOLVED: direct `assessment_id` column confirmed at `schema.ts:233`. |
| R2 | Virtualizer + infinite query scroll reset | `resetQueries` only on filter change, not page append. |
| R3 | Mig 020 ADD COLUMN on append-only table | ADD COLUMN does not invoke UPDATE trigger. Safe. |
| R4 | ADR 0007 body contradicts Accepted status | Outcome section explicitly documents deviation. Body preserved verbatim. |
| R5 | S11 response shape break | `rows` key kept in all responses. Frontend type fixed. |
| R6 | `target_credential_usage` FK ordering in resetAuthState | Explicit gate: A-17-ResetAuthChain. |

---

## S18 Backlog

1. Real Playwright tracing (replace trace stub).
2. Depth-2+ recursive SPA observer.
3. `StagehandBrowserDriver.actOn()` — Phase 4.
4. `last_used_at` write in browser-worker on decrypt → `target_credential_usage`.
5. Full credential form UI (name field + recipe selection).
6. `status` derived from `target_credential_usage` (expired = last_used_at + TTL).
