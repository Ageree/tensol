# Sprint 15 Evaluator Result

**Evaluator:** evaluator-s15 (Sonnet 4.6, isolated)
**Commits reviewed:** `5ef8eb4`, `85deba3`
**Date:** 2026-04-30
**Verdict: PASS**

---

## Verification Matrix

| Gate | Result |
|------|--------|
| lint (biome, 445 files) | 0 errors |
| typecheck (tsc -b) | 0 errors |
| unit tests (no-DB) | 56 pass, 0 fail |
| code-read: AES-256-GCM random IV | PASS — `randomBytes(12)` per call |
| code-read: decrypt only in browser-worker | PASS — no `decryptCredential` in apps/api |
| code-read: scope-guard before navigation | PASS — `checkNavigation` at line 125, before `driver.launch` |
| code-read: KEK never logged | PASS — destructured from env, never included in audit metadata |
| code-read: append-only triggers FOR EACH STATEMENT | PASS — 3 triggers via `attachAppendOnlyTriggers` |
| code-read: AUDIT_ACTIONS 52→56 | PASS — 4 actions added, `toBe(56)` in test |
| code-read: ENVELOPE_KINDS 5→7 | PASS — both `packages/queue` and `packages/contracts` updated |
| code-read: P5 Buffer not Uint8Array | PASS — `encryptedBlob: Buffer`, `iv: Buffer`, `authTag: Buffer` |
| code-read: P27 resetAuthState per test | PASS — `afterAll` + `beforeEach` + explicit in each test |
| code-read: ScopeDenyError constructor | PASS — `(targetUrl, decision.matchedDenyRuleIds)` |
| code-read: HandlerOutcome shape | PASS — `{kind:'nack',error}`, no terminal field |

---

## R1-R5 from Round-1 Review — Verification

**R1 (TENANT_OWNED/APPEND_ONLY location):**
- `packages/db/src/schema.ts:451,462` — `target_credentials` in `ALL_TABLE_NAMES` and `APPEND_ONLY_TABLES` ✓
- `tests/integration/db/schema-shape.test.ts:38` — TENANT_OWNED ✓
- `tests/integration/db/schema-shape.test.ts:49` — APPEND_ONLY ✓

**R2 (resetAuthState trigger disable/delete order):**
- `ALTER TABLE target_credentials DISABLE TRIGGER USER` present alongside existing block ✓
- `DELETE FROM target_credentials` before `DELETE FROM targets` (FK order) ✓
- `ENABLE TRIGGER USER` in finally block ✓

**R3 (credential insert API — explicit defer decision):**
- IT seeds via `insertEncryptedCredential` repo helper directly ✓
- Deferral to S16 is explicit: `POST /assessments/:id/target-credentials` with `assertCan` + `RbacDenyError` + `auth.credential.encrypted` audit — ACCEPTED per evaluator round-1 note

**R4 (B6 rollback):**
- New B6 test at `migrations.test.ts:152-180` verifies 3 trigger names, rolls back 018→017, asserts table gone, re-applies ✓
- Existing B6 langgraph test (017) left intact ✓

**R5 (append-only SQLSTATE 23514):**
- `85deba3` fixes the probe to assert `(e as {code?:string}).code === '23514'` ✓
- Pattern matches `append-only-runtime.test.ts:23,36` ✓

---

## Notable implementation decisions

- **Driver choice:** Raw Playwright (no abstraction layer beyond `BrowserDriverFacade` interface). ADR 0007 is present in `docs/adr/`; interface is driver-agnostic so future swap is contained to `playwright-facade.ts`.
- **Duck-typed `ExecutorPage`/`ExecutorContext`:** Avoids hard playwright dep in `packages/browser-auth` — correct design for testability.
- **`goto` spread pattern:** `...(step.waitFor ? [{timeout: step.waitFor.timeoutMs}] : [])` — handles `exactOptionalPropertyTypes` correctly.
- **`noPropertyAccessFromIndexSignature` vs biome `useLiteralKeys`:** Resolved via destructuring (`const { CREDENTIAL_KEK } = process.env`) — matches the `audit/writer.ts` precedent.

---

## Open items (not blocking PASS)

1. **A-15-DriverADR DEFERRED** — ADR 0007 exists but A-15-DriverADR criterion was not formally closed. Carry to S16 codex review.
2. **S16 backlog: credential insert API** — `POST /assessments/:id/target-credentials` with RBAC, `auth.credential.encrypted` audit.
3. **GitNexus index stale** — run `npx gitnexus analyze` post-sprint to update graph (last indexed: `832fa0d`).
4. **Playwright browser binaries** — `playwright install chromium` required before PG IT suite can run; not automated in CI yet.

---

## Verdict

**PASS.** All R1-R5 gaps from the round-1 review are resolved. Lint, typecheck, and unit tests are clean. The crypto design, DB migration, append-only invariants, audit wiring, and scope-guard placement are all correct. The explicit deferral of the credential insert API to S16 is documented and accepted.

Generator may proceed to S16.
