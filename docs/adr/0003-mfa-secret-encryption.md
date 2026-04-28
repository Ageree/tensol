# ADR 0003 — Auth, RBAC, Tenancy & MFA Secret Encryption

- **Status:** Accepted (Sprint 3, 2026-04-27)
- **Supersedes:** N/A
- **Superseded by:** N/A
- **Tags:** auth, rbac, tenancy, mfa, encryption, slice-limitation

## Context

Sprint 3 introduces the authentication / RBAC / tenancy surface for the
CyberStrike Hybrid product API: bcrypt-hashed passwords, otplib-driven TOTP
MFA, server-side session cookies, single-use password-reset tokens, and a
1274-cell static RBAC matrix. The Sprint 3 contract
(`.harness/cyberstrike-hybrid/sprint-3-contract.md`) locks the exact behaviour
of these primitives. This ADR records the durable decisions so they outlive
the slice and can be referenced by later sprints.

## Decision

### 1. Password storage

`bcrypt` via `Bun.password` (no native build dependency) at
`BCRYPT_COST=12` in production. Per-env defaults: `local=4`, `dev=10`,
`staging=10`, `internal-lab=10`, `production=12`. Boot fails with
`ConfigValidationError` in any non-`local` env if `BCRYPT_COST < 10`
(C13b fail-fast gate).

### 2. Session storage

Server-side, NOT JWT. Cookie value = `userId.plaintext` where `plaintext` is
32 random bytes hex; the server stores `bcrypt(plaintext)` as
`user_sessions.token_hash`. Cookie attributes (C19):

- non-`local`: `__Host-cs_session=...; HttpOnly; Secure; SameSite=Lax; Path=/`
- `local`:    `cs_session=...; HttpOnly; SameSite=Lax; Path=/`

The `__Host-` prefix is browser-enforced (Domain forbidden, Path must be `/`,
Secure required) and gives a free defence against subdomain cookie injection.

### 3. TOTP MFA

`otplib` with `SHA1` / 6 digits / 30s period / ±1 step verification window.
Replay protection is provided by an in-memory LRU keyed by
`(userId, code, windowStart)`; codes consumed inside the same step are
rejected on the second presentation.

### 4. Production MFA secret encryption (R9 — slice limitation)

In production, the `secret_encrypted` column MUST be encrypted with a per-tenant key derived from a KMS-rooted master secret. The Sprint 3 implementation stores base32-plaintext as a deliberate slice limitation; tracked for the security-hardening sprint.

The slice ships with `mfa_secrets.secret_encrypted` storing the base32-plaintext
TOTP seed unencrypted. This is acceptable in `local`, `dev`, and `internal-lab`
where the database is single-tenant or sandboxed. It is NOT acceptable in
`production` or `staging` against real customer data.

The security-hardening sprint (target: Sprint 7 alongside the
shared-store rate-limiter + TOTP-replay-LRU swap) will:

1. Derive a per-tenant data-encryption key (DEK) from the KMS-rooted master.
2. Wrap `secret_encrypted` writes with envelope encryption (AES-256-GCM, IV
   in column, AAD bound to `(tenant_id, user_id)`).
3. Run a one-shot migration that re-keys every existing row.
4. Boot fail-fast in `production` if `MFA_ENCRYPTION_KMS_KEY_ARN` is unset.

### 5. RBAC

Pure-function `assertCan(actor, action, resource) → Decision`. The matrix is
a frozen `Map` of 1274 entries (7 roles × 13 resources × 14 actions),
composed from per-role spec files. `assertCan` does NOT consider tenancy —
that is `tenantGuard` + `assertOwnership`'s job (C12).

### 6. Tenancy middleware

`tenantGuard` runs after `sessionMiddleware`; canonical responses:
- no actor + no expired session → `401 {error: 'unauthenticated'}`
- no actor + expired session    → `401 {error: 'session_expired'}`
- actor present                 → `next()`

`assertOwnership(actorTenantId, resource)` throws structured `RbacDenyError`
on mismatch; route layer catches and returns `403 {error: 'forbidden'}` —
NEVER includes tenant IDs (no enumeration oracle, C18c).

### 7. Two-step login (C22 R2)

`POST /auth/login` → on MFA-enrolled user, returns
`401 {pre_auth_token, expires_in: 60}`. The opaque token lives in an
in-memory LRU (`apps/api/src/pre-auth-tokens.ts`) with single-use
redemption. `POST /auth/login/mfa` redeems the token + verifies TOTP. EVERY
failure path returns the canonical body `{error: 'invalid_credentials'}` —
no oracle distinguishes wrong password from unknown email from expired
pre-auth token.

### 8. Password-reset tokens (C16 R3)

32 bytes from `crypto.randomBytes`, hex-encoded. SHA-256 of plaintext is
PRIMARY KEY of `password_reset_tokens`. Single-use redemption via atomic
`UPDATE ... SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS
NULL AND expires_at > now() RETURNING ...`.

### 9. Bootstrap registration (C21 R4)

Singleton `platform_settings.bootstrap_consumed_at` flag flipped atomically
inside the same transaction that creates the first tenant + platform_admin.
After flip, every subsequent `/auth/register` returns `410 Gone`.

### 10. Audit emission (C29 R5)

Every state-changing auth action emits exactly ONE row to `audit_events`
with canonical `(action, outcome)`. Tests assert
`count(*) FROM audit_events` delta = 1 per request. The
`apps/api/src/routes/shared.ts:ensurePlatformTenantId` helper lazily seeds a
sentinel tenant (slug `__platform__`) used as the FK target for unattributed
audit rows (failed logins for unknown email, pre-auth-token rejections,
register-410-Gone, password-reset miss path).

## Limitations (slice-only — Sprint 7 revisits)

- **TOTP-replay LRU is per-process.** A code accepted on process A could be
  replayed on process B until the step rolls. Sprint 7 swap to Redis or PG.
- **Pre-auth-token LRU is per-process.** Same multi-process gap as above.
- **Rate-limit token bucket is per-process.** C18b's 5-failures-per-60s
  ceiling is enforced per worker. Sprint 7 swap to a shared store.
- **MFA secret encryption is plaintext.** R9 stipulates per-tenant
  KMS-rooted encryption in production; tracked.
- **No real email send.** Password-reset plaintext lands in `audit_events`
  metadata. Production needs an email gateway (deferred).
- **No SSO / OIDC.** Email + password + MFA only.
- **No project-level membership.** All users in a tenant see all assessments
  in slice 3.
- **No session refresh.** Cookie has 1-hour fixed expiry; sliding refresh
  lands in Sprint 5.
- **Single-platform sentinel tenant.** Cross-DB-instance failover would
  produce two `__platform__` rows with different UUIDs; the
  `unique(slug)` constraint prevents this within a single database.

## Consequences

**Pros**

- Auth surface is testable end-to-end against a real Postgres in CI
  (`integration-tests-auth` job).
- The 1274-cell RBAC matrix is exhaustive and statically frozen — no
  implicit defaults can sneak in via code-review oversight.
- Canonical 401 body across every credential failure forecloses the
  user-enumeration oracle and the pre-auth-token-lifetime oracle.
- The audit-events delta=1 invariant gives forensic reconstructability of
  every login / MFA / password-reset attempt.

**Cons / Tech debt**

- Per-process state (TOTP LRU, pre-auth LRU, rate-limit bucket) requires
  a coordinated Sprint 7 sweep before multi-replica deployment.
- Plaintext MFA secrets block production deployment until the encryption
  layer (§4) lands.
- bcrypt session-token-hash means session lookup must scan candidate rows
  for a user — acceptable at slice scale, may need a HMAC-indexable column
  if the active-session count grows past a few hundred per user.

## References

- Sprint 3 contract: `.harness/cyberstrike-hybrid/sprint-3-contract.md`
- Product spec §1.4 (auth scope) + §2 Sprint 3 (RBAC + audit)
- Sprint 1 §11.2 cumulative-test-set rule (carries forward)
- Sprint 2 ADR 0002 (db driver), ADR 0001 (monorepo)
- OWASP ASVS L1: see `docs/security/asvs-l1-mapping.md`
- Auth rotation runbook: `docs/runbooks/auth-rotation.md`
