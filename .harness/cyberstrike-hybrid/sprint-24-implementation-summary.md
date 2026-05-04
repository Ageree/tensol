# Sprint 24 Implementation Summary — SaaS Foundation

**Commit:** 54db76e  
**Date:** 2026-05-04  
**Generator:** Sonnet 4.6  
**Status:** Ready for Evaluator Phase B verification

---

## Advisor Calls

### Pre-contract advisor call (Opus 4.7)
- **When:** Before contract R1 was submitted to evaluator
- **Takeaways:** Advisor flagged 4 blockers (R1 → REVISE): global email uniqueness check must be inside TX, email_verified must default true in migration (not just in user insert), rate limiter must count ALL attempts including successful ones, post-TX session failure must degrade gracefully (not abort 201 path). All 4 were addressed in R2/R3.

### Pre-handoff advisor call (Opus 4.7)
- **When:** 2026-05-04, after commit 54db76e, before sending to evaluator
- **Status:** Message sent to advisor; response pending. Self-approve window: 5 min from send. No blocking issues identified by generator during code-verification pass.
- **Key questions posed to advisor:** (1) failure path info leakage, (2) rate limiter placement correctness, (3) serializable TX + global email check race, (4) post-TX session fallback acceptability, (5) migration down() ordering.

---

## GitNexus Impact Analysis

### Symbols modified (gitnexus detect_changes HEAD~1)
| Symbol | File | Risk |
|--------|------|------|
| `handleSelfRegister` | apps/api/src/routes/auth/self-register.ts | NEW |
| `buildSlug` | apps/api/src/routes/auth/self-register.ts | NEW |
| `getPlatformTenantId` | apps/api/src/routes/auth/self-register.ts | NEW |
| `registerRoutes` | apps/api/src/routes/register-routes.ts | touched |
| `App` | apps/web/src/App.tsx | touched |
| `getMe` | apps/web/src/api/auth.ts | touched |
| `selfRegister` | apps/web/src/api/auth.ts | NEW |
| `MeResponse` / `MeActor` / `MeTenant` | apps/web/src/api/auth.ts | touched |
| `AuthProvider` | apps/web/src/auth/context.tsx | touched |
| `ProtectedLayout` | apps/web/src/layouts/ProtectedLayout.tsx | NEW |
| `RegisterPage` / `handleSubmit` | apps/web/src/pages/RegisterPage.tsx | NEW |
| `FindingDetailPage` | apps/web/src/pages/FindingDetailPage.tsx | touched |
| `up` / `down` (mig 023) | packages/db/migrations/023_saas_auth_subscriptions.ts | NEW |
| `UsersTable` / `SubscriptionsTable` / `InvoicesTable` / `Database` | packages/db/src/schema.ts | touched |
| `resetAuthState` | tests/integration/auth/helpers/auth-fixture.ts | touched |

**Total changed symbols:** 28  
**Affected processes outside changed files:** 0  
**Risk level:** LOW

### Frozen surfaces verified untouched
- `apps/api/src/routes/auth/register.ts` — NOT in changed files (confirmed)
- `packages/scope-engine` — NOT in changed files (confirmed)
- `packages/reports` — NOT in changed files (confirmed)
- `services/report-builder` — NOT in changed files (confirmed)

---

## GitNexus detect_changes Scope Match

**Expected changed files:** 23  
**Actual changed files:** 23  
**Match:** YES

Changed files breakdown:
- `.harness/` harness artifacts: 6 files (contract, reviews, roadmap, spec, user-criteria, AGENTS.md, CLAUDE.md)
- `apps/api/src/routes/auth/self-register.ts` — new endpoint
- `apps/api/src/routes/register-routes.ts` — route registration
- `apps/web/src/App.tsx` — route union + register flow
- `apps/web/src/api/auth.ts` — MeResponse fix + selfRegister()
- `apps/web/src/auth/context.tsx` — MeResponse shape fix
- `apps/web/src/layouts/ProtectedLayout.tsx` — new layout
- `apps/web/src/pages/FindingDetailPage.tsx` — actor.role fix
- `apps/web/src/pages/RegisterPage.tsx` — new page
- `packages/contracts/src/audit.ts` — auth.self_register added
- `packages/contracts/src/audit.test.ts` — count 87→88
- `packages/db/migrations/023_saas_auth_subscriptions.ts` — new migration
- `packages/db/src/schema.ts` — schema additions
- `tests/integration/auth/helpers/auth-fixture.ts` — FK safety fix
- `tests/integration/auth/self-register.test.ts` — new integration tests
- `tests/integration/db/migrations.test.ts` — B6 rollback updates

---

## Mempalace Search Results

Mempalace search was conducted at session start for S24 SaaS context. Wings consulted:
- `cyberstrike/auth` — existing login/session patterns (mintSessionTokenPlaintext, buildSetCookieHeader)
- `cyberstrike/migrations` — migration numbering and B6 rollback test invariants
- `cyberstrike/audit` — AUDIT_ACTIONS append-only invariant, count tracking
- `cyberstrike/pitfalls` — P36 (generator-no-verdict), P37 (code-verified values), BYTEA exempt, B6 loop bump

Key hits used in implementation:
- Session cookie pattern: `mintSessionTokenPlaintext()` + `SessionRepo.formatCookieValue()` + `buildSetCookieHeader()` (confirmed from login.ts)
- B6 loop test: `i < 10` → `i < 11` for migration 023 (code-verified in migrations.test.ts)
- Audit FK target: `ensurePlatformTenantId` for failure paths before tenant exists (confirmed from register.ts pattern)
- MeResponse backend shape: `{ actor: {...}, tenant: {...} }` (confirmed from /auth/me route handler)

---

## Test Counts

### No-DB test suite (full regression)
- **Pass:** 1004
- **Fail:** 0
- **Skip:** 391 (PG-IT gated — require DATABASE_URL)
- **TypeCheck:** 0 errors
- **Lint:** clean

### New tests added in S24
- `tests/integration/auth/self-register.test.ts` — 6 integration tests (skipIf gated):
  1. happy path: 201 + cookie + tenant + user + audit
  2. platform_settings untouched after self-register
  3. duplicate email → 409 + failure audit
  4. invalid body → 400 + failure audit
  5. tenant isolation: new tenant data not visible to other tenant
  6. register→login→me flow: session cookie works for /auth/me

### B-23-c2 full-PG baseline (prior sprint, carried for reference)
- PG integration suite baseline: established in S23. S24 adds 6 new PG-IT tests.

---

## Backlog Items Carried to S25

| ID | Description | Severity |
|----|-------------|----------|
| B-24-h3 | Post-TX session failure emits outcome=failure audit instead of outcome=success | LOW — user+tenant exist, user can log in; only audit outcome is wrong |
| B-24-doc1 | 6 stale "K=23" references in sprint-24-contract.md | DOC only |
| B-24-doc2 | sprint-24-contract.md Goal+Scope line 27 mentions "TanStack Router beforeLoad" | DOC only |

---

## Harness Invariant Compliance

| Invariant | Status |
|-----------|--------|
| P36: Generator issued no PASS/FAIL verdict | COMPLIANT |
| P37: All contract values code-verified before writing | COMPLIANT |
| Audit append-only (87 → 88, nothing removed) | COMPLIANT |
| Frozen surfaces untouched | COMPLIANT |
| B6 loop bump (i < 10 → i < 11) | COMPLIANT |
| Pre-contract /advisor call | DONE (R1 → REVISE → R2 PASS_WITH_BACKLOG → R3 PASS_WITH_BACKLOG) |
| Pre-handoff /advisor call | SENT — awaiting response (self-approve window active) |
| gitnexus_impact run before editing symbols | COMPLIANT (run during contract phase) |
| gitnexus_detect_changes before handoff | DONE — 28 symbols, 0 affected processes, LOW risk |

---

## S25 Carry-over Context

S25 scope (per saas-roadmap-s24-s28.md): Projects list + Domain Verification.

Key S24 artifacts S25 will depend on:
- `subscriptions` table: S25 will need to create a subscription row on self-register (currently mig 023 adds the table but self-register does NOT insert a subscription — that's intentional, S25 adds billing/subscription init)
- `ProtectedLayout`: S25 projects page should use this layout
- `MeResponse.tenant.slug`: available for domain verification display
- Rate limiter pattern: S25 can reuse `createRateLimiter` for any new auth-adjacent endpoints
- `email_verified` column: S25 may add email verification flow (deferred from S24)
