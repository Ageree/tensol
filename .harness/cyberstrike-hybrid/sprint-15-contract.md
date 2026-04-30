# Sprint 15 Contract — Browser-Driver Integration + Login Recipes + Encrypted Session Storage

**Generator:** generator-s15 (Sonnet 4.6)
**Evaluator:** evaluator-s15 (Sonnet 4.6, isolated)
**Date:** 2026-04-30
**ADR:** `docs/adr/0007-browser-agent-driver.md` — Decision: Stagehand v3
  (`@browserbasehq/stagehand@^3.3.0`, MIT). A-15-D section is now complete.

---

## Scope

`packages/browser-driver/` (NEW), `packages/browser-auth/` (NEW),
`packages/db` (migration 018_target_credentials + schema.ts + repos/target-credentials.ts),
`services/browser-worker/` (extend real-driver + stagehand-driver + select + auth),
`packages/contracts/src/audit.ts`, `tests/lab/auth-fixture/` (NEW),
`tests/integration/browser-auth/` (NEW).

Frozen surfaces (must not change): `packages/scope-engine`, `packages/decepticon-adapter`,
`packages/reports`, `services/report-builder`, `services/coordinator`, `services/validator-worker`.

---

## Implementation Plan (file-level)

### packages/browser-driver/ (NEW package)

**Purpose:** thin facade over the chosen browser engine exposing a semantic-action API
(`act`, `observe`, `extract`) on top of a Playwright `Page`. The `services/browser-worker`
continues to manage raw Chromium lifecycle via its own `BrowserDriver` interface but builds the
facade on top.

#### packages/browser-driver/package.json
- `"name": "@cyberstrike/browser-driver"`, workspace, ESM, Bun-native.
- Dep: `playwright` (pinned), `zod`, `@cyberstrike/scope-engine` (for scope-guard injection).

#### packages/browser-driver/src/types.ts
- `SemanticActionKind`: `'act' | 'observe' | 'extract'`
- `ActInput`: `{ action: string; selector?: string; value?: string }`
- `ObserveResult`: `{ elements: ReadonlyArray<{ selector: string; text: string; role?: string }>; url: string }`
- `ExtractResult`: `{ data: Record<string, unknown>; url: string }`
- `BrowserDriverFacade` interface: `act(page, input): Promise<void>`, `observe(page): Promise<ObserveResult>`,
  `extract(page, schema: z.ZodSchema): Promise<ExtractResult>`

#### packages/browser-driver/src/playwright-facade.ts
- `PlaywrightBrowserDriverFacade implements BrowserDriverFacade`
- `act`: `page.locator(selector).click()` / `page.fill()` / `page.goto()` depending on
  `input.action` (`'click'|'fill'|'navigate'`). Validated via internal ActionSchema (Zod).
- `observe`: `page.locator('a, button, input, [role]').all()` → map to ObserveResult.
- `extract`: `page.evaluate()` with schema-validated output.
- Scope-guard injection point: `act('navigate', url)` calls `scopeGuard.decide(url)` before
  `page.goto()`. Returns `ScopeDenyError` if denied (caller handles it).

#### packages/browser-driver/src/index.ts
- Export types + `PlaywrightBrowserDriverFacade`.

### packages/browser-auth/ (NEW package)

**Purpose:** pluggable login-recipe interface + AES-256-GCM credential encryption/decryption.

#### packages/browser-auth/package.json
- `"name": "@cyberstrike/browser-auth"`, workspace, ESM.
- Deps: `zod`. Duck-typed `ExecutorPage`/`ExecutorContext` interfaces — no hard playwright dep.

#### packages/browser-auth/src/recipe-schema.ts
- `RecipeStepSchema` (Zod):
  ```
  {
    action: z.enum(['click','fill','navigate','waitFor','submit']),
    selector: z.string().optional(),
    fillFromCred: z.enum(['username','password']).optional(),
    value: z.string().optional(),
    waitFor: z.object({ selector: z.string(), timeoutMs: z.number().int().positive() }).optional()
  }
  ```
- `LoginRecipeSchema` (Zod):
  ```
  {
    name: z.string().min(1),
    kind: z.enum(['form-post','oauth2-pkce','magic-link']),
    steps: z.array(RecipeStepSchema).min(1),
    successCheck: z.object({ selector: z.string(), timeoutMs: z.number().int().positive() })
  }
  ```
- `LoginRecipe = z.infer<typeof LoginRecipeSchema>`

#### packages/browser-auth/src/credential-schema.ts
- `CredentialSchema` (Zod): `{ username: z.string(), password: z.string() }`
- `Credential = z.infer<typeof CredentialSchema>`

#### packages/browser-auth/src/executor.ts
- Duck-typed interfaces (no hard playwright dep):
  - `ExecutorPage`: `{ goto, locator, waitForSelector, url }` — satisfied by real Playwright `Page`
    and by any Stagehand page handle.
  - `ExecutorContext`: `{ storageState }` — satisfied by Playwright `BrowserContext`.
- `LoginResult`: `{ storageState: string; cookies: ReadonlyArray<AuthCookieResult>; lastUrl: string }`
- `executeRecipe(page: ExecutorPage, ctx: ExecutorContext, recipe: LoginRecipe, credential: Credential): Promise<LoginResult>`
  1. Walk `recipe.steps` in order.
  2. `fill` + `fillFromCred`: use `credential[fillFromCred]`.
  3. `navigate`: `page.goto(url, ...(step.waitFor ? [{ timeout: step.waitFor.timeoutMs }] : []))`.
     (Conditional spread required by `exactOptionalPropertyTypes`.)
  4. `successCheck`: `page.waitForSelector(selector, { timeout: timeoutMs })`.
     Throws `LoginFailedError` if times out.
  5. Return `{ storageState: JSON.stringify(await ctx.storageState()), cookies, lastUrl: page.url() }`.
- **ZERO plaintext in memory beyond the call**: credential object used only in this scope.

#### packages/browser-auth/src/crypto.ts
- `encryptCredential(plaintext: string, kek: Buffer): EncryptedBlob`
  - `EncryptedBlob`: `{ iv: Buffer; ciphertext: Buffer; authTag: Buffer }` — all `Buffer`, not `Uint8Array` (P5).
  - Random 96-bit IV per call: `crypto.randomBytes(12)`.
  - AES-256-GCM: `crypto.createCipheriv('aes-256-gcm', kek, iv)`.
- `decryptCredential(blob: EncryptedBlob, kek: Buffer): string`
  - `crypto.createDecipheriv`; `setAuthTag`; throws `DecryptionError` on tamper.
- `parseKek(hexEnvVar: string | undefined): Buffer` — validates 64-char hex; throws `ConfigError`.
  - **NEVER log the key value**.

#### packages/browser-auth/src/errors.ts
- `LoginFailedError`, `DecryptionError`, `ConfigError` — all extend Error, typed name fields.

#### packages/browser-auth/src/index.ts
- Export all public types and functions.

### packages/db — migration 018_target_credentials.ts (NEW)

**Schema:**
```sql
CREATE TABLE target_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  target_id     uuid NOT NULL REFERENCES targets(id),
  recipe_id     text NOT NULL,
  encrypted_blob bytea NOT NULL,
  iv             bytea NOT NULL,
  auth_tag       bytea NOT NULL,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

Append-only: `attachAppendOnlyTriggers(db, 'target_credentials')` — 3 triggers:
- `target_credentials_no_update_delete_stmt` BEFORE UPDATE OR DELETE FOR EACH STATEMENT
- `target_credentials_no_update_delete_row`  BEFORE UPDATE OR DELETE FOR EACH ROW
- `target_credentials_no_truncate`           BEFORE TRUNCATE FOR EACH STATEMENT

All call `enforce_append_only()` (defined in 011). No UPDATE-deny-only trigger —
rows are fully immutable (no status field), consistent with the spec.

### packages/db/src/schema.ts
- Add `TargetCredentialsTable` interface (encrypted fields as `Buffer`).
- Add `target_credentials` to `ALL_TABLE_NAMES`.
- Add `target_credentials` to `APPEND_ONLY_TABLES`.

### packages/db/src/repos/target-credentials.ts (NEW)
- `insertTargetCredential`, `getTargetCredential`, `listTargetCredentials` — tenant-scoped, immutable.

### packages/db/src/index.ts
- Export new repo functions and `TargetCredentialsTable`.

### packages/contracts/src/audit.ts — AUDIT_ACTIONS bump (52 → 56)

New actions (+4):
```
'auth.recipe.executed'       — login recipe ran to completion
'auth.credential.encrypted'  — credential stored (API insert)
'auth.credential.decrypted'  — credential retrieved (browser-worker only)
'auth.login.failed'          — executeRecipe threw LoginFailedError
```

### packages/contracts/src/audit.test.ts
- Update cardinality assertion: `52 → 56`.

### packages/contracts/src/queue-envelope.ts + packages/queue/src/types.ts
- Add `'report.build'` and `'browser.auth'` to `ENVELOPE_KINDS` (5 → 7) in both canonical files.
- Tests updated to assert length 7.

---

## A-15-D: Browser-driver integration — Stagehand v3 (ADR 0007)

**Decision:** Stagehand v3 (`@browserbasehq/stagehand@^3.3.0`, MIT, 2026-04-27) is the
semantic action layer. Raw Playwright (`RealBrowserDriver`) is retained as the low-level path
for navigation, HAR capture, and storageState operations. Stagehand wraps it.

### services/browser-worker/package.json
- Add `"@browserbasehq/stagehand": "^3.3.0"` to dependencies.
- Existing `"playwright": "^1.49.0"` satisfies Stagehand's optional `playwright-core` dep.

### services/browser-worker/src/stagehand-session.ts (NEW)
- `StagehandSession`: `{ stagehand: Stagehand; page: Page; context: BrowserContext; browser: Browser }`
- `StagehandSessionManager`: holds `Map<sessionId, StagehandSession>`.
- `createStagehandSession(input: BrowserLaunchInput): Promise<StagehandSession>`:
  - `new Stagehand({ env: 'LOCAL', verbose: 0, headless: true })` (no Browserbase cloud yet).
  - `await stagehand.init()` — starts local Chromium via CDP.
  - If `input.authCookies` provided: inject via `stagehand.page.context().addCookies(cookies)`.
  - Returns `{ stagehand, page: stagehand.page, context: stagehand.page.context(), ... }`.
- `destroyStagehandSession(sessionId)`: `await stagehand.close()`.

### services/browser-worker/src/stagehand-driver.ts (NEW)
- `StagehandBrowserDriver implements BrowserDriver`
- Constructor takes optional `scopeCheck?: (url: string) => Promise<void>` — same pattern as
  `RealBrowserDriver`.
- `launch(input)`: delegates to `StagehandSessionManager.createStagehandSession(input)`, stores
  in internal `Map<sessionId, StagehandSession>`, returns `BrowserSession`.
- `navigate(sessionId, request)`:
  - Scope-guard: `await this.scopeCheck?.(request.url)` BEFORE any page action.
  - `page.goto(request.url)` via Stagehand's `page` handle (standard Playwright `Page`).
  - HAR capture via `page.on('request')` / `page.on('response')` interception.
  - Screenshot: `page.screenshot({ type: 'webp', quality: 80 })`.
  - DOM snapshot: `page.content()`.
  - Link discovery: `page.evaluate()` returning `Array<string>` of `href` values.
  - Returns `NavigationOutcome`.
- `actOn(sessionId, steps: RecipeStep[], credential: Credential)`:
  - For `action: 'act'` steps: `await stagehand.act({ action: step.instruction })`.
  - For `action: 'navigate'` steps: `await page.goto(step.url)`.
  - For `action: 'fill'` steps with `fillFromCred`: `await stagehand.act({ action: \`fill the ${step.selector} field with ${credential[step.fillFromCred]}\` })`.
  - This is the S15 recipe bridge: recipe steps with `fillFromCred` become natural-language Stagehand acts.
- `close(sessionId)`: `await stagehand.close()`, removes from session map.

### services/browser-worker/src/select.ts (UPDATE)
- Add `'stagehand'` to `BrowserDriverChoice` enum.
- `KNOWN_CHOICES` set: `['fake', 'real', 'stagehand']`.
- `BROWSER_DRIVER=stagehand` → `new StagehandBrowserDriver(opts.stagehandDeps ?? {})`.
- `SelectBrowserDriverOptions` gains optional `stagehandDeps?: StagehandBrowserDriverDeps`.
- Import `StagehandBrowserDriver` from `./stagehand-driver.ts`.

### services/browser-worker/src/select.test.ts (UPDATE)
- Add: `BROWSER_DRIVER=stagehand` returns `StagehandBrowserDriver` instance.
- Existing `fake` and `real` tests unchanged.

### services/browser-worker/src/stagehand-driver.test.ts (NEW)
- Unit tests with a mock Stagehand instance (duck-typed stub — no real browser).
- `launch()` stores session in map, returns sessionId.
- `navigate()` calls `scopeCheck` before `page.goto`.
- `scopeCheck` rejection prevents `page.goto` from being called.
- `close()` calls `stagehand.close()` and removes session.
- These mirror the `real-driver.test.ts` pattern (which tested `NotImplementedError`; now
  `StagehandBrowserDriver` tests real behaviour with a stub).

### services/browser-worker/src/auth-handler.ts (NEW — ships in base S15)
- `handleBrowserAuth(deps, envelope): Promise<HandlerOutcome>` — full flow per existing contract.
- Uses `RealBrowserDriver` directly (not `StagehandBrowserDriver`) for S15 because the login
  flow uses `executeRecipe` (duck-typed `ExecutorPage`) which works with any Playwright `Page`.
  `StagehandBrowserDriver.actOn()` is the S16 semantic-action path; S15 recipe executor is
  selector-based (form-post) and works fine via raw Playwright.
- Note: `handleBrowserAuth` passes `page` (from `RealBrowserDriver`'s internal session) directly
  to `executeRecipe`, which uses the duck-typed `ExecutorPage` interface — compatible with both
  `RealBrowserDriver.page` and `StagehandBrowserDriver.page`.

### Migration plan alignment with ADR 0007

| ADR Phase | S15 Status | Action |
|-----------|-----------|--------|
| Phase 1: keep RealBrowserDriver | Done — `RealBrowserDriver` ships in base S15 | No change |
| Phase 2: add StagehandBrowserDriver | A-15-D deliverable | New files above |
| Phase 3: deprecate RealBrowserDriver | S16/S17 | Out of scope |

---

## services/browser-worker/ — auth integration (base S15)

### services/browser-worker/src/real-driver.ts (REPLACED stub)
- Full Playwright implementation: `launch()`, `navigate()`, `close()`.
- Session map: `Map<sessionId, { browser, context, page }>`.
- `scopeCheck?: (url: string) => Promise<void>` — optional (ADR pattern, also used by Stagehand driver).
- `lib: ["ES2022", "DOM"]` in tsconfig for `document`/`HTMLAnchorElement` in `page.evaluate()`.

### services/browser-worker/src/auth-handler.ts (NEW)
- `handleBrowserAuth(deps, envelope): Promise<HandlerOutcome>`
- Flow: parse → load credential → scope-guard → decrypt → executeRecipe → PUT storageState → audit.
- `objectStorage.put({ key, body, contentType })` — single-object form (not two positional args).
- `Decision.allowed` (not `decision.outcome !== 'allow'`) per scope-engine type.
- `CREDENTIAL_KEK` destructured from `process.env` to satisfy `noPropertyAccessFromIndexSignature`.

---

## tests/lab/auth-fixture/ (NEW)

Hono app (not Express — Bun-native, no native Node bindings).

```
GET  /             — HTML login form
POST /login        — form-post with cookie response
GET  /protected    — 200 if session cookie present, 401 if not
GET  /healthz      — 200 always
```

- Valid credentials: `LAB_USERNAME='lab-user'`, `LAB_PASSWORD='lab-pass'` (constants, test-only).
- Cookie: `httpOnly`, `sameSite: 'Strict'`.
- `startAuthLab(port=0): Promise<{ port, origin, stop }>`.
- `parseBody()` result destructured (`const { username, password } = body`) to satisfy
  `noPropertyAccessFromIndexSignature`.

---

## tests/integration/browser-auth/login-flow.test.ts (NEW)

4 IT cases (A-15-LoginHappyPath, A-15-LoginFailed, A-15-DecryptionFailure, A-15-CredentialRepo).
`skipIf(!hasDatabaseUrl())` guard. P27: `resetAuthState` in `afterAll` + `beforeEach` + explicit
in each test (`grep -c resetAuthState` ≥ 2 confirmed).

**A-15-CredentialRepo** probe asserts SQLSTATE `23514` (`check_violation`) specifically:
```typescript
try {
  await sql`DELETE FROM target_credentials WHERE 1=0`.execute(db);
} catch (e: unknown) {
  threw = true;
  expect((e as { code?: string }).code).toBe('23514');
}
if (!threw) throw new Error('expected SQLSTATE 23514 but no error was thrown');
```
Pattern matches `tests/integration/audit/append-only-runtime.test.ts:23,36`.

---

## tests/integration/db/migrations.test.ts (UPDATE)

**B5 spot-check**: `target_credentials` in the table existence query.

**B6 target_credentials rollback test** (NEW, lines ~152-180):
1. `applyAllMigrations(f)` — ensure 018 is applied.
2. Query `pg_trigger WHERE tgrelid = 'public.target_credentials'::regclass` — assert 3 trigger names:
   `target_credentials_no_update_delete_stmt`, `target_credentials_no_update_delete_row`, `target_credentials_no_truncate`.
3. `f.migrator.migrateDown()` — rolls back 018 only.
4. Query `information_schema.tables` — assert `target_credentials` absent.
5. `applyAllMigrations(f)` — re-apply for downstream tests.
6. Existing langgraph B6 test (017 check) left intact — no regression.

---

## tests/integration/auth/helpers/auth-fixture.ts (UPDATE)

Add to `resetAuthState`:
- `ALTER TABLE target_credentials DISABLE TRIGGER USER` alongside existing DISABLE block
  (after `ALTER TABLE reports DISABLE TRIGGER USER`).
- `DELETE FROM target_credentials` BEFORE `DELETE FROM targets` (FK order — `target_credentials`
  has FK → `targets`). Insert after `DELETE FROM assessment_targets`, before `DELETE FROM targets`.
- `ALTER TABLE target_credentials ENABLE TRIGGER USER` in `finally` block alongside other ENABLE
  statements.

---

## tests/integration/db/schema-shape.test.ts (UPDATE)

- `TENANT_OWNED` array (line ~15): add `'target_credentials'`.
- `APPEND_ONLY` array (line ~40): add `'target_credentials'`.

---

## S16 Backlog (explicit, not in scope for S15)

1. `POST /assessments/:id/target-credentials` API route in `apps/api`:
   - `assertCan(actor, 'create', 'target_credential')` + `RbacDenyError`.
   - Reads `process.env.CREDENTIAL_KEK`, calls `encryptCredential`, inserts via `insertTargetCredential`.
   - Emits `auth.credential.encrypted` audit (already in AUDIT_ACTIONS).
   - IT: auditor → 403, owner → 201 + audit row, cross-tenant target → 404.
2. `playwright install chromium` automated in CI/Makefile.
3. Phase 3: deprecate `RealBrowserDriver` once `StagehandBrowserDriver` covers all navigate paths.
4. Browserbase cloud path (`BROWSER_DRIVER=stagehand-cloud`) — feature flag for tenant isolation.

---

## Risk Register

| ID | Risk | Mitigation |
|----|------|-----------|
| R1 | Stagehand v3 is 3 weeks old (CDP rewrite) | Pin `^3.3.0`; review on S16. CDP protocol itself is stable. ADR accepted this risk. |
| R2 | `playwright` Chromium binary in CI | `playwright install chromium` in setup. Existing project dep in browser-worker. |
| R3 | AES-256-GCM in Bun | Bun 1.x provides Node.js `crypto`. Confirmed. |
| R4 | storageState blob must never be logged | PUT to object storage only; never in audit event payloads. |
| R5 | `target_credentials` FK → `targets` — DELETE order | `DELETE target_credentials` before `targets`. DISABLE trigger before. |
| R6 | B6 rollback test | B6 test updated to check 018 table/triggers specifically. Existing 017 test intact. |
| R7 | `CREDENTIAL_KEK` not in test env | IT uses a test KEK constant (`TEST_KEK_HEX`). Never production KEK. |
| R8 | Stagehand `engines` field: Node >=20.19 | Bun 1.3 satisfies in Node-22-compat mode. Fallback: Playwright adapter path. |
| R9 | `exactOptionalPropertyTypes` + optional goto args | Conditional spread: `...(cond ? [opts] : [])`. Applied in executor.ts. |

---

## Design Decisions

1. **Driver:** Stagehand v3 via `StagehandBrowserDriver`. `RealBrowserDriver` retained as low-level
   Playwright path; `handleBrowserAuth` (S15) uses `RealBrowserDriver` because `executeRecipe`
   is duck-typed and works with any `Page` — no Stagehand-specific API needed for form-post auth.
   S16 semantic crawl (`actOn`) uses `StagehandBrowserDriver`.
2. **Duck-typed `ExecutorPage`/`ExecutorContext`:** `packages/browser-auth` has no hard playwright
   dep — both `RealBrowserDriver.page` and `StagehandBrowserDriver.page` (a Playwright `Page`)
   satisfy the interface.
3. **`BrowserDriver` interface unchanged:** `StagehandBrowserDriver` adds `actOn()` as an
   extension method, not part of the core `BrowserDriver` interface, to avoid breaking existing
   callers. S16 coordinator will narrow to `StagehandBrowserDriver` when scheduling semantic actions.
4. **Encryption key scope:** `CREDENTIAL_KEK` read only in `services/browser-worker`. `apps/api`
   encrypt path deferred to S16.
5. **storageState persistence:** JSON blob in object storage.
   Key: `browser-auth/{assessmentId}/{credentialId}.json`. SHA256 in audit event payload.
6. **Recipe loading:** Recipe JSON passed inline in `browser.auth` envelope payload as `recipeJson`
   string. `recipe_id` in `target_credentials` is a human-readable label.
7. **Append-only triggers:** DELETE+TRUNCATE FOR EACH STATEMENT; no UPDATE guard (rows immutable).

---

## Acceptance Criteria

### A-15-Schema
`target_credentials` migration 018 applied + rolled back cleanly. B6 rollback test asserts
3 trigger names + table absence after rollback. `APPEND_ONLY_TABLES` in `schema.ts` and
`APPEND_ONLY` in `schema-shape.test.ts` both include `'target_credentials'`.

### A-15-DriverFacade
`packages/browser-driver` builds and type-checks. `PlaywrightBrowserDriverFacade` satisfies
`BrowserDriverFacade` (compile-time). Unit tests cover `act` (click, fill, navigate),
`observe`, `extract`. Scope-guard: denied URL → `ScopeDenyError` before `page.goto`.

### A-15-RecipeSchema
`LoginRecipeSchema` validates all 3 kinds. Invalid inputs throw `ZodError`. Unit tests in
`packages/browser-auth/src/recipe-schema.test.ts`.

### A-15-Executor
`executeRecipe` walks steps in order. Unit tests: happy path, `LoginFailedError` on missed
successCheck. Duck-typed interfaces — no Playwright import in test file.

### A-15-Crypto
Round-trip: `decryptCredential(encryptCredential(pt, kek), kek) === pt`. Random IV: two calls
produce different `iv`. Auth-tag tamper → `DecryptionError`. `parseKek` rejects wrong-length
hex. Unit tests in `packages/browser-auth/src/crypto.test.ts`.

### A-15-CredentialRepo
`insertTargetCredential` → `getTargetCredential` round-trips. Cross-tenant returns `null`.
Append-only probe: SQLSTATE `23514` asserted explicitly (not just `.rejects.toThrow()`).

### A-15-Integration
`tests/integration/browser-auth/login-flow.test.ts` — 4 cases pass or skip on no-DB.
`grep -c resetAuthState login-flow.test.ts` ≥ 2.

### A-15-FixtureReset
`target_credentials` in `resetAuthState`: DISABLE before DELETE, DELETE before targets (FK),
ENABLE in finally block.

### A-15-BrowserWorkerIntegration
`services/browser-worker/src/real-driver.ts` launches real Playwright Chromium.
`handleBrowserAuth` wires full flow. Existing `FakeBrowserDriver` unit tests pass (no regression).

### A-15-Audit
4 new actions, `AUDIT_ACTIONS.length === 56` asserted in `packages/contracts/src/audit.test.ts`.

### A-15-SecurityInvariants
- AES-256-GCM random 96-bit IV per record.
- KEK never in audit event payloads.
- All browser navigation through scope-engine gate before `page.goto()`.
- `decryptCredential` only in `services/browser-worker`.

### A-15-D: Stagehand integration

**A-15-D-Dep:** `@browserbasehq/stagehand@^3.3.0` present in
`services/browser-worker/package.json`. `bun install` resolves without errors.

**A-15-D-Session:** `services/browser-worker/src/stagehand-session.ts` exports
`StagehandSession` type and session lifecycle helpers. Compiles to 0 tsc errors.

**A-15-D-Driver:** `services/browser-worker/src/stagehand-driver.ts`:
- `StagehandBrowserDriver implements BrowserDriver` (compile-time check).
- `navigate()` calls `scopeCheck` before `page.goto`.
- Unit tests in `stagehand-driver.test.ts`: `launch` stores session, `navigate` calls scopeCheck
  first, scopeCheck rejection prevents goto, `close` destroys session.

**A-15-D-Select:** `services/browser-worker/src/select.ts`:
- `BrowserDriverChoice` includes `'stagehand'`.
- `BROWSER_DRIVER=stagehand` → `StagehandBrowserDriver` instance.
- `select.test.ts` asserts `BROWSER_DRIVER=stagehand` returns `StagehandBrowserDriver`.

**A-15-D-Compat:** `handleBrowserAuth` remains on `RealBrowserDriver` for S15 (duck-typed
`ExecutorPage` compatible with both drivers). `StagehandBrowserDriver.page` is a Playwright
`Page` — it will satisfy `ExecutorPage` interface when wired in S16.

**A-15-D-LintTC:** All new Stagehand files: 0 lint errors, 0 tsc errors.

### A-15-LintTC
`bun run lint` → 0 errors. `bun run typecheck` → 0 errors.

### A-15-Tests
No-DB suite: 0 failures. Full-PG suite: 0 failures OR ≤3 known flakes.

---

## AUDIT_ACTIONS Delta (52 → 56)

```
auth.recipe.executed       — login recipe ran to completion (browser-worker)
auth.credential.encrypted  — credential stored encrypted (S16: apps/api insert route)
auth.credential.decrypted  — credential retrieved and decrypted (browser-worker only)
auth.login.failed          — executeRecipe threw LoginFailedError
```

---

## Pitfalls Catalog v6 Applied

1. JSONB.stringify wrap — any new JSONB array writes in repos use `JSON.stringify(arr)`.
2. Tenant slugs `${base}-${Date.now()}-${random}` in all new IT fixtures.
3. `resetAuthState` DELETE order: `target_credentials` BEFORE `targets` (FK). audit_events FIRST.
4. B6 rollback test: new B6 test for 018; existing 017 test intact.
5. Append-only triggers FOR EACH STATEMENT for DELETE+TRUNCATE on `target_credentials`.
6. Idempotency cache 2xx-only at insert+lookup in any new idempotency paths.
7. `decide()` action includes `method:'GET'` for http_request kind in scope checks.
8. DNS-NOOP stub: N/A for this sprint — scope-engine used only for navigation gate (no DNS).
9. AUDIT_ACTIONS cardinality: `52 → 56` — test assertion updated.
10. Cyrillic-path footgun: `fileURLToPath(import.meta.url)` in new packages.
11. `pg_trigger` (not `information_schema.triggers`) for TRUNCATE trigger assertions.
12. Migration 018 is greenfield — new number.
13. P27: `grep -c resetAuthState` ≥ 2 in every new IT file.
14. R3 discipline: ONE PG test run.
15. Known PG flakes ≤3 budget.
16. (NEW v6+) `exactOptionalPropertyTypes` + optional goto args — conditional spread pattern.
17. (NEW v6+) `noPropertyAccessFromIndexSignature` — destructure `process.env` to avoid conflict with biome `useLiteralKeys`.
18. (NEW v6+) `Decision.allowed` (boolean), not `Decision.outcome !== 'allow'` — scope-engine type.
19. (NEW v6+) `objectStorage.put({key,body,contentType})` — single object arg, not `(key, body)`.
