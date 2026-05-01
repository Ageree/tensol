# Sprint 23 Contract — CLEANUP SPRINT r2 (FINAL)

> **STATUS: r2 FINAL + r2-corrections applied (CONDITIONAL APPROVE per evaluator-s23)**
>
> **CRITICAL: DO NOT drop any append-only trigger.**
> Team-lead directive 2026-05-01: `audit_events`, `findings`, `evidence`, `reports` triggers
> ALL stay as security invariants. No migration may drop any of them.
>
> **AUDIT_ACTIONS = 13 LOCKED with `validator.run.completed` as #13.** Full list in deliverable E.
>
> **LOC gate: Option (b) aggressive expansion authorized by team-lead.**
> Gate: ≥10% / ≥7,900 LOC of 78,930 baseline. Aim 12-15% if dead code plentiful.
> Scope: delete browser-worker FULLY (not just inline), prune knip-flagged dead exports,
> delete unused test fixtures + contract types/enums.

**Generator:** generator-s23 (Sonnet 4.6)
**Phase:** Cleanup → SaaS readiness
**Base commit:** `a4d0c2e` (S22 hardening + 2 codex fix rounds)
**Baseline tests:** no-DB 1133/0/414, full-PG **1400/2/19** at `a4d0c2e`
**Baseline cardinality:** AUDIT_ACTIONS=83, ENVELOPE_KINDS=11, RBAC_MATRIX=1575, B6 K=9
**Total TS LOC at baseline:** ~78,930 (evaluator-verified)
**LOC target post-cleanup:** ≥7,900 lines net removed (≥10% of 78,930; aim 12-15%)

---

## Round budget note

≤2 contract revision rounds (r1 consumed; r2 = this = LAST) AND ≤2 impl fix rounds post-evaluator-REVISE.

---

## knip dead-code analysis (run on `a4d0c2e`)

`bunx knip` reported: 34 unused files (migration files + harness probes — NOT deleted), 19 unused deps, 25 unused exports, 67 unused types.

**Actionable for S23 (team-lead authorized):**
- `services/browser-worker/` — FULL DELETE (2,771 src LOC + ~519 test LOC); move only active code
- `packages/browser-driver/` — FULL DELETE (217 LOC; zero external importers confirmed)
- Dead exports within authorized packages — enumerate at impl time

---

## S22 codex final-sweep carries (B-22-c1/c2) — batched with deliverable E

| ID | File:line | Fix |
|---|---|---|
| **B-22-c1** | `httpx.ts:138-142`; `worker.ts:216-259` | catch returns `{ kind: 'fail' as const, reason: 'tmpdir_setup' as const, error: String(err) }`; worker nacks on `kind === 'fail'` |
| **B-22-c2** | `nuclei.ts:148-152` | same pattern as c1 |

**P53:** Infrastructure failure → typed error + nack. Not empty-success + ack.

---

## M2 Frozen-Surface Suspension

### Authorized for modification / deletion in S23

| Surface | Reason |
|---|---|
| `packages/authz/` | RBAC simplification (B) |
| `packages/db/migrations/022_drop_bytea_credentials.ts` | New migration (G) — numbered 022 (migrations top at 021; no DB audit enum) |
| `packages/contracts/src/audit.ts` | Audit prune + `metadata?` type (E) |
| `packages/contracts/src/queue-envelope.ts` | Envelope simplification (F) |
| `packages/queue/src/types.ts` | ENVELOPE_KINDS parity (F) |
| `services/browser-worker/` | **FULL DELETION + active code moved to coordinator** (D) |
| `packages/browser-driver/` | **FULL DELETION** (H — zero importers) |
| `packages/browser-auth/src/crypto.ts` + `crypto.test.ts` | **DELETION** (G) |
| `packages/browser-auth/src/index.ts` | Remove crypto exports; re-export shim (G) |
| `packages/browser-auth/src/encrypt-shim.ts` | **NEW ~5-LOC file** for targets.ts 0-diff (G) |
| `services/coordinator/src/` (excluding `payloads.ts`) | Receive moved browser-worker code (D) + envelope→direct-call (F) |
| `tests/integration/auth/helpers/` | Role→admin fixture migration (B) |
| `services/recon-runner/src/subfinder.ts`, `httpx.ts`, `nuclei.ts`, `worker.ts` | Audit consolidation (E) + B-22-c1/c2 |
| Audit emit call-site files (enumerate via `grep -r "emitAudit\|auditEmitter" --include="*.ts" services/ apps/`) | Emission rewrite for pruned actions (E) |

### Still frozen (DO NOT touch)

- `packages/scope-engine`, `packages/decepticon-adapter`, `packages/reports`, `services/report-builder`
- `services/coordinator/src/payloads.ts`
- `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts`
- `services/recon-runner/src/` except `subfinder.ts`, `httpx.ts`, `nuclei.ts`, `worker.ts`
- `services/oob-receiver/`
- `apps/api/src/routes/` (includes `targets.ts` per C-2)
- `apps/web/`, `apps/api/src/middleware/`
- All append-only triggers: `audit_events`, `findings`, `evidence`, `reports`
- HAR redaction (Authorization + Cookie headers)
- sha256 BEFORE DB row insert invariant

**Test-file constraint:** Still-frozen suite tests may have import paths updated (D) but assertions must not change.

---

## Deleted test files (enumerated)

| File | Deleted by | Tests | LOC |
|---|---|---|---|
| `tests/integration/auth/rbac-matrix-e2e.test.ts` | B | 6 | 120 |
| `packages/browser-auth/src/crypto.test.ts` | G | 16 | 79 |
| `services/browser-worker/src/index.test.ts` | D | ~3 | 8 |
| `packages/browser-driver/src/playwright-facade.test.ts` | H | TBD | 98 |
| Other browser-worker `*.test.ts` that test deleted (not moved) logic | D | TBD | TBD |

Tests for moved browser-worker code (worker, auth-handler, scope-guard, har-redactor, etc.) → moved alongside source to `services/coordinator/src/browser/`.

**Post-cleanup no-DB gate:** ≥900 pass (generous floor; exact count confirmed after D since browser-worker tests move). 0 fail.
**Post-cleanup full-PG gate:** ≥1100 pass absolute, ≤3 fail.

---

## LOC reduction budget (per-deliverable honest math)

| Deliverable | Removed | Added | Net |
|---|---|---|---|
| A (DONE) | 0 | 0 | 0 |
| B-22-c1/c2 | 0 | +15 | +15 |
| B (RBAC 7→1) | −446 | +27 | ~−419 |
| C (seed constant) | 0 | +5 | +5 |
| D (browser-worker FULL DELETE — only active files moved) | −3,290 src+tests | +2,587 moved (active only) | ~−703 (deleted non-active) |
| D2 (knip dead exports + unused middleware/utility + unused contract types/enums) | −3,000 estimated | 0 | ~−3,000 |
| D3 (unused test fixtures for deleted RBAC roles + deleted envelope kinds) | −800 estimated | 0 | ~−800 |
| E (audit prune 83→13 + dead emits) | −1,200 | +15 (c1/c2) | ~−1,185 |
| F (envelope 11→7 + dead subscribers) | −400 | 0 | ~−400 |
| G (BYTEA drop + crypto.ts) | −245 | +5 | ~−240 |
| H (browser-driver FULL DELETE) | −315 | 0 | ~−315 |
| **TOTAL** | | | **~−7,062 lines (estimated)** |

**Generator mandate (CORRECTION-2 from evaluator r2):**
1. Run `bunx knip 2>&1 | tee .harness/cyberstrike-hybrid/sprint-23-knip-output.txt` BEFORE first commit.
2. Delete all knip-flagged dead exports across `packages/` (not in frozen packages).
3. Delete unused test fixtures for deleted RBAC roles and envelope kinds.
4. Delete unused contract types/enums (envelope payload types, role definitions).
5. Document EVERY deletion in `sprint-23-implementation-summary.md`: file path + LOC + 1-line justification.
6. If honest cumulative net at end of impl is ≥7,900, ship; if short, escalate to team-lead BEFORE SendMessage to evaluator.

**Target:** ≥7,900 lines net removed. With D2/D3 knip-guided deletions, ~7,000-10,000 is achievable. Aim 12-15%.

---

## Deliverable A — DONE (`e1023e0`)

B-21-e biome lint pass. Lint = 0. No action needed.

---

## Deliverable B — RBAC simplification (7 roles → 1 admin constant)

**Baseline verified:** `packages/authz/src/matrix.test.ts:11` → `expect(RBAC_MATRIX.size).toBe(1575)` (7 × 15 × 15). Post-B: 1 × 15 × 15 = 225.

**What:**
1. Delete 7 role matrix files (~326 LOC): `auditor.ts`, `developer.ts`, `operator.ts`, `tenant_admin.ts`, `security_lead.ts`, `platform_admin.ts`, `viewer.ts` in `packages/authz/src/matrix/`.
2. Create `packages/authz/src/matrix/admin.ts` (~27 LOC): `adminMatrix` where every resource×action = `{ allowed: true, reason: 'admin', matchedRuleKey: key }`.
3. Simplify `packages/authz/src/matrix.ts`: compose only `adminMatrix`.
4. Keep `packages/authz/src/assert-can.ts` signature UNCHANGED. Keep `RBAC_MATRIX.get` call.
5. Update `packages/authz/src/roles.ts`: export only `'admin'`.
6. Update `packages/authz/src/actor.ts`: `role` field narrows to `'admin'`.
7. Update `matrix.test.ts:11`: `toBe(1575)` → `toBe(225)`. Verify line 12 evaluates to 225 with 1 role.
8. Delete `tests/integration/auth/rbac-matrix-e2e.test.ts` (120 LOC, 6 tests).
9. Update `role:` seeds in `tests/integration/auth/helpers/auth-fixture.ts` and any other files with `role:` assignment.

**Acceptance:**
- A-23-B1: `RBAC_MATRIX.size === 225` (matrix.test.ts:11)
- A-23-B2: All `assertCan` call sites compile — tsc 0
- A-23-B3: 7 deleted role files + e2e rbac test absent
- A-23-B4: No new full-PG failures

---

## Deliverable C — Default tenant seed constant (re-spec per C-1)

**Step 0:** `grep -r 'DEFAULT_TENANT_ID\|defaultTenantId' packages/config/ apps/`. If present → no-op.

**What (if absent):** Add `DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID ?? '00000000-0000-0000-0000-000000000001'` to `packages/config/src/app-env.ts`. Wire into dev seed. No middleware/fixture/schema changes.

**Acceptance:**
- A-23-C1: `DEFAULT_TENANT_ID` in `packages/config/` (or documented no-op)
- A-23-C2: `bun run db:seed` uses constant
- A-23-C3: No new full-PG failures

---

## Deliverable D — browser-worker FULL DELETE + active code moved to coordinator + knip dead-code prune

**Team-lead directive (CORRECTION-2):** Delete browser-worker FULLY. Move ONLY actively-used files to coordinator. Delete the rest. Then run `bunx knip` and delete all flagged dead exports across unfrozen packages.

### D1 — browser-worker FULL DELETE

**browser-worker files (2,771 src + ~519 tests = ~3,290 LOC):**

| File | LOC | Disposition |
|---|---|---|
| `worker.ts` | 467 | MOVE → `services/coordinator/src/browser/worker.ts` |
| `real-driver.ts` | 326 | MOVE → `services/coordinator/src/browser/real-driver.ts` |
| `auth-handler.ts` | 274 | MOVE → `services/coordinator/src/browser/auth-handler.ts` (updated in G) |
| `fake-driver.ts` | 243 | MOVE → `services/coordinator/src/browser/fake-driver.ts` |
| `types.ts` | 140 | MOVE → `services/coordinator/src/browser/types.ts` |
| `har-redactor.ts` | 119 | MOVE → `services/coordinator/src/browser/har-redactor.ts` |
| `artifact-writer.ts` | 96 | MOVE → `services/coordinator/src/browser/artifact-writer.ts` |
| `spa-observer.ts` | 72 | MOVE → `services/coordinator/src/browser/spa-observer.ts` |
| `select.ts` | 34 | MOVE → `services/coordinator/src/browser/select.ts` |
| `scope-guard.ts` | 35 | MOVE → `services/coordinator/src/browser/scope-guard.ts` |
| `index.ts` | 55 | DELETE (package entry point, not needed) |
| `index.test.ts` | 8 | DELETE |
| Test files for moved code | ~511 | MOVE alongside source |
| Any unused source/test files identified at impl time | TBD | DELETE (document in summary) |

**Implementation:**
1. `mkdir -p services/coordinator/src/browser/`
2. Move active `services/browser-worker/src/*.ts` → `services/coordinator/src/browser/` (except index.ts/index.test.ts and any non-used files).
3. Update imports within moved files: replace `@cyberstrike/browser-worker` with relative paths.
4. Update `services/coordinator/src/browser-child-job.ts` imports.
5. Update `services/coordinator/package.json`: remove `@cyberstrike/browser-worker`; add direct deps.
6. `git rm -r services/browser-worker/`
7. Remove browser-worker from root workspace config.
8. Update `tests/integration/browser/` import paths (assertions unchanged).

### D2 — knip dead-code prune (run BEFORE first commit, document ALL deletions)

**Pre-impl mandatory run:**
```bash
bunx knip 2>&1 | tee .harness/cyberstrike-hybrid/sprint-23-knip-output.txt
git ls-files | xargs wc -l 2>/dev/null | sort -rn | head -50 > .harness/cyberstrike-hybrid/sprint-23-largest-files.txt
```

**Authorized deletions (NOT in frozen packages):**
- Dead exports within `packages/authz/`, `packages/contracts/`, `packages/queue/`, `packages/config/`, `packages/browser-auth/`
- Unused middleware/utility files in unfrozen packages
- Unused contract types for deleted envelope kinds (4 payload schema types)
- Unused role types for deleted 6 roles
- Any unused deps from `package.json` files (knip reports 19 unused deps including `@cyberstrike/browser-driver`)

**For each deletion:** document `file:path + LOC + 1-line justification` in `sprint-23-implementation-summary.md`.

### D3 — unused test fixtures delete

- Test fixtures for deleted RBAC roles (`tests/integration/auth/helpers/` role-specific sections)
- Test fixtures for deleted envelope kinds
- Any `*.test.ts` files testing exclusively deleted code

**Acceptance:**
- A-23-D1: `services/browser-worker/` does not exist
- A-23-D2: `services/coordinator/src/browser/worker.ts` exists
- A-23-D3: tsc 0
- A-23-D4: All browser IT tests pass
- A-23-D5: `sprint-23-knip-output.txt` exists in harness
- A-23-D6: Implementation summary documents all deletions with LOC counts

---

## Deliverable E — Audit action prune (83 → 13) + B-22-c1/c2

**AUDIT_ACTIONS = 13 (team-lead locked):**
```
assessment.created  assessment.started  assessment.completed  assessment.failed
finding.created     finding.confirmed   report.generated
auth.login.success  auth.login.failure
recon.run.started   recon.run.completed
validator.run.started  validator.run.completed
```

**Consolidation:**
- `recon.subfinder.*` / `recon.httpx.*` / `recon.nuclei.*` → `recon.run.started` / `recon.run.completed` + `metadata.tool`
- `validator.ssrf.*` / `validator.lfi.*` / `validator.rce.*` → `validator.run.started` / `validator.run.completed` + `metadata.kind`
- All other 70 entries dropped

**Schema:** `audit_events.metadata` JSONB pre-exists (mig 011). Add `metadata?: Record<string, unknown>` to `AuditEventEnvelope` TS type in `packages/contracts/src/audit.ts`. No migration needed.

**No migration for audit prune** — TS-only array. BYTEA migration is 022 (deliverable G).

**Implementation (single commit with B-22-c1/c2):**
1. Remove 70 entries from `AUDIT_ACTIONS`.
2. Add `metadata?` to `AuditEventEnvelope`.
3. Update `audit.test.ts` cardinality to 13.
4. Rewrite recon emit sites in `subfinder.ts`, `httpx.ts`, `nuclei.ts`, `worker.ts` → `recon.run.*` + `metadata.tool`.
5. Rewrite validator emit sites → `validator.run.*` + `metadata.kind`.
6. Remove dead emit calls for dropped actions.
7. **B-22-c1:** `httpx.ts:138-142` catch → `{ kind: 'fail' as const, reason: 'tmpdir_setup' as const, error: String(err) }`; `worker.ts:216-259` nacks on `kind === 'fail'`.
8. **B-22-c2:** `nuclei.ts:148-152` same pattern.

**Acceptance:**
- A-23-E1: `AUDIT_ACTIONS.length === 13`
- A-23-E2: `audit.test.ts` cardinality passes
- A-23-E3: tsc 0
- A-23-E4: No new full-PG failures
- A-23-E5: No audit migration; no triggers dropped
- A-23-Triggers-1: `SELECT tgname FROM pg_trigger WHERE tgname IN ('audit_events_append_only', 'findings_append_only', 'evidence_append_only', 'reports_append_only')` → count = 4
- A-23-c1: httpx catch returns typed fail
- A-23-c2: nuclei catch mirrors c1
- A-23-c3: worker nacks on `kind === 'fail'`

---

## Deliverable F — Envelope/queue simplification (11 → 7)

**F-precondition:** Confirm `decepticonRunner` = in-process at `start-handler.ts:193`; confirm `decepticon.findings` has no subscriber in `index.ts` (both verified in r2 research).

**Drop (4):** `recon.browser`, `browser.auth`, `decepticon.findings`, `recon.browser.placeholder`
**Keep (7):** `assessment.start`, `validate.finding`, `report.build`, `validator.ssrf.replay`, `validator.lfi.replay`, `validator.rce.replay`, `recon.subfinder.run`

**Implementation:**
1. Remove 4 dropped from `packages/contracts/src/queue-envelope.ts`.
2. Update `packages/queue/src/types.ts` parity.
3. Replace queue publish/subscribe for active dropped kinds with direct async calls in coordinator.
4. Update `queue-envelope.test.ts` count (11 → 7).
5. Update `packages/queue/src/index.test.ts` parity.
6. Remove queue subscriber registrations.

**Acceptance:**
- A-23-F1: `ENVELOPE_KINDS.length === 7`
- A-23-F2: queue cardinality tests pass
- A-23-F3: No new full-PG failures
- A-23-F4: `recon.browser.placeholder` absent
- A-23-F5: impl summary cites `start-handler.ts:193` for in-process decepticon

---

## Deliverable G — Drop BYTEA credentials (migration 022)

**Migration: 022** (migrations top at 021). **B6 K = 10.**

**B-TARGETSTS-MECHANIC:** `targets.ts:668` calls `encryptCredential` directly (import at line 19). Create `packages/browser-auth/src/encrypt-shim.ts` (~5 LOC no-op pass-through); re-export from `index.ts`. `targets.ts` diff === 0.

**What:**
1. `packages/db/migrations/022_drop_bytea_credentials.ts`: `up` ADD `recipe_text text`, DROP `encrypted_blob`, `iv`, `auth_tag`; `down` reverse; comment `// v1 pre-launch: down silently drops recipe_text data; safe because no production data exists yet`.
2. Delete `packages/browser-auth/src/crypto.ts` (39 LOC) + `crypto.test.ts` (79 LOC, 16 tests).
3. Create `packages/browser-auth/src/encrypt-shim.ts` (~5 LOC).
4. Update `packages/browser-auth/src/index.ts`: remove crypto, re-export from shim.
5. Update `services/coordinator/src/browser/auth-handler.ts` (post-D): replace decrypt with plain `recipe_text` read.
6. Update Drizzle schema `packages/db/src/schema.ts`: `encrypted_blob bytea` → `recipe_text text`.
7. Remove `CREDENTIAL_KEK` from config + startup.
8. Update B6 rollback test: K = 10.
9. Update `matrix.test.ts` B23 exempt list if referencing bytea columns.

**Acceptance:**
- A-23-G1: `packages/browser-auth/src/crypto.ts` does not exist
- A-23-G2: `target_credentials.recipe_text` present; bytea columns absent
- A-23-G3: Migration 022 up/down round-trips
- A-23-G4: B6 rollback K === 10
- A-23-G5: No `CREDENTIAL_KEK` in startup
- A-23-G6: `tests/integration/browser-auth/` IT tests pass
- A-23-G7: `apps/api/src/routes/targets/targets.ts` diff === 0 (via encrypt-shim)
- A-23-G8: Migration 022 down waiver comment present

---

## Deliverable H — packages/browser-driver FULL DELETE

**Justification:** 217 LOC (`playwright-facade.ts` 80, `playwright-facade.test.ts` 98, `types.ts` 29, `index.ts` 10). Zero external importers confirmed via grep. Knip reports `@cyberstrike/browser-driver` as unused dep in root `package.json:40`.

**What:**
1. `git rm -r packages/browser-driver/`
2. Remove `"@cyberstrike/browser-driver": "workspace:*"` from root `package.json`.
3. Remove from root workspace config.

**Acceptance:**
- A-23-H1: `packages/browser-driver/` does not exist
- A-23-H2: `@cyberstrike/browser-driver` absent from root `package.json`
- A-23-H3: tsc 0
- A-23-H4: No new full-PG failures

---

## Verification gates (full sprint)

| Gate | Target |
|---|---|
| `bun run lint` | 0 errors |
| `bun run typecheck` | 0 errors |
| `bun test --no-database` | ≥900 pass (floor; exact count confirmed post-D), 0 fail |
| Full-PG (`DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`) | ≥1100 pass absolute, ≤3 fail |
| Net-new full-PG failures | 0 (B-18a A-Proj-1 + S11 auditor 403 may persist; 3rd = REVISE) |
| E2E smoke pipeline | `tests/integration/e2e/smoke-pipeline.test.ts` passes |
| Append-only triggers | `SELECT tgname FROM pg_trigger WHERE tgname IN ('audit_events_append_only', 'findings_append_only', 'evidence_append_only', 'reports_append_only')` → count = 4 |
| LOC reduction | ≥7,900 lines net removed from ~78,930 baseline (≥10%; aim 12-15%) |
| AUDIT_ACTIONS.length | === 13 |
| ENVELOPE_KINDS.length | === 7 |
| RBAC_MATRIX.size | === 225 (matrix.test.ts:11) |
| B6 rollback K | === 10 |
| Frozen surface | recon-runner diff ≤ subfinder/httpx/nuclei/worker; targets.ts diff === 0 |

---

## Acceptance criteria summary

| ID | Deliverable | Criterion |
|---|---|---|
| A-23-A1 | A | lint → 0 (DONE) |
| A-23-A2 | A | no-DB count unchanged (DONE) |
| A-23-B1 | B | RBAC_MATRIX.size === 225 |
| A-23-B2 | B | tsc 0 |
| A-23-B3 | B | 7 role files + e2e rbac test absent |
| A-23-B4 | B | No new full-PG failures |
| A-23-C1 | C | DEFAULT_TENANT_ID in packages/config/ |
| A-23-C2 | C | db:seed uses constant |
| A-23-C3 | C | No new full-PG failures |
| A-23-D1 | D | services/browser-worker/ deleted |
| A-23-D2 | D | services/coordinator/src/browser/worker.ts exists |
| A-23-D3 | D | tsc 0 |
| A-23-D4 | D | All browser ITs pass |
| A-23-D5 | D | sprint-23-knip-output.txt exists in harness |
| A-23-D6 | D | Implementation summary documents all deletions with LOC counts |
| A-23-E1 | E | AUDIT_ACTIONS.length === 13 |
| A-23-E2 | E | audit.test.ts cardinality passes |
| A-23-E3 | E | tsc 0 |
| A-23-E4 | E | No new full-PG failures |
| A-23-E5 | E | No audit migration; no triggers dropped |
| A-23-Triggers-1 | E/All | pg_trigger count = 4 |
| A-23-c1 | E | httpx catch returns typed fail |
| A-23-c2 | E | nuclei catch mirrors c1 |
| A-23-c3 | E | worker nacks on kind === 'fail' |
| A-23-F1 | F | ENVELOPE_KINDS.length === 7 |
| A-23-F2 | F | queue cardinality tests pass |
| A-23-F3 | F | No new full-PG failures |
| A-23-F4 | F | recon.browser.placeholder absent |
| A-23-F5 | F | decepticon in-process cited (start-handler.ts:193) |
| A-23-G1 | G | crypto.ts deleted |
| A-23-G2 | G | recipe_text present; bytea absent |
| A-23-G3 | G | migration 022 round-trips |
| A-23-G4 | G | B6 K === 10 |
| A-23-G5 | G | CREDENTIAL_KEK absent |
| A-23-G6 | G | browser-auth ITs pass |
| A-23-G7 | G | targets.ts diff === 0 (via encrypt-shim) |
| A-23-G8 | G | migration 022 down waiver comment present |
| A-23-H1 | H | packages/browser-driver/ deleted |
| A-23-H2 | H | @cyberstrike/browser-driver absent from root package.json |
| A-23-H3 | H | tsc 0 |
| A-23-H4 | H | No new full-PG failures |
| A-23-Smoke | All | smoke-pipeline.test.ts passes |
| A-23-LOC-1 | All | ≥7,900 lines net removed vs ~78,930 baseline (≥10%) |
| A-23-Net-PG | All | Net-new full-PG failures = 0 |

---

## Out of scope (do NOT touch)

- `packages/scope-engine`, `packages/decepticon-adapter`, `packages/reports`, `services/report-builder`
- `services/coordinator/src/payloads.ts`
- `services/validator-worker/src/{ssrf,lfi,rce}-validator.ts`
- `services/recon-runner/src/` except subfinder/httpx/nuclei/worker
- `services/oob-receiver/`
- `apps/api/src/routes/` (includes targets.ts)
- `apps/web/`, `apps/api/src/middleware/`
- All append-only triggers
- HAR redaction, sha256-before-insert invariant
- Real multi-tenant column drop — deferred to S24+

---

## Process rules

- Commits: one per deliverable, B-22-c1/c2 batched with E — ~7 commits (B/C/D/E/F/G/H)
- gitnexus impact analysis MANDATORY before deleting any symbol
- `gitnexus_detect_changes` before each commit
- No self-issued PASS verdict (P36) — write `sprint-23-implementation-summary.md` only
- ≤2 evaluator fix rounds; ≤2 codex fix rounds post-PASS (ship-with-backlog if exhausted)
- Full-PG run (P45) before SendMessage to `evaluator-s23` with SHA + counts (P44)
- DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike
- P51: obey most recent team-lead directive on conflicts
- P52: never overwrite a contract differing from directive without confirming
- P53: infrastructure failure → nack/retry, not empty-success ack
