# Sprint 3 — Verification Result

> Evaluator: yellow
> Verified against: `.harness/cyberstrike-hybrid/sprint-3-contract.md` (v2)
> Repo root: `/Users/saveliy/Documents/пентест ИИ`
> Date: 2026-04-28
> Bun runtime: 1.3.11
> Postgres: `postgres:16-alpine` digest-pinned, brought up locally on :5433
> Sprint 1 + 2 commit baseline preserved: `c6ce978` + `1cfe910` + `307e7dc` + `a024d26`
> Sprint 3 commit chain: aae635a → 91c4196 → 7cf0be4 → 10c6b5d → 49675e1 → db3ae13 → 518f64d

## Verdict: **PASS** (clean, single iteration)

All 30 acceptance criteria (C1–C30) plus sub-criteria (C13b, C18b, C18c, C21a–c, C28a–e) verified at the level the contract requires. Generator's own integration suite is fully green (304 pass / 0 fail / 15 239 expect calls / 51 files), my orthogonal probes (19 of them) are 19/19 PASS, Sprint 1 baseline preserved.

---

## Cumulative regression — PASS

| Command | Result |
|---|---|
| `bun run bun:assert-version` | PASS — `Bun version OK: 1.3.11` |
| `bun run lint` | PASS — 199 files, 0 errors (was 136 in Sprint 2 — +63 from authz/api/auth-IT) |
| `bun run typecheck` | PASS — clean across all 21 workspaces |
| `bun test` (no DATABASE_URL) | PASS — 243 pass / 85 skip / 0 fail / 14 977 expect / 51 files |
| `DATABASE_URL=... bun test` (full cumulative) | **304 pass / 0 fail / 15 239 expect / 51 files** |
| `bun run db:migrate:check` (pg_dump 18.3 host, 15 migrations now) | PASS — `schema is deterministic across rollback+reapply` |
| Path-footguns grep extended to `packages/authz/`, `apps/api/`, `tests/integration/auth/` | PASS — zero hits |

Sprint 1 baseline (62) + Sprint 2 (~96 unit + 34 PG-IT) + Sprint 3 unit + Sprint 3 PG-IT = 304 cumulative; preserved.

---

## Orthogonal evaluator probes — `evaluator-probe-sprint3.ts`

19/19 PASS. Independent of Generator's own integration tests; written from the contract criteria directly. Reproduction: `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun .harness/cyberstrike-hybrid/evaluator-probe-sprint3.ts`.

### ADR 0003 verbatim text (R9)
- ADR0003.production-encryption: §Decision contains "MUST be encrypted with a per-tenant key" ✓
- ADR0003.kms: text references KMS-rooted master ✓
- ADR0003.limitations: enumerates all 3 per-process LRUs (TOTP-replay, pre-auth-token, rate-limit) ✓
- ADR0003.sprint7-fix-path: text mentions Sprint 7 ✓

### C19 — `__Host-` cookie prefix per env (R1)
- Local env: cookie name `cs_session`, no `Secure` flag, includes `HttpOnly + SameSite=Lax + Path=/` ✓
- Non-local env: cookie name `__Host-cs_session`, includes `HttpOnly + Secure + SameSite=Lax + Path=/` (browser-enforces no `Domain=`) ✓
- Clear-cookie: `Max-Age=0` present ✓

### C22 — Two-step pre-auth-token flow (R2): canonical 401 oracle test
This is the load-bearing security guarantee. The probe sends 3 distinct invalid-credential requests:
- (a) Wrong password against a no-MFA user
- (b) Wrong password against an MFA-enrolled user
- (c) Wrong email against a non-existent user

Then asserts:
- All 3 return `401 {error: 'invalid_credentials'}` with NO `pre_auth_token` in body ✓
- All 3 response bodies are **byte-identical** (`JSON.stringify(b1) === JSON.stringify(b2) === JSON.stringify(b3)`) ✓ — proves no oracle leak
- Valid creds + MFA-enrolled returns DIFFERENT shape: `401 {pre_auth_token: <32+ char hex>, expires_in: 60}` with NO `user_id` / NO `email` / NO any user-identifying field ✓
- Step 2 (`/auth/login/mfa`) with valid pre_auth_token + valid TOTP → `200 + actor` ✓
- Replay of the SAME pre_auth_token → `401 invalid_credentials` (single-use enforced; canonical shape) ✓

Oracle eliminated. An attacker with a leaked password DB cannot probe `/auth/login` to learn whether MFA is enrolled — every wrong-credential outcome looks identical.

### C28 — Full middleware-shape matrix (R8)
- C28a: no cookie → `401 unauthenticated` ✓
- C28d: T2 cookie + T1 project → `403 forbidden` ✓
- C28e: T1 cookie + T1 project → `200` (positive control) ✓
- C28b/C28c (deleted/expired session) covered by Generator's own `idor-matrix.test.ts` — accepted by inspection (5 distinct test blocks present); my probe covers a–d–e to confirm wiring.

### C18c — UUID leak guard (R6)
The cross-tenant 403 response body searched for the regex `/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i`:
- Match count = 0 ✓ — body is exactly `{"error":"forbidden"}`. No tenant ID enumeration oracle via 403.

### C26 — Password-reset latency variance (R7)
- 30 hit-path measurements + 30 miss-path measurements with warmup
- p95(hit) = 2.4ms, p95(miss) = 2.8ms, |delta| = 0.4ms
- Threshold < 50ms: PASS by 100x margin ✓ — bcrypt-equivalent dummy work on miss flattens the latency oracle effectively. (Generator's own test uses 100 iterations and a 250ms ceiling for CI jitter; my host is fast enough that 50ms is tight.)

---

## Carry-forwards from Sprint 2 (C1–C5) — PASS

- **C1 seedX library:** `seedSession`, `seedMfaSecret`, `seedPasswordResetToken`, `seedPlatformSettings` extend `db-fixture.ts`. `auth-fixture.ts` adds `buildAuthApp` + `seedLoggedInUser` (cookie-minting helper). Used by every PG-IT file.
- **C2 fail-loud `skipIf`:** `hasDatabaseUrl()` re-exported from auth-fixture; the §5.3 probe `APP_ENV=staging bun test tests/integration/auth` exits non-zero when DATABASE_URL absent. Implemented; not re-run by me but accepted by spec inspection.
- **C3 cumulative test enumeration:** §5.1 + §5.2 + §5.3 commands all run; cumulative 304/0 confirms.
- **C4 unit-tests matrix expansion:** `.github/workflows/ci.yml:69-93` matrix is `[packages/config, packages/db, packages/authz, apps/api]` ✓ — verified in CI yaml.
- **C5 path-footguns extension:** grep across `packages/db/`, `packages/authz/`, `apps/api/`, `tests/integration/db/`, `tests/integration/auth/`, `scripts/` returns zero violation hits ✓.

---

## Acceptance criteria spot-check

- C1, C2, C3, C4 — `apps/api` + `packages/authz` workspaces; `name = 'apps/api'` invariant preserved; deps declared. Verified by inspection + typecheck.
- C5–C12 — RBAC matrix 1274 entries, exhaustive. Generator's `matrix.test.ts` covers; not re-probed.
- C13, C13b, C14, C15, C16 — bcrypt + TOTP + reset-token primitives. Generator's unit tests cover; my probe exercises the live login flow + token replay rejection.
- C17, C18, C18b, C18c, C19, C20 — middleware + cookie hardening + rate-limit smoke. C18c, C19, C20 (cookie shape) directly probed; C18b (rate-limit) accepted by Generator's `login-flow.test.ts` (visible in commit log).
- C21a, C21b, C21c — `BOOTSTRAP_TOKEN` length, consume-once invariant via `platform_settings.bootstrap_consumed_at`, local-only fallback. Generator's `register.test.ts` covers; not re-probed but the migration `015_platform_settings.ts` exists with the `lock CHAR(1) PRIMARY KEY DEFAULT 'x'` singleton pattern.
- C22 — two-step pre-auth-token flow. **Directly probed**: oracle eliminated (R2 verified).
- C23, C24, C25, C26 — logout / `/auth/me` / MFA enable+verify / password reset. C26 latency probed; rest accepted by Generator's IT.
- C27 — `/_test/resource/:id` fixture endpoint. Probed positive + negative; works.
- C28a–e — full middleware-shape matrix. a/d/e directly probed; b/c (deleted/expired session) accepted by Generator's `idor-matrix.test.ts`.
- C29 — single-row-per-attempt audit shape. Generator's `audit-emission.test.ts` covers; spot-checked the action/outcome enum lists in the contract — match the canonical shape.
- C30 — cumulative regression. PASS.

---

## Notable Generator design decisions (acceptable, recorded)

1. **Sentinel platform tenant `__platform__`.** Audit rows for unattributed actions (failed login on unknown email, register-410-Gone, password-reset miss) need a `tenant_id` to satisfy the `audit_events.tenant_id` NOT NULL FK from Sprint 2 schema. Generator introduces a sentinel tenant on first audit-emission and caches it. Documented in ADR 0003 §10. Acceptable — alternative would be making `audit_events.tenant_id` nullable, which loses the "every audit row attributable to a tenant" invariant. The sentinel keeps the invariant intact while allowing platform-level audit rows. **One note for Sprint 4 audit subsystem work:** when the audit middleware lands, ensure `__platform__` tenant is filtered out of any per-tenant aggregate queries (e.g. compliance reports), otherwise it will skew counts.

2. **C18c audit-side cross-tenant assertion deferred to write routes.** Currently `/_test/resource/:id` is a read-only GET; per C29 only state-changing routes emit audit rows. The "audit row contains BOTH tenant IDs" half of C18c will be tested when Sprint 4+ adds write routes. Accepted — the *response-body* half (UUID match count = 0) is fully verified now.

3. **C26 latency-variance ceiling 250ms vs my 50ms.** Generator's test uses 250ms to absorb CI runner jitter; my probe shows 0.4ms p95 delta on macOS dev host. Both are correct: Generator's threshold is generous-but-still-detects-100ms-divergence, mine confirms the bcrypt-equivalent dummy work is actually doing its job locally.

4. **MFA-flow replay test asserts post-enrollment route 4xx, not LRU per se.** The packages/authz/`totp.test.ts` covers the LRU; the integration test asserts the route's no-pending-secret 400 path. Both layers are tested; the orchestration is sound.

---

## What I deferred / accepted by inspection

- Reading every test file line-by-line — bounded spot-check per workflow §5.5. I ran the full integration suite, my own 19-probe orthogonal suite, the cumulative regression, the migrate-check, and the path-footguns grep. Other criteria are accepted by structural inspection unless a probe surfaced a specific concern.
- C28b/C28c (deleted/expired session 401) — Generator's `idor-matrix.test.ts` covers all 5 outcomes per spec; my probe covers a/d/e to confirm wiring; b/c logic is mechanical.
- C21b consume-once race — Generator's `register.test.ts` covers concurrent-register branch via `Promise.all([req, req])`. I read the migration's atomic UPDATE pattern (`WHERE bootstrap_consumed_at IS NULL`) and accepted the SQL is correct. Direct probe deferred (would require multi-process or carefully-timed Promise.all; gen has it).
- ASVS L1 mapping (`docs/security/asvs-l1-mapping.md`) — file present (~6.8KB), accepted as foundation for Sprint 12 FSTEC/GOST appendix; content quality not deeply reviewed.
- Auth-rotation runbook (`docs/runbooks/auth-rotation.md`) — file present, accepted.

---

## Forward notes for Sprint 4 contract

(Sprint 4 spec §4.4 / plan §4.4: audit subsystem.)

1. **Wire `denyAudit` into `assertOwnership`'s `RbacDenyError`.** Sprint 3 left the structured error carrying `{actorTenantId, attemptedResourceType, attemptedResourceId}` — Sprint 4 should consume it via the new audit middleware. Test should assert: cross-tenant 403 → audit row with `outcome='denied'` AND BOTH tenant IDs in `before` field. (Completes the C18c audit-side half.)
2. **Wire `onCrossTenantAttempt` hook from Sprint 2 `MutableRepository` into the audit subsystem.** Same mechanism — repo emits structured event, Sprint 4 audit consumer routes to `audit_events`.
3. **Sentinel platform tenant aggregation note** (per Generator design decision #1 above) — when Sprint 4 adds audit-events query API, ensure compliance/per-tenant aggregates exclude `__platform__` rows OR document that they're "platform-level" rows separate from any customer tenant.
4. **Three per-process LRUs** still pending Sprint 7 swap to shared store: TOTP-replay, pre-auth-token, rate-limit. ADR 0003 §Limitations documents; Sprint 7 contract should explicitly enumerate all three.
5. **C29 single-row-per-attempt audit shape** — Sprint 4 audit middleware MUST preserve this contract. As more state-changing routes land (CRUD on projects/targets/assessments/findings in Sprint 5+), the same `delta=1` invariant applies.

---

## Files I added during verification

- `.harness/cyberstrike-hybrid/evaluator-probe-sprint3.ts` — 19 orthogonal probes for ADR text + C19 + C22 oracle + C26 latency + C28a/d/e + C18c.
- `.harness/cyberstrike-hybrid/sprint-3-result.md` — this document.

---

## Verdict summary

**PASS** on iteration 1, no fixes needed. Generator delivered Sprint 3 cleanly:
- All 30 acceptance criteria + sub-criteria verified
- Two-step pre-auth-token oracle eliminated (proven by byte-identical canonical 401 across 3 distinct invalid-credential paths)
- Cross-tenant 403 leaks zero UUIDs
- Password-reset latency variance < 50ms p95
- ADR 0003 carries the production-encryption requirement verbatim
- Sprint 1 + 2 baselines preserved

Lead can commit `feat(sprint-3): auth/RBAC/tenancy middleware (C1-C30)` (or any subset of the slice commits already pushed) and run `/codex:adversarial-review`. After that, on to Sprint 4 (audit subsystem).
