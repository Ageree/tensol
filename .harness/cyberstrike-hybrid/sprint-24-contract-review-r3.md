# Sprint 24 Contract Review — R3 Verdict

**Reviewer:** evaluator (Opus 4.7)
**Date:** 2026-05-04
**Contract under review:** `.harness/cyberstrike-hybrid/sprint-24-contract.md` (R3)
**Round:** 3 (post-PASS_WITH_BACKLOG inline cleanup — generator addressed backlog items in a fresh revision instead of impl-summary)

## Verdict: PASS_WITH_BACKLOG (smaller backlog) — proceed to implementation

R3 substantively cleared 11 of 13 backlog items from R2. Remaining 2 items are pure stale-text inconsistencies in non-binding sections — implementer following the binding sections (§B6 Change Map, A1 R2 clarification, Frontend Routes) gets the right code. Per ≤2-rounds rule and team-lead's "respawn after PASS" lifecycle mandate, S24 contract is acceptable; no further contract round.

## R2 backlog → R3 coverage

### Substantively resolved in R3

| ID | R2 Status | R3 Resolution |
|----|-----------|---------------|
| **C1** (B6 enumeration) | partial in R2 | §B6 Change Map (lines 148-163) enumerates ALL 8 B6 tests with per-test hunk descriptions. K=11 in reports loop. |
| **C2** (B5 users-column drift) | unverified in R2 | Line 163 confirms B5 test asserts only on table existence, not users column shape. (I empirically verified during R2 review.) |
| **H1** (Z.6/Z.7 inconsistency) | unaddressed in R2 | Line 14 preamble "Mig 023 authority note" — explicit Z.7 wins, mig 023 = subscriptions+invoices. |
| **H2** (email-uniqueness in-TX literal SQL) | unaddressed in R2 | Lines 260-265 show literal Kysely `tx.selectFrom('users').select('id').where('email', '=', body.email).executeTakeFirst()` inside TX, before user INSERT. Race-safe. |
| **H3** (session-issue post-TX failure audit trail) | unaddressed in R2 | Line 266 spec'd: emit success on TX commit, then return 500. User can log in separately. No second audit event. |
| **H4** (App.tsx vs router file) | partial in R2 | Line 268 explicit: `apps/web/src/App.tsx` is the modified file. ProtectedLayout reuses existing `useAuth()` context — no second `/auth/me` call. **Stronger than my ask.** |
| **M1** (A-24-19 baseline) | unaddressed in R2 | Line 368 changed to "0 NEW failures vs baseline established during B-23-c2 pre-work run". Number written into impl summary at runtime. |
| **M2** (slug suffix length) | unaddressed in R2 | Line 253 changed to `randomHex(8)` — 32 bits, ~4B possibilities. |
| **M3** (tenants row fields) | unaddressed in R2 | Line 267 enumerated from mig 001: `{ id: gen_random_uuid(), name: displayName, slug: computedSlug, status: 'active', created_at: now(), updated_at: now() }`. |
| **L1** (naming consistency preamble) | unaddressed in R2 | Line 12 preamble note: `self-register` / `auth.self_register` / `selfRegister()` consistent across all three surfaces. |
| **L2** (mempalace wings) | unaddressed in R2 | Lines 88-98 corrected: `cyberstrike-hybrid` (47 drawers) + `wing_lead-cyberstrike` (46 drawers). Pitfall references P16-P37 from `wing_lead-cyberstrike` now documented. |

### R3 bonus catches (positive)

- **`apps/web/src/api/auth.ts:MeResponse` interface drift** — line 139 in Modified Files. Generator caught that `MeResponse` is currently a flat `{ id, email, role, tenantId, displayName }` interface that does NOT match the actual `/auth/me` backend `{ actor, tenant }` nested shape. This was an implied consequence of BLOCKER-4 that I did not explicitly request. Excellent self-review.

### Remaining backlog (not blockers — addressed at impl handoff)

| ID | Severity | Item | Why not blocker |
|----|----------|------|-----------------|
| **B-24-doc1** | HIGH (doc) | 6 stale "K=23" / "K=22→23" references at lines 109, 171, 217, 338, 361, 379. The binding §B6 Change Map (lines 148-163) is correct (`i < 11` + per-test prefix-pop). | Implementer follows the binding §B6 Change Map. The stale numbers don't reach code. Find-and-replace at impl handoff. |
| **B-24-doc2** | MEDIUM (doc) | Goal+Scope line 27 still says "Auth guard using TanStack Router `beforeLoad`, no content flash". A1 R2 clarification (line 43) + Frontend Routes section (lines 294-311) override with state-machine + ProtectedLayout React component. | A1 + Frontend Routes are binding. Cleanup at impl handoff. |

## Cardinality / spec invariants verified for R3

| Invariant | Expected (Z.5/Z.6 patched) | Contract | Verified |
|-----------|----------------------------|----------|----------|
| AUDIT_ACTIONS post-S24 | 88 | 88 | YES — current count 87 in `packages/contracts/src/audit.ts`, +1 for `auth.self_register` |
| B6 reports-loop K post-S24 | 11 | 11 in §B6 Change Map (line 155) — but 6 stale "K=23" references → B-24-doc1 | PARTIAL — binding section correct; stale doc references remain |
| ENVELOPE_KINDS | 7 (unchanged) | n/a (not touched) | YES |
| RBAC_MATRIX | 1575 (unchanged) | n/a (not touched) | YES |
| Frozen surfaces diff | 0 lines | 0 (none in change list) | YES |
| BYTEA in mig 023 | 0 | 0 | YES |
| Tenant slug suffix entropy | safe | randomHex(8), 32 bits | YES |
| Email-uniqueness check inside TX | mandatory (Z.1.5) | inside TX, before user INSERT | YES |

## Pitfalls v8 application (R3)

| Pitfall | R3 status |
|---------|-----------|
| **P36** (generator-no-verdict) | APPLIED |
| **P37** (pure-fn values code-verified) | APPLIED — column types, role enum, audit count all verified against source |
| **P32** (BYTEA exempt) | APPLIED — no BYTEA in mig 023 |
| **P-FULL-suite-counts** | COMMITTED in handoff |
| **P-gitnexus_impact-before-edits** | APPLIED for `registerRoutes`, `SessionRepo`, `AUDIT_ACTIONS` |
| **P-mempalace-wings** | APPLIED in R3 (correct wing names) |
| **P-Tenant-isolation** | APPLIED — `req.user.tenantId` in hot path |
| **P-Audit-append-only** | APPLIED — no trigger drops in mig 023 |
| **P-Frozen-surfaces** | APPLIED — none in change list |
| **P-Self-register-atomicity** | APPLIED — tenant + user in single TX; email uniqueness check ALSO in TX (R3 fix) |
| **P-resetAuthState-FK-order** | APPLIED — invoices/subscriptions DELETE before tenants |

## Pitfall candidates for v9 catalog (still relevant after R3)

- **P38**: "B6 K math is empirically `for (let i = 0; i < N; i++)` count, not migration-file count. Read the loop literal." (R1 generator counted migration files = 22.)
- **P39**: "Doc-update fixes must do find-and-replace ALL, not just one site." (R3 still has 6 stale K=23 references — fix only updated the binding §B6 Change Map.)
- **P40 candidate**: "Frontend interface drift catches require code-reading the type definitions, not just the route handler. R3's `MeResponse` catch was a near-miss — could have shipped with broken nested-field reads." (Generator caught this in R3.)

## Action for generator

1. Proceed to S24 implementation. The §B6 Change Map (lines 148-163) is the binding spec for `migrations.test.ts` changes — ignore the 6 stale K=23 references.
2. **At impl handoff**, in `sprint-24-implementation-summary.md`, include a "Doc cleanup performed during impl" section addressing:
   - **B-24-doc1**: 6 K=23 references corrected to "K = 11 (was 10)" or removed
   - **B-24-doc2**: Goal+Scope line 27 reworded to "Auth guard via `useAuth()` context + ProtectedLayout React component, no content flash"
3. Document in summary all the standard mandates:
   - Advisor pre-contract + pre-handoff calls + takeaways
   - gitnexus_impact symbols + risk levels
   - gitnexus_detect_changes scope match
   - mempalace_search wings/hits (use correct wing names)
   - B-23-c2 full-PG baseline numbers
   - Test counts: NEW + FULL regression
4. Phase B (impl review) follows. ≤2 round rule.

## Carry-over for next sprint reviewer (S25)

(Same as R2 review file; updated where R3 strengthens.)

**Active checks still relevant for S25 review:**
- `subscriptions` and `invoices` tables now exist post-S24 (in mig 023, NOT mig 025). S25 mig 024 = `domain_verifications`. S25 reviewer must NOT re-create subscriptions/invoices.
- AUDIT_ACTIONS baseline for S25 = 88 (post-S24); S25 target = 93 (+5 for `domain.verify.{requested, checked, confirmed, failed, expired}`) per spec Z.5.
- B6 reports-loop K baseline for S25 = 11 (post-S24); S25 target K = 12 (mig 024 added).
- All 8 B6 tests will need another round of prefix-pop bumps when mig 024 lands. S25 generator must enumerate all 8.
- `auth.self_register` AUDIT_ACTION lives at end of array post-S24.
- `tenant_admin` is the only role used for self-registered users.
- `apps/web/src/api/auth.ts:MeResponse` interface now correctly nested (R3 fix). S25 frontend additions reference `actor.tenantId` and `tenant.id`.
- Tenant slug derivation pattern: email-localpart-`[a-z0-9-]`-`-${randomHex(8)}`. S25 reviewer can rely on this for project-scope tenant lookups in IT fixtures.
- Email-uniqueness check is application-level inside TX (Z.1.5 mandate). S25 reviewer: any auth-related new endpoint must follow the same in-TX check pattern.
- Session-issue post-TX failure audit pattern: emit success then return 500 (R3 H3 decision). S25 reviewer: any new "create-then-issue-token" flow follows the same.

**Test-count baseline at end of S24 (to be filled by S24 evaluator at Phase B):**
- no-DB: TBD
- full-PG: TBD (B-23-c2 baseline + S24 IT for self-register + B6 update)

**E2E paths walked by playwright (S24 has none — IT only):**
- None — E2E deferred to S27 per spec. S25 reviewer drives the first playwright walk.

**Risks under observation:**
- **B-24-doc1 (HIGH-doc)**: 6 stale K=23 references in S24 contract. If generator does NOT clean up at impl handoff, S25 generator may copy-paste the bad pattern when drafting S25 contract. **S25 reviewer MUST verify** sprint-24-implementation-summary.md notes the doc cleanup OR that the implementation correctly used K=11.
- **B-24-doc2 (MEDIUM-doc)**: stale "TanStack Router beforeLoad" wording.
- B-24-h2 verification: in Phase B, code-read `apps/api/src/routes/auth/self-register.ts` confirming the email-uniqueness `SELECT 1` lands inside the same `db.transaction()` block.
- B-24-h3 verification: in Phase B, code-read confirming session-issue failure path emits `outcome=success` then returns 500.
- Frozen-surface adherence — every sprint must re-verify.
- Z.1.5 `users.email` global-unique check is application-level only.

## Verdict line for harness routing

**PASS_WITH_BACKLOG** (R3 — smaller backlog) — generator proceed to S24 implementation. 11 of 13 R2 backlog items resolved in R3. Remaining 2 items (B-24-doc1, B-24-doc2) are pure stale-text in non-binding sections and addressed at impl handoff via `sprint-24-implementation-summary.md` "Doc cleanup performed during impl" section.
