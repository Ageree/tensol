# Sprint 15 Contract Review — Round 1

**Reviewer:** evaluator-s15 (Opus, isolated)
**Contract revision:** `.harness/cyberstrike-hybrid/sprint-15-contract.md` (initial draft, ADR 0006 deferred)
**Date:** 2026-04-30
**Verdict:** **REVISE** — 5 specific gaps. Driver-section deferral is acceptable; remaining design is sound; AES-GCM crypto and migration plan are well-specified.

---

## Headline assessment

The contract is well-structured: testable A-15-* IDs, explicit invariant checks (random IV, auth-tag tamper, scope-gate before nav, encryption-key never logged, append-only triggers, AUDIT_ACTIONS bump). Pitfalls catalog v6 is honored point-by-point. Two-pass review on the driver section (A-15-DriverADR DEFERRED) is fine.

The five issues below are small but blocking — most are exact-location nits the generator can fix quickly.

---

## Required revisions (R1-R5)

### R1 — `TENANT_OWNED` location is wrong (Implementation Plan §packages/db/src/schema.ts)

> Contract says: "Add `target_credentials` to `TENANT_OWNED` set (for schema-shape test)."

**Verified location:** `TENANT_OWNED` is a literal array in `tests/integration/db/schema-shape.test.ts:15` (NOT in `packages/db/src/schema.ts`). Generator must edit the test file, not schema.ts. `APPEND_ONLY` (line 40 same file) is also test-local, not in schema.ts.

`packages/db/src/schema.ts:440` has `APPEND_ONLY_TABLES` (a separate prod constant), which IS the right edit target for the table-class catalog. Both must be updated:
- `packages/db/src/schema.ts:440` — append `'target_credentials'` to `APPEND_ONLY_TABLES`.
- `tests/integration/db/schema-shape.test.ts:15` — append `'target_credentials'` to `TENANT_OWNED`.
- `tests/integration/db/schema-shape.test.ts:40` — append `'target_credentials'` to `APPEND_ONLY`.

**Fix:** restate the file paths in §packages/db/src/schema.ts and add a separate §tests/integration/db/schema-shape.test.ts bullet listing both arrays.

---

### R2 — `resetAuthState` DELETE order needs explicit placement vs `audit_events` and `assessment_targets`

> Contract A-15-FixtureReset says: "`DELETE FROM target_credentials` BEFORE `DELETE FROM targets` (FK order)."

**Verified context** (`tests/integration/auth/helpers/auth-fixture.ts:229-262`):
1. `DELETE FROM audit_events;` (line 229) — runs FIRST due to S5 F3 lesson (audit_events refs projects + assessments)
2. `DELETE FROM assessment_targets;` (line 253) — join table, no triggers
3. `DELETE FROM targets;` (line 256)
4. `DELETE FROM user_sessions;` (line 258)
5. `DELETE FROM tenants;` (line 262)

`target_credentials` has FK → `targets` (per migration). Insert point: **between `assessment_targets` (or `audit_events`) and `targets`**.

**Also flag pattern from S14 ALTER TRIGGER at `auth-fixture.ts:223-224, 233-234, 269, 276`:** the `ALTER TABLE … DISABLE TRIGGER USER` for append-only tables happens BEFORE the DELETE block, with `ENABLE TRIGGER USER` in `finally` block — contract says this but doesn't reference the pattern.

**Fix:** A-15-FixtureReset must call out:
- `ALTER TABLE target_credentials DISABLE TRIGGER USER` placed alongside existing `audit_events` / `reports` DISABLE statements (lines 223-224, 233-234)
- `DELETE FROM target_credentials` inserted **after `audit_events`/`assessment_targets`, before `targets`** — concrete line range expected (around current line 254)
- `ALTER TABLE target_credentials ENABLE TRIGGER USER` in the same `finally` block (current lines 264, 271)

---

### R3 — Missing API insert path criterion (encryption side)

> Contract describes browser-worker as the decrypt site (correct) but does not pin down the **encrypt** site as a testable AC.

The brief explicitly says "MUST be zero hits in `apps/api`" for `decryptCredential` and "encryptCredential calls source key from `process.env.CREDENTIAL_KEK`". The contract's A-15-SecurityInvariants covers the negative direction (key never in payloads, no decrypt in apps/api) but does not require:
- An `apps/api` route that **inserts** a target credential (using `encryptCredential` + `parseKek(process.env.CREDENTIAL_KEK)`) before the worker can ever decrypt one.
- That insert route uses `RbacDenyError` + `assertCan(actor, 'create', 'target_credential')` per S14 lesson (pattern at `apps/api/src/routes/reports/reports.ts:7,41-48`).
- An IT case asserting auditor role → 403 on credential insert, owner → 201, cross-tenant target → 404.

Without an insert site, the IT (A-15-LoginHappyPath) "inserts encrypted credential" via what? Test helper? Direct repo? Make this explicit.

**Fix:** add criterion **A-15-CredentialInsertAPI**:
- New route `POST /assessments/:id/target-credentials` (or similar) under apps/api.
- Reads `process.env.CREDENTIAL_KEK`, calls `encryptCredential`, inserts via `insertTargetCredential`.
- Uses `assertCan` + `RbacDenyError` pattern; throws on `decision.outcome !== 'allow'` (S14 lesson).
- Emits `auth.credential.encrypted` audit (already in the new actions list).
- IT covers: auditor → 403, owner happy-path → 201 + audit row, cross-tenant target → 404.

If you'd rather defer the API route to S16 and seed credentials directly via the repo in tests, **say so explicitly in the contract** and add a backlog entry; do not leave it implicit.

---

### R4 — B6 rollback test bump strategy is vague

> Contract R6 says: "Currently highest migration is 017. Adding 018 → rollback test must iterate `(018 - target_down)` times. Update assertion count."

**Verified context** (`tests/integration/db/migrations.test.ts`): the existing B6 test (line 50-75) calls `migrateDown()` ONCE and asserts that the `langgraph_thread_id` column on `decepticon_sessions` (mig 017) is gone. If 018 ships, that one-step migrateDown now drops `target_credentials` instead, and the existing 017-asserting B6 test breaks.

**Fix:** A-15-Schema must specify exactly:
- Update `tests/integration/db/migrations.test.ts:50-75` (B6 test): change the assertion to check `target_credentials` table is dropped after one `migrateDown()` (was checking `langgraph_thread_id`).
- Add a NEW assertion that confirms `decepticon_sessions.langgraph_thread_id` is still present after step-1 migrateDown (017 is intact), then step-2 migrateDown removes it (regression coverage).
- After both, re-apply with `applyAllMigrations(f)` (already done at the test's end).
- Trigger assertion: add to the B6-trigger block at `migrations.test.ts:118-130` — `pg_trigger` query with `tgrelid = 'public.target_credentials'::regclass` expects `target_credentials_no_delete_stmt` and `target_credentials_no_truncate` (or whatever names you pick — be consistent with the `reports_*` precedent).

---

### R5 — Append-only IT requires distinct path; "embedded" is ambiguous

> A-15-CredentialRepo says: "Append-only: direct `DELETE FROM target_credentials WHERE 1=0` raises PG error… IT in `tests/integration/db/` or embedded in `tests/integration/browser-auth/login-flow.test.ts`."

S14 left an explicit soft-finding (B14 in S14 backlog) that the DELETE-deny trigger was **untested** — the suite never confirmed the trigger fires. Don't repeat the gap here. "Embedded or separate" leaves room for it to be skipped.

**Fix:** mandate either:
- A new test file `tests/integration/db/target-credentials-append-only.test.ts` (preferred, mirrors `tests/integration/audit/append-only-runtime.test.ts:23-101` pattern), OR
- An embedded test case **named** `'A-15-AppendOnly: DELETE FROM target_credentials WHERE 1=0 raises PG check_violation'` inside login-flow.test.ts.

Either way, the assertion must verify **SQLSTATE `23514`** (or whatever ERRCODE you set in the trigger function — reports uses `'check_violation'` = 23514). Pattern at `tests/integration/audit/append-only-runtime.test.ts:23,36,89,101`.

---

## Items that look correct (no revision needed)

✓ AES-256-GCM crypto design (random 96-bit IV per call, auth-tag verification, parseKek length guard, `DecryptionError` on tamper) — A-15-Crypto criteria are testable and tight.

✓ `decryptCredential` confined to browser-worker + `auth.credential.decrypted` audit only emitted there — A-15-SecurityInvariants explicit.

✓ AUDIT_ACTIONS 52 → 56 with 4 named actions in `audit.test.ts:108` cardinality bump — matches the audit pattern (current literal `52` confirmed at `packages/contracts/src/audit.test.ts:108`).

✓ Migration **018** — confirmed correct number (014-017 already taken: `password_reset_tokens`, `platform_settings`, `assessment_targets_idempotency_ownership_approvals`, `decepticon_sessions_thread_id`).

✓ Append-only triggers FOR EACH STATEMENT for DELETE+TRUNCATE; no UPDATE trigger because rows are immutable (consistent with the spec — and a deliberate divergence from the `reports` UPDATE-on-ready pattern, justified because target_credentials has no status field).

✓ Pitfalls catalog v6: 14/15 honored. Item 8 (DNS-NOOP stub) is N/A here since the auth flow doesn't go through scope-engine.decide for DNS — only for the navigation gate, which uses the standard pattern. Worth noting in the contract that item 8 is N/A for this sprint, not silently skipped.

✓ scope-guard `decide()` invocation: `services/browser-worker/src/auth-handler.ts` step 7 uses scope-engine before navigation. Method `'GET'` is explicit (per S13 lesson).

✓ R3 discipline: ONE PG run, ≤3 known flake budget — matches S14 baseline (1209/2 PG, S11 auditor-403 known flake).

✓ Lab fixture: ephemeral port + `httpOnly`/`sameSite: 'strict'` cookie + hardcoded test creds — fine for IT.

✓ A-15-LoginHappyPath, A-15-LoginFailed, A-15-ScopeGuard, A-15-DecryptionFailure, A-15-StorageState — all 5 IT cases cover the brief's required happy + scope-deny + wrong-credential + encryption-tamper + storage-state-reuse paths.

✓ ADR 0006 deferral: contract's stance that `BrowserDriverFacade` interface is driver-agnostic and only `playwright-facade.ts` internals would change is reasonable. A-15-DriverADR DEFERRED is the right placeholder.

---

## Optional advisor consult notes

The [ADVISOR-CONSULT PLACEHOLDER] section is reasonable. For R3 (the credential insert API), I'd lean toward shipping the API route in S15 since it's load-bearing for the IT to even seed credentials — but I'm not gating on this; if generator picks "seed via repo helper, defer API to S16," accept that as long as it's **explicit in the contract** with a backlog entry.

---

## Iteration budget

Round 1 of ≤2. After R1-R5 are addressed in v2, I expect to APPROVE and let implementation begin.

Send updated contract back; I'll do a focused pass on the deltas only.
