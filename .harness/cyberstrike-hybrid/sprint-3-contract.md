# Sprint 3 Contract — Auth, RBAC, Tenancy Middleware

> Status: REVISED v2 (awaiting evaluator approval)
> Author: Generator
> Reviewer: Evaluator (R1–R9 + 2 optional tightenings folded in)
> Source: product-spec.md §1.4 / §2 Sprint 3; plan §4.3
> Repo root: `/Users/saveliy/Documents/пентест ИИ`
> Sprint 2 baseline: commits `307e7dc` + `a024d26` (Sprint 2 + evaluator iteration 1 fixes)

## Revision log

- **v2** (current): folded evaluator R1–R9 + 2 optional tightenings.
  - **R1 (C19):** `__Host-cs_session` prefix in non-local; plain `cs_session` in local.
  - **R2 (C22):** two-step pre-auth-token flow — `POST /auth/login` → `POST /auth/login/mfa`. Single canonical `401 invalid_credentials` for every failure, MFA-required path returns opaque `pre_auth_token` with ≤60s TTL.
  - **R3 (C16/C26):** new migration `014_password_reset_tokens.ts`. Redemption is single-use atomic `UPDATE ... SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL` returning row count 0 on second try. Audit alongside.
  - **R4 (C21):** new migration `015_platform_settings.ts`. C21 split into C21a (token length ≥32 bytes), C21b (consume-once via `platform_bootstrap_consumed_at` flag, `410 Gone` thereafter), C21c (local-only fallback).
  - **R5 (C22 + C29):** audit shape canonicalised — single row per attempt with `outcome ∈ {success, failure, mfa_required}`. C29 delta=1 per state-changing action assertion now matches.
  - **R6 (C18):** `assertOwnership` throws structured `RbacDenyError` with `{actorTenantId, attemptedResourceType, attemptedResourceId}`; middleware translates to generic `{error:'forbidden'}` body. New C18c assertion: response body regex-search for any UUID returns 0 matches.
  - **R7 (C26):** bcrypt-equivalent dummy work performed when user not found, flattening response-time side channel.
  - **R8 (C28):** full middleware-shape matrix — no cookie / deleted session / expired session / cross-tenant resource. Each its own assertion.
  - **R9 (ADR 0003):** §Decision locks production-encryption requirement for `mfa_secrets.secret_encrypted`. Slice limitation explicit.
  - **Optional accepted:**
    - C18b rate-limit smoke (5 failed login attempts within 60s from same IP → 429 on 6th).
    - `docs/security/asvs-mapping.md` for OWASP ASVS L1 mapping (foundation for FSTEC/GOST appendix in Sprint 12).
- v1: initial proposal.

## 1. Goal

Hono API in `apps/api` authenticates users, resolves tenant context from the session cookie, and gates every privileged request through the RBAC matrix in `packages/authz`. Every login / logout / MFA / password-reset attempt produces an `audit_events` row. Cross-tenant access is denied (403/empty) at the middleware layer, not just at the repository layer (Sprint 2 already enforces it there as well — defence-in-depth).

No business CRUD, no scope engine, no queue. Just identity + RBAC + tenancy + a fixture endpoint exercising IDOR, plus the wiring surface (Hono server, route layer, middleware, session repository, MFA repository, audit-events writer hook).

## 2. Carry-forwards from Sprint 2 (durable rules)

These are evaluator's forward notes from `sprint-2-fixes-result.md`, encoded so they outlive any one sprint:

- **(C1) `seedX` helper library.** Sprint 2 introduced `seedTenant` / `seedUser`. Sprint 3 adds `seedSession(f, userId, {expiresAt?, ip?, userAgent?})` and `seedMfaSecret(f, userId, {algo?, digits?, period?})`. As later sprints land projects/targets/assessments, each one extends the library; tests never reach across the FK chain manually.
- **(C2) Fail-loud `skipIf(!DATABASE_URL)`.** PG-dependent tests skip cleanly only when `APP_ENV ∈ {local, undefined}`. When `APP_ENV ∈ {dev, staging, production, internal-lab}` and `DATABASE_URL` is missing, the suite **fails loudly** rather than silently skipping. Codified in `tests/integration/db/helpers/db-fixture.ts` `hasDatabaseUrl()` — Sprint 3 extends this to `tests/integration/auth/`. CI never silently skips the security suite.
- **(C3) Cumulative test enumeration.** Sprint 3 §5 verification commands re-run Sprint 1 (62) + Sprint 2 (62 + 34 PG-IT) + Sprint 3 suites. The cumulative-regression rule from Sprint 1 §11.2 carries forward.
- **(C4) `unit-tests` matrix expansion.** `packages/authz` lands real code in this sprint, so the CI matrix grows to `[packages/config, packages/db, packages/authz]` with per-workspace coverage gate (B26-B29 / Sprint 2).
- **(C5) Path-footguns grep extension.** `tests/integration/db/path-footguns.test.ts` already covers `packages/db/`, `tests/integration/db/`, `scripts/`. Sprint 3 extends the grep to `packages/authz/` and `apps/api/`. Same regex (3 footguns), same fileURLToPath rule.

### 2.1. Sprint 1 + 2 commit baseline

CI must run all Sprint 1 + Sprint 2 suites unchanged. Sprint 3 §5 lists the cumulative command set. Reference commits: `c6ce978` (sprint-1) + `1cfe910` (sprint-1 fixes) + `307e7dc` (sprint-2) + `a024d26` (sprint-2 fixes).

---

## 3. Scope (files / dirs to be created or modified)

### 3.1. New code

```
packages/authz/
  package.json                     hono peer dep, bcrypt, otplib, zod
  tsconfig.json                    existing
  src/
    index.ts                       public surface; preserves name = 'packages/authz'
    roles.ts                       Role enum + RoleSchema
    actions.ts                     Action enum (read|create|update|delete|approve|start|...)
    resources.ts                   Resource enum (project|target|assessment|finding|evidence|report|scope_rule|tool_policy|audit_log|skill|tool_catalog|user|tenant)
    matrix.ts                      static immutable RBAC map keyed by (role, resource, action) → Decision
    decision.ts                    Decision = {allowed, reason, matchedRule}
    assert-can.ts                  assertCan(actor, action, resource) — pure function
    actor.ts                       Actor type {type:'user'|'service', id, name, role, tenantId}
    errors.ts                      AuthError, MfaError, RbacDenyError
    bcrypt.ts                      hashPassword/verifyPassword (cost 12, parametrised)
    totp.ts                        wrapper around otplib (verify with step-window enforcement, anti-replay)
    password-reset.ts              token generation + verification (single-use, time-bounded)

apps/api/
  package.json                     hono dep
  tsconfig.json                    existing
  src/
    index.ts                       Hono app factory; preserves name = 'apps/api'
    server.ts                      Bun.serve entry (only used in dev/integration tests)
    middleware/
      session.ts                   parse cookie → load session row → attach actor
      tenant-guard.ts              attaches tenantId; rejects 401 (no session) / 403 (cross-tenant)
      assert-ownership.ts          assertOwnership(tenantId, resource) helper for routes
      rate-limit.ts                lightweight in-memory limiter for auth endpoints (real one in Sprint 7)
      audit.ts                     audit-event hook called by route handlers
    routes/
      auth/
        register.ts                POST /auth/register (platform_admin-bootstrap only in slice)
        login.ts                   POST /auth/login (bcrypt + MFA challenge)
        logout.ts                  POST /auth/logout (invalidate session)
        me.ts                      GET /auth/me (returns {actor, tenantId})
        mfa-enable.ts              POST /auth/mfa/enable (issue TOTP secret, store enrolled_at after verify)
        mfa-verify.ts              POST /auth/mfa/verify
        password-reset-request.ts  POST /auth/password/reset/request (token → audit, no email)
        password-reset-confirm.ts  POST /auth/password/reset/confirm (single-use, audited)
      _test/
        resource.ts                GET /_test/resource/:id — fixture endpoint for IDOR test (Sprint 3 only)
    session-repo.ts                wraps packages/db user_sessions repo with auth-specific helpers
    cookies.ts                     httpOnly secure cookie helpers
    config.ts                      reads SESSION_SECRET, BCRYPT_COST, etc. from packages/config
```

### 3.2. Tests

```
packages/authz/src/
  matrix.test.ts                  RBAC matrix exhaustive tests
  assert-can.test.ts              decision shape + reason strings
  bcrypt.test.ts                  hash/verify round-trip
  totp.test.ts                    TOTP step window + replay rejection
  password-reset.test.ts          token single-use + time-bound

apps/api/src/
  routes/auth/login.test.ts       unit test against in-process Hono client
  routes/auth/me.test.ts          unit test (mocked session repo)
  middleware/tenant-guard.test.ts unit test (mocked session repo)

tests/integration/auth/
  helpers/auth-fixture.ts         seedSession, seedMfaSecret, mintCookie, makeClient
  register.test.ts                bootstrap flow, audit event emitted
  login-logout.test.ts            login → cookie → /auth/me → logout → cookie invalid
  mfa.test.ts                     enable → verify → step-window replay rejection
  password-reset.test.ts          request → confirm; token reuse rejected; audited
  idor.test.ts                    GET /_test/resource/:id from T2 cookie against T1 row → 403
  rbac-matrix.test.ts             every role × resource × action via real fixture endpoint
  audit-emission.test.ts          every auth action persists exactly one audit_events row
```

### 3.3. Schema additions

Two new migrations land in Sprint 3 (R3 + R4):

- **`packages/db/migrations/014_password_reset_tokens.ts`** (R3):
  ```sql
  CREATE TABLE password_reset_tokens (
    token_hash CHAR(64) PRIMARY KEY,                    -- sha256(token), hex
    user_id    UUID NOT NULL REFERENCES users(id),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_password_reset_tokens_user_expires
    ON password_reset_tokens (user_id, expires_at);
  CREATE INDEX idx_password_reset_tokens_tenant
    ON password_reset_tokens (tenant_id);
  ```
  Mutable (NOT append-only) because redemption flips `consumed_at`. Schema-shape test (Sprint 2 B9–B12 pattern) verifies `tenant_id` + `created_at` + tenant index.

- **`packages/db/migrations/015_platform_settings.ts`** (R4):
  ```sql
  CREATE TABLE platform_settings (
    -- Singleton row enforced by partial unique index on a fixed lock value.
    lock CHAR(1) PRIMARY KEY DEFAULT 'x' CHECK (lock = 'x'),
    bootstrap_consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Seed the singleton row in the same migration so the platform_settings
  -- query is always non-null on a fresh DB.
  INSERT INTO platform_settings (lock) VALUES ('x') ON CONFLICT DO NOTHING;
  ```
  Platform-scoped (no `tenant_id`); singleton enforced via the `lock CHECK` pattern. Schema type alias added to `packages/db/src/schema.ts`.

Sprint 2 migrations remain unchanged; `users` / `user_sessions` / `mfa_secrets` are reused as-is.

**Pre-auth tokens (R2 — ephemeral):** the short-lived (≤60s) opaque token used for the two-step login flow lives in an in-memory LRU on the API process, NOT in Postgres. Documented as a slice limitation in ADR 0003 §Limitations alongside the TOTP-replay LRU multi-process gap (same Sprint 7 fix path: replace with Redis or a dedicated table).

### 3.4. CI updates

- `unit-tests` matrix: append `packages/authz` (C4) — three entries `[packages/config, packages/db, packages/authz]` each with `--workspace=` per-workspace coverage gate.
- New `integration-tests-auth` job, identical service-container shape to `integration-tests`. Runs `bun test tests/integration/auth/`.
- Existing `integration-tests` job keeps running `tests/integration/db/` (no overlap).

### 3.5. Documentation

- ADR `docs/adr/0003-auth-rbac-tenancy.md` — locks: bcrypt cost 12 (with C13b boot-time gate in non-local), otplib TOTP (SHA1, 6 digits, 30s, ±1 step window), httpOnly secure cookie + server-side session store (no JWT), 7-role static matrix (no per-project membership in slice), two-step pre-auth-token login flow (R2). **§Decision MUST include the R9 production-encryption requirement for `mfa_secrets.secret_encrypted`:** "In production, the `secret_encrypted` column MUST be encrypted with a per-tenant key derived from a KMS-rooted master secret. The Sprint 3 implementation stores base32-plaintext as a deliberate slice limitation; tracked for the security-hardening sprint." §Limitations enumerates: TOTP-replay LRU per-process, pre-auth-token LRU per-process, in-memory rate-limit per-process — all three replaced in Sprint 7 with shared-store implementations.
- New `docs/security/asvs-mapping.md` (optional, accepted) — per-route mapping to OWASP ASVS L1 controls (V2 Authentication, V3 Sessions). One row per Sprint 3 endpoint listing which ASVS clauses it satisfies. Foundation for FSTEC/GOST appendix in Sprint 12.
- Update README "Auth" section: how to register the bootstrap platform_admin, how to enable MFA locally, how to seed `BOOTSTRAP_TOKEN`.
- Runbook `docs/runbooks/auth-rotation.md` — how to rotate `SESSION_SECRET`, force-logout-all-sessions, MFA-secret regeneration. Optional this sprint; can defer to security-hardening sprint.

### 3.6. Out of scope

- No SSO. Spec §1.4 explicitly defers SSO; only email/password + MFA + sessions.
- No OAuth / OIDC providers.
- No project-level membership (assessments are tenant-wide for Sprint 3).
- No real email sending for password reset; token goes to audit_events. Spec §1.4.
- No browser CAPTCHA / WAF / login-throttling beyond a basic in-memory limiter (production-readiness).
- No rate-limit storage in PG / Redis; in-memory per-process is fine for the slice.

---

## 4. Acceptance Criteria (testable, binary)

Identifiers continue from Sprint 2 (which ended at B30). Sprint 3 acceptance criteria are C1–C30 (numbering reset for the new sprint, no overlap with Sprint 2's B-series).

> Note: C-prefix below refers to acceptance criteria, not the §2 carry-forward references. To avoid confusion, criteria are numbered `C1` through `C30` and the §2 carry-forwards stay `(C1)` through `(C5)` in their parenthesised form.

### 4.1. Hono server + workspace surface

- [ ] **C1:** `apps/api/src/index.ts` exports `name = 'apps/api'` (preserves Sprint 1 A18 invariant) AND a `createApp(options)` factory returning a Hono instance.
- [ ] **C2:** `bun run typecheck` clean across `apps/api` + `packages/authz` (composite refs).
- [ ] **C3:** `apps/api` workspace `package.json` declares `hono` as a runtime dep.
- [ ] **C4:** `packages/authz` workspace `package.json` declares `bcrypt`, `otplib`, `zod` as runtime deps. `@types/bcrypt` as dev.

### 4.2. RBAC matrix

- [ ] **C5:** `packages/authz/src/roles.ts` exports `Role` enum with EXACTLY these 7 values: `platform_admin`, `tenant_admin`, `security_lead`, `operator`, `developer`, `auditor`, `viewer`. Asserted in test.
- [ ] **C6:** `packages/authz/src/actions.ts` exports `Action` enum: `read`, `list`, `create`, `update`, `delete`, `submit`, `approve`, `start`, `pause`, `resume`, `cancel`, `change_status`, `change_scope`, `change_tool_policy`. (Subset that matters for the matrix; later sprints extend.)
- [ ] **C7:** `packages/authz/src/resources.ts` exports `Resource` enum covering: `tenant`, `user`, `project`, `target`, `assessment`, `scope_rule`, `tool_policy`, `finding`, `evidence`, `report`, `audit_log`, `skill`, `tool_catalog`.
- [ ] **C8:** `packages/authz/src/matrix.ts` exports a frozen, exhaustive map `RBAC_MATRIX` of type `ReadonlyMap<RoleResourceActionKey, Decision>` covering EVERY (role × resource × action) combination — no implicit defaults. Test asserts the cardinality (7 × 13 × 14 = 1274 entries) and that each entry is `Object.isFrozen`.
- [ ] **C9:** `assertCan(actor, action, resource) → Decision` is a pure function (no I/O). Decision = `{allowed: boolean, reason: string, matchedRuleKey: string}`. Unit tests assert deterministic output across at least 50 representative (role, action, resource) inputs.
- [ ] **C10:** **Auditor read-only invariant** (testable rule from spec §2 Sprint 3): for every resource, `auditor` has `read` and `list` allowed; every other action is denied. Test enumerates all `(auditor, action, resource)` combinations; only `read|list` may be allowed.
- [ ] **C11:** **Developer scope-policy invariant**: `developer` is denied `change_scope`, `change_tool_policy` for ALL resources. Test enumerates and asserts.
- [ ] **C12:** **Cross-tenant invariant**: `assertCan` does NOT leak any allow decision when the actor's tenant differs from the resource's tenant — that's the middleware's job, but the unit-test matrix asserts `assertCan` is purely role-based and never makes a tenant decision (no `tenantId` field on its inputs). Reasoning: tenant enforcement belongs to `tenantGuard` and `assertOwnership`, not `assertCan`.

### 4.3. Bcrypt + TOTP

- [ ] **C13:** `hashPassword(plain)` returns a bcrypt hash with cost 12 in production / non-`local` env. Configurable via `BCRYPT_COST` env (default 12); test override to 4 for fast tests is allowed. `verifyPassword(plain, hash)` round-trips. Asserted in unit test.
- [ ] **C13b (R-evaluator-Q2 + Sprint 1 fail-fast pattern):** in any non-`local` `APP_ENV`, `BCRYPT_COST < 10` aborts boot with a `ConfigValidationError`. Defaults: `local`=4, `dev`=10, `staging`=10, `production`=12, `internal-lab`=10. Schema validated via `packages/config` zod loader.
- [ ] **C14:** TOTP via `otplib`: SHA1 algorithm, 6 digits, 30-second period, ±1-step verification window. `verifyTotp(secret, code, opts)` returns `boolean`.
- [ ] **C15 (replay protection):** `verifyTotp` rejects a code that has been seen and accepted within the same step window. Implementation: track `(user_id, code, window_start)` in an in-memory LRU keyed by user; on accept, mark consumed. Unit test: same code accepted once, rejected on the second call within the same step. Edge case: clock-step boundary (test uses fake clock).
- [ ] **C16 (R3 rewrite — backed by `password_reset_tokens` table):** Password reset token = 32 bytes from `crypto.randomBytes`, hex-encoded; the SHA-256 hash of the token is stored as `password_reset_tokens.token_hash` (PRIMARY KEY). 15-minute TTL via `expires_at`. Single-use enforced atomically by:
  ```sql
  UPDATE password_reset_tokens
  SET consumed_at = now()
  WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
  RETURNING user_id, tenant_id;
  ```
  Row count 0 → token unknown / expired / already consumed → reject. `verifyResetToken(token)` runs this UPDATE in a transaction and returns `{userId, tenantId}` on success, throws `AuthError` otherwise. Unit + integration tests: reuse rejected; expired rejected; tampered rejected.

### 4.4. Hono server + middleware

- [ ] **C17:** `tenantGuard` middleware:
  - Extracts session cookie → loads `user_sessions` row by `token_hash` (bcrypt-hashed cookie value, not the plain value).
  - On miss: 401 `{ error: 'unauthenticated' }`.
  - On hit: sets `c.set('actor', actorFromUser)` and `c.set('tenantId', user.tenant_id)`.
  - On expired session: 401 `{ error: 'session_expired' }`. Sliding TTL not yet — explicit refresh in Sprint 5.
- [ ] **C18 (R6 rewrite):** `assertOwnership(tenantId, resource)`:
  - Returns void on match.
  - Throws structured `RbacDenyError` carrying `{actorTenantId, attemptedResourceType, attemptedResourceId}` for audit reconstruction.
  - Middleware catches and emits a generic `403 {error: 'forbidden'}` body — NEVER includes tenant IDs in the response (no enumeration oracle).
  - Designed to be called by every CRUD route in later sprints.
- [ ] **C18b (optional, accepted — rate-limit smoke):** Failed login attempts from the same source IP are rate-limited via an in-memory token bucket. After 5 failures within 60 seconds, the 6th attempt returns `429 {error: 'too_many_requests', retry_after_seconds: <n>}`. In-memory implementation is documented in ADR 0003 §Limitations as a slice-only mechanism (Sprint 7 revisits with shared store). Test asserts the 6th attempt response code and shape.
- [ ] **C18c (R6 — UUID leak guard):** Integration test against the cross-tenant 403 path searches the response body bytes for any UUID via regex `/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i`. Match count MUST be 0. The audit-events row for the same request, by contrast, MUST contain BOTH the actor's tenant ID and the attempted resource's tenant ID (asserted by querying `audit_events` after the request).
- [ ] **C19 (R1 — `__Host-` prefix):** Cookie hardening:
  - In `APP_ENV ∈ {dev, staging, production, internal-lab}`: cookie name is `__Host-cs_session`; `Set-Cookie` includes `HttpOnly; Secure; SameSite=Lax; Path=/`. The `__Host-` prefix is browser-enforced (Domain attribute forbidden, Path must be `/`, Secure required).
  - In `APP_ENV=local`: cookie name is `cs_session` (plain); `Set-Cookie` drops `Secure` (allows HTTP testing) and drops the `__Host-` prefix (browser would reject without `Secure`).
  - Test asserts the right name + flags per env.
- [ ] **C20:** Cookie value is opaque random (32 bytes hex); the **bcrypt hash** of the cookie is what's stored in `user_sessions.token_hash`. Test: server has no plaintext token after login.

### 4.5. Auth routes

- [ ] **C21a (R4 — token strength):** `BOOTSTRAP_TOKEN` env MUST be ≥32 bytes (≥64 hex chars) in any non-`local` env. Validated at boot via `packages/config` zod schema; missing/short token aborts boot. In `local`, missing token is allowed (insecure default; documented in README + ADR 0003).
- [ ] **C21b (R4 — consume-once invariant):** `POST /auth/register` is gated by:
  ```sql
  SELECT bootstrap_consumed_at FROM platform_settings WHERE lock = 'x';
  ```
  - If `bootstrap_consumed_at IS NULL` AND token matches: create the platform_admin + tenant atomically, then `UPDATE platform_settings SET bootstrap_consumed_at = now() WHERE lock = 'x' AND bootstrap_consumed_at IS NULL`. Row count 0 → race lost → 410 Gone.
  - If `bootstrap_consumed_at IS NOT NULL`: return `410 Gone {error: 'bootstrap_already_consumed'}`. No further bootstrap registration is possible regardless of token.
  Audited (`action='auth.register'`, `outcome='success'|'failure'|'gone'`).
- [ ] **C21c (R4 — local-only fallback):** in `APP_ENV=local`, missing `BOOTSTRAP_TOKEN` is allowed; the route accepts any value (so dev iteration works without env friction). README + ADR 0003 document this is for local only.
- [ ] **C22 (R2 — two-step pre-auth-token flow + R5 — single-row audit shape):** Login is a two-step protocol:
  - **Step 1: `POST /auth/login` with `{email, password}`.** Server runs bcrypt verify + (if user not found) dummy-bcrypt work to flatten timing. Outcomes:
    - Valid credentials AND MFA enrolled: server mints an opaque 32-byte hex `pre_auth_token`, stores it in the in-memory pre-auth LRU keyed by token with `{user_id, expires_at: now() + 60s, consumed_at: null}`. Response: **`401 {pre_auth_token, expires_in: 60}`**. (401 not 200 — caller must complete step 2 before treating the session as authenticated.)
    - Valid credentials AND no MFA enrolled: issue session cookie, **`200 {actor}`**.
    - Invalid credentials (no such email OR bad password): **`401 {error: 'invalid_credentials'}`**.
    - Rate-limited (C18b): **`429 {error: 'too_many_requests', retry_after_seconds}`**.
  - **Step 2: `POST /auth/login/mfa` with `{pre_auth_token, mfa_code}`.** Server looks up the LRU entry, verifies token not expired and not consumed, calls `verifyTotp`, marks consumed. Outcomes:
    - Valid token + valid TOTP: issue session cookie, **`200 {actor}`**.
    - Anything else (token missing/expired/consumed/wrong, code wrong, replay): **`401 {error: 'invalid_credentials'}`**. SAME canonical shape as step-1 failure — no oracle.
  - The pre-auth token NEVER carries user identity in the body; the server resolves the mapping internally.
  - **Audit shape (R5 — single row per attempt with `outcome` field):** every login attempt produces exactly ONE audit row:
    - `action='auth.login.password'` with `outcome ∈ {success, failure, mfa_required}` for step 1.
    - `action='auth.login.mfa'` with `outcome ∈ {success, failure}` for step 2.
  - Replays of the SAME `pre_auth_token` are rejected; the LRU `consumed_at` field guarantees single-use.
- [ ] **C23:** `POST /auth/logout` invalidates the session row (deletes it — not append-only) and clears the cookie. Audited.
- [ ] **C24:** `GET /auth/me` returns `{actor: {id, email, role, tenantId}, tenant: {id, slug}}`. 401 if no session.
- [ ] **C25:** `POST /auth/mfa/enable` issues a new TOTP secret bound to the authenticated user; stores in `mfa_secrets` with `enrolled_at = NULL`. `POST /auth/mfa/verify` accepts the first valid code and sets `enrolled_at = now()`. Audited (both).
- [ ] **C26 (R3 rewrite + R7 — timing-safe + table-backed):** `POST /auth/password/reset/request` accepts `{email}`. Server flow:
  - Look up user by email.
  - On hit: generate 32-byte hex token, INSERT into `password_reset_tokens` with `expires_at = now() + 15 min`, audit row (`action='auth.password.reset.request'`, `outcome='issued'`, no token in audit body).
  - On miss: perform a bcrypt-equivalent dummy hash to keep response time within ±50ms of the hit path. No DB write, but DO emit an audit row (`outcome='miss'`, `email` field carries the requested email — append-only audit can record the attempt for incident triage).
  - **Always respond 202 with empty body** — no user enumeration.

  `POST /auth/password/reset/confirm` accepts `{token, new_password}`:
  - Verifies single-use atomic UPDATE (C16 SQL).
  - On success: `bcrypt(new_password)` → update `users.password_hash`, INVALIDATE all of the user's `user_sessions` rows (force re-login), audit (`action='auth.password.reset.confirm'`, `outcome='success'`).
  - On failure: 401 `{error: 'invalid_credentials'}` canonical shape; audit (`outcome='failure'`).

  Test: latency variance between hit and miss paths is < 50ms (measured over 100 iterations, p95 delta < 50ms). Test: token reuse rejected. Test: token tampering rejected.

### 4.6. Tenant isolation / IDOR

- [ ] **C27:** `GET /_test/resource/:id` is a Sprint-3-only fixture endpoint that:
  - Loads a project from `packages/db`.
  - Calls `assertOwnership(tenantId from session, project.tenant_id)`.
  - Returns 200 + project on match, 403 on mismatch.
  IDOR test: T2 cookie + T1 project ID → 403; same T1 cookie → 200. Both assertions in the same test file.
- [ ] **C28 (R8 — full middleware-shape matrix):** `tests/integration/auth/idor.test.ts` exercises EVERY auth-middleware outcome on `GET /_test/resource/:id`:
  - **C28a (no cookie):** request has no `Cookie` header → `401 {error: 'unauthenticated'}`.
  - **C28b (cookie pointing at deleted session):** seed session, delete it, request with stale cookie → `401 {error: 'unauthenticated'}`.
  - **C28c (cookie pointing at expired session):** seed session with `expires_at = now() - 1 second`, request → `401 {error: 'session_expired'}`.
  - **C28d (cross-tenant resource):** valid T2 cookie + T1 project ID → `403 {error: 'forbidden'}`. Combined with C18c assertion that the body contains no UUIDs.
  - **C28e (positive control):** valid T1 cookie + T1 project ID → `200 + project body`.
  Each scenario its own `test()` block; all five MUST pass for the suite to be green.

### 4.7. Audit emission

- [ ] **C29 (R5 rewrite — single-row-per-attempt):** Every auth state change emits EXACTLY ONE `audit_events` row, with the canonical action / outcome shape:
  - `auth.register` → `outcome ∈ {success, failure, gone}`
  - `auth.login.password` → `outcome ∈ {success, failure, mfa_required}`
  - `auth.login.mfa` → `outcome ∈ {success, failure}`
  - `auth.logout` → `outcome ∈ {success, no_session}`
  - `auth.mfa.enable` → `outcome ∈ {issued}`
  - `auth.mfa.verify` → `outcome ∈ {success, failure, replay}`
  - `auth.password.reset.request` → `outcome ∈ {issued, miss}`
  - `auth.password.reset.confirm` → `outcome ∈ {success, failure}`

  Test pattern: `count(*) FROM audit_events` before request, perform request, `count(*)` after. Delta MUST equal 1 for every state-changing endpoint. Outcome value asserted via `SELECT after_state->>'outcome' FROM audit_events ORDER BY occurred_at DESC LIMIT 1`.

### 4.8. Cumulative regression + carry-forwards

- [ ] **C30:** Sprint 1 + Sprint 2 cumulative test set passes without regression. `bun test` from root reports zero failures, all prior baseline counts (62 + ~96 — exact numbers in `sprint-2-fixes-result.md`) preserved as a floor (per Sprint 1 §11.2 N3 rule). C5/C4 path-footguns grep extension covers `packages/authz/`, `apps/api/`. C2 fail-loud `skipIf` extends to `tests/integration/auth/`.

---

## 5. Verification commands (cumulative — Sprint 1 + 2 + 3)

The evaluator runs, in order. Per §11.2: Sprint 1 commands, Sprint 2 commands, then Sprint 3 new.

### 5.1. Sprint 1 baseline (unchanged)

```bash
bun run bun:assert-version
bun run lint
bun run typecheck
bun test --coverage
bun run coverage:gate
bun scripts/coverage-gate.ts --threshold=1.00      # MUST exit 1 (Sprint 1 A11)
bun scripts/coverage-gate.ts --threshold=0.80 --workspace=packages/config   # exit 0
diff <(docker compose -f infra/docker/docker-compose.local.yml config --services | sort) \
     <(printf 'cs-minio\ncs-postgres\ncs-queue-emulator\n')
git diff --exit-code -- bun.lock
```

### 5.2. Sprint 2 cumulative (unchanged)

```bash
docker compose -f infra/docker/docker-compose.local.yml up -d cs-postgres
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun run db:migrate:check
bun test --coverage packages/db
bun scripts/coverage-gate.ts --threshold=0.80 --workspace=packages/db
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/db
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test
```

### 5.3. Sprint 3 new

```bash
# Per-workspace gate for new authz package.
bun test --coverage packages/authz
bun scripts/coverage-gate.ts --threshold=0.80 --workspace=packages/authz

# apps/api unit tests.
bun test --coverage apps/api

# Auth integration suite.
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/auth

# Path-footguns extended to authz + apps/api.
! grep -RIn -E "(import\.meta\.url\)?\.pathname|path\.dirname\(import\.meta\.url|^.*\b__dirname\b)" \
  packages/db/ packages/authz/ apps/api/ tests/integration/db/ tests/integration/auth/ scripts/ \
  --include="*.ts" --exclude-dir=node_modules --exclude-dir=dist

# Fail-loud probe: APP_ENV=staging without DATABASE_URL must FAIL the integration suite.
APP_ENV=staging bun test tests/integration/auth   # exit non-zero
```

---

## 6. Edge cases covered

- **Session cookie tampering** — bcrypt-hashed token-hash means a bit-flip in the cookie produces an unrecognised hash → 401, not silent acceptance.
- **MFA TOTP replay within the same step window** — anti-replay LRU rejects (C15).
- **Password reset token reuse** — single-use, single-acceptance; second attempt 401 + audit (C16).
- **Login enumeration timing** — bcrypt verify is constant-time; failed-login response time is dominated by bcrypt, not by user-existence check.
- **MFA bypass attempt: step-1 only** — step 1 returns 401 with opaque `pre_auth_token` but no session; step 2 (`POST /auth/login/mfa`) is required to authenticate (C22).
- **Logout idempotency** — second logout call with the same cookie is a no-op (200 with `{ok: true}`), but does not delete a session that doesn't exist.
- **Cross-tenant fixture endpoint** — IDOR test confirms (C27, C28).
- **Auditor mutation attempt** — RBAC matrix denies all non-read/list actions for `auditor` role (C10).
- **Developer scope-edit attempt** — denied (C11).
- **Bootstrap re-registration** — `410 Gone` after `bootstrap_consumed_at` is set (consume-once invariant, C21b).

---

## 7. TDD plan

1. **RED — `packages/authz` units.** Write `roles.test.ts`, `matrix.test.ts`, `assert-can.test.ts`, `bcrypt.test.ts`, `totp.test.ts`, `password-reset.test.ts`. They reference symbols that don't exist yet → compile fails → all tests fail.
2. **GREEN — authz units.** Implement `roles.ts`, `actions.ts`, `resources.ts`, `matrix.ts`, `decision.ts`, `assert-can.ts`, `bcrypt.ts`, `totp.ts`, `password-reset.ts`, `errors.ts`. Unit tests pass without DB or Hono.
3. **RED — middleware.** `middleware/tenant-guard.test.ts`, `middleware/assert-ownership.test.ts` against mocked session repo + db.
4. **GREEN — middleware + Hono factory.** Implement middleware, `createApp(options)`, `apps/api/src/index.ts`, route stubs that return 501.
5. **GREEN — auth routes.** Implement each route. Unit tests against in-process Hono client.
6. **GREEN — integration.** Author `tests/integration/auth/helpers/auth-fixture.ts` (`seedSession`, `seedMfaSecret`, `mintCookie`, `makeClient`). Then 7 PG-IT files (skipIf-gated, fail-loud in non-local APP_ENV).
7. **REFACTOR.** Files <400 lines, extract `auth-fixture.ts` helpers, write ADR 0003 + README "Auth" section.

## 8. File-size budget

- `packages/authz/src/matrix.ts` is the only file at risk. 7 × 13 × 14 = 1274 entries → ~1300 lines if expressed as a flat object literal. Split strategy: one file per role (`matrix-platform-admin.ts`, `matrix-tenant-admin.ts`, … 7 files × ~180 lines each), composed in `matrix.ts` (~80 lines). Alternative: one helper that takes a `(role, resource) → Set<Action>` shorthand and expands. Decision: per-role files, composed in `matrix.ts`. Documented in ADR 0003.
- All other files target 200–400 lines, hard cap 800.

## 9. Non-deliverables (explicit deferrals)

- **No real email send.** Password reset tokens land in `audit_events`; SMTP/Yandex email integration deferred to production-readiness.
- **No SSO / OIDC.** Email + password + MFA only.
- **No project-level membership.** All users in a tenant see all assessments at this stage; finer-grained access in Sprint 5+ if needed.
- **No rate-limit persistence.** In-memory limiter only; Redis-backed limiter deferred.
- **No CAPTCHA / WAF.** Trust the network boundary in this slice.
- **MFA recovery codes** — deferred (operator manual workflow for now).
- **No session refresh.** Cookie has 1-hour fixed expiry. Sliding refresh land in Sprint 5 once the API surface is wider.
- **gitleaks/trufflehog** — still deferred per Sprint 1 §9 R3.

## 10. Risks / open questions (RESOLVED in v2)

All previously-open questions are now resolved per evaluator's review:

1. **MFA secret encryption — APPROVED with R9 stipulation.** Base32 plaintext for the slice; ADR 0003 §Decision (R9) explicitly requires production-encryption with per-tenant key derived from KMS-rooted master secret.
2. **Bcrypt cost — APPROVED with C13b fail-fast gate.** `BCRYPT_COST` env: production=12, dev/staging/internal-lab=10, local/test=4. Boot aborts on `BCRYPT_COST < 10` in non-local.
3. **TOTP anti-replay LRU — APPROVED.** ADR §Limitations names the multi-process gap; Sprint 7 revisits with shared store. Same path applies to the new pre-auth-token LRU (R2) and the rate-limit token bucket (C18b).
4. **`assertCan` shape — APPROVED.** `Map<string, Decision>` with `${role}:${resource}:${action}` composite key, frozen at module load. Sprint 4 adds the `denyAudit` hook.
5. **Hono testing strategy — APPROVED.** `app.request()` for units; `Bun.serve` + `fetch` for integration.
6. **Matrix per-role split — APPROVED.** 7 per-role files (~180 lines each), composed by `matrix.ts`.
7. **Session storage — APPROVED bcrypt(token).** Symmetric with password storage; one less secret-rotation surface than HMAC.

---

## 11. Commit hygiene + regression guard

### 11.1. Commit hygiene (unchanged from Sprint 1 §11.1)

Conventional commits only. No `Co-Authored-By:`, no attribution. Lead handles git.

### 11.2. Regression guard

Per Sprint 1 §11.2 + Sprint 2 §11.2: cumulative test-set rule applies. Sprint 3 PASS requires:

- All Sprint 1 unit/integration tests pass without regression (zero failures).
- All Sprint 2 unit/integration tests pass without regression (62 + 34 PG-IT, see `sprint-2-fixes-result.md`).
- All Sprint 3 unit + integration tests pass.
- Per-workspace coverage gate green for `packages/config`, `packages/db`, `packages/authz`, `apps/api`.
- `git diff --exit-code -- bun.lock` after `bun install --frozen-lockfile`.
- Path-footguns grep extended to `packages/authz/`, `apps/api/` returns no hits.

---

End of contract proposal v1. Awaiting evaluator approval or revision requests.
