# OWASP ASVS L1 — CyberStrike Hybrid Auth Mapping

> Sprint 3 contract §3.5 — foundation for the FSTEC/GOST appendix in Sprint 12.

This document maps each Sprint 3 auth endpoint to the OWASP ASVS Level 1
controls it satisfies. ASVS chapter references are to v4.0.3 (the version
the contract was authored against).

## Coverage summary

| Endpoint                              | V2 (Auth) | V3 (Sessions) | V4 (Access)
|---------------------------------------|-----------|---------------|-------------
| `POST /auth/register`                 | 2.1.x     | 3.2.x         | 4.1, 4.3
| `POST /auth/login`                    | 2.1, 2.2.1, 2.2.7 | 3.2, 3.4 | 4.1
| `POST /auth/login/mfa`                | 2.7.x, 2.8.x      | 3.2, 3.4 | 4.1
| `POST /auth/logout`                   |           | 3.3.1, 3.3.2  |
| `GET  /auth/me`                       |           | 3.2.x         | 4.1
| `POST /auth/mfa/enable`               | 2.7.x     |               | 4.1
| `POST /auth/mfa/verify`               | 2.7.x, 2.8.x |            | 4.1
| `POST /auth/password/reset/request`   | 2.5.x     |               |
| `POST /auth/password/reset/confirm`   | 2.5.x     | 3.3.4         |

## V2 — Authentication

| Clause | Requirement (paraphrased)                                          | Where satisfied |
|--------|--------------------------------------------------------------------|-----------------|
| 2.1.1  | Passwords ≥12 chars                                                | `register.ts` zod `password.min(12)`; reset-confirm route uses same schema. |
| 2.1.2  | No truncation of long passwords                                    | bcrypt accepts up to 72 bytes; route schema caps at 256 chars; documented in ADR §1. |
| 2.1.7  | Compromised-password check                                         | DEFERRED to Sprint 7 (HIBP integration). |
| 2.2.1  | Anti-automation: rate-limit failed attempts                        | C18b in-memory token bucket; `apps/api/src/middleware/rate-limit.ts`. |
| 2.2.7  | Generic auth-failure messages (no oracle)                          | C22 canonical 401 `{error: 'invalid_credentials'}` body. |
| 2.5.1  | Password reset uses out-of-band channel                            | Plaintext token currently lands in `audit_events` (slice limitation; production needs SMTP gateway). |
| 2.5.2  | Reset tokens single-use, time-bound                                | C16 atomic `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING ...`. |
| 2.5.3  | Reset tokens ≥20 random chars                                      | 32 bytes hex (64 chars). |
| 2.5.4  | Reset tokens stored hashed                                         | sha256(token) is the PK; plaintext never reaches DB. |
| 2.5.6  | Reset notification                                                 | DEFERRED (no email gateway). |
| 2.7.1  | TOTP (RFC 6238) supported                                          | `otplib` SHA1 / 6 / 30s. |
| 2.7.2  | TOTP shared secret protected                                       | R9 slice limitation: plaintext today; KMS-encrypted in Sprint 7. |
| 2.7.6  | TOTP replay protection                                             | C15 LRU keyed by `(userId, code, windowStart)`. |
| 2.8.1  | Backup codes available                                             | DEFERRED (operator-manual recovery flow this slice). |

## V3 — Session management

| Clause | Requirement (paraphrased)                                          | Where satisfied |
|--------|--------------------------------------------------------------------|-----------------|
| 3.2.1  | Session tokens use unbiased entropy                                | 32 random bytes from `crypto.randomBytes`. |
| 3.2.2  | Sessions invalidated on logout                                     | C23 `invalidateById` on session row. |
| 3.2.3  | Sessions invalidated on password change                            | C26 `invalidateAllForUser` after reset-confirm success. |
| 3.3.1  | Session timeout                                                    | 1-hour fixed expiry; sliding refresh deferred to Sprint 5. |
| 3.3.2  | Session terminated on logout (server-side)                         | C23 hard-delete from `user_sessions`. |
| 3.3.4  | Session bound to MFA assurance level                               | C22 two-step ensures pre-auth token cannot be substituted for a session cookie. |
| 3.4.1  | Cookies marked Secure                                              | C19 `Secure` flag in non-`local`. |
| 3.4.2  | Cookies marked HttpOnly                                            | C19 `HttpOnly`. |
| 3.4.3  | Cookies marked SameSite                                            | C19 `SameSite=Lax`. |
| 3.4.4  | Cookies use `__Host-` prefix                                       | C19 in non-`local`. |

## V4 — Access control

| Clause | Requirement (paraphrased)                                          | Where satisfied |
|--------|--------------------------------------------------------------------|-----------------|
| 4.1.1  | Trusted enforcement on the server side                             | `tenantGuard` + `assertOwnership` + `assertCan` chain — never client-side. |
| 4.1.2  | RBAC matrix is enumerable                                          | `RBAC_MATRIX` is a frozen `Map<string, Decision>` of 1274 entries. |
| 4.1.3  | Principle of least privilege                                       | C10 auditor read-only invariant; C11 developer scope/tool-policy denial. |
| 4.1.5  | Access-control failures fail closed                                | `assertCan` defence-in-depth deny on matrix-miss; matrix size asserted at unit-test level. |
| 4.3.1  | Multi-tenancy enforced at every boundary                           | C28 middleware-shape matrix + Sprint 2 cross-tenant repo guards. |
| 4.3.2  | No cross-tenant ID leakage                                         | C18c body-side regex assertion; structured `RbacDenyError` carries IDs only for audit. |

## Out of scope (this slice, deferred per ADR 0003 §Limitations)

- V2.7.5 (push-based MFA), V2.8.2 (SMS MFA): not implemented. TOTP only.
- V2.10.x SSO / OIDC / SAML: deferred (spec §1.4 explicitly excludes SSO).
- V3.5.x token-binding: not applicable (server-side sessions only).
- V14.5 anti-CSRF tokens: cookies use `SameSite=Lax`; explicit anti-CSRF
  middleware lands in Sprint 11 alongside the SPA.

## How this is verified

- Unit tests in `packages/authz/src/*.test.ts` cover the matrix shape and
  decision invariants.
- Integration tests in `tests/integration/auth/` exercise every endpoint
  against a live Postgres (job `integration-tests-auth` in CI).
- `audit-emission.test.ts` asserts the C29 delta=1 invariant per action.
- `idor-matrix.test.ts` covers C28a-e in the middleware shape matrix.
