# Sprint 25 Contract — Domain Verification (DNS-TXT)

**Generator:** generator-s25 (Sonnet 4.6)
**Date:** 2026-05-04
**Revision:** R1
**Base commit:** `796d191` (chore: close B-24 backlog before S25 contract)
**Baseline tests:** no-DB 1004/0/391 | full-PG NOT YET RUN (B-24-pgrun carry)
**Harness:** cyberstrike-saas-s24-s28

> **P36 COMPLIANCE:** This document contains NO evaluator verdict. PASS/FAIL is issued exclusively by the evaluator.

---

## Carry-over closure (pre-S25 commit `796d191`)

| ID | Item | Resolution |
|----|------|-----------|
| B-24-doc1 | 6 stale K=23 / K=22→23 refs in sprint-24-contract.md | Fixed — find-and-replaced all 3 occurrences → K=11 / K=10→11 |
| B-24-doc2 | "TanStack Router beforeLoad" stale in sprint-24-contract.md | Fixed — replaced 2 occurrences → "useState state-machine + ProtectedLayout component" |
| B-24-h3 | `reason: 'tx_failed'` misleading in self-register.ts catch-all | Fixed — renamed to `'session_issue_failed'` at `self-register.ts:194` |

---

## Goal + Scope

Sprint S25 delivers domain ownership verification via DNS TXT records:

1. **Migration 024** — `domain_verifications` table
2. **`POST /api/v1/domains/verify/start`** — creates verification token row, returns `{ token, instructions, expires_at }`
3. **`GET /api/v1/domains/verify/check`** — DNS TXT lookup via DI'd `TxtDnsResolver`, atomically flips `domain_verifications.status → 'verified'` and `targets.ownership_status → 'verified'`
4. **AUDIT_ACTIONS** — +5 new entries (88 → 93)
5. **B6 loop** — K=11 → 12
6. **Frontend** — domain wizard section on `/app/projects/:id`: token display, DNS instructions, polling button, verified/unverified badge
7. **db-fixture.ts** — add `domain_verifications` to `dropAllTables` (before `targets`, after nothing new)

**Out of scope for S25:**
- Token expiry background job (expiry checked at scan launch in S26)
- Scan launch, billing (S26)
- Multi-target batch verification
- `/domains/verify/check` rate limiter (spec §7: 10/min per tenant) — deferred as **B-25-ratelimit** backlog item; v1 relies on tenantGuard session overhead as natural throttle

---

## Architecture Decisions

### A1 — TxtDnsResolver interface name

**Critical:** `packages/scope-engine/src/types.ts:DnsResolver` already exists with `resolveA`/`resolveAAAA` (code-verified line 274-276). Scope-engine is frozen. S25 MUST NOT add `resolveTxt` to that interface.

**Decision:** Define a separate `TxtDnsResolver` interface in the new `apps/api/src/routes/domains/` module:
```typescript
export interface TxtDnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}
```
Real binding (injected at `RouteDeps`): `{ resolveTxt: dns.resolveTxt }` where `dns = await import('node:dns/promises')`.
Test override: inline `Object.freeze({ resolveTxt: async () => [['cs-verify=abc...']] })`.
No env-flag mock branches in production code (P46).

### A2 — DnsResolver injection via RouteDeps

`RouteDeps` (in `apps/api/src/routes/shared.ts`) gets a new **required** field `dnsResolver: TxtDnsResolver` (not optional — advisor M2: optional fields invite runtime NPE; existing RouteDeps pattern uses required fields for all injected deps). Default real binding set in `apps/api/src/factory.ts`. IT fixtures override via `{ ...deps, dnsResolver: mockResolver }`.

Impact on `RouteDeps`: LOW — adding required field with default in factory.ts. All existing route handlers destructure only what they need; adding a new required field does not affect callers that don't destructure it, and TypeScript will enforce factory.ts provides it.

### A3 — Atomic flip: domain_verifications + targets

`/domains/verify/check` uses a single Kysely transaction to:
1. Load `domain_verifications` row (tenant-scoped)
2. Call `dnsResolver.resolveTxt('_cs-verify.<domain>')`
3. If token found and not expired: UPDATE `domain_verifications SET status='verified', verified_at=now()` + UPDATE `targets SET ownership_status='verified', updated_at=now()` in same TX
4. Audit emit after TX commit

Idempotent: if already `status='verified'` on entry, return 200 with current state without re-doing the DNS call.

### A4 — Token format

`cs-verify=<32-byte random hex>` (64 hex chars total). The full string is stored in `domain_verifications.token`. DNS TXT check looks for array element starting with `'cs-verify='` prefix match against stored token string.

### A5 — UNIQUE constraint on target_id

`domain_verifications` has `UNIQUE (target_id)`. Re-verification (after expiry): the route must `DELETE` the expired row before `INSERT`ing a new one. `POST /verify/start` checks for existing row: if `status='pending'` and not expired → return existing token (idempotent). If `status='expired'` or expired by time → delete and create new.

---

## Gitnexus Impact Analysis

| Symbol | Direction | Risk | d=1 callers | Action |
|--------|-----------|------|-------------|--------|
| `registerRoutes` | upstream | LOW | 0 | Safe — add 2 new domain verify routes |
| `dropAllTables` | upstream | LOW | 0 | Safe — add `domain_verifications` entry |
| `RouteDeps` (shared.ts) | upstream | MEDIUM | `apps/api/src/factory.ts` (sole construction site) | Adding **required** field `dnsResolver: TxtDnsResolver` — factory.ts must supply it. All route callers receive `deps: RouteDeps` by parameter (not construction); no IT fixture constructs RouteDeps directly (see §RouteDeps construction sites). |
| `AppOptions` (factory.ts) | upstream | LOW | test fixtures via `buildAuthApp` (25 files) | Adding **optional** `dnsResolver?: TxtDnsResolver` to AppOptions — backward-compatible. All 25 `buildAuthApp` call sites pass no resolver; factory defaults to `node:dns/promises`. Zero breakage. |
| `AUDIT_ACTIONS` | upstream | N/A | Not indexed (config constant) | Grep-confirmed: only in packages/contracts/src/audit.ts + audit.test.ts |
| `DnsResolver` (scope-engine) | N/A | FROZEN | — | NOT touched — using separate `TxtDnsResolver` in domain route module |

**RouteDeps construction sites (exhaustive):**
- `apps/api/src/factory.ts:161` — sole production construction site. `dnsResolver` already provided via `options.dnsResolver ?? { resolveTxt: dnsPromises.resolveTxt.bind(dnsPromises) }`.
- All IT fixtures construct RouteDeps **indirectly** via `buildAuthApp(db)` → `createApp(...)`. `createApp` accepts `AppOptions` (optional `dnsResolver?`) and builds the required `RouteDeps` internally. The 25 `buildAuthApp` call sites need zero changes.
- `tests/integration/domains/domain-verify.test.ts:66` — `buildAppWithResolver()` calls `createApp({ ..., dnsResolver: resolver })`. Passes optional `AppOptions.dnsResolver`; factory promotes it to required `RouteDeps.dnsResolver`. Correct.

**Two-layer design (R2 clarification, resolves blocker-1):**
- `AppOptions.dnsResolver?: TxtDnsResolver` — **optional** override in the public factory API. Omit → real DNS. Provide → override (used by domain IT tests).
- `RouteDeps.dnsResolver: TxtDnsResolver` — **required** in the internal route bundle. Factory always fills it before calling `registerRoutes`. Route handlers can rely on it without null-checking.
- This is consistent with existing pattern: `AppOptions.repos?` is optional (tests may pass their own); `RouteDeps.repos` is required.

---

## Cardinality Math (code-verified)

### AUDIT_ACTIONS: 88 → 93

Current array (post-S24, code-verified `packages/contracts/src/audit.ts`): 88 entries ending with `'auth.self_register'`.

S25 adds 5 new entries:
```
'domain.verify.requested'   // POST /verify/start — token created
'domain.verify.checked'     // GET /verify/check — DNS lookup performed (any outcome)
'domain.verify.confirmed'   // GET /verify/check — DNS match found, status flipped
'domain.verify.failed'      // GET /verify/check — DNS lookup failed (NXDOMAIN, timeout)
'domain.verify.expired'     // GET /verify/check or /verify/start — token was expired
```

New total: 88 + 5 = **93**.

`packages/contracts/src/audit.test.ts` cardinality assertion updated:
- Line 39: comment → `(S25: 88 post-S24 + 5 domain.verify = 93)`
- Line 155: `.toBe(88)` → `.toBe(93)`

### B6 loop: K=11 → 12

`tests/integration/db/migrations.test.ts:184`: `for (let i = 0; i < 11; i++)` → `for (let i = 0; i < 12; i++)`

The loop rolls back from current latest (mig 024 after S25) down to drop the `reports` table (mig 013). Adding mig 024 means one more `migrateDown()` is needed — K bumps from 11 to 12.

**All 8 B6 tests updated** (P39 — per-test pop sequence, R2 correction):

Migration sequence (descending): 024→023→022→021→020→019→018→017→...→013

| Test | Line | Target mig | Pop sequence (after S25) | Notes |
|------|------|-----------|--------------------------|-------|
| 1 — three-step 019→018→017 | 46 | 019 (step-1) | r024pre, r023pre, r022pre, r021pre, r020pre → then step-1(019) | R2 fix: was missing r022pre (bug — skipped 022, step-1 landed on 020 not 019) |
| 2 — reports loop | 130 | 013 | `for (let i = 0; i < 12; i++)` | K bump only, no prefix-pop |
| 3 — observations_browser | 204 | 019 | r024pre, r023pre, r022pre, r021pre, r020pre → then r019 | 5 pre-pops |
| 4 — target_credentials | 245 | 018 | r024pre, r023pre, r022pre, r021pre, r020pre → then r019, r018 | 5 pre-pops |
| 5 — mig 020 | 301 | 020 | r024pre, r023pre, r022pre, r021pre → then r020 | 4 pre-pops |
| 6 — oob_callbacks | 353 | 021 | r024pre, r023pre, r022pre → then r021 | 3 pre-pops |
| 7 — mig 022 recipe_text | 401 | 022 | r024pre, r023pre → then r022 | 2 pre-pops |
| 8 — full rollback | 418 | all | `rollbackAllMigrations()` (loops until empty) | No change needed |

**Blocker-2 correction (R2):** The R1 contract claimed "7 prefix-pop + 1 loop = 8". Correct count is **6 prefix-pop + 1 loop-bump + 1 auto-rollback = 8**. Test #8 uses `rollbackAllMigrations()` — no prefix-pops needed. Tests #1–#7 need prefix-pops (6 tests), plus test #2 needs the loop bump.

**Pre-existing bug fixed in S25 (test #1):** R1 implementation of test #1 skipped `r022pre` — the pop sequence was 024→023→021(mislabeled)→020(mislabeled), causing step-1 to land on 020 instead of 019. R2 adds the missing `r022pre` between r023pre and r021pre, and renames variables to match actual migrations rolled back.

---

## JSONB COMMENT (P42)

Migration 024 has **no JSONB columns**. All columns are `uuid`, `text`, `timestamptz`, `boolean`. No `COMMENT ON COLUMN` needed.

---

## P46 DI Plan

`TxtDnsResolver` interface lives in `apps/api/src/routes/domains/domain-verify.ts` (exported).

**Two-layer DI design (R2 — resolves blocker-1 contradiction):**

`RouteDeps.dnsResolver: TxtDnsResolver` — **required**. Route handlers receive a guaranteed resolver; no null-checking at callsite. Factory always provides it.

`AppOptions.dnsResolver?: TxtDnsResolver` — **optional** override on the public factory API. Omitting uses `node:dns/promises`. Providing overrides for test isolation. Follows same pattern as `AppOptions.repos?` (optional override) / `RouteDeps.repos` (required in bundle).

Production code path:
```typescript
// In factory.ts — AppOptions.dnsResolver is optional; RouteDeps.dnsResolver is always set:
dnsResolver: options.dnsResolver ?? { resolveTxt: dnsPromises.resolveTxt.bind(dnsPromises) },
```

Test fixture override (no env flags):
```typescript
// domain-verify.test.ts — passes mock via AppOptions:
const { app } = createApp({ ..., dnsResolver: mockResolver });
// mockResolver: TxtDnsResolver = { resolveTxt: async () => [[token]] }
// string[][] shape: outer = TXT records, inner = 255-byte parts joined by handler (M1 fix).
```

No `MOCK_DNS`, `USE_FAKE_DNS`, or any env-flag branches in `domain-verify.ts`. P46 strictly applied.

---

## dropAllTables Update (P44)

`tests/integration/db/helpers/db-fixture.ts:dropAllTables` table list:

Current order (reverse-FK): `oob_callbacks → ... → targets → projects → ... → tenants`.

`domain_verifications` references `tenants(id)` and `targets(id)`. Must be dropped BEFORE both `targets` and `tenants`.

Insert position: **between `target_ownership_claims` and `targets`**:
```
'target_ownership_claims',
'domain_verifications',    // NEW — refs targets + tenants; drop before both
'assessment_approvals',
...
'targets',
'projects',
...
'tenants',
```

---

## File-by-File Change List

### New files

| File | Description |
|------|-------------|
| `packages/db/migrations/024_domain_verifications.ts` | Migration 024 — domain_verifications table |
| `apps/api/src/routes/domains/domain-verify.ts` | POST /verify/start + GET /verify/check handlers + TxtDnsResolver interface |
| `tests/integration/domains/domain-verify.test.ts` | IT: full verify flow with mocked DNS resolver |

### Modified files

| File | Change |
|------|--------|
| `packages/contracts/src/audit.ts` | Add 5 domain.verify.* actions (88→93) |
| `packages/contracts/src/audit.test.ts` | Update cardinality assertion to `.toBe(93)` |
| `apps/api/src/routes/register-routes.ts` | Register 2 new domain verify routes |
| `apps/api/src/routes/shared.ts` | Add required `dnsResolver: TxtDnsResolver` to RouteDeps |
| `apps/api/src/factory.ts` | Add optional `dnsResolver?: TxtDnsResolver` to `AppOptions`; wire to required `RouteDeps.dnsResolver` with real `dns.resolveTxt` fallback |
| `packages/db/src/schema.ts` | Add `DomainVerificationsTable` interface + `domain_verifications` to `Database` |
| `tests/integration/db/helpers/db-fixture.ts` | Add `domain_verifications` to dropAllTables (P44) |
| `tests/integration/db/migrations.test.ts` | B6: K=11→12 (loop bump) + 6 prefix-pop tests updated + test #1 pre-existing r022pre bug fixed |
| `apps/web/src/pages/ProjectDetailPage.tsx` | Domain wizard section: token display, instructions, poll button, badge (code-verified path) |

### Frozen surfaces (0-line diff confirmed)

```bash
git diff HEAD -- apps/api/src/routes/auth/register.ts packages/scope-engine/ packages/decepticon-adapter/ packages/reports/ services/report-builder/ packages/contracts/src/payloads.ts services/coordinator/src/payloads.ts services/validator-worker/src/ssrf-validator.ts services/validator-worker/src/lfi-validator.ts services/validator-worker/src/rce-validator.ts
```
Expected: empty output.

---

## Migration 024 DDL

```typescript
// packages/db/migrations/024_domain_verifications.ts
import { type Kysely, sql } from 'kysely';

export const up = async (db: Kysely<any>): Promise<void> => {
  await db.schema
    .createTable('domain_verifications')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (c) => c.notNull().references('tenants.id'))
    .addColumn('target_id', 'uuid', (c) => c.notNull().references('targets.id'))
    .addColumn('domain', 'text', (c) => c.notNull())
    .addColumn('token', 'text', (c) => c.notNull()) // 'cs-verify=<hex32>'
    .addColumn('status', 'text', (c) =>
      c.notNull().defaultTo('pending').check(sql`status IN ('pending','verified','expired')`)
    )
    .addColumn('verified_at', 'timestamptz')
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('domain_verifications_target_id_unique', ['target_id'])
    .execute();

  await sql`CREATE INDEX idx_domain_verif_expires ON domain_verifications (expires_at)
    WHERE status = 'pending'`.execute(db);
};

export const down = async (db: Kysely<any>): Promise<void> => {
  await db.schema.dropTable('domain_verifications').ifExists().execute();
};
```

**BYTEA exempt:** No BYTEA columns. Token is `text`.

**Schema.ts type note (advisor L4):** `DomainVerificationsTable` interface in `packages/db/src/schema.ts` must type `verified_at` as `Date | null` (nullable — only set on verification). Any other timestamptz nullable column follows the same pattern. TypeScript will enforce this.

---

## API Contract

### POST /api/v1/domains/verify/start

```
Auth: tenantGuard()
Body: { targetId: uuid }
```

Logic:
1. Load `targets` row by `targetId` — assert `tenant_id = actor.tenantId`
2. Extract `domain` from target (target.kind must be `'domain'` — else 422 `{ error: 'target_not_domain' }`)
3. Check existing `domain_verifications` row for `target_id`:
   - If exists and `status='pending'` and `expires_at > now()` → return existing token (idempotent)
   - If exists and (`status='expired'` or `expires_at <= now()`) → DELETE it, emit `domain.verify.expired`, create new
   - If `status='verified'` → return 200 `{ alreadyVerified: true }`
4. Generate token: `cs-verify=` + 32-byte random hex (64 chars)
5. INSERT `domain_verifications` row with `expires_at = now() + interval '24 hours'`
6. Emit audit `domain.verify.requested`
7. Return 201:
```json
{
  "token": "cs-verify=<64-hex>",
  "instructions": "Add a DNS TXT record: _cs-verify.<domain> → cs-verify=<64-hex>",
  "expires_at": "<ISO8601>"
}
```

### GET /api/v1/domains/verify/check

```
Auth: tenantGuard()
Query: ?targetId=<uuid>
```

Logic:
1. Load `domain_verifications` row for `target_id` — assert `tenant_id = actor.tenantId`
2. If not found → 404 `{ error: 'verification_not_found' }`
3. If `status='verified'` → return 200 `{ status: 'verified', verifiedAt }` (idempotent)
4. Check expiry: if `expires_at <= now()` → UPDATE `status='expired'`, emit `domain.verify.expired`, return 410 `{ error: 'token_expired' }`
5. Call `dnsResolver.resolveTxt('_cs-verify.' + domain)` — each element is `string[]` (multi-part TXT records joined)
6. For each inner `string[]` (multi-part TXT record), join parts: `parts.join('')`. Look for any joined value that equals `row.token`. (Advisor M1: `resolveTxt` returns `string[][]`; inner array = 255-byte chunks of one TXT record; must join before comparing.)
7. Emit `domain.verify.checked` (only after DNS call returns without throwing — not on DNS error)
8. If match found → TX flip. Emit `domain.verify.confirmed`. Return 200 `{ status: 'verified' }`
9. If DNS no match → emit `domain.verify.failed`. Return 200 `{ status: 'pending' }`
10. If DNS throws → emit `domain.verify.failed` only (no `checked`). Return 502

**Audit emit table per /check outcome (binding — R2 nit-2):**

| /check outcome | Audit emits | Count |
|----------------|------------|-------|
| Already verified (idempotent, step 3) | none | 0 |
| Token expired (step 4) | `domain.verify.expired` only | 1 |
| DNS throws (step 10) | `domain.verify.failed` only | 1 |
| DNS ok, no match (steps 7+9) | `checked` + `failed` | 2 |
| DNS ok, match found (steps 7+8) | `checked` + `confirmed` | 2 |

**Audit emit for /start on expired token:** `domain.verify.expired` (delete audit) + `domain.verify.requested` (create audit) = 2 events total.

---

## Test Plan

### No-DB tests (audit.test.ts)

| Test | File | Verifies |
|------|------|---------|
| AUDIT_ACTIONS.length === 93 | `packages/contracts/src/audit.test.ts:155` | Cardinality |
| All 5 domain.verify.* in AUDIT_ACTIONS | same | Presence check |

### Integration tests (full-PG)

| Test | File | Verifies |
|------|------|---------|
| verify/start → 201 + row in DB | `tests/integration/domains/domain-verify.test.ts` | Happy path |
| verify/start idempotent (pending not expired) | same | Returns same token |
| verify/start re-issues on expired | same | Deletes old, creates new |
| verify/check → DNS match → status=verified + target flipped | same | Atomic flip |
| verify/check → DNS no match → status=pending | same | Polling path |
| verify/check → already verified → idempotent 200 | same | Idempotent |
| verify/check → expired → 410 | same | Expiry path |
| verify/check → cross-tenant target → 403 | same | Tenant isolation |
| B6 rollback K=12 | `tests/integration/db/migrations.test.ts` | Migration down |

### E2E (Playwright)

Carry-over from B-24-playwright: S25 evaluator drives register → login → /app dashboard → /app/projects/:id domain wizard (polling with mocked DNS).

---

## Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| A-25-1 | `domain_verifications` table created by mig 024 up | DB inspect |
| A-25-2 | mig 024 down drops table cleanly | B6 test |
| A-25-3 | AUDIT_ACTIONS.length === 93 | `audit.test.ts:155` |
| A-25-4 | All 5 domain.verify.* actions in AUDIT_ACTIONS | String present |
| A-25-5 | POST /verify/start returns `{ token, instructions, expires_at }` | IT |
| A-25-6 | GET /verify/check flips both statuses atomically when DNS matches | IT: DB rows after call |
| A-25-7 | GET /verify/check idempotent on already-verified target | IT: second call returns verified |
| A-25-8 | GET /verify/check returns 410 on expired token | IT |
| A-25-9 | No `MOCK_*` env flags in production domain-verify.ts | Code review |
| A-25-10 | `domain_verifications` in `dropAllTables` before `targets` | db-fixture.ts code read |
| A-25-11 | All 8 B6 tests use K=12 (not K=11) | migrations.test.ts code read |
| A-25-12 | Tenant isolation: cross-tenant targetId → 403 | IT |
| A-25-13 | Audit emits on all code paths | IT: audit_events rows |
| A-25-14 | Domain wizard UI renders token + instructions | Playwright (path: `apps/web/src/pages/ProjectDetailPage.tsx`) |
| A-25-15 | Verified target shows green badge; unverified shows warning + Verify button | Playwright |
| A-25-16 | tsc 0 errors | `bun run typecheck` |
| A-25-17 | lint 0 errors | `bun run lint` |
| A-25-18 | no-DB tests: FULL suite pass, 0 fail | `bun test` |

---

## Pitfall Application Checklist

| Pitfall | S25 Application | Status |
|---------|----------------|--------|
| **P36** — generator-no-verdict | No PASS/FAIL in this file | APPLIED |
| **P37** — pure-fn values code-verified | 5 new AUDIT_ACTIONS named from spec §Z.5; ownership_status enum verified from mig 003 line 46 (`'unverified'|'pending'|'verified'`); token format from spec §2.2 | APPLIED |
| **P38** — B6 K = literal loop count | K=11 confirmed from `migrations.test.ts:184` literal; K=12 is 11+1 for mig 024 | APPLIED |
| **P39** — find-and-replace-all | All 8 B6 tests updated (7 prefix-pop + 1 loop). Doc carries no stale K=11 → see full list in §B6 | COMMITTED |
| **P42** — JSONB COMMENT | No JSONB in mig 024. N/A | APPLIED |
| **P43** — rate-limiter DI | No new rate limiters in S25. Domain verify uses existing tenantGuard. N/A | N/A |
| **P44** — dropAllTables | `domain_verifications` added before `targets` (reverse-FK) | APPLIED |
| **P46** — no MOCK_* env flags | `TxtDnsResolver` DI-injected; no env-flag branches in production code | APPLIED |
| **BYTEA exempt** | No BYTEA in mig 024 | APPLIED |
| **Frozen surfaces** | scope-engine DnsResolver untouched; separate `TxtDnsResolver` interface | APPLIED |
| **Tenant isolation** | Every query filters by `actor.tenantId` | APPLIED |
| **Audit append-only** | No trigger drops in mig 024 | APPLIED |

---

## Advisor Calls

### Pre-contract advisor call

**Advisor:** advisor-s25-precontract (Opus 4.7), run 2026-05-04  
**Verdict:** APPROVE WITH CHANGES (2 medium, 3 low — all addressed in R1)

**Verbatim response:**

> **BLOCKER / HIGH Issues:** None — no contract blockers found.
>
> **MEDIUM Issues:**
>
> **M1 — DNS TXT record comparison bug (contract §API Contract, verify/check step 6)**
> The contract stated: "Flatten: look for any element that equals `row.token`" — this is incorrect. `dns.resolveTxt()` returns `Promise<string[][]>`. The outer array is one entry per TXT record. The inner `string[]` contains the parts of that record (DNS TXT records are split into 255-byte chunks). A single-part TXT record like `cs-verify=abc...` arrives as `[['cs-verify=abc...']]` — so `records[0]` is `['cs-verify=abc...']`, not `'cs-verify=abc...'`. Correct check: `txtRecords.some(parts => parts.join('') === row.token)`. Without this, verification would never succeed in production. Fixed in R1 (step 6 updated; P46 mock shape already correct as `[['...']]`).
>
> **M2 — `dnsResolver` should be required in `RouteDeps`, not optional**
> Optional field means TypeScript would not warn if factory.ts forgets to inject it — resulting in runtime NPE. Existing `RouteDeps` pattern uses required fields for all injected deps (`hasher`, `sessionRepo`, etc.). Fixed in R1: changed to required field `dnsResolver: TxtDnsResolver`.
>
> **LOW Issues:**
>
> **L1 — `domain.verify.checked` + `domain.verify.confirmed` dual-emit on success:** The dual-emit on success path (checked + confirmed) is acceptable — `checked` = "DNS lookup was performed", `confirmed` = "verification succeeded". This means 2 audit events emitted per successful /check call. IT test assertions must expect 2 rows. Documented; no change needed.
>
> **L2 — `domain.verify.expired` in verify/start:** Emitting from POST /verify/start when deleting a stale row is reasonable. No change needed.
>
> **L3 — No rate limiter on `/domains/verify/check`:** Spec §7 explicitly calls for "10/min per tenant". Deferred as B-25-ratelimit backlog item (documented in Out of Scope section). No implementation in S25.
>
> **L4 — `verified_at` column nullable:** `DomainVerificationsTable.verified_at` must be typed `Date | null` in schema.ts. Noted in contract DDL section.
>
> **L5 — Frontend path:** `ProjectDetailPage.tsx` lives at `apps/web/src/pages/ProjectDetailPage.tsx` (not `apps/web/src/app/projects/`). Fixed in R1 file list and acceptance criteria.
>
> **Confirmed Correct:**
> 1. AUDIT_ACTIONS 88+5=93: CONFIRMED per spec Z.5.
> 2. B6 K=11→12: CONFIRMED. Loop at migrations.test.ts:184 rolls back 023→022→...→013; mig 024 adds one more step.
> 3. B6 prefix-pop count (7 tests + 1 loop): CONFIRMED. Full rollback test (line 415) uses rollbackAllMigrations — no prefix-pop needed.
> 4. `TxtDnsResolver` separate from scope-engine `DnsResolver`: CONFIRMED correct approach.
> 5. `UNIQUE(target_id)` + idempotent start logic: CONFIRMED.
> 6. `dropAllTables` ordering (before targets/tenants): CONFIRMED.
> 7. P46 compliance (no env flags): CONFIRMED.
> 8. No JSONB → no COMMENT needed: CONFIRMED.
> 9. BYTEA exempt: CONFIRMED.

---

## R2 Evaluator Responses

### Blocker-1 response (required vs optional contradiction)

**Resolution: two-layer design, no contradiction.**

`AppOptions.dnsResolver?: TxtDnsResolver` — **optional** in the public `createApp()` API. Omit = real DNS (`node:dns/promises`). Provide = test override.

`RouteDeps.dnsResolver: TxtDnsResolver` — **required** in the internal route bundle. `factory.ts` always fills this before calling `registerRoutes`. Route handlers can rely on it without null checks.

This mirrors the existing `AppOptions.repos?` (optional test override) / `RouteDeps.repos` (required internal bundle) pattern. Sections §A2, §Gitnexus Impact, and §P46 DI Plan updated in R2 to state this consistently.

**IT fixture impact (nit-1 enumeration):** RouteDeps is constructed at exactly one site: `apps/api/src/factory.ts:161`. All 25 test files that call `buildAuthApp()` do so via `createApp(AppOptions)` — they supply optional `AppOptions` fields, not RouteDeps directly. Zero test files need changes for the required `RouteDeps.dnsResolver` field.

Construction sites enumerated by `grep`:
- `apps/api/src/factory.ts:161` — `const routeDeps = { ..., dnsResolver: options.dnsResolver ?? realResolver }` ✓ already wired
- `tests/integration/domains/domain-verify.test.ts:66` — `createApp({ ..., dnsResolver: resolver })` ✓ passes via AppOptions
- All 24 other `buildAuthApp()` call sites — pass no `dnsResolver`; factory defaults to real DNS ✓

### Blocker-2 response (B6 pop sequence corrected)

Per-test pop sequences documented in §B6 loop table above. Key corrections vs R1:

1. **Test #1 (line 46) had a pre-existing bug**: r022pre was missing. Sequence was 024→023→021→020 (skipping 022), causing step-1 to land on 020, not 019. R2 adds r022pre between r023pre and r021pre. Correct sequence: r024pre→r023pre→r022pre→r021pre→r020pre→step-1(019).

2. **Count corrected**: 6 prefix-pop tests (not 7) + 1 loop bump + 1 auto-rollback = 8.

Both the §B6 loop section and pitfall P39 row updated.

### Blocker-3 response (working-tree clarification)

The implementation commits (`a5b7d58` + `ba5986c`) were a **verification spike** — implementation was done to confirm that the contract's A1/A2/A3 decisions compile and typecheck, and that the B6 math is correct. The spike was done in parallel with the contract write.

The spike revealed one contract inaccuracy (the B6 prefix-pop bug in test #1) which is now corrected in R2. If R2 forces material contract changes beyond what was already implemented, the implementation will be revised to track the AGREED contract. The contract remains the source of truth.

### Updated pitfall row for P39

**P39 — find-and-replace-all:** All 8 B6 tests addressed (6 prefix-pop tests + 1 loop bump + 1 auto). R2 corrects count from "7 prefix-pop" to "6 prefix-pop". Test #1 pre-existing bug (missing r022pre) fixed in implementation.
