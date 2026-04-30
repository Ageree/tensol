# Sprint 16 Contract v2 — SPA Route Discovery + Artifact Persistence + Credential API

**Generator:** generator-s16 (Sonnet 4.6)
**Evaluator:** evaluator-s16 (Opus, isolated)
**Date:** 2026-04-30
**Base commit:** `1fd0462` (S15 PASS)
**Phase:** Phase 3 sprint 2 — SPA route discovery + artifact persistence
**Contract round:** v2 (addresses evaluator r1 blockers B1-B5 + soft S1-S3 + missing M1-M2)

---

## Scope

**New / changed surfaces:**
- `packages/authz/src/resources.ts` (B1 — add `'target_credential'`)
- `packages/authz/src/matrix/platform_admin.ts` (B1)
- `packages/authz/src/matrix/tenant_admin.ts` (B1)
- `packages/authz/src/matrix/security_lead.ts` (B1)
- `packages/authz/src/matrix/operator.ts` (B1)
- `packages/authz/src/matrix/developer.ts` (B1)
- `packages/authz/src/matrix/auditor.ts` (B1)
- `packages/authz/src/matrix/viewer.ts` (B1)
- `packages/authz/src/matrix/spec.ts` (B1 — stale comment update only)
- `packages/authz/src/matrix.test.ts` (B1 — cardinality 1365→1470)
- `packages/db/migrations/019_observations_browser_spa.ts` (NEW)
- `packages/db/src/schema.ts` (update `ObservationsBrowserTable`)
- `packages/db/src/repos/observations-browser.ts` (update insert shape)
- `packages/db/src/index.ts` (re-export)
- `services/browser-worker/src/spa-observer.ts` (NEW)
- `services/browser-worker/src/real-driver.ts` (extend navigate: SPA crawl, depth config)
- `services/browser-worker/src/types.ts` (extend `NavigationOutcome.spaRoutes`)
- `packages/contracts/src/audit.ts` (AUDIT_ACTIONS bump 58→60)
- `packages/contracts/src/audit.test.ts` (cardinality 58→60)
- `tests/lab/spa-fixture/` (NEW)
- `tests/integration/browser/spa-discovery.test.ts` (NEW)
- `tests/integration/db/migrations.test.ts` (B6 loop 6→7 + new 019 test)
- `tests/integration/browser-auth/login-flow.test.ts` (B26 fix)
- `apps/api/src/routes/targets/targets.ts` (B19)
- `apps/api/src/routes/register-routes.ts` (B19)
- `tests/integration/auth/target-credentials-api.test.ts` (NEW)

**Frozen surfaces (must not change):**
`packages/scope-engine`, `packages/decepticon-adapter`, `packages/reports`,
`services/report-builder`, `services/coordinator`, `services/validator-worker`,
`packages/browser-auth/src/crypto.ts`, `packages/browser-auth/src/executor.ts`,
`packages/browser-driver`.

---

## AUDIT_ACTIONS Delta (58→60) — revised per S3

**Dropping `browser.artifact.uploaded` / `browser.artifact.upload_failed`** (S3 finding):
`recon.browser.observation.persisted` already covers the artifact-persist outcome (emitted in `worker.ts:320` after `writeArtifacts()` completes, which includes screenshot+HAR+trace upload). A separate per-artifact upload event would be duplicative. The existing action is the correct consumer-facing signal.

New actions (+2 only):

```
'browser.spa.route.discovered'    — SPA route found via pushState observer (navigated=true) or popstate (navigated=false, discovery-only)
'browser.spa.route.skipped_oos'   — SPA pushstate route rejected by scope-engine, not navigated
```

**Orthogonality note (B3):** `'auth.recipe.scope_denied'` (S15) fires in `auth-handler.ts` when `buildScope()` returns null or scope engine denies the initial target URL before any recipe step executes. `'browser.spa.route.skipped_oos'` fires in `real-driver.ts` during SPA crawl when a discovered pushstate route is denied by scope after initial navigation already succeeded. Different actor (auth pipeline vs crawl loop), different timing (pre-recipe vs mid-crawl), different consumer (auth audit trail vs recon audit trail). It is architecturally impossible for a SPA route discovery from inside a recipe execution to trigger `browser.spa.route.skipped_oos` — `executeRecipe` runs in `handleBrowserAuth`, SPA crawl runs in `worker.ts`/`real-driver.ts`; these are separate queue job types.

---

## B1 — RBAC Matrix Fan-out (Option A)

**Decision: Option A** — add `'target_credential'` as the 14th resource. Option B (reusing `'target'`) rejected because credential lifecycle (encrypt-at-insert, decrypt-in-worker, immutable rows) is a distinct access-control domain from target metadata CRUD. Folding it into `'target'` would require handler-level sub-resource logic, violating the C12 "purely role-based, no tenancy in keys" invariant.

**Current cardinality:** 7 × 13 × 15 = 1365 (verified: `matrix.test.ts:9` asserts 1365; `spec.ts` comment is stale at 1274 — it predates Sprint 6's `scope_validate` action addition).

**New cardinality:** 7 × 14 × 15 = 1470.

### `packages/authz/src/resources.ts`

Add `'target_credential'` as 14th entry in `RESOURCES`.

### `packages/authz/src/matrix/spec.ts`

Update stale comment line:
- Old: `13 × 14 = 182 entries per role and 7 × 182 = 1274 entries total`
- New: `14 × 15 = 210 entries per role and 7 × 210 = 1470 entries total`

No logic changes.

### Per-role matrix files — `target_credential` entry

Every role MUST declare `target_credential` in its `SPEC` (TypeScript `Record<Resource, ...>` exhaustiveness enforces this at compile time):

| Role | `target_credential` allowed actions |
|---|---|
| `platform_admin` | `[]` — platform admin never touches tenant credential blobs |
| `tenant_admin` | `['read', 'list', 'create', 'delete']` |
| `security_lead` | `['read', 'list', 'create']` |
| `operator` | `['read', 'list', 'create']` |
| `developer` | `['read', 'list']` |
| `auditor` | `['read', 'list']` — C10 invariant: read+list on every resource |
| `viewer` | `[]` |

B19 handler uses `assertCan(actor, 'create', 'target_credential')`. Grants `tenant_admin`, `security_lead`, `operator` → 201; denies others → 403.

### `packages/authz/src/matrix.test.ts`

```typescript
// 7 roles × 14 resources × 15 actions = 1470 (Sprint 16: target_credential added)
expect(RBAC_MATRIX.size).toBe(1470);
```

---

## B2 — Artifact Persistence Baseline Clarification

**Today's behavior (S9, already shipped):**
- `real-driver.ts`: `page.screenshot({ type: 'png' })` → real Playwright screenshot bytes.
- HAR: assembled from `harEntries` (real network intercept), JSON-serialized.
- Trace: `new Uint8Array([0x50, 0x4b, 0x03, 0x04])` — 4-byte stub ZIP header.
- `artifact-writer.ts`: real sha256 via `Bun.CryptoHasher('sha256')` for all three.
- `recon.browser.observation.persisted` fires with real sha256 values.
- This pipeline is **fully wired today** for the initial navigation case.

**S16 delta — SPA-discovered routes only:**
S16 extends `real-driver.ts` to run the same pipeline (screenshot + HAR + trace) for each discovered SPA pushstate route that passes scope check. `writeArtifacts()` and `insertObservationBrowser()` are re-used, parameterized with `depth`, `source_url`, `discovery_method`.

**A-16-ArtifactRoundTrip:** Tests screenshot sha256 round-trip for a SPA-discovered route (depth=1): bytes → sha256 by `artifact-writer.ts` → stored in `observations_browser.screenshot_sha256` → IT re-fetches bytes from object storage → recomputes sha256 → asserts match. Trace sha256 intentionally excluded (stub is constant — tautological).

---

## B4 — Depth Budget Enforcement (both sub-approaches)

### Sub-approach 1: SPA fixture depth-2 route

`tests/lab/spa-fixture/` `/about` page includes inline JS that pushState's to `/about/team` (depth-2). With `maxSpaDepth:1`: `/about` is crawled (depth=1), `/about/team` is NOT (depth=2). IT asserts no `observations_browser` row for `/about/team`.

### Sub-approach 2: Unit test on `parseSpaMaxDepth`

```typescript
test.each([
  ['3',       3],
  ['0',       0],
  ['10',      10],
  ['11',      3],   // above cap → default
  ['-1',      3],   // negative → default
  ['abc',     3],   // NaN → default
  ['10.9',    3],   // float → NaN after parseInt → default
  ['2147483648', 3], // overflow → above cap → default
  [undefined, 3],   // absent → default
])('parseSpaMaxDepth(%s) === %d', (input, expected) => {
  expect(parseSpaMaxDepth(input)).toBe(expected);
});
```

---

## B5 — Depth Config Single-Source Pattern

`RealBrowserDriverDeps` gains `readonly maxSpaDepth?: number`. If provided, used directly. If absent, `parseSpaMaxDepth(process.env.BROWSER_SPA_MAX_DEPTH)` is called. Tests inject `maxSpaDepth` directly — **no `process.env` mutation in tests.** Mirrors S15's `CREDENTIAL_KEK`/`parseKek` pattern.

---

## S1 — popstate Semantics

**Decision (a):** popstate routes are captured in `spaRoutes` (discovery-only audit) but NOT navigated.

In the crawl loop:
```typescript
if (route.method === 'popstate') {
  // Discovery-only: emit audit, do not navigate.
  emitAudit('browser.spa.route.discovered', { url: route.url, navigated: false, reason: 'popstate_discovery_only' });
  continue;
}
```

`browser.spa.route.discovered` fires for both popstate (`navigated: false`) and pushstate (`navigated: true`). Codex will verify the non-navigation invariant.

---

## S2 — B26 Root-Cause Verification

Fix: `makeShortTimeoutRecipeJson(port)` uses `successCheck.timeoutMs: 2000`. `handleBrowserAuth` returns nack in ~2s, `resetAuthState` called normally within the test body.

Verification plan for A-16-B26-LoginFailed: run `login-flow.test.ts` both in isolation (`bun test tests/integration/browser-auth/login-flow.test.ts`) AND as part of full suite. Both must pass A-15-LoginFailed with no FK violation. State both counts in "ready for review" message.

---

## Migration 019 — `019_observations_browser_spa.ts`

```sql
ALTER TABLE observations_browser
  ADD COLUMN source_url        text,
  ADD COLUMN depth             integer NOT NULL DEFAULT 0,
  ADD COLUMN discovery_method  text NOT NULL DEFAULT 'initial_navigation';
```

- `source_url`: NULL for initial navigation, populated for SPA routes.
- `depth`: 0 = initial, 1+ = discovered.
- `discovery_method`: `'initial_navigation'` | `'pushstate'` | `'popstate'` (no CHECK — extensible).
- No BYTEA columns → P32 N/A.
- `observations_browser` is NOT append-only → no triggers.

**Down:**
```sql
ALTER TABLE observations_browser
  DROP COLUMN IF EXISTS source_url,
  DROP COLUMN IF EXISTS depth,
  DROP COLUMN IF EXISTS discovery_method;
```

### B6 loop bump (P33)

Loop at `migrations.test.ts:159`: `6 → 7`.
Comment: `// 7 = down(019)→down(018)→down(017)→down(016)→down(015)→down(014)→down(013); reports table dropped at 013-down.`

### New B6 test for migration 019

```typescript
test('B6 — observations_browser SPA columns present after 019, absent after rollback', async () => {
  await applyAllMigrations(f);
  const cols = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'observations_browser'
      AND column_name IN ('source_url', 'depth', 'discovery_method')
  `.execute(f.db);
  expect(cols.rows).toHaveLength(3);
  const r = await f.migrator.migrateDown();
  if (r.error) throw r.error instanceof Error ? r.error : new Error(String(r.error));
  const after = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'observations_browser'
      AND column_name IN ('source_url', 'depth', 'discovery_method')
  `.execute(f.db);
  expect(after.rows).toHaveLength(0);
  await applyAllMigrations(f);
});
```

---

## `packages/db/src/schema.ts`

Add to `ObservationsBrowserTable`:
```typescript
source_url:        string | null;
depth:             number;
discovery_method:  string;
```

---

## `packages/db/src/repos/observations-browser.ts`

Insert function gains optional SPA fields (defaults: `source_url=null`, `depth=0`, `discovery_method='initial_navigation'`). No new JSONB arrays → P1 N/A.

---

## `services/browser-worker/src/spa-observer.ts` (NEW)

No Playwright import. Exports:

```typescript
export const SPA_OBSERVER_SCRIPT: string;

export interface SpaRoute {
  readonly url: string;
  readonly sourceUrl: string;
  readonly method: 'pushstate' | 'popstate';
}

export const parseSpaRoutes = (raw: unknown): ReadonlyArray<SpaRoute>;
export const parseSpaMaxDepth = (raw: string | undefined): number;
```

`SPA_OBSERVER_SCRIPT` patches `history.pushState` and listens `popstate`, appends to `window.__cs_spa_routes`. Uses `new URL(url, location.href)` for absolute URL resolution. try/catch around URL construction (malformed relative URLs must not throw).

`parseSpaMaxDepth`: `parseInt` → NaN/negative → 3; >10 → 3; [0,10] → value.

---

## `services/browser-worker/src/real-driver.ts` (EXTEND)

### Constructor

```typescript
export interface RealBrowserDriverDeps {
  readonly scopeCheck?: (url: string) => Promise<void>;
  readonly randomUUID?: () => string;
  readonly maxSpaDepth?: number;  // if absent, reads process.env.BROWSER_SPA_MAX_DEPTH
}
```

### SPA crawl after initial `page.goto()` completes

1. `await page.addInitScript(SPA_OBSERVER_SCRIPT)`.
2. Wait settle (env `BROWSER_SPA_SETTLE_MS`, default 500ms, injectable via deps or env).
3. `const raw = await page.evaluate(() => (window as any).__cs_spa_routes ?? [])`.
4. `const routes = parseSpaRoutes(raw)`.
5. `const maxDepth = this.maxSpaDepth ?? parseSpaMaxDepth(process.env.BROWSER_SPA_MAX_DEPTH)`.
6. For each route:
   - `popstate`: emit `browser.spa.route.discovered` (navigated:false), continue.
   - `pushstate` at depth > maxDepth: skip (budget exceeded, no audit — not an OOS event).
   - `pushstate` at depth ≤ maxDepth:
     - **Scope-first:** `await this.scopeCheck?.(route.url)` — if throws: emit `browser.spa.route.skipped_oos`, continue.
     - `await page.goto(route.url, { timeout: 30_000 })`.
     - Capture screenshot + HAR + trace stub.
     - `await writeArtifacts(deps.objectStorage, ...)`.
     - `await insertObservationBrowser(db, { ..., source_url: route.sourceUrl, depth: 1, discovery_method: 'pushstate' })`.
     - Emit `browser.spa.route.discovered` (navigated:true).

### HAR redaction comment

```typescript
// Headers intentionally empty: Authorization and Cookie are never captured (HAR redaction, S2 lesson).
```

### `NavigationOutcome` extension

```typescript
readonly spaRoutes: ReadonlyArray<{
  readonly url: string;
  readonly sourceUrl: string;
  readonly depth: number;
  readonly method: 'pushstate' | 'popstate';
  readonly navigated: boolean;
}>;
```

---

## `tests/lab/spa-fixture/` (NEW)

Routes:
- `GET /` — pushState to `/about` (100ms) and `/contact` (200ms).
- `GET /about` — pushState to `/about/team` (100ms) [depth-2 for B4].
- `GET /about/team` — static "Team page".
- `GET /contact` — static "Contact page".
- `GET /healthz` — `{ ok: true }`.

`startSpaLab(port=0): Promise<{ port, origin, stop }>`.
P10: `fileURLToPath(import.meta.url)`.

---

## Integration Test: `tests/integration/browser/spa-discovery.test.ts`

`skipIf(!hasDatabaseUrl())`. P27: `resetAuthState` ×2 per file.

5 cases:
1. **A-16-SpaFixtureUp** — healthz 200.
2. **A-16-SpaRouteDiscovery** — navigate `/`, `maxSpaDepth:1` → 2 rows (`/about`, `/contact`), `depth=1`, `source_url` populated, `discovery_method='pushstate'`, audit `browser.spa.route.discovered` ×2.
3. **A-16-ArtifactRoundTrip** — screenshot sha256 from DB matches re-computed sha256 of bytes from object storage.
4. **A-16-OosRouteSkipped** — `scopeCheck` denies `/about` → no row for `/about`, audit `browser.spa.route.skipped_oos` ×1 → `/contact` row exists.
5. **A-16-DepthBudget** — `maxSpaDepth:1` → no row for `/about/team` (depth-2).

---

## B19 — POST `/assessments/:id/target-credentials`

### Handler flow

1. `assertOwnership(actor, assessmentId)` — cross-tenant → 403/404.
2. `const decision = assertCan(actor, 'create', 'target_credential')` — if `decision.outcome !== 'allow'` throw `new RbacDenyError({...})`.
3. Validate body (`CredentialSchema`) → 400.
4. `const { CREDENTIAL_KEK } = process.env` → 500 if absent.
5. `parseKek(CREDENTIAL_KEK)` → `kek`.
6. `encryptCredential(JSON.stringify(body), kek)` → blob.
7. `insertTargetCredential(db, { tenantId, targetId, recipeId, encryptedBlob: blob.ciphertext, iv: blob.iv, authTag: blob.authTag, createdBy: actor.userId })`.
8. Emit `auth.credential.encrypted`.
9. Return 201 `{ id }`.

`decryptCredential` NEVER called in `apps/api`.

### `register-routes.ts`

Wire: `POST /assessments/:id/target-credentials → handleCreateTargetCredential`.

### `tests/integration/auth/target-credentials-api.test.ts`

`skipIf(!hasDatabaseUrl())`. P27: `resetAuthState` ×2. 4 cases: A-16-CredentialCreate (201+audit), A-16-CredentialCreate403 (auditor→403), A-16-CredentialCreateCrossTenant (→403/404), A-16-CredentialCreateBadBody (→400).

---

## B26 — Fix A-15-LoginFailed

`makeShortTimeoutRecipeJson(port)`: same as `makeRecipeJson` but `successCheck.timeoutMs: 2000`. Used only in `A-15-LoginFailed`. `handleBrowserAuth` returns nack in ~2s. Verification: run test in isolation AND full suite, both pass with no FK violation.

---

## B20 — auth-handler.ts coverage ≥80%

Natural consequence of B26 fix. Verify in final run.

---

## §X — Codex Review Gate (M1)

After evaluator verification matrix passes, adversarial codex probes:

1. **SPA scope bypass via redirect** — pushState URL redirects to OOS host. Verify `scopeCheck` fires on the pushed URL. `context.route()` intercept also aborts OOS subrequests mid-navigation (double-coverage).
2. **Credential API cross-tenant + RBAC bypass** — `POST` with `targetId` from different tenant. `assertOwnership` fires before `assertCan`.
3. **HAR header redaction edge cases** — subrequest with `Authorization` header in SPA JS. Verify never in stored HAR.
4. **Depth budget integer overflow / negative cap** — `parseSpaMaxDepth('2147483648')`, `('-999')`, `('10.9')`. Unit test covers these (B4 sub-approach 2).

Codex P1+P2 → implementation blockers. P3+ → S17 backlog.

---

## §Y — Regression Guard (M2)

### A-16-RegressionGuard

```bash
git diff main..HEAD -- \
  packages/scope-engine \
  packages/decepticon-adapter \
  packages/reports \
  services/report-builder \
  services/coordinator \
  services/validator-worker \
  packages/browser-auth/src/crypto.ts \
  packages/browser-auth/src/executor.ts \
  packages/browser-driver
```

Must produce zero non-comment line changes. Generator verifies before "ready for review". Any output is a blocker.

---

## Acceptance Criteria

### A-16-RbacMatrixCardinality
`RBAC_MATRIX.size === 1470`. TypeScript exhaustiveness enforces all 7 matrix files include `target_credential`. `bun run typecheck` 0 errors.

### A-16-Schema
Migration 019 applies + rolls back. B6 test: 3 columns present after 019, 0 after rollback. B6 loop 6→7 with comment. `ObservationsBrowserTable` has `source_url`, `depth`, `discovery_method`.

### A-16-SpaObserver
`spa-observer.ts`: no Playwright import. Unit tests: `parseSpaRoutes` (valid/non-array/malformed), `parseSpaMaxDepth` (all 9 corners from B4 table).

### A-16-SpaDiscovery
5 IT cases pass or skip on no-DB. `grep -c resetAuthState spa-discovery.test.ts` ≥ 2. A-16-DepthBudget: no `/about/team` row with `maxSpaDepth:1`.

### A-16-ArtifactRoundTrip
Screenshot sha256 from DB matches re-computed sha256 of bytes from object storage. Trace excluded.

### A-16-OosRouteSkipped
`browser.spa.route.skipped_oos` emitted. No `observations_browser` row. No `page.goto()` called for OOS URL (verifiable in unit test with mock).

### A-16-AuditCardinality
`AUDIT_ACTIONS.length === 60`. Exhaustive array includes `browser.spa.route.discovered` and `browser.spa.route.skipped_oos`.

### A-16-SpaFixture
`startSpaLab()` resolves. All routes serve correctly. `/about` JS pushState's to `/about/team`.

### A-16-B19-CredentialAPI
Route registered. IT: 201+audit (owner), 403 (auditor), 400 (bad body), cross-tenant → 403/404. `auth.credential.encrypted` fires. `decryptCredential` not imported in `apps/api`. `grep -c resetAuthState target-credentials-api.test.ts` ≥ 2.

### A-16-B26-LoginFailed
A-15-LoginFailed passes in isolation AND full suite. Completion ≤5s. No `audit_events_tenant_id_fkey` violation.

### A-16-B20-Coverage
`auth-handler.ts` line+function coverage ≥80%.

### A-16-ScopeFirst
Every SPA pushstate route: `scopeCheck(url)` before `page.goto()`. Verified in A-16-OosRouteSkipped IT and unit test.

### A-16-DepthBudget
`parseSpaMaxDepth` unit tests pass all 9 corners. A-16-DepthBudget IT: no depth-2 row with `maxSpaDepth:1`.

### A-16-RegressionGuard
`git diff main..HEAD -- <frozen surfaces>` → zero non-comment line changes.

### A-16-LintTC
`bun run lint` → 0 errors. `bun run typecheck` → 0 errors.

### A-16-Tests
No-DB: 0 failures. Full-PG: 0 failures OR ≤3 known flakes. A-15-LoginFailed MUST be in the passing column (not a flake).

---

## Pitfalls Catalog v7 Applied

1. P1: no new JSONB array writes. N/A.
2. P2: tenant slugs in new IT fixtures.
3. P3: `observations_browser` DELETE already in `resetAuthState` (L253). No new FK chains from 019 (ALTER TABLE only). No changes needed.
4. P4+P33: B6 loop 6→7, math comment.
5. P5: no append-only triggers on 019.
6. P7: `scopeCheck(url)` before `page.goto()` for every SPA pushstate route.
7. P9: AUDIT_ACTIONS 58→60.
8. P10: `fileURLToPath(import.meta.url)` in spa-fixture.
9. P11: N/A.
10. P27: `grep -c resetAuthState` ≥ 2 per new IT file (3 new IT files).
11. P32: no bytea in 019. N/A.
12. P33: B6 loop bumped.
13. P34: `BuildEffectiveScopeInputs` 5+ fields in new scope builds.
14. P35: full-suite counts mandatory in evaluator verification.
15. R3: ONE PG run.
16. Flake budget: ≤3. A-15-LoginFailed must PASS.

---

## Risk Register

| ID | Risk | Mitigation |
|----|------|-----------|
| R1 | `page.addInitScript()` timing vs SPA scripts | `addInitScript()` fires before any page script by design. |
| R2 | `/about/team` only visible after navigating `/about` | Correct by design — depth tracking means depth-2 only discovered from depth-1 page JS. |
| R3 | `assertOwnership` order vs `assertCan` in B19 | `assertOwnership` first (consistent with `scope-validate.ts:180-190`). |
| R4 | `target_credential` TypeScript exhaustiveness | `RoleSpec = Record<Resource, ...>` enforces at compile time. |
| R5 | SPA scope bypass via redirect | `scopeCheck` on pushed URL + `context.route()` intercept = double-coverage. |

---

## S17 Backlog

1. Real Playwright tracing replacing trace stub.
2. `StagehandBrowserDriver.actOn()` for semantic SPA crawl.
3. `BROWSER_DRIVER=stagehand-cloud` Browserbase flag.
4. Deprecate `RealBrowserDriver` once Stagehand covers navigate paths.
5. `playwright install chromium` in CI/Makefile.
6. Depth-2+ recursive SPA observer.
