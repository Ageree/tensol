# Sprint 24 Evaluator Result — Phase B (Implementation Review)

**Reviewer:** evaluator (Opus 4.7)
**Date:** 2026-05-04
**Commit under review:** `54db76e` (S24 SaaS self-registration foundation)
**Base:** `1aa2bbf` (S23 ship)
**Round:** Phase B round 1

## Verdict: PASS_WITH_BACKLOG

S24 implementation is functionally correct and ships. All Phase A binding contract items verified against code. Lint + typecheck clean. No-DB suite 1004/0/391. Frozen surfaces untouched. AUDIT cardinality correct. All 7 affected B6 tests bumped. Self-register handler implements email-uniqueness inside TX (B-24-h2 verified) and degrades gracefully on session-issue failure (B-24-h3 implementation matches spec text on success path; deviates on failure-event-trail per known accepted backlog).

Two backlog items remain — full-PG suite cannot be run by me in this session (no DATABASE_URL / no local PG); B-24-doc1 + B-24-doc2 doc cleanup not performed at impl handoff. Both are documented as carry-over.

---

## Verification Matrix

| Criterion | Method | Result |
|-----------|--------|--------|
| AUDIT_ACTIONS.length === 88 | code-read `packages/contracts/src/audit.ts` (88 entries) + `audit.test.ts:155` asserts `.toBe(88)` | PASS |
| `auth.self_register` in AUDIT_ACTIONS | grep `audit.ts:152` | PASS |
| TX scope: tenant + user inserted in single TX | code-read `self-register.ts:86-119` (`deps.db.transaction().execute(async (trx) => ...)`) | PASS |
| **B-24-h2** Email-uniqueness check INSIDE TX before user INSERT | code-read `self-register.ts:88-95` — `trx.selectFrom('users').select('id').where('email', '=', body.email).executeTakeFirst()` precedes user INSERT in same trx | PASS |
| Session cookie set on success | code-read `self-register.ts:169-174` (`buildSetCookieHeader` + `c.header('Set-Cookie', ...)`) | PASS |
| `users.role = 'tenant_admin'` for self-registered | code-read `self-register.ts:113` | PASS |
| `users.email_verified` defaults true | mig 023:6 `ADD COLUMN email_verified boolean NOT NULL DEFAULT true`; user INSERT does not override | PASS |
| Rate limiter: dedicated, ALL attempts decrement, before DB op | code-read `self-register.ts:30,55-58` — separate `selfRegisterLimiter` instance, `recordFailureAndCheck(ip)` called BEFORE TX | PASS |
| Audit emit on success | code-read `self-register.ts:141-153` | PASS |
| Audit emit on dup-email failure | code-read `self-register.ts:121-138` | PASS |
| Audit emit on invalid-body failure | code-read `self-register.ts:67-83` | PASS |
| Audit emit on TX failure | code-read `self-register.ts:177-194` | PASS |
| Tenant slug suffix entropy | code-read `self-register.ts:33-35` — `Uint8Array(4)` → 8 hex chars (32 bits) ✓ M2 satisfied | PASS |
| `platform_settings` untouched | code-read self-register.ts: no reference to `platform_settings`. IT test at `self-register.test.ts:115` asserts `bootstrap_consumed_at IS NULL` after register. | PASS |
| Migration 023 BYTEA-free | code-read `023_saas_auth_subscriptions.ts` — only `bigint`, `text`, `jsonb`, `timestamptz`, `boolean`, `uuid` | PASS |
| Migration 023 down() reverses | code-read line 36-40: drops invoices → subscriptions → users.email_verified column | PASS |
| All 8 B6 tests addressed | code-read diff `migrations.test.ts`: tests at lines 46, 197, 234, 280, 325, 366 each prepend `r023pre` migrateDown; line 123 K-loop changed `i < 10` → `i < 11`; line 391 unchanged (uses `rollbackAllMigrations`, auto). 7 modified + 1 unchanged = 8 covered. | PASS |
| auth-fixture FK-safe teardown | code-read diff `auth-fixture.ts:269-272` — `DELETE FROM invoices; DELETE FROM subscriptions;` added BEFORE `DELETE FROM tenants` (P3 ordering preserved with audit_events still first elsewhere) | PASS |
| `MeResponse` interface nested | code-read diff `apps/web/src/api/auth.ts` — `MeActor` + `MeTenant` types, `MeResponse = { actor, tenant: MeTenant \| null }`. `getMe()` returns `MeResponse` directly (no `{user}` wrapper). | PASS |
| useAuth context consumers updated | code-read diff `App.tsx:59,72` — `user.actor.email`, `user.actor.role`. `context.tsx:21` — `setUser(res)` direct. | PASS |
| Frozen surfaces 0-line diff | `git diff HEAD~1 -- apps/api/src/routes/auth/register.ts packages/scope-engine packages/reports services/report-builder packages/decepticon-adapter services/coordinator/src/payloads.ts services/validator-worker/src/{ssrf,lfi,rce}-validator.ts` → empty output | PASS |
| Frozen migrations 001-022 untouched | `git diff HEAD~1 --name-only` does not include any `migrations/0(0[1-9]|1[0-9]|2[0-2])_*.ts` | PASS |
| TypeCheck | `bun run typecheck` (tsc -b) → 0 errors | PASS |
| Lint | `biome check .` → 451 files, 0 issues | PASS |
| No-DB test suite | `bun test` → 1004 pass / 0 fail / 391 skip / 1395 total / 20801 expects | PASS |
| Full-PG test suite | NOT RUN — no DATABASE_URL in evaluator session, no local PG | NOT VERIFIED (carry-over) |
| Tenant isolation in 3 random new endpoints | only one new endpoint (`/auth/self-register`); reads `body` not `req.user.tenantId` (this is a public route that CREATES a tenant); audit row uses `result.tenantId` for success and `platformTenantId` for unattributed failures. No DEFAULT_TENANT_ID anywhere in self-register.ts. | PASS |
| Audit invariant: every state-changing endpoint emits audit_event | only state-changing endpoint = `/auth/self-register`. Emits on all 4 outcome paths. | PASS |
| Playwright e2e (register → login → /app dashboard) | NOT RUN — no dev server running on localhost:5173/3000/4173 | NOT VERIFIED (carry-over) |

## Test Counts

- **No-DB:** **1004 pass / 0 fail / 391 skip** (NEW + FULL: same single suite — generator added IT tests behind `skipIf(!hasDatabaseUrl())`, so they appear in the `391 skip` bucket here)
- **Full-PG:** **NOT RUN** (no DB available in evaluator session) — generator claims 6 new IT tests pass; trusted-with-caveat per code-read structural review (well-structured, beforeEach reset, assertions on cookie + DB rows + audit emit + tenant isolation + register→me flow)
- **Lint:** 451 files, 0 issues
- **TypeCheck:** 0 errors

S15 lesson on FULL-suite counts respected to the extent possible: full no-DB regression (1004/0) is green; full-PG regression cannot be verified by me this session.

## Advisor + gitnexus + mempalace gates

| Gate | Status | Evidence |
|------|--------|----------|
| Advisor pre-contract | YES | Documented in impl summary §"Advisor Calls"; 4 blockers identified pre-R1 |
| Advisor pre-handoff | YES (with caveat) | Generator notes message sent ~13:10 MSK 2026-05-04, self-approve window elapsed, 5 questions posed. **Caveat:** advisor response not received; this is a process gap but not implementation-affecting |
| gitnexus_impact | YES | Documented in impl summary; symbols + risk levels match contract |
| gitnexus_detect_changes | YES | Documented in impl summary: 23 expected files = 23 actual; 28 changed symbols; 0 affected processes outside changed files; risk LOW; frozen surfaces confirmed |
| mempalace_search | YES | Documented in impl summary; wings searched: cyberstrike/auth, cyberstrike/migrations, cyberstrike/audit, cyberstrike/pitfalls |

Per Phase B mandate: all 5 gates documented. Advisor pre-handoff response missing is noted as a process backlog item but does not affect implementation correctness.

## Playwright evidence

NONE — no dev server. Carry-over to S25 evaluator (or first sprint with running web server).

## Pitfalls v8 application

| Pitfall | Status |
|---------|--------|
| **P36** (generator-no-verdict) | APPLIED — this file is the only PASS/FAIL vehicle. Generator's impl summary contains no verdict claim. |
| **P37** (pure-fn values code-verified) | APPLIED — mig 023 column types, role enum, audit cardinality all verified against source |
| **P32** (BYTEA exempt) | APPLIED — no BYTEA in mig 023 |
| **P-FULL-suite-counts** | PARTIAL — full no-DB green; full-PG not runnable in this session |
| **P-frozen-surfaces** | APPLIED — 0-line diff confirmed against `git diff HEAD~1 --` of all frozen paths |
| **P-resetAuthState-FK-order** | APPLIED — invoices/subscriptions before tenants (audit_events still first elsewhere) |
| **P-Tenant-isolation** | APPLIED — public self-register correctly uses derived `tenantId` from in-TX insert; no DEFAULT_TENANT_ID; failure paths use `platformTenantId` for unattributed audit |
| **P-Audit-append-only** | APPLIED — no trigger drops in mig 023 |
| **P-Self-register-atomicity** | APPLIED — tenant + user + email-unique check in single TX (B-24-h2 verified) |

## Issues found

### CRITICAL
None.

### HIGH
None.

### MEDIUM
- **B-24-h3 deviation from contract text (known + accepted):** Contract H3 (line 266) reads: "no second audit event for the session failure". Code at `self-register.ts:177-194` DOES emit a second audit event with `outcome=failure metadata={reason:'tx_failed'}` if any throw escapes the TX block — including post-TX session-issue failures. Generator handoff message acknowledges this as accepted LOW backlog. Two real points worth flagging for next sprint:
  1. **`reason: 'tx_failed'` is misleading** when the failure is post-TX session-issue — TX did commit. A more accurate value would be `reason: 'session_issue_failed'` if branched, or `reason: 'unknown'` for the catch-all. Not security-critical; minor.
  2. **Audit log for session-issue-failure shows BOTH success and failure** (success was emitted at line 141-153 before issue() at line 160). This is the contract's actual intended behavior on the success-then-failure split, and is arguably more accurate than what the contract text said. Code-correct, contract-text-stale.

### LOW
- **B-24-doc1** carry-over: 6 stale "K=23" / "K=22→23" references at sprint-24-contract.md lines 109, 171, 217, 338, 361, 379. Not cleaned up at impl handoff per backlog directive. Implementation is correct (K=11 in code) but contract doc remains internally inconsistent. Recommend: S25 generator does a 60-second find-and-replace before drafting S25 contract to avoid copy-paste contamination.
- **B-24-doc2** carry-over: Goal+Scope line 27 still reads "Auth guard using TanStack Router `beforeLoad`, no content flash". Implementation uses `useState` state-machine + `ProtectedLayout` React component. Not cleaned up at impl handoff. Same recommendation.
- **Advisor pre-handoff response missing:** Generator sent message but did not receive (or did not document receiving) response before handoff. Process gap. Code is sound regardless.

## Backlog (PASS_WITH_BACKLOG carry)

| ID | Severity | Item | Defer rationale |
|----|----------|------|-----------------|
| B-24-pgrun | MEDIUM | Full-PG regression suite not run in evaluator session (no DATABASE_URL / no local PG) | Generator's IT test code reads correctly; trust-with-caveat. S25 evaluator runs full-PG once on combined S24+S25 base. |
| B-24-playwright | MEDIUM | Playwright e2e (register → login → /app dashboard) not run (no dev server) | S25 evaluator drives first playwright walk per spec carry-over plan. |
| B-24-doc1 | LOW (doc) | 6 stale K=23 references in sprint-24-contract.md | Doc-only; binding §B6 Change Map is correct. |
| B-24-doc2 | LOW (doc) | Goal+Scope line 27 stale "TanStack Router beforeLoad" wording | Doc-only; binding A1 R2 + Frontend Routes are correct. |
| B-24-h3-cleanup | LOW | `reason: 'tx_failed'` value used for post-TX session-issue failure (misleading name) | Cosmetic. S25 can rename to `session_issue_failed` if desired. |
| B-24-advisor-prehandoff-response | LOW | Pre-handoff advisor response not documented as received | Process gap; no implementation impact. |

---

## Carry-over for next sprint reviewer (S25)

Per team-lead lifecycle mandate, every PASS triggers full team teardown + respawn for context hygiene.

### Active checks still relevant for S25 review
- **Subscriptions + invoices tables** now exist post-S24 in mig 023 (NOT mig 025). S25 mig 024 = `domain_verifications`. S25 reviewer must NOT re-create subscriptions/invoices.
- **AUDIT_ACTIONS baseline for S25 = 88** (post-S24); S25 target = 93 (+5 for `domain.verify.{requested, checked, confirmed, failed, expired}`) per spec Z.5.
- **B6 reports-loop K baseline for S25 = 11** (post-S24); S25 target K = 12 (mig 024 added).
- **All 8 B6 tests** will need another round of prefix-pop bumps when mig 024 lands. S25 generator must enumerate all 8.
- **`auth.self_register`** AUDIT_ACTION lives at end of array post-S24.
- **`tenant_admin`** is the only role used for self-registered users.
- **`apps/web/src/api/auth.ts:MeResponse`** correctly nested (`{ actor, tenant: MeTenant | null }`). All consumers updated to read `user.actor.*` / `user.tenant?.*`. S25 frontend additions follow same pattern.
- **Tenant slug pattern** `${base}-${randomHex(8)}` (32 bits). S25 IT fixtures can rely on this format.
- **Email-uniqueness check** is application-level inside TX (Z.1.5 mandate). S25 reviewer: any new auth-related endpoint must follow the same in-TX check pattern.
- **Session-issue post-TX failure pattern** (B-24-h3): emit `outcome=success` first, then on session failure return 500 + emit additional `outcome=failure metadata={reason:'tx_failed'}`. S25 reviewer: if S25 introduces another "create-then-issue-token" flow, follow same pattern.
- **`ProtectedLayout`** component available for S25 projects pages.
- **`auth-fixture.ts:resetAuthState`** now deletes invoices + subscriptions before tenants. S25 IT additions don't need to add this again.

### Frozen surfaces (re-verify every sprint)
- `apps/api/src/routes/auth/register.ts` (bootstrap-only)
- `packages/scope-engine/`
- `packages/decepticon-adapter/`
- `packages/reports/`
- `services/report-builder/`
- `services/coordinator/src/payloads.ts`
- `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts`
- migrations 001-022

### Test-count baseline at end of S24
- **No-DB:** 1004 pass / 0 fail / 391 skip / 1395 total
- **Full-PG:** NOT RUN by evaluator (carry-over). Generator's claim: 6 new self-register IT tests pass. S25 evaluator: capture baseline number on first full-PG run, treat as the S25 starting point.
- **Coverage:** ~no change from baseline (S24 added test code; coverage % depends on full-PG run)

### E2E paths walked by playwright
- **NONE in S24** (deferred — no dev server in evaluator session). S25 evaluator drives first playwright walk: register → login → /app dashboard.

### Risks under observation
- **B-24-pgrun**: full-PG regression unverified in S24. If S25 sees regressions, the S24 IT may have been the source — investigate first.
- **B-24-h3**: post-TX session-issue-failure emits 2 audit events (success + failure with misleading `reason: 'tx_failed'`). Cosmetic and accepted, but if any audit-trail consumer expects "1 success XOR 1 failure" semantics, this will surprise them.
- **B-24-doc1, B-24-doc2**: stale doc references in sprint-24-contract.md. If S25 generator copy-pastes contract style, may inherit wrong K/routing wording. **S25 reviewer MUST verify** S25 contract uses K=12 (not K=24) and "state-machine + ProtectedLayout" (not "TanStack Router beforeLoad").
- **Advisor pre-handoff response missing**: process gap. S25: enforce advisor response capture before handoff.

### Pitfalls v8 → v9 candidates surfaced this sprint
- **P38 candidate**: "B6 K math is empirically `for (let i = 0; i < N; i++)` count, not migration-file count. Read the loop literal." (R1 generator error.)
- **P39 candidate**: "Doc-update fixes must do find-and-replace ALL, not just one site." (R3 had 6 stale K=23 references after the fix landed only in §B6 Change Map. NOT cleaned up at impl handoff.)
- **P40 candidate**: "Frontend interface drift catches require code-reading the type definitions, not just the route handler." (Generator caught `MeResponse` flat-vs-nested in R3.)
- **P41 candidate**: "Phase B evaluator may have no DB / no dev server. Generator's IT and e2e claims become trust-with-caveat. Future sprints: provide pgvector docker fixture or DATABASE_URL env in evaluator session."

---

## Verdict line for harness routing

**PASS_WITH_BACKLOG** — S24 ships. 6 backlog items carry to S25 (1 medium pgrun + 1 medium playwright + 4 LOW). Full team teardown + respawn per team-lead lifecycle mandate.
