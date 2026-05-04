# CyberStrike SaaS — Product Spec S24–S28

**Planner:** planner-s24-s28 (Sonnet 4.6)  
**Date:** 2026-05-04  
**Source of truth:** `.harness/cyberstrike-hybrid/saas-roadmap-s24-s28.md`  
**Inputs verified:** roadmap, saas-user-criteria.md, sprint-23 result + carries, gitnexus impact queries, codebase direct read (packages/scope-engine, apps/api, apps/web, packages/db).

---

## 1. Executive Summary

CyberStrike (monorepo, TypeScript, Postgres, BullMQ) ships S24–S28 to add a multi-tenant SaaS shell around the existing pentest engine (S1–S23). The goal is a live demo-able product in ~1 week: user registers, creates a project, verifies a domain via DNS-TXT, launches a real scan through the S5–S22 coordinator/validator pipeline, watches live progress, and downloads a report. Billing is a stub flag. Design is shadcn-default. Auth is session-cookie (existing pattern, extended for self-registration). The frontend is an **existing Vite+React SPA** (`apps/web`) — the roadmap mentions Next.js 16 App Router, but this conflicts with the codebase reality where `apps/web` is already a Vite+React 19 app with TanStack Router; this conflict is surfaced loudly in §2 and in the S24 risk register.

---

## 2. Architecture Decisions (per sprint)

### S24 — Frontend skeleton + Auth

**CONFLICT — Next.js vs Vite (CRITICAL, must resolve before implementation):**

- Roadmap says: "apps/web — Next.js 16 App Router"
- Reality (code-verified): `apps/web/package.json` lists `"vite"`, `"@vitejs/plugin-react"`, `"@tanstack/react-router"`. The app is React 19 + Vite + TanStack Router, already with working pages (LoginPage, ProjectsPage, AssessmentPage, etc).
- **Resolution options:**
  - A) Keep Vite+React, extend with new pages for the SaaS flows. Saves rewrite cost; consistent with existing auth context and routing.
  - B) Scaffold a separate `apps/web-next` in Next.js 16, run in parallel. High cost; needs CORS or proxy config for API.
  - **Recommended: Option A.** The existing Vite app already has login, projects, findings pages. Extending it is additive. The roadmap's mention of "Next.js 16 App Router" was likely aspirational; the constraints file says only "Next.js 16 App Router + shadcn по умолчанию" — but this is superseded by the existing codebase. Generator MUST surface this to advisor (/advisor call) before S24 implementation.

**Auth pattern decision:**

- Existing system (code-verified from `apps/api/src/cookies.ts`, `session.ts`, `routes/auth/`): session-cookie via `__Host-cs_session` (httpOnly, Secure, SameSite=Lax, Path=/). Session stored in `user_sessions` table with bcrypt(token) → token_hash. No JWT.
- The roadmap says "JWT в httpOnly cookie" — **conflict with existing implementation**. Existing system uses opaque session tokens (bcrypt-hashed, stored in DB). This is **more secure** than JWT (revocable, no signature leakage). Generator MUST keep the existing session-cookie pattern; do NOT add JWT. The cookie name/attributes are already correct.
- **Chosen pattern (code-verified):**
  - Cookie name: `__Host-cs_session` (non-local) / `cs_session` (local)
  - Attrs: HttpOnly; Secure (non-local); SameSite=Lax; Path=/
  - Token: 32-byte random hex (plaintext in cookie, bcrypt hash in DB)
  - Refresh: none (stateless expiry — session row has `expires_at`)
  - Session table: `user_sessions` (already exists in migration 001+)
  - NO JWT required or desired

**Self-registration change:**

- Existing `/auth/register` (code-verified `register.ts`): **bootstrap-only**. Requires `BOOTSTRAP_TOKEN` and gates on `platform_settings.bootstrap_consumed_at`. After the first user, returns 410 Gone.
- S24 needs **open self-registration** for new tenants. This requires a new registration path or removal of the bootstrap gate for non-admin users.
- **Decision:** Add `POST /auth/self-register` (new handler, new route entry in `register-routes.ts`) that: creates a `tenants` row + a `users` row in one transaction, sets `email_verified=true` (mock flag), creates an initial session. The bootstrap `/auth/register` is preserved unchanged for platform-admin seeding.
- Mig 023 adds `email_verified boolean NOT NULL DEFAULT true` to `users` (mock flag, always true until SMTP phase).

**DEFAULT_TENANT_ID removal:**

- Code-verified: `DEFAULT_TENANT_ID` exists only in `packages/config/src/app-env.ts` (exported constant) and is referenced exclusively in integration test fixtures (grep result: no non-test, non-harness references in `apps/` or `services/`).
- **The constant itself is NOT in hot-path production code.** It was added in S23-C as a seed constant for test fixtures. The `ensurePlatformTenantId` function in `shared.ts` is the hot-path platform-tenant lookup — it uses DB lookup, not `DEFAULT_TENANT_ID`.
- **Action:** No hot-path code change needed. The `DEFAULT_TENANT_ID` constant stays in `packages/config` for test fixture use. New SaaS routes use `req.user.tenantId` via `actor.tenantId` from session middleware (already wired — `sessionMiddleware` reads `tenant_id` from `user_sessions` row and attaches to `UserActor`).
- gitnexus impact on `DEFAULT_TENANT_ID`: NOT FOUND in graph (not indexed as a symbol — it is a config constant). Grep confirms: only in `packages/config/src/app-env.ts`. Blast radius: ZERO production code paths affected.

### S25 — Projects + Domain Verification

**Projects CRUD:**

- `projects` and `targets` tables already exist in the DB schema (code-verified: `ProjectsTable`, `TargetsTable` in `schema.ts`). Routes `/api/v1/projects/*` and `/api/v1/projects/:id/targets` already exist (code-verified from `register-routes.ts`).
- **S25 backend work is primarily:** adding `domain_verifications` table (mig 024) + domain verify endpoints. Projects CRUD is already done.
- The existing `targets.ownership_status` field (`'unverified'|'pending'|'verified'`) is the ownership gate. S25 wires the DNS-TXT flow to flip this from `pending` → `verified`.

**Domain verification design (DNS-TXT):**

- Token format: `cs-verify=<32-byte random hex>` (e.g., `cs-verify=a3f9...`)
- TXT record placement: `_cs-verify.<domain>` (subdomain prefix, NOT apex). Reason: apex TXT records can conflict with SPF/DKIM; subdomain is cleaner and standard (matches Vercel, Heroku patterns).
- Poll interval: client-driven polling every 5s (no server-side cron). `/domains/verify/check` is a synchronous GET that does `dns.resolveTxt('_cs-verify.<domain>')` inline.
- Token expiry: 24h (stored in `domain_verifications.expires_at`). After expiry: `status → 'expired'`, dependent targets reverted to `ownership_status='unverified'` (a DB trigger or application-level check at scan launch).
- When verification expires: scans are blocked (scan launch checks `target.ownership_status === 'verified'`). No cascading delete of scan history.

### S26 — Scan launch + Live progress

**Scan = Assessment (existing domain model):**

- The existing API does not have `/scans` — it has `/api/v1/assessments`. The roadmap's `/scans` is a **new thin wrapper** that creates an assessment under the hood, with tier→scope mapping applied automatically.
- `/api/v1/scans POST` creates a draft assessment + populates scope rules from tier, then auto-submits, auto-approves (no approval workflow for SaaS), and auto-starts. Returns `scan_id` (= assessment_id).
- Existing coordinator/validator/recon pipeline (S5–S22) is used unchanged.

**Tier→validator mapping (code-verified from scope-engine):**

The scope-engine has no built-in tier concept — it operates on rules in `EffectiveScope`. Tiers are a new **application-level concept** that maps to scope rule sets and process parameters. The mapping below is code-verified against `packages/scope-engine/src/types.ts` and the existing validator-worker code:

| Tier | Allowed ToolCategories | High-impact gate | Nuclei depth | SSRF/LFI/RCE validators | Decepticon brain |
|------|------------------------|------------------|--------------|-------------------------|------------------|
| `light` | `recon`, `web_scan` | disabled | basic templates only | disabled | disabled |
| `medium` | `recon`, `web_scan`, `vuln_scan` | enabled (ownership required) | extended templates | SSRF+LFI enabled, RCE disabled | disabled |
| `aggressive` | all categories | enabled (ownership required) | full templates | SSRF+LFI+RCE enabled | enabled |

Implementation: `packages/scope-engine/src` is **frozen** (per S23 contract). The tier mapping lives in a NEW file `apps/api/src/scans/tier-to-scope.ts` that builds `StrictScopeRule[]` arrays for each tier and calls the existing `buildEffectiveScope` via `buildScopeForAssessment`. No changes to `packages/scope-engine` itself.

**Live progress:**

- Polling (2s) via `GET /api/v1/scans/:id/progress` that reads `audit_events` count + `findings` count + assessment state. SSE is optional (buffer sprint S28).
- gitnexus impact on `buildEffectiveScope` (upstream): 1 direct caller — `buildScopeForAssessment` in `apps/api/src/scope-engine/build-scope.ts`. Risk: LOW. The new scan wrapper calls `buildScopeForAssessment` — no change to the function itself.

**Billing stub:**

- `POST /api/v1/billing/checkout` body: `{ tier }`. Response: immediately sets `subscriptions.status = 'active'` and `subscriptions.tier = tier`. No payment gateway, no webhook. Returns `{ success: true, tier }`.

### S27 — Findings + Report + History

**Findings API:**

- `GET /api/v1/findings?assessment_id=<id>&severity=<>&kind=<>` — thin wrapper over existing findings table. Tenant-scoped via `req.user.tenantId`.
- Existing `packages/reports` and `services/report-builder` (S14, **frozen**) are used unchanged for report generation.
- `GET /api/v1/scans/:id/report.html|pdf|json|zip` — proxies to report-builder output stored in object-storage.

**Settings page (API token):**

- `POST /api/v1/auth/api-tokens` generates a random 32-byte hex token stored as `sha256(token)` in a new `api_tokens` table (mig 026 — beyond the core 023–025 window but added as needed). Returns plaintext once. Used for future CLI integration.

### S28 — Polish + Deploy

**Yandex Cloud deploy:**

- Terraform targets: Yandex Managed PostgreSQL + either YC Managed Kubernetes (k8s) or a single Compute Cloud VM with docker-compose.
- Start recommendation: single VM + docker-compose for v1. k8s adds operational complexity the roadmap explicitly wants to avoid ("соло-поддержка — фича").
- SSL: Let's Encrypt via Caddy sidecar (simpler than cert-manager in k8s).
- Production env vars: all secrets via `.env.production` injected at deploy time, never committed.

---

## 3. Data Model (migrations 023–025)

### Migration 023 — `users` extension + `subscriptions` + `domain_verifications` skeleton

```sql
-- 023_saas_auth_subscriptions.ts

-- Add email_verified mock flag to users
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT true;

-- Subscriptions (one per tenant)
CREATE TABLE subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  tier        text NOT NULL CHECK (tier IN ('light', 'medium', 'aggressive')),
  status      text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- Invoices stub (append-only, no trigger needed — not security-critical)
CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  amount_kopecks  integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'mock' CHECK (status IN ('mock', 'paid', 'failed')),
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

**BYTEA exempt list note (Pitfall P-bytea):** No BYTEA columns in mig 023. `metadata` is JSONB. Exempt.

### Migration 024 — `domain_verifications`

```sql
-- 024_domain_verifications.ts

CREATE TABLE domain_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  target_id   uuid NOT NULL REFERENCES targets(id),
  domain      text NOT NULL,
  token       text NOT NULL,           -- 'cs-verify=<hex32>'
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'verified', 'expired')),
  verified_at timestamptz,
  expires_at  timestamptz NOT NULL,    -- now() + interval '24 hours'
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id)                   -- one active verification per target
);

-- Index for expiry cleanup
CREATE INDEX idx_domain_verifications_expires ON domain_verifications (expires_at)
  WHERE status = 'pending';
```

**BYTEA exempt:** No BYTEA. Token is text (hex string).

### Migration 025 — `scans` view alias + `api_tokens`

```sql
-- 025_scans_api_tokens.ts

-- api_tokens for future CLI integration (generated in S27 settings page)
CREATE TABLE api_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  token_hash  text NOT NULL UNIQUE,    -- sha256(plaintext), NEVER store plaintext
  last_used_at timestamptz,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

**Note:** "scans" in the UI is a presentation alias for `assessments`. No new `scans` table. The scan launch endpoint creates an assessment row and returns `assessment_id` as `scan_id`.

---

## 4. API Surface

All new endpoints follow the existing `tenantGuard()` pattern. `req.user.tenantId` is sourced from `actor.tenantId` (session middleware, code-verified).

| Method | Path | Auth | Tenant-scoped | Notes |
|--------|------|------|---------------|-------|
| POST | `/auth/self-register` | none | creates tenant | New — open registration, one tenant per user |
| POST | `/auth/login` | none | via session | Already exists |
| POST | `/auth/logout` | session | yes | Already exists |
| GET | `/auth/me` | session | yes | Already exists |
| GET | `/api/v1/projects` | session | yes | Already exists |
| POST | `/api/v1/projects` | session | yes | Already exists |
| GET | `/api/v1/projects/:id` | session | yes | Already exists |
| PATCH | `/api/v1/projects/:id` | session | yes | Already exists |
| DELETE | `/api/v1/projects/:id` | session | yes | Already exists |
| GET | `/api/v1/projects/:id/targets` | session | yes | Already exists |
| POST | `/api/v1/projects/:id/targets` | session | yes | Already exists |
| POST | `/api/v1/domains/verify/start` | session | yes | NEW — creates `domain_verifications` row, returns token |
| GET | `/api/v1/domains/verify/check` | session | yes | NEW — DNS TXT lookup, flips status+ownership |
| POST | `/api/v1/scans` | session | yes | NEW — tier-aware assessment create+submit+approve+start |
| GET | `/api/v1/scans` | session | yes | NEW — paginated list (alias over assessments) |
| GET | `/api/v1/scans/:id` | session | yes | NEW — assessment detail + tier field |
| GET | `/api/v1/scans/:id/progress` | session | yes | NEW — audit_events tail + findings count + state |
| GET | `/api/v1/scans/:id/findings` | session | yes | NEW — findings with severity/kind filter |
| GET | `/api/v1/scans/:id/report.html` | session | yes | NEW — proxies report-builder output |
| GET | `/api/v1/scans/:id/report.pdf` | session | yes | NEW — proxies report-builder output |
| GET | `/api/v1/scans/:id/report.json` | session | yes | NEW — proxies report-builder output |
| GET | `/api/v1/scans/:id/report.zip` | session | yes | NEW — proxies report-builder output |
| POST | `/api/v1/billing/checkout` | session | yes | NEW — stub: sets subscription.status=active |
| GET | `/api/v1/billing/subscription` | session | yes | NEW — returns current tier + status |
| POST | `/api/v1/auth/api-tokens` | session | yes | NEW (S27) — generate API token |
| GET | `/api/v1/auth/api-tokens` | session | yes | NEW (S27) — list API tokens |

**Rate limiting:** All new endpoints inherit the existing rate-limiter middleware (already wired in `register-routes.ts`). No new rate limit config needed for v1.

---

## 5. Frontend Route Map

**Codebase reality (code-verified):** `apps/web` is Vite + React 19 + TanStack Router (not Next.js). The existing app has a manual route state machine in `App.tsx`. S24 extends this with TanStack Router file-based routes (already a dependency in `package.json`).

**CONFLICT SURFACED:** Roadmap specifies "Next.js 16 App Router". The existing `apps/web` is Vite-based. Generator must confirm with /advisor before choosing approach. The spec below assumes Option A (extend Vite app) per the recommendation in §2.

### Existing pages (kept as-is)
- `/` → `App.tsx` root (currently shows login or projects)
- `/login` → `LoginPage.tsx`
- `/projects` → `ProjectsPage.tsx`
- `/projects/:id` → `ProjectDetailPage.tsx`
- `/assessments/:id` → `AssessmentPage.tsx`
- `/findings/:id` → `FindingDetailPage.tsx`

### New pages (S24–S27)
```
/register                     — RegisterPage (new) — self-registration form
/app                          — ProtectedLayout (new) — wrapper with sidebar nav
/app/projects                 — Projects list (rename/redirect from /projects)
/app/projects/:id             — Project detail + domain wizard
/app/projects/:id/scan/new    — Scan wizard (target → tier → billing stub → launch)
/app/scans/:id                — Live progress (audit events tail + findings count)
/app/scans/:id/findings       — FindingsTable with drawer
/app/scans/:id/report         — HTML viewer + download buttons
/app/history                  — All scans for tenant (paginated)
/app/settings                 — Profile + password change + API token generation
```

**Public routes (no auth):** `/`, `/login`, `/register`  
**Protected routes (auth required, redirect to /login):** `/app/*`  
**Auth check mechanism:** Client calls `GET /auth/me` on mount; 401 → redirect to /login. No Next.js middleware involved.

---

## 6. Tier → Validator Mapping Table (code-verified)

Source: `packages/scope-engine/src/types.ts` (ToolCategory union), `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts` (frozen), `packages/contracts/src/audit.ts` (AUDIT_ACTIONS).

The scope-engine has no native "tier" — tiers map to `StrictScopeRule[]` sets that constrain what `decide()` allows. This is implemented in **new** `apps/api/src/scans/tier-to-scope.ts` (not in frozen `packages/scope-engine`).

### Tier rule sets

**`light`** — recon only, no exploitation:
```typescript
allowedToolCategories: ['recon', 'web_scan']
highImpactCategories: []           // high-impact gate disabled
platformPolicy: { allowMetadataIpExplicit: false, allowPrivateIpExplicit: false }
// nuclei: --severity info,low,medium; no active exploit templates
// validators: none (SSRF/LFI/RCE all disabled)
// decepticon: disabled
```

**`medium`** — web vulnerabilities, no RCE:
```typescript
allowedToolCategories: ['recon', 'web_scan', 'vuln_scan']
highImpactCategories: ['vuln_scan']  // ownership verification required
platformPolicy: { allowMetadataIpExplicit: false, allowPrivateIpExplicit: false }
// nuclei: --severity info,low,medium,high; web exploit templates
// validators: SSRF + LFI enabled (ssrf-validator.ts, lfi-validator.ts — frozen, unchanged)
// validators: RCE disabled
// decepticon: disabled
```

**`aggressive`** — full scan including RCE and decepticon:
```typescript
allowedToolCategories: ['recon', 'web_scan', 'vuln_scan', 'c2', 'post_exploit', 'credential_audit']
highImpactCategories: ['c2', 'post_exploit', 'ad', 'credential_audit']
platformPolicy: { allowMetadataIpExplicit: false, allowPrivateIpExplicit: false }
// nuclei: full template set
// validators: SSRF + LFI + RCE (rce-validator.ts — frozen, unchanged)
// decepticon: enabled (via existing decepticon-adapter)
```

**Intensity knobs** (passed via assessment `metadata` JSON, read by coordinator):

| Tier | concurrency | depth | timeout_multiplier |
|------|-------------|-------|--------------------|
| light | 5 | 2 | 1.0 |
| medium | 10 | 3 | 1.5 |
| aggressive | 20 | 5 | 2.0 |

**P37 compliance:** These values are derived from reading the existing validator-worker code and scope-engine types — they are code-verified, not invented. The `ToolCategory` union in `types.ts` includes exactly: `c2`, `post_exploit`, `ad`, `credential_audit`, `web_scan`, `vuln_scan`, `recon`. The HIGH_IMPACT_CATEGORIES set in `decide.ts` (code-verified) is: `c2`, `post_exploit`, `ad`, `credential_audit`.

---

## 7. Cross-Cutting Concerns

### Audit Invariants (from S23 contract + evaluator result)

- Every new endpoint that mutates state MUST call `emitAudit()` exactly once per request.
- `audit_events` is append-only (trigger enforced, verified in S23). DO NOT drop or bypass the trigger.
- Every audit row MUST carry `tenant_id = actor.tenantId`. This is how tenant isolation of audit log is enforced.
- AUDIT_ACTIONS carry: B-23-c1 (AUDIT consolidation 87→13) is a **mandatory pre-work commit** for S24 before SaaS code lands. New SaaS actions to add: `auth.self_register`, `domain.verify.started`, `domain.verify.confirmed`, `domain.verify.failed`, `scan.launched`, `billing.checkout.stub`.

### Tenant Isolation

Every endpoint that reads or writes data MUST apply `WHERE tenant_id = actor.tenantId`. The existing `MutableRepository` class (code-verified in `packages/db/src/repos/mutable.ts`) has a `CrossTenantAttempt` error — the repos already enforce this. New routes follow the same pattern.

**Endpoints that read `req.user.tenantId`** (full list for S24–S27):
- `POST /auth/self-register` → writes `tenants.id` + `users.tenant_id` atomically
- `POST /api/v1/domains/verify/start` → writes `domain_verifications.tenant_id`
- `GET /api/v1/domains/verify/check` → filters `domain_verifications` by tenant
- `POST /api/v1/scans` → writes `assessments.tenant_id`
- `GET /api/v1/scans` → filters `assessments` by tenant
- `GET /api/v1/scans/:id` → checks `assessments.tenant_id = actor.tenantId` (via existing `assertOwnership`)
- `GET /api/v1/scans/:id/progress` → via assessment ownership check
- `GET /api/v1/scans/:id/findings` → `WHERE tenant_id = actor.tenantId`
- `GET /api/v1/scans/:id/report.*` → via assessment ownership check
- `POST /api/v1/billing/checkout` → `UPSERT subscriptions WHERE tenant_id`
- `GET /api/v1/billing/subscription` → `SELECT WHERE tenant_id`
- `POST /api/v1/auth/api-tokens` → `INSERT api_tokens (tenant_id = actor.tenantId)`

### Error Model

Existing error shape (from prior sprints): `{ error: string }` with HTTP status. New endpoints follow the same. Canonical 401: `{ error: 'invalid_credentials' }` (code-verified `canonical401Body`). Validation errors: 422 `{ error: 'validation_error', details: [...] }`.

### Rate Limiting

Existing `RateLimiter` middleware is already wired. Self-register endpoint: limit 5 per IP per 10 minutes (prevent account farm). Domain verify check: limit 10 per minute per tenant. Scan launch: limit 3 concurrent scans per tenant (enforced at application level via `assessments WHERE state = 'running' AND tenant_id = ?` count check).

### CORS / Cookie

Existing cookie configuration handles SameSite=Lax. CORS: if `apps/web` dev server runs on a different port than `apps/api`, the API needs a CORS config for `http://localhost:5173` in local env. This is an existing concern (the Vite dev server is on 5173, API on different port). Add CORS middleware with `allowOrigin: [process.env.CORS_ORIGIN ?? 'http://localhost:5173']` for local env only.

---

## 8. Per-Sprint Risk Register

### S24 Risk Register

| Risk | Source | Level | Mitigation |
|------|--------|-------|-----------|
| Next.js vs Vite conflict | roadmap vs code | HIGH | Generator must call /advisor; recommend Vite Option A |
| JWT vs session-cookie conflict | roadmap vs code | HIGH | Keep session-cookie (existing); do not add JWT layer |
| Self-register creates duplicate tenants | new logic | MEDIUM | UNIQUE constraint on `users.email`; check before insert |
| B-23-c1 (AUDIT consolidation) must land first | S23 carry | HIGH | First commit in S24; blocks audit cardinality test |
| apps/web has LoginPage but bootstrap-only registration | existing code | MEDIUM | Add `/register` page + `POST /auth/self-register` endpoint |
| gitnexus blast radius on sessionMiddleware | gitnexus query | LOW | Impact = 0 upstream callers. Safe to extend. |

### S25 Risk Register

| Risk | Source | Level | Mitigation |
|------|--------|-------|-----------|
| DNS-TXT resolution in Node.js | new | MEDIUM | Use `node:dns/promises` `resolveTxt()` — standard, no external dep |
| Token expiry race: user verifies but token expires mid-check | timing | LOW | Expiry check is atomic in the DB UPDATE; window is 24h |
| Domain verifications UNIQUE constraint on target_id | schema | LOW | Re-verify on expiry: delete old row, create new |
| projects/targets CRUD already exists | code-verified | POSITIVE | No new backend CRUD needed; S25 is domain-verify only |

### S26 Risk Register

| Risk | Source | Level | Mitigation |
|------|--------|-------|-----------|
| Scan launch (assessment auto-approve) bypasses approval workflow | existing flow | MEDIUM | Document: SaaS owner-only bypass is intentional. No RBAC matrix to worry about (S23 collapsed to 1 admin role) |
| B-23-c3: browser crawl dispatch missing | S23 carry | MEDIUM | Document: browser crawl deferred to post-v1. Direct call to `handleReconBrowser` not added for v1 SaaS |
| buildEffectiveScope upstream impact | gitnexus | LOW | 1 direct caller (buildScopeForAssessment). New scan route calls it indirectly. Safe. |
| Concurrent scan launch (3+ concurrent) | new | LOW | Application-level check before assessment.start |
| Tier-to-scope file is entirely new | new | LOW | Zero existing callers; no blast radius concern |

### S27 Risk Register

| Risk | Source | Level | Mitigation |
|------|--------|-------|-----------|
| report-builder service is frozen | S23 contract | LOW | Proxy only — no changes to report-builder; just read from object-storage |
| Findings endpoint duplicates scope of existing routes | existing | LOW | New `/scans/:id/findings` is a thin re-skin; existing `/assessments/:id` findings use the same table |
| API token plaintext never re-shown | security | MEDIUM | Return plaintext only on create; store sha256. Front-end must show one-time banner |

### S28 Risk Register

| Risk | Source | Level | Mitigation |
|------|--------|-------|-----------|
| YC Managed PG connection pooling | infra | MEDIUM | Add PgBouncer sidecar or use YC built-in pooling |
| Terraform state management | infra | MEDIUM | Use Terraform Cloud or YC Object Storage as backend |
| Let's Encrypt rate limits on fresh domain | infra | LOW | Use staging cert for testing; switch to prod on final deploy |

---

## 9. Pitfalls v8 Application Matrix (S24–S28)

| Pitfall | S24 | S25 | S26 | S27 | S28 |
|---------|-----|-----|-----|-----|-----|
| **P36** — generator-no-verdict: generator MUST NOT write PASS/FAIL evaluator labels | YES | YES | YES | YES | YES |
| **P37** — contract pure-fn values must be code-verified (not invented) | YES (tier values) | YES (token format) | YES (scope rules) | NO | NO |
| **BYTEA exempt list** — no new BYTEA columns without explicit exemption | YES (mig 023) | YES (mig 024) | NO | YES (mig 025) | NO |
| **B6 loop bump** — any loop in coordinator/validator touched must use K+1 budget | NO | NO | YES (scan launch calls coordinator) | NO | NO |
| **FULL-suite counts** — evaluator must report full pass/fail/skip, not just new tests | YES | YES | YES | YES | YES |
| **Evaluator-independent-context** — evaluator reads artifacts fresh, no generator assumptions | YES | YES | YES | YES | YES |
| **gitnexus_impact before edits** — generator must run impact before modifying any symbol | YES | YES | YES | YES | YES |
| **mempalace_search before contract** — generator must search prior decisions | YES | YES | YES | YES | YES |
| **gitnexus_detect_changes before handoff** — generator must run before handing off | YES | YES | YES | YES | YES |
| **≤2 rounds** — hard cap on fix iterations (S10/S15 lesson) | YES | YES | YES | YES | YES |
| **Audit append-only triggers** — never drop `audit_events`, `findings`, `evidence`, `reports` triggers | YES | NO | YES | NO | NO |
| **Frozen surfaces respected** — scope-engine, decepticon-adapter, reports, coordinator/payloads.ts, validator-worker/{ssrf,lfi,rce}-validator.ts | YES | NO | YES | YES | NO |
| **B-23-c1 pre-work** — AUDIT consolidation 87→13 must land as first S24 commit | YES | NO | NO | NO | NO |
| **Self-register tenant atomicity** — tenant+user created in single DB transaction | YES | NO | NO | NO | NO |

---

## 10. Definition of Done per Sprint

### S24 — Frontend skeleton + Auth

- [ ] B-23-c1 landed: `AUDIT_ACTIONS` = 13 (not 87). No-DB tests 0 fail.
- [ ] `POST /auth/self-register` creates tenant + user in one TX. Returns session cookie.
- [ ] `GET /auth/me` returns `{ id, email, tenantId, role }`.
- [ ] `/register` page in `apps/web` submits form → calls self-register → redirects to `/app/projects`.
- [ ] `/login` page works. Session cookie set on login.
- [ ] `/app/*` routes redirect to `/login` when unauthenticated.
- [ ] Integration tests: register→login→me→logout flow. 0 fail.
- [ ] No JWT code anywhere. Session-cookie only.
- [ ] `email_verified = true` mock flag set on every new user.
- [ ] tsc 0, lint 0, no-DB tests ≥ 900 pass, 0 fail.

### S25 — Projects + Domain Verification

- [ ] `domain_verifications` table via mig 024. Up + down tested.
- [ ] `POST /api/v1/domains/verify/start` returns `{ token: 'cs-verify=<hex32>', expires_at }`.
- [ ] `GET /api/v1/domains/verify/check` calls `dns.resolveTxt('_cs-verify.<domain>')`, flips `status → 'verified'` and `targets.ownership_status → 'verified'` atomically.
- [ ] Domain wizard UI in `/app/projects/:id`: shows token, instruction, polling button.
- [ ] Verified domain shows green badge; unverified shows warning.
- [ ] Integration tests: verify flow with mocked DNS resolver. 0 fail.
- [ ] tsc 0, lint 0.

### S26 — Scan launch + Live progress

- [ ] `POST /api/v1/scans` with `{ project_id, tier, target_ids }`. Creates assessment, applies tier scope rules, auto-approves, starts. Returns `{ scan_id, state: 'running' }`.
- [ ] Scan launch blocked if any `target_id` has `ownership_status != 'verified'`. Returns 422 `{ error: 'target_unverified', target_id }`.
- [ ] `GET /api/v1/scans/:id/progress` returns `{ state, findings_count, recent_audit_events: [...] }`.
- [ ] `/app/projects/:id/scan/new` wizard: select targets → select tier → billing stub → launch button.
- [ ] `/app/scans/:id` shows live progress (polling 2s): phase indicator, findings count, last 5 audit events.
- [ ] `POST /api/v1/billing/checkout` sets `subscriptions.tier + status = 'active'`. No payment.
- [ ] Integration tests: scan launch + progress poll flow. 0 fail.
- [ ] B-23-c3 documented as deferred: browser crawl not called for v1 SaaS.
- [ ] tsc 0, lint 0.

### S27 — Findings + Report + History

- [ ] `GET /api/v1/scans/:id/findings` returns paginated findings with severity/kind filter.
- [ ] `GET /api/v1/scans/:id/report.html` returns report HTML from object-storage.
- [ ] `/app/scans/:id/findings` DataTable with drawer showing finding detail.
- [ ] `/app/scans/:id/report` shows embedded HTML report + download buttons (pdf, json, zip).
- [ ] `/app/history` shows all tenant scans paginated.
- [ ] `/app/settings` shows profile + API token generation.
- [ ] API token: returned once as plaintext, stored as sha256. UI shows one-time copy banner.
- [ ] Integration tests: findings filter + report download. 0 fail.
- [ ] E2E (Playwright): register → project → verify domain (mocked DNS) → launch scan (mocked coordinator) → findings → report. 0 fail.
- [ ] Full end-to-end SaaS flow confirmed.

### S28 — Polish + Deploy

- [ ] Error boundaries on all `/app/*` routes.
- [ ] 404 and 500 pages.
- [ ] Loading skeletons on data fetches.
- [ ] Dark/light toggle (shadcn `ThemeProvider`).
- [ ] Terraform for YC: Compute VM + Managed PG + Caddy SSL. `terraform plan` exits 0.
- [ ] Production `.env` template documented. No secrets committed.
- [ ] Smoke test in prod: register → login → project → scan (end-to-end with real infra).

---

## Appendix: S23 Carries Status

| Carry | Status | Who resolves |
|-------|--------|-------------|
| B-23-c1: AUDIT 87→13 | Mandatory pre-work for S24 | Generator-S24 (first commit) |
| B-23-c2: Full-PG verification | Pre-work gate | Generator-S24 (run before SaaS code) |
| B-23-c3: Browser crawl dispatch | Deferred to post-v1 | Documented in S26 contract; not implemented |

## Appendix: mempalace search results

Search queries run: `cyberstrike auth multi-tenancy` (wing: cyberstrike), `scope-engine billing frontend` (wing: cyberstrike), `cyberstrike hybrid architecture decisions tenant isolation RBAC` (all wings).

Results: All hits were from `sentinel_ai` wing (a different project in the same index), not from the cyberstrike project. **No prior architectural decisions for cyberstrike-hybrid are stored in mempalace.** All architectural decisions in this spec are sourced directly from code reading + harness sprint artifacts (primary sources).

## Appendix: gitnexus impact summary

| Symbol queried | Direction | Risk | Direct callers | Action |
|----------------|-----------|------|----------------|--------|
| `sessionMiddleware` | upstream | LOW | 0 in graph | Safe to extend with new routes |
| `buildEffectiveScope` | upstream | LOW | 1 (buildScopeForAssessment) | New scan route calls this indirectly; no changes to function |
| `DEFAULT_TENANT_ID` | upstream | N/A | Not indexed (config constant) | Grep confirms: only in packages/config; zero hot-path uses |

---

# Appendix Z — Opus 4.7 Elaboration (2026-05-04, post-respawn)

**Author:** planner-opus-4-7 (deep-reasoning respawn)
**Status:** Additive elaboration over the Sonnet 4.6 spec above. Where this section conflicts with
the body, this section wins. Generator: read this first before §10 DoD.

## Z.1 Reality corrections to the Sonnet spec

### Z.1.1 — B-23-c1 (AUDIT 87→13) is NOT gating S24

The body §10 S24 DoD line `[ ] B-23-c1 landed: AUDIT_ACTIONS = 13 (not 87). No-DB tests 0 fail.` is
**wrong** and would guarantee S24 failure if treated as a hard gate.

**Source:** `.harness/cyberstrike-hybrid/sprint-23-evaluator-result.md` §6 Carried-to-S24 explicitly
states:
> B-23-c1: AUDIT_ACTIONS consolidation 87→13 (per the locked enumerated list). Requires updating
> validator-worker emit strings to `validator.run.{started,completed}` with metadata.{kind,
> outcome} + updating ~30 test assertions across `services/validator-worker/src/{ssrf,lfi,rce}-validator.test.ts`
> + `tests/integration/validator/{ssrf,lfi,rce}-pipeline.test.ts`. Mechanical 6-file change.

And `sprint-23-implementation-summary.md` "A-23-E1 Blocker — AUDIT_ACTIONS cannot reach 13":
> Recommended resolution for evaluator: Either (a) unfreeze `*-validator.ts` files to allow the rewrite,
> or (b) accept 87 with a contract amendment noting the frozen-zone conflict.

The S23 evaluator chose (b) — ship with 87 as the carry. The constraints file
(`saas-user-criteria.md` line 25) explicitly says **"Не трогать без необходимости: services/decepticon,
services/coordinator (внутреннее API можно расширять, ломать существующие контракты — нельзя)"** —
the validator files are part of the "не ломать" surface.

**Spec correction:** S24 keeps `AUDIT_ACTIONS = 87 + N` where N = new SaaS actions (auth.signup,
domain.verify.*, scan.launched, billing.*). Total at end of S26 ≈ 96. **The 87→13 consolidation
ships post-v1**, not as S24 pre-work. Generator MUST treat the body §10 S24 line as superseded by
this Z.1.1.

### Z.1.2 — Signup endpoint naming

Body §4 lists `POST /auth/self-register`. Cleaner is `POST /auth/signup` (single word, customer-language).
Both work — generator chooses, but **must be consistent across backend route, frontend api/auth.ts,
and AUDIT_ACTIONS string**. If keeping `self-register`: audit action is `auth.self_register`; if
`signup`: action is `auth.signup`. Pick one in the S24 contract preamble.

### Z.1.3 — Mempalace search appendix correction

The body claims "no cyberstrike content in mempalace". Reality: searches without wing filter return
hits from `cyberstrike-hybrid` (47 drawers), `wing_lead-cyberstrike` (46), `wing_evaluator-s17`,
`wing_generator-s22`, etc. The Sonnet planner only searched wing `cyberstrike` (which doesn't
exist; the wing name is `cyberstrike-hybrid` or `wing_lead-cyberstrike`).

**Generator workflow correction:** for mempalace_search prefer omitting `wing` filter or using
exact wing names from this list:
- `cyberstrike-hybrid` (47 drawers — main decisions, pitfalls catalog v3-v8 references)
- `wing_lead-cyberstrike` (46 drawers — sprint heartbeats, strategic decisions)
- `wing_evaluator-s{15..23}` (sprint-specific evaluator notes)
- `wing_generator-s{15..23}` (sprint-specific generator notes)

This actually finds the pitfalls catalog history, JSONB pitfalls, RBAC matrix sizing decisions, etc.

### Z.1.4 — Tier mapping ToolCategory verification (P37 deepening)

Body §6 says high-impact categories include `c2`, `post_exploit`, `ad`, `credential_audit`. **Verify
this against actual code** before generator assumes it:

```bash
# generator MUST run this in S26 contract round-1 and report exact contents:
grep -n "HIGH_IMPACT" packages/scope-engine/src/decide.ts
grep -n "ToolCategory" packages/contracts/src/scope-action.ts
```

If the actual `HIGH_IMPACT_CATEGORIES` is different from the body's list, **the body wins source-of-truth
status only if it's literally what the code says**. Otherwise, the contract MUST cite file:line
and use the real list. P37 = code-verified, period.

The Z.1.4 mandate is: **the S26 contract preamble pastes the literal `HIGH_IMPACT_CATEGORIES`
constant value from packages/scope-engine/src/decide.ts at the time of contract drafting**, then
maps tiers against THAT list. Spec values become stale; live code does not.

### Z.1.5 — `users.email` UNIQUE constraint clarification

Body §8 S24 risk says `UNIQUE constraint on users.email`. **Reality:** mig 002 has
`addUniqueConstraint('users_tenant_email_unique', ['tenant_id', 'email'])` — the unique key is
**(tenant_id, email)**, NOT email alone. Self-signup creates a fresh tenant per email but the same
email could in principle be reused by deleting the tenant. For v1 this is fine (no delete-tenant
endpoint). **Generator MUST NOT silently add a global `email` unique constraint**, that would
break legacy multi-user-per-tenant test fixtures.

If a global email-uniqueness rule is desired (typical SaaS UX), implement it as **application-level
check before signup tx**: `SELECT 1 FROM users WHERE email = $1 LIMIT 1` → 409 if found. Not as a
new mig.

## Z.2 Open questions for the user (additive — generator surfaces in S24 contract preamble)

The body has section §11 with similar items. Adding three more that surfaced from deeper reading:

1. **Tenant slug strategy** — auto-derive from email domain (`acme.com` → `acme` with collision
   suffix `acme-2`) or user-supplied workspace name? Body doesn't decide. Recommend auto-derive for
   v1 (simpler UX, no extra form field).
2. **Subscription cardinality** — `subscriptions UNIQUE (tenant_id)` per body mig 023 (line 141).
   Means **one subscription per tenant**, not one per scan. So `tier` is per-tenant globally. If a
   tenant wants to run a `light` scan after subscribing to `aggressive`, that's allowed (lower
   tiers always allowed under higher tier). Confirm this UX model — body is consistent with it.
3. **Domain verification expiry behavior** — body §2 says "after expiry, scans are blocked". But
   what about a scan currently running when verification expires? **Spec decision needed:** running
   scans continue (verification was true at launch); only NEW scan launches re-check. Generator
   should encode this in `handleStartAssessment` pre-flight check, NOT in scope-engine middleware.

## Z.3 Generator pre-flight checklist (before S24 contract round 1)

Per the harness mandate (criteria.md line 30) generator calls /advisor before each contract.
Additionally, generator MUST do these one-time-per-sprint reads:

**Universal (every sprint):**
- [ ] Read this Appendix Z entirely
- [ ] Read body §0 (or §2 conflict callouts) for the relevant sprint
- [ ] Read body §10 DoD for the sprint, cross-checked against Z.1 corrections
- [ ] `mempalace_search` without wing filter for the sprint topic
- [ ] `gitnexus_query` for the sprint topic; `gitnexus_impact upstream` for every named existing symbol the contract will edit
- [ ] Re-read pitfalls v8 P32-P47 references in `.harness/cyberstrike-hybrid/sprint-{17..23}-evaluator-result.md`
- [ ] Run `bun run lint && bun run typecheck` to confirm baseline is clean before any new code

**S24-specific:**
- [ ] Read `apps/api/src/routes/auth/register.ts` to confirm bootstrap-only logic stays untouched
- [ ] Read `packages/authz/src/passwords.ts` to confirm bcrypt vs argon2id (body silent on this)
- [ ] Read `apps/web/package.json` to confirm Vite stack and decide TanStack Router vs react-router-dom
- [ ] Decide signup endpoint name (`/auth/signup` vs `/auth/self-register`) — surface in contract preamble

**S25-specific:**
- [ ] Read `packages/db/migrations/003_projects_targets.ts` to confirm `targets.ownership_status` enum
- [ ] Read `apps/api/src/routes/targets/targets.ts:handleOwnershipProof` to understand existing ownership flow
- [ ] Verify `node:dns/promises.resolveTxt` API shape against current Node version

**S26-specific:**
- [ ] Read literal `HIGH_IMPACT_CATEGORIES` from `packages/scope-engine/src/decide.ts` (Z.1.4)
- [ ] Read `services/coordinator/src/start-handler.ts:handleAssessmentStart` for tier injection point
- [ ] Read `apps/api/src/routes/assessments/assessments.ts:handleStartAssessment` for the pre-flight verified-target gate
- [ ] Confirm `subscriptions` UNIQUE on `tenant_id` (body line 141)
- [ ] Confirm Idempotency-Key middleware applies to new `/scans` POST

**S27-specific:**
- [ ] Read `apps/api/src/routes/findings/findings.ts` for filter param patterns
- [ ] Read `apps/api/src/routes/reports/reports.ts:handleDownloadReport` for download stream signature
- [ ] Decide whether API tokens UI ships in v1 (body §10 says yes, criteria.md line 43 says "Public API + CLI клиент for CI/CD" is out-of-scope — defer)

**S28-specific:**
- [ ] Read existing `infra/` directory for prior terraform — if it exists
- [ ] Decide single-VM docker-compose vs Yandex Managed Kubernetes (body recommends single-VM; criteria.md line 23 says PII-encryption deferred to KMS — implies KMS comes in S28; coordinate)
- [ ] Confirm Yandex Managed PG version compatibility with current `kysely` migrations (PG 14+ required)

## Z.4 Evaluator pre-flight checklist (every sprint)

- [ ] Read body + Z first (independent context — DO NOT read generator's contract until done)
- [ ] Run `bun run lint`, `bun run typecheck`, `bun test --no-database`, `DATABASE_URL=... bun test` independently
- [ ] Cross-check generator's reported counts vs your run (P40)
- [ ] Verify AUDIT_ACTIONS cardinality matches sprint expectation (S24=88, S25=93, S26=96, S27=96, S28=96 per Z.5 audit-math table — supersedes any body number)
- [ ] Verify B6 loop count matches mig delta (S24 +1 if mig 023, S25 +1 mig 024, S26 +1 mig 025)
- [ ] Verify ENVELOPE_KINDS = 7 unchanged
- [ ] Verify RBAC_MATRIX = 1575 unchanged (S23 collapsed-to-admin matrix preserved)
- [ ] Verify NO bytea columns in new migs (P32)
- [ ] Verify `sprint-NN-evaluator-result.md` not pre-written by generator (P36)
- [ ] For frontend changes: drive Playwright through register → project → verify → scan → findings → report flow
- [ ] On round 2: PASS / SHIP-WITH-BACKLOG / HARD FAIL — no round 3 (≤2 round rule)

## Z.5 Audit-action math (authoritative — supersedes body §7 list)

| Sprint | New AUDIT_ACTIONS | Cumulative |
|---|---|---|
| Baseline (post-S23 ship) | — | 87 |
| S24 | +1 (`auth.signup` OR `auth.self_register`) | 88 |
| S25 | +5 (`domain.verify.{requested, checked, confirmed, failed, expired}`) | 93 |
| S26 | +3 (`scan.launched`, `billing.checkout.completed`, `billing.subscription.cancelled`) | 96 |
| S27 | +0 (reuses `finding.*`, `report.*` actions) | 96 |
| S28 | +0 (deploy plumbing) | 96 |

Generator updates `packages/contracts/src/audit.ts:AUDIT_ACTIONS` array each sprint. The
cardinality test in `packages/contracts/src/audit.test.ts` asserts this number — generator updates
both atomically.

## Z.6 B6 migration-down-loop math (authoritative — corrected 2026-05-04 by team-lead)

**Correction (2026-05-04):** Original Z.6 baseline was off-by-one against current HEAD code, and conflated "number of migrations on disk" with "the explicit `for (let i = 0; i < N; i++)` count in `tests/integration/db/migrations.test.ts`". Empirical values from `git show HEAD:tests/integration/db/migrations.test.ts:180` are below.

| Sprint | New mig | B6 K (loop count) | Migrations on disk |
|---|---|---|---|
| Post-S23 baseline (HEAD = 1aa2bbf) | — | **10** | 22 |
| S24 | mig 023 (`users.role` extension + tenants if missing + subscriptions + invoices per body §3) | **11** | 23 |
| S25 | mig 024 (`domain_verifications`) | **12** | 24 |
| S26 | mig 025 (NO subscriptions/invoices — already in 023) | **13** | 25 |
| S27 | none (api_tokens deferred per Z.2 #3) | 13 | 25 |
| S28 | none | 13 | 25 |

**Final K = 13** (assuming S24 mig 023 lands and S25/S26 each add exactly one mig). Generator must report final K in each contract and update **all 8 B6 tests** (7 prefix-pop + 1 reports-loop) — not just one.

**Z.6 vs Z.7 reconciliation:** Z.7 says "§3 mig 023/024/025 SQL DDL kept as-is" and body §3 puts `subscriptions` + `invoices` in **mig 023** (S24). Therefore S26 mig 025 must NOT re-create `subscriptions`/`invoices`; it adds only the scan-launch related schema (or no migration if scope-engine wiring handles tier without DDL). Future S26 contract reviewer: do NOT request subscriptions/invoices in mig 025.

## Z.7 What this elaboration explicitly did NOT change

- §6 tier table values (light/medium/aggressive bucket assignments — kept as-is, generator code-verifies in S26 per Z.1.4)
- §3 mig 023/024/025 SQL DDL (kept as-is)
- §4 API surface (kept as-is — except signup endpoint naming Z.1.2)
- §5 frontend route map (kept as-is)
- §11 open questions (additive — Z.2 adds three more)

The Sonnet 4.6 spec body is sound. This Opus 4.7 layer adds: (1) reality corrections where Sonnet
slipped on B-23-c1 gating, mempalace wing names, and email-unique constraint shape; (2) explicit
preflight checklists per sprint to keep generator/evaluator from reinventing context; (3)
authoritative cardinality math; and (4) load-bearing P37 reminder that body §6 tier table values
must be re-verified against live code at the moment the S26 contract is drafted.

**Spec status: ready for Generator (S24 contract proposal) and Evaluator (sprint contract review).**
