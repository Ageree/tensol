# Sprint 24 Contract — SaaS Foundation: Auth + Tenant Init

**Generator:** generator-s24 (Sonnet 4.6)
**Date:** 2026-05-04
**Revision:** R3 (final — evaluator R1 C1/C2/H1-H4/M1-M3/L1-L2 fully resolved; this is the last revision round per ≤2-round harness rule)
**Base commit:** `1aa2bbf` (S23 ship + post-sprint cleanup)
**Baseline tests:** no-DB 1066/0/415, full-PG NOT YET RUN (B-23-c2 gate)
**Harness:** cyberstrike-saas-s24-s28

> **P36 COMPLIANCE:** This document contains NO evaluator verdict. PASS/FAIL is issued exclusively by the evaluator.

> **Z.1.2 naming consistency:** Chose `self-register` for route slug + audit action string + frontend function. Backend: `POST /auth/self-register`. AUDIT_ACTIONS: `auth.self_register`. Frontend: `apps/web/src/api/auth.ts:selfRegister()`. Consistent across all three surfaces.

> **Mig 023 authority note:** Mig 023 includes `subscriptions` + `invoices` per spec body §3 (authoritative). Z.6 line referencing mig 025 for these tables is internally inconsistent with Z.7 ("§3 DDL kept as-is"). Z.7 wins; this contract follows §3.

---

## Goal + Scope

Sprint S24 delivers the SaaS registration foundation:

1. **Pre-work A** (B-23-c1): AUDIT_ACTIONS validator emit consolidation (87→88: consolidate validator granular actions, add `auth.self_register`)
2. **Pre-work B** (B-23-c2): Full-PG baseline run on current HEAD
3. **Migration 023**: `users.email_verified` + `subscriptions` + `invoices`
4. **`POST /auth/self-register`**: New route — creates tenant + user in single TX, issues session cookie
5. **`/register` page**: Extend existing `apps/web` (Vite + React 19 + TanStack Router) with registration form
6. **`/app/*` protected layout**: Auth guard using TanStack Router `beforeLoad`, no content flash

**Out of scope for S24:**
- Domain verification, scan launch, billing real integration (S25-S26)
- shadcn component library (deferred: Tailwind v4 incompatibility with stable shadcn)
- Validator emit consolidation to final 13-action set (B-23-c1 partial only — see §B-23-c1 section)
- `domain.verify.*`, `scan.launched`, `billing.checkout.stub` audit actions (no emit sites in S24)

---

## Architecture Decisions (advisor-reviewed)

### A1 — Frontend: Extend Vite, NOT Next.js

- **Decision:** Option A — extend existing `apps/web` (Vite 6 + React 19)
- **Rationale:** Next.js 16 App Router was aspirational in the roadmap; codebase reality is Vite. Rewriting is ~3x cost for zero user-visible benefit at this stage.
- **R2 clarification (BLOCKER-2):** TanStack Router 1.91 is in `package.json` but is NOT wired into `App.tsx`. The app uses a `useState<Route>` state machine for routing. S24 extends the state machine (Option B) rather than introducing `<RouterProvider>` from scratch.
- **Advisor verdict:** CONFIRMED — code-verified, no risks.

### A2 — Auth: Session-cookie, NOT JWT

- **Decision:** Keep `__Host-cs_session` / `cs_session` (local) opaque token pattern. No JWT layer.
- **Rationale:** Session-cookie is revocable, already implemented, more secure than JWT (no signature leakage). `user_sessions` table + bcrypt hash in DB is the existing invariant.
- **Advisor verdict:** CONFIRMED.

### A3 — B-23-c1 Partial Scope

- **Decision:** S24 does NOT achieve AUDIT_ACTIONS=13. That is unachievable without touching validator-worker frozen test assertions.
- **What S24 does:** Adds ONLY `auth.self_register` to AUDIT_ACTIONS. **No existing actions are removed.** Final count: 87→88. Validator granular→consolidated emit consolidation is deferred to S25 pre-work.
- **Rationale:** S23 evaluator §6 confirmed the mechanical 6-file change needed — but that touches `*-validator.test.ts` + IT pipeline tests, which belong in S25 validator sprint context.
- **Advisor verdict:** CONFIRMED — "Defer validator emit consolidation to S25."

### A4 — `users.role` for self-registered users

- **Decision:** Self-registered users get `role = 'tenant_admin'`.
- **Rationale:** `users.role` CHECK constraint (migration 002) allows: `platform_admin`, `tenant_admin`, `security_lead`, `operator`, `developer`, `auditor`, `viewer`. `'owner'` is NOT in the list. Adding `'owner'` requires a CHECK constraint extension in migration 023 OR using the closest existing role. `tenant_admin` is the correct SaaS workspace-owner equivalent.
- **Alternative considered:** Extend CHECK to add `'owner'` in mig 023. Rejected: unnecessary schema churn; `tenant_admin` conveys the same semantics in a solo-tenant model.
- **Advisor verdict:** CRITICAL BLOCKER resolved — use `tenant_admin`.

### A5 — shadcn deferred

- **Decision:** S24 uses plain Tailwind utilities for RegisterPage. shadcn deferred to S25 (Tailwind v4 incompatibility with stable shadcn).
- **Advisor verdict:** CONFIRMED.

---

## Gitnexus Impact Analysis

| Symbol | Direction | Risk | d=1 callers | Action |
|--------|-----------|------|-------------|--------|
| `registerRoutes` | upstream | LOW | 0 | Safe — new route added, no existing caller modified |
| `SessionRepo` | upstream | MEDIUM | 6 (factory.ts, index.ts, factory.ts import, shared.ts, session.ts, login.ts) | New self-register handler IMPORTS SessionRepo same as login.ts — no change to SessionRepo itself |
| `AUDIT_ACTIONS` | upstream | N/A | Not indexed (config constant) | Grep-verified: only in packages/contracts/src/audit.ts + audit.test.ts |
| `sessionMiddleware` | upstream | LOW | 0 in graph | Safe to add new routes using it |

**d=1 risk for SessionRepo:** All 6 callers are import-only. Self-register adds a 7th importer — no interface change to SessionRepo. Risk remains LOW after analysis.

---

## Mempalace Search Results

**L2 correction:** Wing `cyberstrike` is non-existent (confirmed empty). Correct wings are `cyberstrike-hybrid` (47 drawers) and `wing_lead-cyberstrike` (46 drawers) per Appendix Z.1.3. Prior search was missing `wing_lead-cyberstrike`.

- Wing `cyberstrike-hybrid` results: pitfalls P1-P15 (S5-S6 catalog), S10 session checkpoint. Relevant:
  - P2: Test fixture isolation — unique tenant slugs `${base}-${Date.now()}-${random}` (contract uses randomHex(8) suffix instead of timestamp per advisor recommendation)
  - P3: resetAuthState DELETE order — audit_events FIRST due to FK
  - P4: Migration B6 rollback loop must match migration count
- Wing `wing_lead-cyberstrike` results: pitfalls catalog P16-P37 (S16-S23), auth session pattern (P-session: opaque token + bcrypt), B6 rollback K math pattern, audit append-only enforcement. Relevant:
  - P36: generator-no-verdict (applied at top of this document)
  - P37: contract pure-fn values code-verified (all migration column types, role enum, audit count verified against source)
  - P32: BYTEA exempt list (no BYTEA in mig 023 — confirmed)
- No prior auth/tenant decisions stored (all decisions sourced from code + sprint artifacts)

---

## Advisor Review Summary

**Advisor:** advisor-s24-precontract (Opus 4.7), run 2026-05-04

**Verdict:** APPROVE WITH CHANGES

**Key findings applied:**
1. B6 loop K = 22→23 (not 10→11 as initially drafted — there are 22 migrations on disk)
2. `invoices.amount_kopecks bigint` (not int4 — overflow risk at ~21M RUB)
3. `subscriptions` UNIQUE(tenant_id) is correct; add `trial_ends_at timestamptz NULL`
4. `invoices.status` CHECK must include `'pending'`
5. Tenant slug collision: use `${base}-${randomHex(4)}` not timestamp (timing leak)
6. TanStack Router `beforeLoad` guard (not useEffect polling — avoids content flash)
7. `auth.self_register` only new AUDIT_ACTION in S24; other 5 SaaS actions deferred
8. Self-register must NOT touch `platform_settings` (bootstrap route guard)

---

## File-by-File Change List

### New files

| File | Description |
|------|-------------|
| `apps/api/src/routes/auth/self-register.ts` | POST /auth/self-register handler |
| `packages/db/migrations/023_saas_auth_subscriptions.ts` | Migration: email_verified + subscriptions + invoices |
| `apps/web/src/pages/RegisterPage.tsx` | Registration form component |
| `apps/web/src/layouts/ProtectedLayout.tsx` | /app/* auth guard wrapper |
| `tests/integration/auth/self-register.test.ts` | IT: register→login→me→logout flow |

### Modified files

| File | Changes |
|------|---------|
| `packages/contracts/src/audit.ts` | Add `auth.self_register` to AUDIT_ACTIONS (87→88, no removals); update count |
| `packages/contracts/src/audit.test.ts` | Update cardinality assertion: `expect(AUDIT_ACTIONS.length).toBe(88)` |
| `apps/api/src/routes/register-routes.ts` | Add `POST /auth/self-register` route (rate-limited, no auth) |
| `apps/web/src/api/auth.ts` | Add `selfRegister(body)` function. Also update `MeResponse` interface to match actual backend shape: `{ actor: { id, email, role, tenantId }, tenant: { id, slug } }` — and update `getMe()` return type accordingly. Current flat shape `{ id, email, role, tenantId, displayName }` does not match `/auth/me` backend output. (Note: `displayName` is absent from the backend response; remove from interface.) |
| `apps/web/src/App.tsx` | Extend `Route` union: add `{ name: 'register' }` + `/app/*` guarded routes; add `ProtectedLayout` component usage |
| `tests/integration/auth/helpers/auth-fixture.ts` | **BLOCKER-1 FIX:** Add `DELETE FROM invoices; DELETE FROM subscriptions;` BEFORE `DELETE FROM tenants` in `resetAuthState`. This prevents FK violation when mig 023 lands. |
| `tests/integration/db/helpers/db-fixture.ts` | Add `subscriptions`, `invoices` to teardown table list |
| `packages/db/src/schema.ts` | Add `SubscriptionsTable`, `InvoicesTable` interfaces; extend `UsersTable` with `email_verified` |
| `tests/integration/db/migrations.test.ts` | **C1 — 7 B6 hunks (see §B6 Change Map below):** (1) K-loop line 180: `i < 10` → `i < 11`. (2–7) Each test that currently pops r022pre as its FIRST migrateDown must prepend `const r023pre = await f.migrator.migrateDown()` before that pop. Line 391 `rollbackAllMigrations` test is auto — no change. See §B6 Change Map for per-test detail. |

---

## B6 Change Map — migrations.test.ts (C1 resolution)

Code-verified against `tests/integration/db/migrations.test.ts`. 8 B6 tests total; 7 require changes when mig 023 lands. The 8th (`rollbackAllMigrations` at line 391) is automatic — no change.

| Line | Test name | Change required |
|------|-----------|-----------------|
| 46 | "rollback removes the latest migration (three-step: 019→018→017→re-apply)" | Prepend `const r023pre = await f.migrator.migrateDown(); if (r023pre.error) throw ...;` BEFORE the existing `r021pre` pop (line 64). Now pops 023→022→021+020 prefix before step-1. |
| 123 | "reports table has expected column shape after migration 013" | Change `for (let i = 0; i < 10; i++)` (line 180) to `i < 11`. Comment: "11 = down(023)→…→down(013)". No other changes. |
| 197 | "observations_browser SPA columns present after migration 019" | Prepend `const r023pre = await f.migrator.migrateDown(); if (r023pre.error) throw ...;` BEFORE the existing `r022pre` pop (line 211). Now pops 023→022→021→020 prefix before targeting 019. |
| 234 | "target_credentials table present after migration 018" | Prepend `const r023pre = await f.migrator.migrateDown(); if (r023pre.error) throw ...;` BEFORE the existing `r022pre` pop (line 251). Now pops 023→022→021→020 prefix. |
| 280 | "mig 020: target_credentials.name + target_credential_usage" | Prepend `const r023pre = await f.migrator.migrateDown(); if (r023pre.error) throw ...;` BEFORE the existing `r022pre` pop (line 299). Now pops 023→022→021 prefix before targeting 020. |
| 325 | "oob_callbacks table present after migration 021" | Prepend `const r023pre = await f.migrator.migrateDown(); if (r023pre.error) throw ...;` BEFORE the existing `r022` pop (line 349). Now pops 023→022→021. |
| 366 | "mig 022: recipe_text column present after 022" | Prepend `const r023pre = await f.migrator.migrateDown(); if (r023pre.error) throw ...;` BEFORE the existing `r022` pop (line 378). Now pops 023 first, then 022. |
| 391 | "full rollback to empty schema" | No change — uses `rollbackAllMigrations` (auto). |

**C2 — B5 spot-check for users column shape:** B5 test (line 32) only checks existence of `tenants`, `audit_events`, `reports`, `target_credentials` tables — NOT `users` column shape. Confirmed: no assertion on `users` columns anywhere in `migrations.test.ts`. Adding `email_verified` column in mig 023 does NOT create any B5 drift. No additional change required.

---

## Migration 023 (code-verified)

```typescript
// packages/db/migrations/023_saas_auth_subscriptions.ts
// B6 rollback loop: K = 23 (was 22 migrations before this one)

import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // Add email_verified mock flag to users (always true until SMTP phase)
  await sql`ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT true`.execute(db);

  // Subscriptions: one per tenant, billing tier + status
  await sql`
    CREATE TABLE subscriptions (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       uuid NOT NULL REFERENCES tenants(id),
      tier            text NOT NULL CHECK (tier IN ('light', 'medium', 'aggressive')),
      status          text NOT NULL DEFAULT 'trial'
                        CHECK (status IN ('trial', 'active', 'cancelled')),
      trial_ends_at   timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id)
    )
  `.execute(db);

  // Invoices: append-only stub (no trigger needed — not security-critical)
  await sql`
    CREATE TABLE invoices (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       uuid NOT NULL REFERENCES tenants(id),
      amount_kopecks  bigint NOT NULL DEFAULT 0,
      status          text NOT NULL DEFAULT 'mock'
                        CHECK (status IN ('mock', 'pending', 'paid', 'failed')),
      metadata        jsonb NOT NULL DEFAULT '{}',
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`DROP TABLE IF EXISTS invoices`.execute(db);
  await sql`DROP TABLE IF EXISTS subscriptions`.execute(db);
  await sql`ALTER TABLE users DROP COLUMN IF EXISTS email_verified`.execute(db);
};
```

**P-bytea check:** No BYTEA columns. `metadata` is JSONB. EXEMPT.
**B6 rollback loop:** K must be set to 23 in `tests/integration/db/migrations.test.ts`.

---

## API Contracts

### POST /auth/self-register

**Auth:** none (public)
**Rate limit:** 5 per IP per 10 minutes

**Request:**
```json
{ "email": "string", "password": "string (min 12)", "displayName": "string (min 1, max 128)" }
```

**Success response (201):**
```json
{ "ok": true, "userId": "uuid", "tenantId": "uuid" }
```
Sets `Set-Cookie: cs_session=<userId>.<plaintext>; ...` (session cookie).

**Error responses:**
- `400 { "error": "invalid_request" }` — zod validation failure
- `409 { "error": "email_already_registered" }` — duplicate email
- `429 { "error": "rate_limited", "retry_after_seconds": N }` — rate limit hit
- `500 { "error": "internal_error" }` — TX failure

**Audit emissions:**
- Success: `action=auth.self_register, outcome=success, resourceType=user, resourceId=userId`
- Zod failure: `action=auth.self_register, outcome=failure, metadata={reason:'invalid_body'}`
- Dup email: `action=auth.self_register, outcome=failure, metadata={reason:'email_taken'}`
- TX failure: `action=auth.self_register, outcome=failure, metadata={reason:'tx_failed'}`
- Rate limit: no audit emit (rate limiter returns before handler runs)

**Implementation notes:**
- **Tenant slug (M2 fix):** Derived from email local-part, sanitized to `[a-z0-9-]`, max 60 chars + `-${randomHex(8)}` suffix (8 hex chars = 32 bits = ~4B possibilities; safer than 4-char default). `tenants.slug` has DB UNIQUE constraint (mig 001) as final collision guard.
- Role: `tenant_admin` (existing CHECK constraint — `'owner'` is NOT in the allowed set)
- `email_verified = true` (mock flag per spec)
- Session issued via `SessionRepo.issue()` directly (NOT via login handler — avoids MFA branch)
- **TX scope:** tenant INSERT + user INSERT only. Session issued AFTER TX commit.
- `platform_settings` NOT touched (bootstrap-only flow preserved)
- Password hash: `deps.hasher.hash(body.password)` (bcrypt, existing pattern)
- **H2 — Global email uniqueness check (Z.1.5 mandate):** The global email check is performed INSIDE the transaction, BEFORE the user INSERT. Kysely form:
  ```typescript
  const existing = await tx.selectFrom('users').select('id').where('email', '=', body.email).executeTakeFirst();
  if (existing) return c.json({ error: 'email_already_registered' }, 409);
  ```
  This runs inside the same `db.transaction()` block as the tenant+user inserts, so concurrent registrations with the same email cannot both pass (serializable or repeatable-read TX isolation + the subsequent UNIQUE(tenant_id, email) constraint provides a second guard). The DB per-tenant UNIQUE(tenant_id, email) (mig 002) is NOT a global uniqueness guard — the application-level check above is required.
- **H3 — Session-issue failure audit trail:** If the TX commits but `SessionRepo.issue()` throws (extremely rare — session insert failure), the handler emits `action=auth.self_register, outcome=success` first (user+tenant were created), then returns 500. The user can log in manually. No second audit event for the session failure — the success event reflects the state of the created account (tenant+user exist). The 500 response body is `{ error: 'internal_error' }`.
- **M3 — Tenant row fields (code-verified from mig 001):** `{ id: gen_random_uuid(), name: displayName, slug: computedSlug, status: 'active', created_at: now(), updated_at: now() }`. The `name` field maps to `displayName` from the request body. `status` defaults to `'active'` (CHECK: `active`, `suspended`, `archived`).
- **H4 — Routing file:** The modified file is `apps/web/src/App.tsx` (confirmed: the only routing surface). `ProtectedLayout.tsx` is a NEW file. `auth/context.tsx` exports `useAuth()` which already calls `getMe()` on mount via `useEffect` — `ProtectedLayout` re-uses this existing context rather than making a second `GET /auth/me` call.
- **BLOCKER-3 FIX — Rate limiting:** A dedicated `createRateLimiter({ maxFailures: 5, windowSeconds: 600 })` instance is used for self-register — NOT the login rate limiter. The limiter is keyed by source IP (from `c.req.header('x-forwarded-for') ?? c.req.raw.headers.get('x-real-ip') ?? 'unknown'`). `recordFailureAndCheck()` is called at the START of the handler, BEFORE any DB operation — including both successful and failed registrations. A successful registration still consumes a slot. If the bucket is full, return 429 immediately without further processing. The `retry_after_seconds` value is derived from `windowSeconds - elapsed`.

### GET /auth/me (existing, unchanged)

**BLOCKER-4 FIX:** Code-verified response shape from `apps/api/src/routes/auth/me.ts`:
```json
{
  "actor": { "id": "uuid", "email": "string", "role": "string", "tenantId": "uuid" },
  "tenant": { "id": "uuid", "slug": "string" }
}
```
The frontend `useAuth()` hook must read `actor.*` and `tenant.*` — NOT flat `{ id, email, tenantId, role }`. No changes to the backend endpoint itself.

---

## Frontend Routes

### New: `/register` page

- Form fields: email, password, displayName
- On submit: `POST /auth/self-register` → success → redirect to `/app/projects`
- On error: show field-level error messages
- Link to `/login` for existing users
- Plain Tailwind utilities (no shadcn — deferred)

### New: `/app/*` protected layout — BLOCKER-2 FIX

**Code-verified:** `apps/web/src/App.tsx` uses `useState<Route>` as a custom routing state machine. TanStack Router is in `package.json` but is NOT wired into `App.tsx` (no `<RouterProvider>`).

**Decision: Option B — extend the existing `useState<Route>` state machine.**

Rationale: Wiring TanStack Router from scratch (Option A) is a large-scope rewrite with high regression risk. Extending the state machine is a minimal, low-risk change.

**Implementation:**
- Add `{ name: 'register' }` to the `Route` type union in `App.tsx`
- Add protected route names: `{ name: 'app-projects' }` (and others as needed)
- `ProtectedLayout` is a React component (NOT a TanStack Router layout). It:
  1. Reads auth state from a `useAuth()` context (calls `GET /auth/me` once on mount)
  2. While loading: renders a loading spinner (prevents content flash)
  3. On 401: sets route to `{ name: 'login' }` (same pattern as existing auth guard logic)
  4. On success: renders children (the protected page)
- The `RegisterPage` is rendered when `route.name === 'register'`
- Success handler on register: sets route to `{ name: 'app-projects' }`

### Existing routes untouched:
- `/login` (LoginPage.tsx)
- `/projects`, `/assessments`, `/findings` (existing pages — keep as-is, they are pre-SaaS pages)

---

## Test Plan

### Unit tests (no-DB)

| Test | File | Verifies |
|------|------|---------|
| `audit.test.ts` | `packages/contracts/src/audit.test.ts` | AUDIT_ACTIONS.length === 88, includes `auth.self_register` |
| migration 023 structure | existing migration test framework | up/down idempotent |

### Integration tests (full-PG)

| Test | File | Verifies |
|------|------|---------|
| self-register happy path | `tests/integration/auth/self-register.test.ts` | POST → 201 + cookie + tenant+user rows |
| register → login → me → logout | same file | Full auth session flow |
| duplicate email → 409 | same file | Email uniqueness enforcement |
| invalid body → 400 | same file | Zod validation |
| audit emission | same file | `auth.self_register` rows in audit_events |
| tenant isolation | same file | New tenant's data not visible to other tenants |
| B6 rollback | `tests/integration/db/migrations.test.ts` | K=23 loop passes |

### E2E (Playwright)

Deferred to S27 (spec: E2E for full flow). S24 has IT coverage for the auth flow.

---

## Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| A-24-1 | B-23-c2: full-PG baseline ≤ baseline flakes | Run before SaaS code commits |
| A-24-2 | AUDIT_ACTIONS.length === 88 | `audit.test.ts` cardinality test |
| A-24-3 | `auth.self_register` is in AUDIT_ACTIONS | String present in array |
| A-24-4 | `POST /auth/self-register` creates tenant + user in single TX | IT: DB rows created atomically |
| A-24-5 | Session cookie set on successful registration | IT: `set-cookie` header present |
| A-24-6 | `email_verified = true` on new users | IT: DB row check |
| A-24-7 | Duplicate email → 409 | IT: second register with same email |
| A-24-8 | `users.role = 'tenant_admin'` for self-registered | IT: DB row check |
| A-24-9 | Audit event emitted for success + failure paths | IT: audit_events table count |
| A-24-10 | `tenantId` on audit event = new tenant's id | IT: audit row field check |
| A-24-11 | `platform_settings` untouched after self-register | IT: bootstrap_consumed_at unchanged |
| A-24-12 | Migration 023 up/down idempotent | B6 rollback test K=23 |
| A-24-13 | No BYTEA columns in mig 023 | Schema inspection |
| A-24-14 | `/register` page renders + submits | Manual smoke test (no E2E in S24) |
| A-24-15 | `/app/*` routes redirect to `/login` when unauthenticated | Manual smoke test |
| A-24-16 | tsc 0 errors | `bun run typecheck` |
| A-24-17 | lint 0 errors | `bun run lint` |
| A-24-18 | no-DB tests ≥ 1066 pass, 0 fail | Full no-DB suite |
| A-24-19 | full-PG: 0 NEW failures vs baseline established during B-23-c2 pre-work run | Full PG suite — baseline number written into implementation summary after B-23-c2 run |

---

## Pitfall Application Checklist (P1-P37)

| Pitfall | S24 Application | Status |
|---------|----------------|--------|
| **P36** — generator-no-verdict | No PASS/FAIL in this file | APPLIED |
| **P37** — contract pure-fn values code-verified | Migration column types verified against schema.ts + mig 002 | APPLIED |
| **BYTEA exempt** | No BYTEA in mig 023 — JSONB metadata only | APPLIED |
| **B6 loop bump** | K=22→23 (22 migrations exist before mig 023) | APPLIED |
| **FULL-suite counts** | Report NEW pass/total AND FULL pass/total at handoff | COMMITTED |
| **gitnexus_impact before edits** | Run for registerRoutes, SessionRepo, AUDIT_ACTIONS | APPLIED |
| **mempalace_search before contract** | Searched cyberstrike + cyberstrike-hybrid wings | APPLIED |
| **gitnexus_detect_changes before handoff** | Will run in Phase D | PLANNED |
| **Tenant isolation** | self-register creates tenant+user atomically; no DEFAULT_TENANT_ID in hot-path | APPLIED |
| **Audit append-only** | No migration drops triggers; new emit only | APPLIED |
| **Frozen surfaces** | scope-engine, decepticon-adapter, reports, coordinator/payloads.ts, register.ts (bootstrap) untouched | APPLIED |
| **B-23-c1 pre-work** | ONLY adds `auth.self_register` (87→88, no removals). Validator consolidation deferred to S25. | APPLIED |
| **Self-register atomicity** | tenant+user in single DB TX | APPLIED |
| **P2 fixture isolation** | Self-register IT uses unique tenant slugs | WILL APPLY |
| **P3 resetAuthState order** | auth-fixture.ts: `DELETE FROM invoices; DELETE FROM subscriptions;` added BEFORE `DELETE FROM tenants` | APPLIED (R2) |
| **R1 BLOCKER-1** | auth-fixture.ts FK teardown fix for mig-023 tables | RESOLVED in R2 |
| **R1 BLOCKER-2** | Routing: Option B (extend state machine), NOT TanStack Router beforeLoad | RESOLVED in R2 |
| **R1 BLOCKER-3** | Rate limiting: own `createRateLimiter` instance, ALL attempts decrement, 429 before DB | RESOLVED in R2 |
| **R1 BLOCKER-4** | `/auth/me` shape: `{ actor: {…}, tenant: {…} }` — frontend reads nested fields | RESOLVED in R2 |
| **R2 C1 (B6 K math)** | All 7 affected B6 tests enumerated with per-test prefix bump; K-loop `i < 11` | RESOLVED in R3 |
| **R2 C2 (email_verified column drift)** | B5 test checks table existence only — no `users` column shape assertion; confirmed no drift | RESOLVED in R3 |
| **R2 H2 (global email check TX placement)** | Kysely query inside TX, before user INSERT; race-condition safe | RESOLVED in R3 |
| **R2 H3 (session-issue failure audit)** | Emit success event (user+tenant created); return 500; user can log in separately | RESOLVED in R3 |
| **R2 H4 (routing file)** | Explicit: `apps/web/src/App.tsx`; ProtectedLayout re-uses existing `useAuth()` context | RESOLVED in R3 |
| **R2 M1 (A-24-19 baseline)** | Changed to "0 new failures vs B-23-c2 baseline run" | RESOLVED in R3 |
| **R2 M2 (slug randomHex)** | Updated to randomHex(8) — 32 bits, ~4B possibilities | RESOLVED in R3 |
| **R2 M3 (tenant row fields)** | Enumerated from mig 001: id, name (=displayName), slug, status='active', timestamps | RESOLVED in R3 |
| **R2 L1 (naming consistency)** | Preamble note added: self-register/auth.self_register/selfRegister() consistent | RESOLVED in R3 |
| **R2 L2 (mempalace wing)** | Corrected to `cyberstrike-hybrid` + `wing_lead-cyberstrike`; results from both listed | RESOLVED in R3 |

---

## Deferred Items (Carry-over to S25)

| Item | Reason |
|------|--------|
| AUDIT_ACTIONS validator emit consolidation (87→13 full goal) | Requires touching `*-validator.test.ts` + IT pipeline tests — S25 context |
| shadcn component library install | Tailwind v4 incompatibility with stable shadcn |
| `domain.verify.*` audit actions | No emit sites until S25 domain verification |
| `scan.launched`, `billing.checkout.stub` audit actions | No emit sites until S26 |
| `/app/projects`, `/app/projects/:id`, etc. routes | Frontend skeleton only in S24; full SaaS pages in S25-S27 |
| E2E Playwright tests | Full flow deferred to S27 per spec |
