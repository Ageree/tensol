# Sprint 17 — Implementation Summary

**Generator:** generator-s17 (Sonnet 4.6)
**HEAD SHA (ship-cleanup):** 7f9ce7f87d0af6e8efae279455b306503feee75a
**HEAD SHA (R2-reverted):** ec597d63e3e44069dfa9005d22aa459b7c0ebe07
**HEAD SHA (R1):** b2a09356aa7cece65ab11084e75f1e0eb79c8186
**Date:** 2026-04-30

---

## Deliverables completed

### A — Timeline kind filter + AssessmentTimelinePage
- `GET /assessments/:id/timeline?kind=audit|browser|all` implemented in `apps/api/src/routes/assessments/queries.ts`
- Cursor pagination: `auditHasMore = page.nextCursor !== null` (not recomputed from items length)
- Response returns both `rows` and `items` keys for kind path; no-kind path unchanged (S11 compat)
- `apps/web/src/api/timeline.ts` — new typed client with `TimelineItem`, `TimelinePage`, `getTimelinePage`
- `apps/web/src/pages/AssessmentTimelinePage.tsx` — `useInfiniteQuery` + `useVirtualizer` (estimateSize:56, overscan:5, height:600px)
- B1 fix: `apps/web/src/api/assessments.ts` return type → `{ rows: TimelineEvent[]; nextCursor: string | null }`
- B1 fix: `apps/web/src/pages/AssessmentPage.tsx` `timelineData?.events` → `timelineData?.rows`

### B — Credentials API + TargetCredentialsPage
- `handleListTargetCredentials` + `mapCredentialRowToListItem` in `apps/api/src/routes/targets/targets.ts`
- `fingerprintHex = sha256(encryptedBlob).slice(0,16)` via `Bun.CryptoHasher`; encrypted_blob/iv/authTag never in response
- `GET /api/v1/targets/:id/credentials` registered in `apps/api/src/routes/register-routes.ts`
- `apps/web/src/api/credentials.ts` — typed client
- `apps/web/src/pages/TargetCredentialsPage.tsx` — RBAC deny path returns `data-testid="credentials-forbidden"`
- `apps/web/src/App.tsx` — new routes `assessment-timeline` and `target-credentials`
- Audit action `auth.credential.read.viewed` added to `packages/contracts/src/audit.ts`

### C — Migration 020
- `packages/db/migrations/020_target_credentials_meta.ts` — ADD COLUMN `name TEXT NOT NULL DEFAULT ''` on `target_credentials`; CREATE TABLE `target_credential_usage` (mutable sibling with UNIQUE FK)
- `listTargetCredentials` added to `packages/db/src/repos/target-credentials.ts`
- Schema updated in `packages/db/src/schema.ts`
- `migrations.test.ts` loop count 7→8

### SF1 — BrowserContext pooling
- `services/browser-worker/src/real-driver.ts` — single `sharedContext: BrowserContext | null` per worker instance
- `launch()` calls `context.newPage()` only; `close()` calls `session.page.close()` only
- `shutdown()` closes sharedContext + sharedBrowser
- Injected `browserContext?` dep in `RealBrowserDriverDeps` for unit testability
- Eliminates TCP TIME_WAIT between jobs

### SF3 — 3 new real-driver unit tests
- `tests/unit/browser/real-driver-coverage.test.ts`:
  1. context.route intercept deny path: scopeCheck throws → route.abort called
  2. popstate non-navigation: parseSpaRoutes returns popstate, no page.goto
  3. injected browserContext: sharedContext set from dep, sharedBrowser null

### SF4 — ADR 0008 + spa-observer comment
- `docs/adr/0008-popstate-semantics.md` — Status: Accepted, Date: 2026-04-30
- `services/browser-worker/src/spa-observer.ts` — popstate comment added explaining discovery-only semantics and crawl loop prevention
- `docs/adr/0007-browser-agent-driver.md` — Status → `Accepted (with deviation — see Outcome section)`; Outcome section appended

### Integration tests
- `tests/integration/ui/timeline-api.test.ts` — 4 cases: A-17-TimelineAPIAudit, A-17-TimelineAPIKindAll, A-17-TimelineAPICursor, A-17-TimelineAPIUnauth
- `tests/integration/ui/credentials-api.test.ts` — 4 cases: A-17-CredentialsList, A-17-CredentialsNoBlob, A-17-CredentialsList403, A-17-CredentialsListCrossTenant

---

## Test results (ship-cleanup HEAD 7f9ce7f)

### No-DB suite
- **1053 pass, 0 fail, 373 skip** (`bun test`, no DATABASE_URL)

### Full PG suite (`DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`, no path filter)
- **1292 pass, 3 fail, 13 skip**
- All 3 fails are pre-existing S11/S9 baseline flakes:
  - `projects.test.ts:327` — pre-existing
  - `findings-api.test.ts:320` — pre-existing (Bun double-counts as 2)
- A-15 login: **5/5 pass** in full suite
- B6 migrations: **7/7 pass** in full suite
- S17 UI IT tests: **8/8 pass**

### Lint / typecheck
- `bun run lint` — 0 errors
- `bun run build` (tsc -b) — 0 errors

---

## Ship-cleanup actions (per lead-directive Option A modified)

- **Reverted `ec597d63`** (R2 cascade: four-step rollback test + getSessionContext approach)
- **SF1 BrowserContext pooling reverted** to S16 `browser+context+page` per-session baseline (`real-driver.ts` + `real-driver.test.ts` restored to `b130ab6` shape). Carried as **B-17b** to S18+.
- **B6 P33 fix**: pop-020 prefix added to three granular rollback tests (`three-step`, `observations_browser`, `target_credentials`) with `K = down(020) → down(019) → ...` math comment. Loop test (reports, K=8) was already correct.
- **SF3 unit tests** rewritten to match S16 `RealSession` shape (no `browserContext` dep): scopeCheck propagation, popstate non-navigation, maxSpaDepth injection.
- **B-17a** (four-step rollback with proper state isolation) carried to S18.

## Backlog carries
- **B-17a**: B6 four-step rollback test in separate file with `afterAll` DB reset (P33/state isolation)
- **B-17b**: SF1 BrowserContext pooling structural fix with IT-isolation pre-flight (P39)

---

## Security gate
- `mapCredentialRowToListItem`: encrypted_blob, iv, authTag never returned; only fingerprintHex (sha256 first 16 hex chars)

---

**I have not written sprint-17-evaluator-result.md.**
