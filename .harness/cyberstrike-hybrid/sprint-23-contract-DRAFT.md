# Sprint 23 Contract — CLEANUP SPRINT (DRAFT)

> **STATUS: DRAFT** — Inherited from S22 cleanup contract v2. Pending S23 generator adoption,
> evaluator review, and incorporation of all R1/R2 blockers + team-lead corrections listed below.
> See "Inherited open items" section.
>
> **CRITICAL: DO NOT drop `audit_events` append-only trigger.** Team-lead directive 2026-05-01:
> trigger stays as security invariant for tamper resistance. Remove any migration step that drops it.

**Generator:** generator-s23 (TBD)
**Phase:** Cleanup → SaaS readiness
**Base commit:** `0fcf33b` (S22 hardening ship — codex fix at `d4ffa91` also included)
**Baseline tests:** no-DB 1133/0/414, full-PG 1399/2/19, lint 0
**Baseline cardinality:** AUDIT_ACTIONS=83, ENVELOPE_KINDS=11, RBAC_MATRIX=1575, B6 K=9
**Total TS LOC at baseline:** ~73k
**LOC target post-cleanup:** ≥15% reduction (~11k lines; evaluator measures via `git diff --stat` excluding test fixtures)

---

## Inherited open items (must resolve before contract v1 APPROVED)

This draft inherits unresolved items from the S22 cleanup contract review cycle:

**Evaluator R1 blockers (10) — addressed in v2 but not yet APPROVED:**
B1 frozen-surface gaps, B2 audit count lock, B3 LOC target, B4 E2E smoke gate,
B5 append-only trigger gate, B6 recon-runner frozen, B7 hardening carries enumerated,
B8 migration rollback waiver, B9 codex round budget, B10 deleted test file enumeration.

**Team-lead corrections (2) — incorporated in v2:**
C-1 (DEFAULT_TENANT_ID seed-only, no middleware), C-2 (targets.ts frozen, G internal only).

**Evaluator R2 items:** Not yet reviewed. S23 generator must request R2 review before impl.

**S22 hardening carries (from B-22-h1/h2/h3):**
These are now S23 P1 openers per team-lead roadmap lock 2026-05-01. See "Carries" section below.

---

## Mission

Cut structural bloat. Solo-maintainable SaaS-ready codebase for S24 web wrapper. No new features.
New tests only where deleted code paths need re-coverage.

User mandate (verbatim 2026-05-01): "Возможно после 18-20 спринта надо будет сильно причесать все.
Потом собрать вокруг всего этого сайт — веб платформы по быстрому и уже искать клиентов"

---

## Carries from S22 hardening — RECONCILIATION 2026-05-01 (post-evaluator-PASS)

> **CORRECTION (2026-05-01 post-evaluator PASS verdict):** Per team-lead final directive after
> S22 evaluator-PASS at `0fcf33b`, **B-22-h1/h2/h3 are ALL CLOSED in S22 ship.** Zero h-carries
> to S23. The table below reflects the original draft state before the team-lead directive;
> see "Reconciled status" column for the authoritative S23 starting state.

| ID | Finding | Original draft status | Reconciled status (authoritative) | S23 action |
|---|---|---|---|---|
| B-22-h1 | P1-HIGH-A: B2 audit FK throw before ack — ghost/cross-tenant `assessmentId` causes audit INSERT to throw → NACK loop (`services/recon-runner/src/worker.ts:137-149`) | NOT FIXED | **CLOSED** at `e7fefcf` per team-lead — `worker.ts:105-132` null-tolerant signature, `155, 168` denied paths pass null resourceId | None — closed |
| B-22-h2 | P1-HIGH-B: `findingsWriter` missing from `ReconWorkerDeps` → nuclei findings never persisted (`worker.ts:196-203`) | NOT FIXED | **CLOSED** at `5858f14` (S22) — `worker.ts:93-94, 249-250`; `nuclei.ts:33, 202-204` | None — closed |
| B-22-h3 | P2-MED-A: httpx-absent path silently disables nuclei stage | NOT FIXED | **CLOSED** at `5858f14` (S22) — `worker.ts:213, 243` httpxSkipped fallback to probeUrls | None — closed |
| — | P1-HIGH-C: OOS subfinder yields persisted as targets | FIXED at `e7fefcf` | — | — |
| — | P2-MED-B: null `projectId` publishes invalid envelope | FIXED at `e7fefcf` | — | — |

**Net for S23 cleanup:** zero hardening blocker carries. S23 generator can proceed directly to
deliverables A-G (cleanup scope) without the original "P1 opener: fix h1 first" sequencing.

---

## Carries from S22 codex final sweep (post-PASS, P2 priority)

After S22 evaluator-PASS at `0fcf33b` and 2 codex fix rounds (`d4ffa91` → `a4d0c2e`), team-lead's final codex sweep on `a4d0c2e` surfaced 2 new HIGH bugs introduced by the R2 catch-path semantics. Per pitfalls v13 candidate B9 ≤2 codex round hard limit (already exhausted), shipped-with-backlog. These carry to S23.

| ID | Finding | File:line | Severity / S23 action |
|---|---|---|---|
| **B-22-c1** | httpx tempdir failure converted to "successful empty scan" via `return []` from catch — worker treats as success/ack instead of fail/retry. TMPDIR EPERM/ENOSPC silently produces 0-finding scan with no failure signal. | `services/recon-runner/src/httpx.ts:138-142` (catch returns `[]`); `services/recon-runner/src/worker.ts:216-259` (callsite treats `[]` as empty-but-OK) | **P2 — recommended:** typed failure result `{ kind: 'fail', reason: 'tmpdir_setup', error: msg }` from catch; worker.ts:216-259 maps to nack/retry instead of ack. Audit emit stays as-is. Non-critical for v1 SaaS (rare-edge, non-exploitable) per team-lead. |
| **B-22-c2** | nuclei mirrors same pattern | `services/recon-runner/src/nuclei.ts:148-152` | **P2** — same fix as c1, applied to nuclei. |

**Routing note:** these carries are R3-class design changes (typed failure return + worker callsite contract update). They were deliberately excluded from R2 to bound S22 sprint duration. S23 generator should sequence them as a small surgical task before deliverable A (lint baseline already done in `e1023e0`) or fold into a "Pre-cleanup hardening prefix" section, similar to how S22 itself was structured.

**Out-of-scope nudge for S23 contract:** since S23 cleanup also touches recon-runner audit emission consolidation (per team-lead A3 collapses `recon.subfinder.*`/`recon.httpx.*`/`recon.nuclei.*` → `recon.run.*` with `metadata.tool`), the S23 generator should batch B-22-c1+c2 fixes with the recon-runner audit consolidation in deliverable E to avoid touching the same files twice.

---

## M2 Frozen-Surface Suspension

The following surfaces are **AUTHORIZED for modification** in S22:

| Surface | Reason |
|---|---|
| `packages/authz/` | RBAC simplification (B) |
| `packages/db/migrations/022+` | New migrations only (E, G) |
| `packages/contracts/src/audit.ts` | Audit action prune (E) |
| `packages/contracts/src/queue-envelope.ts` | Envelope simplification (F) |
| `packages/queue/src/types.ts` | ENVELOPE_KINDS parity (F) |
| `services/browser-worker/` | **DELETION authorized** (inline into coordinator — D) |
| `packages/browser-auth/src/crypto.ts` + `crypto.test.ts` | **DELETION authorized** (BYTEA drop — G) |
| `apps/api/src/middleware/` | DEFAULT_TENANT_ID env fallback (C) |
| `services/coordinator/src/` (excluding `payloads.ts`) | Queue→direct-call refactor (F), browser inline (D) |
| `tests/integration/auth/helpers/` | Role→admin fixture migration (B) |
| Audit emit call-site files (scattered) | Emission deletions for pruned actions (E) |

**Still frozen (DO NOT touch):**
- `packages/scope-engine`
- `packages/decepticon-adapter`
- `packages/reports`
- `services/report-builder`
- `services/coordinator/src/payloads.ts`
- `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts`
- `services/recon-runner/` — frozen; B-22-h1/h2/h3 carry to S23
- `services/oob-receiver/`
- `apps/api/src/routes/` (API contract stability for S23) — **includes `targets.ts`; see G re-spec**
- `apps/web/`
- Append-only triggers on `findings`, `evidence`, `reports` tables (security invariant — see E)

**Test-file constraint:** Test files in still-frozen suites may have import paths updated (D) but
assertions must not change. Any test deletion must be in the enumerated list below.

---

## Deleted test files (enumerated)

| File | Deleted by | Test count | LOC |
|---|---|---|---|
| `tests/integration/auth/rbac-matrix-e2e.test.ts` | B | 6 | 120 |
| `packages/browser-auth/src/crypto.test.ts` | G | 16 | 79 |

**Expected post-cleanup no-DB count:** 1131 − 22 = **~1109 pass** (gate: 1054–1164, ±5%)
**Expected post-cleanup full-PG count:** ≥1100 pass absolute (≤3 fail)

No other test files are authorized for deletion without explicit team-lead approval.

---

## Deliverable A — DONE (`e1023e0`, base `1d5d371`)

B-21-e biome lint pass. Lint = 0. No-DB count 1131/0/414 unchanged.

---

## Deliverable B — RBAC simplification (7 roles → 1 admin constant)

**Advisor A1:** Keep `assertCan` call signature unchanged in all 8 frozen API route files.
Simplify matrix internally to 1 admin constant-allow.

**What:**
1. Delete 7 role matrix files (326 LOC total):
   `packages/authz/src/matrix/auditor.ts`, `developer.ts`, `operator.ts`,
   `tenant_admin.ts`, `security_lead.ts`, `platform_admin.ts`, `viewer.ts`.
2. Create `packages/authz/src/matrix/admin.ts` (~27 LOC): exports `adminMatrix` where
   every resource×action entry = `{ allowed: true, reason: 'admin', matchedRuleKey: key }`.
3. Simplify `packages/authz/src/matrix.ts`: compose only `adminMatrix`.
4. Keep `packages/authz/src/assert-can.ts` function signature + return type UNCHANGED (A1).
   Keep RBAC_MATRIX.get call for defense-in-depth.
5. Update `packages/authz/src/roles.ts`: export only `'admin'` as single Role.
6. Update `packages/authz/src/actor.ts`: `role` field type narrows to `'admin'`.
7. Update `packages/authz/src/matrix.test.ts`: cardinality `toBe(1575)` → `toBe(225)`.
8. Delete `tests/integration/auth/rbac-matrix-e2e.test.ts` (120 LOC, 6 tests).
9. Auth fixture files — update all `role` seeds to `'admin'`. Specific files (verify with
   `rg "role:" tests/integration/auth/helpers/`):
   - `tests/integration/auth/helpers/auth-fixture.ts`
   - Any other helpers file with `role:` assignment

**LOC delta:** −326 (7 role files) − 120 (e2e test) + 27 (admin.ts) = **~−419 lines**

**Acceptance:**
- A-22-B1: `RBAC_MATRIX.size === 225` (1 role × 15 resources × 15 actions)
- A-22-B2: All 8 `assertCan` call sites in route files compile — tsc 0 (call shape frozen per A1)
- A-22-B3: 7 deleted role files + e2e rbac test absent from working tree
- A-22-B4: No new full-PG failures vs post-A baseline

---

## Deliverable C — Default tenant seed constant (re-spec per team-lead C-1)

**Team-lead C-1:** Drop "single-tenant env fallback in middleware" idea. Keep `tenant_id` columns
+ queries entirely unchanged. Only change: hardcode `DEFAULT_TENANT_ID` constant in dev seed /
app start config (~5 LOC additive). Multi-tenant table support fully preserved.

**What:**
- Add `DEFAULT_TENANT_ID` constant in `packages/config/src/` (or equivalent config entry point).
  Value sourced from env var with static dev fallback.
- Wire constant into dev seed script so local `bun run db:seed` uses the fixed tenant ID.
- No middleware changes. No fixture changes. No schema changes.

**LOC delta:** ~+5 lines (additive only)

**Acceptance:**
- A-22-C1: `DEFAULT_TENANT_ID` constant present in `packages/config/`
- A-22-C2: `bun run db:seed` uses the constant (no dynamic slug on dev path)
- A-22-C3: No new full-PG failures; IT multi-tenant isolation unchanged

---

## Deliverable D — Inline browser-worker into coordinator (per advisor A2)

**Target:** `services/coordinator/src/browser/`

**What:**
1. Move all files from `services/browser-worker/src/` into `services/coordinator/src/browser/`.
2. Update `services/coordinator/src/browser-child-job.ts` and any coordinator imports to use
   new local path (remove `@cyberstrike/browser-worker` references).
3. Update `services/coordinator/package.json`: remove `@cyberstrike/browser-worker` dep;
   add `@playwright/test` + any other direct deps that browser-worker declared.
4. Delete `services/browser-worker/` directory (package.json, tsconfig.json, src/, tests/).
5. Update root workspace config to remove browser-worker package reference.
6. Update `tests/integration/browser/` import paths to new location
   (assertions unchanged — frozen-surface rule applies).
7. Move browser-worker unit tests alongside source in `services/coordinator/src/browser/`.

**LOC delta:** 0 (move). Saves ~5 config files (package.json, tsconfig).

**Acceptance:**
- A-22-D1: `services/browser-worker/` directory does not exist
- A-22-D2: `services/coordinator/src/browser/worker.ts` exists with same content
- A-22-D3: `bun run typecheck` → 0 errors (all imports resolved)
- A-22-D4: All browser IT tests pass (no new full-PG failures vs post-C baseline)

---

## Deliverable E — Audit action prune (83 → exactly 12, per advisor A3)

**Target: exactly 12 actions** (team-lead A3 answer):

```
assessment.created
assessment.started
assessment.completed
assessment.failed
finding.created
finding.confirmed
report.generated
auth.login.success
auth.login.failure
recon.run.started
recon.run.completed
validator.run.started
```

> If evaluator's A3 count differs from 12, evaluator's count is authoritative. Update
> `AUDIT_ACTIONS.length` assertion to match evaluator's confirmed list.

**Consolidation rules (per A3):**
- All `recon.subfinder.*`, `recon.httpx.*`, `recon.nuclei.*` → `recon.run.started` /
  `recon.run.completed` with `metadata.tool` field
- All `validator.ssrf.*`, `validator.lfi.*`, `validator.rce.*` → `validator.run.started`
  with `metadata.kind` field
- All other 71 entries dropped entirely (no stubs, no dead emit calls)

**Migration 022 — audit cardinality only (NO trigger drop):**
- Write `packages/db/migrations/022_audit_prune.ts` if schema changes are needed for audit action
  consolidation (e.g., enum column update). If AUDIT_ACTIONS is a TS array only (no DB enum),
  no migration needed for E — skip to 023 numbering for BYTEA drop.
- **DO NOT drop any append-only trigger** — `audit_events`, `findings`, `evidence`, `reports`
  triggers ALL stay. This is a security invariant for tamper resistance. Team-lead directive
  2026-05-01: "audit_events append-only trigger DROP — REJECTED."
- B6 rollback K update only if a migration file is actually written.

**Implementation:**
1. Remove 71 non-kept entries from `AUDIT_ACTIONS` in `audit.ts`.
2. Update `audit.test.ts` cardinality assertion to `12`.
3. Update all recon emission call sites to `recon.run.*` + `metadata.tool`.
4. Update all validator emission call sites to `validator.run.*` + `metadata.kind`.
5. Remove emission call sites for all fully dropped actions.

**LOC reduction estimate:** ~80-100 lines from audit.ts + scattered emit deletions

**Acceptance:**
- A-22-E1: `AUDIT_ACTIONS.length === 12` (or evaluator-confirmed A3 count)
- A-22-E2: `audit.test.ts` cardinality updated and passes
- A-22-E3: `bun run typecheck` → 0 errors
- A-22-E4: No new full-PG failures vs post-D baseline
- A-23-E5: If migration written, it round-trips cleanly; NO append-only triggers dropped
- A-23-E-append: ALL append-only triggers (`audit_events`, `findings`, `evidence`, `reports`)
  present in pg_trigger after all migrations (security invariant — DO NOT drop any)

---

## Deliverable F — Envelope/queue simplification (11 → 7)

**Drop (4 kinds):**
- `recon.browser` — inlined to coordinator/browser/ after D
- `browser.auth` — inlined to coordinator/browser/ after D
- `decepticon.findings` — decepticon-adapter runs in-process with coordinator (verify before drop)
- `recon.browser.placeholder` — deprecated Sprint 7, no consumers

**Keep (7 total):**
`assessment.start`, `validate.finding`, `report.build`,
`validator.ssrf.replay`, `validator.lfi.replay`, `validator.rce.replay`,
`recon.subfinder.run`

**Implementation:**
1. Remove 4 dropped kinds from `ENVELOPE_KINDS` in `packages/contracts/src/queue-envelope.ts`.
2. Update `packages/queue/src/types.ts` parity.
3. Replace queue publish/subscribe for 3 active dropped kinds with direct async function
   calls in `services/coordinator/src/`.
4. Update `queue-envelope.test.ts` count assertion (11 → 7).
5. Update `packages/queue/src/index.test.ts` parity assertion.
6. Remove queue subscriber registrations in coordinator for 3 dropped kinds.

**LOC reduction estimate:** ~150-200 lines

**Acceptance:**
- A-22-F1: `ENVELOPE_KINDS.length === 7`
- A-22-F2: `queue-envelope.test.ts` + `queue/index.test.ts` cardinality pass
- A-22-F3: No new full-PG failures vs post-E baseline
- A-22-F4: `recon.browser.placeholder` absent from ENVELOPE_KINDS

---

## Deliverable G — Drop BYTEA encrypted credentials (migration 023, re-spec per team-lead C-2)

**Team-lead C-2:** `apps/api/src/routes/targets/targets.ts` STAYS FROZEN. Cleanup is internal:
migration changes column type, auth-handler stops decrypting, API route JSON shape unchanged.

**What:**
1. Write `packages/db/migrations/023_drop_bytea_credentials.ts`:
   - `up`: ALTER TABLE `target_credentials` ADD COLUMN `recipe_text` text,
     DROP COLUMN `encrypted_blob`, DROP COLUMN `iv`, DROP COLUMN `auth_tag`.
   - `down`: ADD COLUMN `encrypted_blob` bytea, ADD COLUMN `iv` bytea,
     ADD COLUMN `auth_tag` bytea, DROP COLUMN `recipe_text`.
   - Add comment: `// pre-launch waiver: dev DB only, prod has no production data;
     recipe_text data lost on rollback is acceptable` (B8 waiver).
2. Delete `packages/browser-auth/src/crypto.ts` (39 LOC) and
   `packages/browser-auth/src/crypto.test.ts` (79 LOC, 16 tests).
3. Remove crypto exports from `packages/browser-auth/src/index.ts`.
4. Update `services/coordinator/src/browser/auth-handler.ts` (after D inline):
   replace AES decrypt call with plain `recipe_text` column read. No API surface change.
5. **DO NOT change `apps/api/src/routes/targets/targets.ts`** — route JSON shape frozen (C-2).
   If the route currently calls `encrypt()` before insert: remove that call or inline it
   without changing the route's request/response shape.
6. Remove `CREDENTIAL_KEK` env var from config and startup checks.
7. Update B6 rollback test: K goes 10 → 11 (migrations 022 + 023 both present).
8. Update `packages/authz/src/matrix.test.ts` B23 schema-shape exempt list if it references
   bytea columns.

**LOC reduction estimate:** ~250 lines (crypto.ts 39 + crypto.test.ts 79 + auth-handler decrypt
path + KEK startup config + schema assertions)

**Acceptance:**
- A-22-G1: `packages/browser-auth/src/crypto.ts` does not exist
- A-22-G2: `target_credentials` table has `recipe_text` column; `encrypted_blob`, `iv`,
  `auth_tag` absent
- A-22-G3: Migration 023 up/down round-trips cleanly
- A-22-G4: B6 rollback K === 11 (migrations 022 + 023 counted)
- A-22-G5: No `CREDENTIAL_KEK` in production startup path
- A-22-G6: All credential IT tests pass (`tests/integration/browser-auth/`)
- A-22-G7: `apps/api/src/routes/targets/targets.ts` diff === 0 (frozen per C-2)
- A-22-G8: Migration 023 down waiver comment present

---

## Verification gates (full sprint)

All gates run from clean working tree at final commit SHA:

| Gate | Target |
|---|---|
| `bun run lint` | 0 errors |
| `bun run typecheck` | 0 errors |
| `bun test --no-database` | ~1109 pass ±5% (1054–1164), 0 fail |
| Full-PG (`DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`) | ≥1100 pass absolute, ≤3 fail |
| E2E smoke pipeline | `tests/integration/e2e/smoke-pipeline.test.ts` passes |
| Append-only triggers preserved | ALL 4 triggers (audit_events + findings + evidence + reports) present post all migrations — NONE dropped |
| LOC reduction | ≥15% vs baseline ~73k (~≥11k lines removed, `git diff --stat` excl. fixtures) |
| AUDIT_ACTIONS.length | === 12 (or evaluator-confirmed A3 count) |
| ENVELOPE_KINDS.length | === 7 |
| RBAC_MATRIX.size | === 225 |
| B6 rollback K | === 11 |
| Frozen surface check | `services/recon-runner/` diff === 0; `apps/api/src/routes/targets/targets.ts` diff === 0 |

---

## Acceptance criteria summary

| ID | Deliverable | Criterion |
|---|---|---|
| A-22-A1 | A | lint → 0 (DONE) |
| A-22-A2 | A | no-DB count unchanged (DONE) |
| A-22-B1 | B | RBAC_MATRIX.size === 225 |
| A-22-B2 | B | tsc 0 (assertCan call shape frozen per A1) |
| A-22-B3 | B | 7 deleted role files + e2e rbac test absent |
| A-22-B4 | B | No new full-PG failures |
| A-22-C1 | C | DEFAULT_TENANT_ID constant in packages/config/ |
| A-22-C2 | C | db:seed uses constant |
| A-22-C3 | C | No new full-PG failures |
| A-22-D1 | D | services/browser-worker/ deleted |
| A-22-D2 | D | services/coordinator/src/browser/worker.ts exists |
| A-22-D3 | D | tsc 0 |
| A-22-D4 | D | All browser ITs pass |
| A-22-E1 | E | AUDIT_ACTIONS.length === 12 |
| A-22-E2 | E | audit.test.ts cardinality updated and passes |
| A-22-E3 | E | tsc 0 |
| A-22-E4 | E | No new full-PG failures |
| A-22-E5 | E | Migration 022 round-trips; only audit_events trigger dropped |
| A-22-E-append | E | findings/evidence/reports triggers present post-022 (B5) |
| A-22-F1 | F | ENVELOPE_KINDS.length === 7 |
| A-22-F2 | F | queue cardinality tests pass |
| A-22-F3 | F | No new full-PG failures |
| A-22-F4 | F | recon.browser.placeholder absent |
| A-22-G1 | G | crypto.ts deleted |
| A-22-G2 | G | recipe_text present, bytea columns absent |
| A-22-G3 | G | migration 023 round-trips |
| A-22-G4 | G | B6 K === 11 |
| A-22-G5 | G | CREDENTIAL_KEK absent from startup |
| A-22-G6 | G | browser-auth IT passes |
| A-22-G7 | G | targets.ts diff === 0 (frozen per C-2) |
| A-22-G8 | G | migration 023 down waiver comment present |
| A-22-Smoke | All | smoke-pipeline.test.ts passes |

---

## Out of scope (do NOT touch)

- `packages/scope-engine` — security-critical
- `packages/decepticon-adapter` — external brain
- `packages/reports` / `services/report-builder` — works fine
- `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts` — codex-clean
- `services/recon-runner/` — frozen; B-22-h1/h2/h3 carry to S23
- `services/oob-receiver/` — S18 fresh
- `apps/api/src/routes/` — API contract stability for S23 (includes targets.ts per C-2)
- `apps/web/` — S23 will modify
- Append-only triggers on `findings`, `evidence`, `reports` (security invariant)
- HAR redaction (Authorization + Cookie headers)
- sha256 BEFORE DB row insert invariant
- Real multi-tenant column drop — deferred to S23+ post-launch decision

---

## Process rules

- One commit per deliverable (B through G) — ~6 commits (A already done at `e1023e0`)
- `git checkout -- services/recon-runner/` executed before first commit (already done)
- gitnexus impact analysis MANDATORY before deleting any symbol
- `gitnexus_detect_changes` before each commit
- No self-issued PASS verdict (P36) — write `sprint-22-implementation-summary.md` only
- ≤2 evaluator fix rounds (R1/R2 budget; R2 contract round = this document; 1 impl round left)
- ≤2 codex fix rounds post-evaluator-PASS (B9 hard limit; ship-with-backlog if exhausted)
- Full-PG run (P45) before sending ready-for-review
- Explicit SendMessage to `evaluator-s22` with SHA + counts (P44)
- DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike
