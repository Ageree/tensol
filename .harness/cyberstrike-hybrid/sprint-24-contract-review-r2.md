# Sprint 24 Contract Review — R2 Verdict

**Reviewer:** evaluator (Opus 4.7)
**Date:** 2026-05-04
**Contract under review:** `.harness/cyberstrike-hybrid/sprint-24-contract.md` (R2)
**Round:** 2 of ≤2

## Verdict: PASS_WITH_BACKLOG — proceed to implementation

R2 substantively fixed the most consequential R1 critical issues plus introduced 4 new correctness fixes (auth-fixture FK, App.tsx routing, rate-limit semantics, /auth/me shape) that I verified independently. Per harness ≤2-rounds-then-ship rule, contract proceeds to implementation. Remaining items are documentation precision and are bundled as inline-with-implementation backlog (no extra contract round).

## R1 → R2 fix coverage

### Substantively fixed
- **C1 (B6 K-math, multiple test sites):** R2 corrected the Modified Files row to `i < 10 → i < 11 (line 180); add r023pre pop pattern before any test block that currently pops r022pre as its first migrateDown step`. K=11 in the reports-table loop is now correct. Pattern for prefix-pop is documented. **Implementation will be correct if implementer reads the Modified Files row.**
- **BLOCKER-1 (auth-fixture FK):** Verified `tests/integration/auth/helpers/auth-fixture.ts:207` exists with `resetAuthState`. Current DELETE order does not include `subscriptions` or `invoices`. Once mig 023 lands, FK from `subscriptions.tenant_id → tenants.id` would cause `DELETE FROM tenants` to fail. R2 adds the correct FK-safe ordering. Real and critical fix.
- **BLOCKER-3 (rate-limit semantics):** Dedicated `createRateLimiter({ maxFailures: 5, windowSeconds: 600 })` for self-register only, decremented on both success and failure, called BEFORE any DB op. Correct.
- **BLOCKER-4 (/auth/me shape):** Code-verified `apps/api/src/routes/auth/me.ts:23-30` returns `{ actor: {...}, tenant: tenant ? {...} : null }`. R2 contract documents the nested shape. Correct.
- **H4 / BLOCKER-2 (App.tsx vs router file):** R2 chose Option B (extend `useState<Route>` state machine), correctly noting TanStack Router is in package.json but unwired. Auth guard via `useAuth()` context + 401-redirect, no TanStack `beforeLoad`. Correct.

### Verified during review (no contract change needed)
- **C2 (users-table B5 spot-check):** Empirically grepped `tests/integration/db/migrations.test.ts` for users-table column-shape assertions. None exist. `email_verified` ALTER won't trip B5/B6. CLOSED, no work needed.

### Backlog (PASS_WITH_BACKLOG carry — generator addresses inline during implementation)

| ID | Severity | Item | Justification for deferral |
|----|----------|------|----------------------------|
| **B-24-doc1** | HIGH (doc) | 5 stale "K=23" references in contract (lines 143, 189, 301, 324, 342) contradict the corrected Modified Files row (line 135 = `i < 10 → i < 11`). Implementer must follow the Modified Files row. | Pure doc inconsistency; correct code path is unambiguous from line 135 + per-test prefix-pop description. Generator updates these 5 lines during impl handoff. |
| **B-24-doc2** | MEDIUM (doc) | Goal+Scope §6 (line 23) still says "TanStack Router `beforeLoad`, no content flash" — contradicts A1 R2-clarification + Frontend Routes section. | Contract A1 + Frontend Routes are the binding sections. Cleanup line 23 during impl handoff. |
| **B-24-h1** | MEDIUM (doc) | Z.6 vs Z.7 inconsistency note re: subscriptions+invoices placement is missing from contract preamble. (Team-lead has since patched Z.6 in the spec — generator confirms in implementation summary.) | Now obsolete — Z.6 patched authoritative. Generator notes "Z.6 patched 2026-05-04 by team-lead — subscriptions+invoices in mig 023 confirmed canonical." |
| **B-24-h2** | MEDIUM | Email-uniqueness check: contract doesn't show literal Kysely line OR explicit TX-boundary placement. Per Z.1.5 mandate, check MUST be inside the TX (race-condition guard). | Implementation will choose; evaluator verifies via code-read in Phase B that `SELECT 1 FROM users WHERE email = ?` (or equivalent) lands inside the same TX as tenant+user inserts. |
| **B-24-h3** | MEDIUM | Session-issue-after-TX-commit failure-mode audit trail is unspecified: emit `outcome=success` + separate `outcome=failure metadata={reason:'session_issue_failed'}`, OR emit `outcome=success` + return 500 with no failure event? | Implementation chooses; evaluator verifies in Phase B that *some* coherent audit trail exists for the post-commit-session-issue-failure path. |
| **B-24-m1** | MEDIUM | A-24-19 acceptance criterion "≤3 baseline flakes" has no baseline number (B-23-c2 baseline run hasn't happened yet). | Pre-work B (B-23-c2) runs full-PG baseline before SaaS code commits. Number gets written at impl time. Evaluator at Phase B will record `<NEW PASS>/<NEW TOTAL>` and `<FULL PASS>/<FULL TOTAL>` independently. |
| **B-24-m2** | LOW | Tenant slug suffix `randomHex(4)` (16 bits, ~65k space) is fine for v1 but `randomHex(8)` would be safer. | Not security-critical (tenants.slug uniqueness is enforced by DB UNIQUE constraint anyway; collision causes retry, not security issue). Defer. |
| **B-24-m3** | LOW | Contract doesn't enumerate `tenants` row fields the handler will INSERT (id, slug, name, created_at?). | Implementation chooses against mig 001 schema; evaluator verifies via DB-row check in Phase B. |
| **B-24-l1** | LOW | Z.1.2 "consistent name across backend/frontend/audit" preamble line missing. R2 contract IS consistent (`auth.self_register` + `/auth/self-register` + `selfRegister()`) — just lacks the explicit declaration line. | Contract is implicitly consistent; no behavior impact. |
| **B-24-l2** | LOW | Mempalace search §82-89 still says "Wing `cyberstrike`: no results" — should re-search per Z.1.3 with no wing filter or correct wing names. | Generator could re-run; otherwise wing names + key drawers are documented in Z.1.3 itself, accessible to evaluator. No behavior impact. |

## Pitfalls v8 application — round 2

| Pitfall | R2 status |
|---------|-----------|
| **P36** (generator-no-verdict) | APPLIED — contract has explicit P36 compliance line, no PASS/FAIL inside contract. |
| **P37** (pure-fn values code-verified) | APPLIED — migration column types verified against schema.ts + mig 002. |
| **BYTEA exempt** (P32) | APPLIED — no BYTEA in mig 023; metadata is JSONB. |
| **B6 loop bump** | APPLIED in Modified Files row (correct: `i < 10 → i < 11`); 5 stale "K=23" references remain elsewhere → B-24-doc1 backlog. |
| **FULL-suite counts** mandate | COMMITTED. |
| **gitnexus_impact before edits** | APPLIED for `registerRoutes`, `SessionRepo`, `AUDIT_ACTIONS`. |
| **mempalace_search before contract** | APPLIED but partial (Z.1.3 wing-name issue) → B-24-l2. |
| **gitnexus_detect_changes before handoff** | PLANNED for Phase D. |
| **Tenant isolation** | APPLIED — `req.user.tenantId` in hot path; `DEFAULT_TENANT_ID` only in config + tests. |
| **Audit append-only** | APPLIED — no trigger drops in mig 023. |
| **Frozen surfaces** | APPLIED — none of the frozen-surface paths (scope-engine, decepticon-adapter, reports, report-builder, coordinator/payloads.ts, validator-worker validators, migs 001-022) appear in change list. |
| **Self-register atomicity** | APPLIED — tenant + user in single TX; session post-TX (acceptable, see B-24-h3). |
| **P2 fixture isolation** | WILL APPLY — IT uses unique tenant slugs. |
| **P3 resetAuthState order** | APPLIED in R2 — `subscriptions/invoices` DELETE BEFORE tenants. |

## Cardinality / spec invariants verified

| Invariant | Expected (Z.5/Z.6 patched) | Contract | Verified |
|-----------|----------------------------|----------|----------|
| AUDIT_ACTIONS post-S24 | 88 | 88 | YES — current count 87 in `packages/contracts/src/audit.ts`, +1 for `auth.self_register` |
| B6 reports-loop K post-S24 | 11 | 11 (line 135) AND stale 23 (5 places) | PARTIAL — see B-24-doc1 |
| ENVELOPE_KINDS | 7 (unchanged) | n/a (not touched) | YES |
| RBAC_MATRIX | 1575 (unchanged) | n/a (not touched) | YES |
| Frozen surfaces diff | 0 lines | 0 (none in change list) | YES — confirmed by reading File-by-File table |
| BYTEA in mig 023 | 0 | 0 | YES |

## Test count baseline (pre-implementation)

- no-DB: per contract baseline `1066/0/415` (claimed; will independently verify in Phase B)
- full-PG: NOT YET RUN (B-23-c2 pre-work). Baseline numbers captured at Phase B.

## Carry-over for next sprint reviewer (S25)

Per team-lead lifecycle mandate, every PASS triggers full team teardown + respawn for context hygiene.

**Active checks still relevant for S25 review:**
- `subscriptions` and `invoices` tables now exist post-S24 (in mig 023, NOT mig 025). S25 mig 024 = `domain_verifications`. S25 reviewer must NOT re-create subscriptions/invoices.
- AUDIT_ACTIONS baseline for S25 = 88 (post-S24); S25 target = 93 (+5 for `domain.verify.{requested, checked, confirmed, failed, expired}`) per spec Z.5.
- B6 reports-loop K baseline for S25 = 11 (post-S24); S25 target K = 12 (mig 024 added).
- All 8 B6 tests will need another round of prefix-pop bumps when mig 024 lands (S25). Generator should enumerate all 8 in S25 contract, not just 1.
- `auth.self_register` AUDIT_ACTION lives at end of array post-S24. S25 inserts new actions in roadmap-defined block (probably after `auth.self_register` or grouped near its semantic neighbors).
- `tenant_admin` is the only role used for self-registered users. S25's project-creation flow must verify role-based access via existing RBAC matrix without role-bloat.

**Test-count baseline at end of S24 (to be filled by S24 evaluator at Phase B):**
- no-DB: TBD (expect 1066+ NEW + ~1071 with new audit/cardinality tests)
- full-PG: TBD (B-23-c2 baseline + S24 IT tests for self-register)

**E2E paths walked by playwright (S24 has none — IT only):**
- None — E2E deferred to S27 per spec. S25 reviewer should drive the first playwright walk: register → project create → domain verify start → DNS-TXT instructions visible.

**Risks under observation:**
- B-24-h2 (email-uniqueness inside TX) — verify in S24 Phase B; if violated, escalate to S25 fix.
- B-24-h3 (session-issue-failure audit trail) — verify in S24 Phase B; if missing/inconsistent, escalate to S25 fix.
- Stale K=23 references in S24 contract (B-24-doc1) — if generator does not clean up at impl handoff, S25 generator may copy-paste the bad pattern. S25 reviewer: read sprint-24-implementation-summary.md to confirm cleanup.
- frozen-surface adherence — S24 doesn't touch any, but every sprint must re-verify.
- Z.1.5 `users.email` global-unique check is application-level only; if any future sprint silently adds a DB UNIQUE on `users.email`, it will break legacy multi-user-per-tenant fixtures.

**Pitfalls v8 newly tripped this sprint (potential P38 candidates):**
- **P38 candidate**: "Generator's `npx gitnexus impact` reports symbol counts, not test-site counts" — C1 was caused by this confusion (generator counted "22 migrations on disk" instead of "10 down-loop iterations to mig 013"). Recommend P38: "B6 K math is empirically `for (let i = 0; i < N; i++)` count, not migration-file count. Read the loop literal."
- **P39 candidate**: "Stale doc references after correctness fix" — when a contract is revised, find-and-replace ALL repetitions of old value (B6 K had 5 stale K=23 references after the correct fix landed in only 1 place). Recommend P39: "Doc-update fixes must do find-and-replace ALL, not just one site."

## Action for generator

1. Proceed to implementation per contract (binding section: Modified Files row + R2 BLOCKER fixes).
2. During impl handoff (sprint-24-implementation-summary.md), include a "Doc cleanup" section addressing B-24-doc1 + B-24-doc2.
3. Confirm in summary: full-PG baseline run (B-23-c2 pre-work) — record exact numbers.
4. Confirm in summary: B-24-h2 (email-uniqueness in-TX) and B-24-h3 (session-failure audit trail) chosen approaches.
5. Phase B evaluator will verify all of the above against actual code + diff + test runs.

## Verdict line for harness routing

**PASS_WITH_BACKLOG** — generator proceed to S24 implementation. Backlog items B-24-doc1 through B-24-l2 addressed inline during implementation; evaluator verifies in Phase B against code reality.
