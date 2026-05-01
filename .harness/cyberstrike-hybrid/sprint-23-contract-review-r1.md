# Sprint 23 Contract Review — Round 1

**Evaluator:** evaluator-s23 (Opus 4.7, isolated context)
**Verdict:** REVISE
**Reviewed file:** `.harness/cyberstrike-hybrid/sprint-23-contract.md` v1 (mtime 2026-05-01 08:10)
**Baseline commit:** `a4d0c2e` (S22 ship-with-backlog)
**Round budget:** ≤2 contract revisions; this is r1; r2 then APPROVE.

---

## 0. Repo verification (evaluator-side reads)

Before reviewing, evaluator confirmed against working tree:

| Check | Result | Source |
|---|---|---|
| `tests/integration/e2e/smoke-pipeline.test.ts` exists | ✓ exists | `find` |
| Current `AUDIT_ACTIONS.length` | 83 (matches contract baseline) | `grep` of `packages/contracts/src/audit.ts` |
| `packages/config/src/` exists for DEFAULT_TENANT_ID | ✓ exists (`base-schema.ts`, `app-env.ts`, `index.ts`) | `find` |
| `packages/authz/src/matrix/*.ts` LOC: 33+44+46+46+58+58+41 = **326 across 7 role files** | matches B estimate | `wc -l` |
| `services/browser-worker/src/*.ts` total | 2,587 LOC (move-not-delete per D) | `wc -l` |
| `packages/browser-auth/src/crypto.ts` | 39 LOC; `crypto.test.ts` 79 LOC | `wc -l` |
| Total TS/TSX LOC repo-wide (excl. node_modules/dist) | **78,930 LOC** (contract claims ~73k — discrepancy ~6k) | `find + wc -l` |

These verifications surface two of the R1 blockers below (B-LOC, B-AUDIT-COUNT).

---

## 1. R1 BLOCKERS (must fix before APPROVE)

### B-LOC — LOC reduction math is mathematically infeasible (carry from S22 R1+R2)

This is the single most important blocker. R1 of the S22 cleanup contract flagged it. R2 flagged it again. v1 of the S23 contract still does NOT resolve it — it just keeps the gate at 15% without any deliverable change to actually reach 15%.

Evaluator-computed honest delta from the contract's own per-deliverable estimates:

| Deliverable | Estimate from contract | Concrete LOC delta |
|---|---|---|
| A (DONE biome) | 0 | 0 |
| B-22-c1/c2 prefix | "+15" | +15 |
| B (RBAC 7→1) | "−326 + 27 − 120 = −419" | ~−419 |
| C (DEFAULT_TENANT_ID) | "+5" | +5 |
| D (browser-worker inline) | "0 (move not delete)" | ~−10 (saves 5 config files, ~10 LOC) |
| E (audit prune + c1/c2) | "−80 to −100" | ~−100 |
| F (envelope 11→7) | "−150 to −200" | ~−175 |
| G (BYTEA drop) | "−250" | ~−250 |
| **TOTAL** | sum | **~−934 lines** |

Repo baseline (verified): **78,930 LOC** TS/TSX (excl. node_modules, dist). Note: contract says ~73k, but evaluator measurement is 78,930 — the gate denominator is wrong by ~7%.

Honest reduction = 934 / 78,930 = **~1.18%**, not 15%. This is **~13 percentage points short**.

**Two acceptable resolutions (pick one):**

**Option (a) — relax the gate to honest math.** Change LOC gate from "≥15% / ≥11k" to "≥1% / ≥800 lines net" with explicit team-lead sign-off note in the contract that 15% was aspirational and deliverables genuinely cannot reach it without scope expansion. This is the honest path. A-22-LOC-1 must mirror the new threshold.

**Option (b) — expand scope to actually hit 15%.** Add concrete deliverables totaling ~10k more LOC removed. Candidates that fit S23 cleanup theme:
  - Delete `services/browser-worker/` *content* not just move (if D becomes "delete + tiny replacement in coordinator", saves ~2,587 LOC)
  - Delete unused middleware/route files (need enumeration first)
  - Delete dead Sprint 7+ commented code (need enumeration)
  - Delete TanStack Virtual / Confirmed Finding UI / Auth State UI (per strategic_inflection memo § "accumulated bloat") — but `apps/web/` is FROZEN per contract line 63
  - Drop multi-tenant table columns destructively (but team-lead C-1 says NO column drops)

Without team-lead approval to expand scope, only option (a) is available. r2 contract MUST pick (a) explicitly with team-lead-signoff comment, OR pick (b) with enumerated deliverable additions and team-lead approval.

**Status:** BLOCKING. Generator may not start implementation until LOC math is reconciled — otherwise sprint will fail evaluator gate at end and force a wasted impl round.

### B-AUDIT-COUNT — Team-lead brief locks 13, contract locks 12

Team-lead's brief to evaluator-s23 (verbatim wake-up):
> AUDIT_ACTIONS = 13
> E: Audit prune 83 → 13

Contract v1 lists 12 actions in deliverable E (lines 188-201) and locks `AUDIT_ACTIONS.length === 12` in A-22-E1 + verification gate (line 310).

The 13-action set is missing one entry. Best guess based on team-lead lock and prior consolidation rules: a 13th action is needed for one of:
- `validator.run.completed` (paired with `validator.run.started` symmetric to recon)
- `assessment.scope-denied` (security-relevant signal that should not be lost)
- `auth.logout` or `target.created` (UX signal)

Generator MUST escalate to team-lead with one-shot question: "Confirm 12 vs 13 audit actions; if 13, name the 13th." Update r2 contract to match the confirmed lock. Do NOT pick 12 unilaterally.

**Status:** BLOCKING. Mismatch with team-lead's locked acceptance budget = automatic evaluator REVISE at impl-eval time.

### B-BASELINE-FULLPG — Baseline test count discrepancy

Contract v1 line 12: `Baseline tests: no-DB 1133/0/414, full-PG 1399/1/19`

But S22 evaluator-result §3 shows `0fcf33b` evaluator gate as 1399/1/19, and §14 shows the FINAL S22 ship at `a4d0c2e` ran full-PG **1400/2/19** (after the 2 mkdtemp regression tests added in R2). Team-lead brief says baseline = 1400/2/19.

Two issues:
1. Contract baseline uses wrong commit's numbers (cite `0fcf33b` numbers but base on `a4d0c2e`).
2. Contract gate "≥1100 absolute, ≤3 fail" lets full-PG drop from 1400 → 1100 (tolerated drop of ~21%) AND lets fails go from 2 → 3. Team-lead's brief locked: **"≥1100 absolute"** but the relative drop check is weak.

**Fix:** r2 contract baseline line should read `Baseline tests: no-DB 1133/0/414, full-PG 1400/2/19 at a4d0c2e`. Gate row remains "≥1100 / ≤3 fail" per team-lead lock — that's authoritative — but the "no net-new failures" gate (separate from absolute floor) must be made explicit. Add gate row:

```markdown
| Net-new full-PG failures | 0 (the 2 documented baselines: B-18a A-Proj-1 + S11 auditor 403 may persist; any 3rd is REVISE) |
```

**Status:** BLOCKING. Without no-net-new-fail gate, regressions can hide under the absolute floor.

### B-RBAC-MATH — RBAC_MATRIX = 225 may be wrong

Contract line 133: `A-22-B1: RBAC_MATRIX.size === 225 (1 role × 15 resources × 15 actions)`

But baseline cardinality declared in same contract (line 13): `RBAC_MATRIX=1575`. If 1575 = 7 roles × 15 resources × 15 actions = 1575 ✓, then 1 role × 15 × 15 = 225. ✓ Math is consistent.

However, evaluator notes the numbers are not verified against actual `packages/authz/src/matrix.test.ts` `toBe(N)` assertion. r2 contract should cite the file:line of the cardinality assertion so generator and evaluator agree on what `RBAC_MATRIX.size` actually counts (matrix entries vs role count vs role × resource entries).

**Fix:** Add to deliverable B step 7: "Cite current matrix.test.ts cardinality file:line and confirm `1575` is the actual baseline (not e.g. 7 × 14 × 16). Then update assertion proportionally."

**Status:** BLOCKING-LITE — math is plausibly correct but unverified; could become impl-eval surprise.

### B-DEC-INPROC — Deliverable F drops `decepticon.findings` envelope without verifying decepticon-adapter is in-process

Contract line 240-241: "decepticon.findings — verify decepticon-adapter runs in-process with coordinator before dropping (if separate process, escalate before drop)"

This is a deferred verification, not an actual gate. If decepticon-adapter runs as a separate process (e.g., LangGraph subprocess), dropping `decepticon.findings` envelope without replacing it with a non-queue IPC mechanism breaks the flow.

**Fix:** Add as a hard gate to deliverable F:

```markdown
**F-precondition (must verify before commit F):** Run `gitnexus_context({name: "decepticon-adapter"})` and `grep "decepticon" services/coordinator/src/`. If decepticon-adapter is invoked via `await import()` or direct function call from coordinator — drop is safe. If invoked via subprocess/IPC/queue — escalate to team-lead BEFORE dropping the envelope kind.
```

And acceptance A-22-F5: "Decepticon-adapter integration with coordinator confirmed as in-process invocation; cite file:line of the call site in implementation summary."

**Status:** BLOCKING. Wire-cutting decepticon.findings without verification is a smoke-test-fail risk.

### B-MIGRATION-AMBIGUITY — Migration 022 vs 023 numbering ambiguity

Contract is internally inconsistent on whether migration 022 exists:
- Line 211: "Write `packages/db/migrations/022_audit_prune.ts` ONLY if schema changes are needed"
- Line 280 (deliverable G): "B6 rollback test: K goes 9 + 2 = **11** (migrations 022 + 023 both present, if 022 is written; or 9 + 1 = 10 if only 023 written)"
- Verification gate line 313: "B6 rollback K | === 11 (if mig 022 written) or === 10 (only 023)"

The contract leaves the 022/023 question to runtime decision. This means the evaluator cannot verify the gate without knowing the path. Worse: K is a hard test assertion; the assertion can only have ONE value.

**Fix:** Decide NOW whether migration 022 is written. Two paths:

(a) `AUDIT_ACTIONS` is a TS-only array (no DB enum) — confirmed by reading `packages/contracts/src/audit.ts` and `packages/db/migrations/`. If TS-only, NO migration 022. Then rename 023 → 022 (sequential). K = 10. A-22-G4 hard-codes K === 10. Single migration.

(b) If audit_events DB enum exists — write migration 022 to update enum. K === 11.

Generator MUST run `grep -r "audit_action\|audit_actions" packages/db/migrations/` BEFORE r2 contract to determine the path, then commit to one number in r2.

**Status:** BLOCKING. Test gate cannot have two values.

### B-FROZEN-RECON-LITE — Recon-runner partial freeze enforcement gap

Contract line 60: "`services/recon-runner/src/` **except** `httpx.ts`, `nuclei.ts`, `worker.ts` (B-22-c1/c2 only)"
Frozen surface gate line 314: "`services/recon-runner/` diff limited to httpx.ts/nuclei.ts/worker.ts only"

But the carve-out is for B-22-c1/c2 typed-failure fix only (3 files). Recon-runner also has emit call sites that deliverable E (audit consolidation) must touch (`recon.subfinder.* → recon.run.*`, etc.). The 3 files listed include `worker.ts` (the dispatcher) but NOT `subfinder.ts` (which emits) or `index.ts` (which orchestrates).

Two interpretations:
- (a) If recon-runner subfinder/httpx/nuclei emit functions all live in `worker.ts` (centralized emit), 3-file carve-out is sufficient.
- (b) If emits live in `subfinder.ts` directly, contract is inconsistent — 3 files is not enough for E.

**Fix:** Generator must run `grep -n "emitAudit\|auditEmitter" services/recon-runner/src/*.ts` BEFORE r2 contract, then either:
- (a) Confirm centralized emit in worker.ts and keep 3-file carve-out, OR
- (b) Expand carve-out to include emit-site files (likely subfinder.ts + httpx.ts + nuclei.ts + worker.ts = 4 files).

**Status:** BLOCKING-LITE. Easy verification but must be done before APPROVE.

### B-TARGETSTS-MECHANIC — How does targets.ts stay 0-line diff if its caller chain changes?

Contract C-2 enforces `apps/api/src/routes/targets/targets.ts` diff === 0 (A-22-G7).

But deliverable G removes the AES-encrypt path. `targets.ts` may currently call:
- (i) `encrypt()` from `packages/browser-auth` directly — then diff === 0 is impossible without keeping a no-op `encrypt()` shim, OR
- (ii) A helper in another package that calls `encrypt()` — then refactor the helper, targets.ts unchanged. ✓
- (iii) Direct DB insert of `recipe_text` via Drizzle without indirection — diff === 0 if column rename happens via migration only.

Contract step 5 (line 278) covers this: "If `encrypt()` helper is called from within a helper file (not from `targets.ts`), refactor the helper to a pass-through instead." But it doesn't handle path (i) — direct call from targets.ts.

**Fix:** Generator must `grep -n "encrypt\|crypto\." apps/api/src/routes/targets/targets.ts` BEFORE r2 contract. If targets.ts calls `encrypt()` directly:
- Either keep a no-op `encrypt()` shim in `packages/browser-auth/` that just returns its input as `Buffer.from(text)` (drop-in compatible, ~3 LOC) and let targets.ts continue calling it (diff === 0 satisfied), AND have the migration handle the column type change (text not bytea), AND have the read-side just decode buffer-as-text.
- Or escalate to team-lead BEFORE r2.

r2 contract MUST document the exact mechanism by which targets.ts achieves 0-line diff, with file:line reference.

**Status:** BLOCKING. C-2 cannot be enforced without a documented mechanism.

### B-CARDINALITY-METADATA — Audit envelope schema migration not specified

Contract line 209: "Metadata fields `metadata.tool` and `metadata.kind` must be present in the audit envelope schema (add as nullable JSON columns if not already)"

But:
- "audit envelope schema" (TS) vs "JSON columns" (DB) — which one? They're different.
- If it's the TS envelope (`packages/contracts/src/audit.ts`), no migration needed.
- If it's the DB column (`audit_events.metadata` JSONB), it likely already exists — `metadata` is a generic JSONB field used by all audit emitters in S15+ history.

**Fix:** r2 contract clarifies:
- (a) `metadata` JSONB column already exists in `audit_events` (verify via grep of `packages/db/migrations/` and `packages/contracts/src/audit.ts`), so no schema change needed — only TS-side audit emit signature must accept `metadata.tool` and `metadata.kind` payload.
- (b) If TS-side schema is currently `{ tenantId, actorId, action, resourceType, resourceId, beforeState, afterState }` without `metadata`, r2 must spec adding `metadata?: Record<string, unknown>` to the type.

**Status:** BLOCKING-LITE. Cannot estimate E LOC delta without knowing schema state.

### B-DELIVC-VERIFY — Deliverable C lacks a "do nothing" branch

Contract C describes adding `DEFAULT_TENANT_ID` and wiring it into seed. But:
- If `packages/config/src/` already has a `DEFAULT_TENANT_ID` constant or env var (likely — multi-tenant code paths usually have a default), C is a no-op.
- If seed already uses a fixed UUID, C is a no-op.

**Fix:** r2 step 0 for C: "Verify current state via `grep -r 'DEFAULT_TENANT_ID\|defaultTenantId' packages/config/ apps/`. If already present, mark C as no-op carry from prior sprint and document no LOC delta. Otherwise proceed with +5 LOC add."

This is minor but prevents impl-eval surprise.

**Status:** NON-BLOCKING — note in r2 but won't block APPROVE.

---

## 2. R1 NON-BLOCKERS (acknowledge, address opportunistically in r2)

- **N1**: Contract uses A-22-* ID prefix throughout but this is sprint 23. Should be A-23-*. Generator inherited this from the DRAFT (which inherited from S22). r2 should rename all `A-22-*` → `A-23-*` for sprint hygiene. Existing B-22-c1/c2 carry IDs stay as B-22-* since they originate in S22.
- **N2**: Contract line 10 says `Generator: generator-s23 (Sonnet 4.6)`. Fine; recorded for memory.
- **N3**: Contract Process rules line 386 says "≤2 evaluator fix rounds (R1 → impl → PASS; R2 if needed)" — but the ≤2 budget covers contract review rounds AND impl fix rounds in different contexts. r2 should disambiguate: "≤2 contract revision rounds (this r1 + r2) AND ≤2 impl fix rounds post-evaluator-REVISE."
- **N4**: A-22-G4 acceptance is "K === 11 OR K === 10" — same B-MIGRATION-AMBIGUITY blocker: pick one.
- **N5**: Contract has both A-22-E5 ("NO append-only triggers dropped") and A-22-E-append ("ALL 4 triggers present"), and A-22-Triggers-1 in summary. Three redundant assertions for the same invariant. Consolidate to one (A-22-Triggers-1 in summary table) and reference from E.
- **N6**: Contract verification gate line 308 says "ALL 4 triggers" but the strategic invariant is enforced via DDL inspection. r2 should specify the verification mechanism: `SELECT tgname FROM pg_trigger WHERE tgname IN ('audit_events_append_only', 'findings_append_only', 'evidence_append_only', 'reports_append_only');` — count expected = 4.

---

## 3. Items already correct in v1 (carry forward, no change)

- §1 B-22-c1/c2 prefix with explicit P53 application reasoning ✓
- Frozen-surface authorization list (with R1+R2 inherited fixes) ✓ (modulo B-FROZEN-RECON-LITE)
- Deleted test files enumerated (2 files, 22 tests) ✓
- E2E smoke gate row + `tests/integration/e2e/smoke-pipeline.test.ts` (exists per evaluator verification) ✓
- Append-only trigger preservation gate ✓
- ≤2 codex fix rounds rule in process section ✓
- Process rules cite P36/P44/P45/P50/P53 ✓
- Migration 023 down-path destructive note + waiver comment ✓
- targets.ts frozen per C-2 stated explicitly ✓
- DEFAULT_TENANT_ID seed-only per C-1 stated explicitly ✓
- audit_events trigger preservation per team-lead directive stated explicitly ✓

---

## 4. Required REVISE actions for r2 contract

Generator must, in r2:

1. **B-LOC** (TOP PRIORITY): pick option (a) honest gate at ~1% / ~900 lines OR option (b) expand scope with team-lead approval. Update gate row + A-22-LOC-1 + header line 15.
2. **B-AUDIT-COUNT**: send SendMessage to team-lead asking 12 vs 13 confirmation; update locked count + named keep-list to match the answer.
3. **B-BASELINE-FULLPG**: fix baseline line to cite a4d0c2e numbers (1400/2/19) and add "Net-new full-PG failures = 0" gate row.
4. **B-RBAC-MATH**: cite `packages/authz/src/matrix.test.ts` cardinality assertion file:line in deliverable B.
5. **B-DEC-INPROC**: add F-precondition check (gitnexus + grep) + A-22-F5 acceptance.
6. **B-MIGRATION-AMBIGUITY**: grep audit_action enum existence, commit to one migration plan (022 OR no-022), update K === N to single value.
7. **B-FROZEN-RECON-LITE**: grep emitAudit sites in recon-runner, expand carve-out if needed.
8. **B-TARGETSTS-MECHANIC**: grep targets.ts encrypt callsite, document the exact mechanism for 0-line diff.
9. **B-CARDINALITY-METADATA**: clarify TS-side vs DB-side schema state for `metadata.tool/kind` fields.
10. **N1**: rename `A-22-*` → `A-23-*` IDs (excluding B-22-* carry IDs).
11. **N3, N5, N6**: minor wording fixes for budget disambiguation, redundant trigger assertions, pg_trigger verification SQL.

---

## 5. Verdict

**REVISE** — generator must produce r2 contract addressing all 9 BLOCKING items above (B-LOC, B-AUDIT-COUNT, B-BASELINE-FULLPG, B-RBAC-MATH, B-DEC-INPROC, B-MIGRATION-AMBIGUITY, B-FROZEN-RECON-LITE, B-TARGETSTS-MECHANIC, B-CARDINALITY-METADATA) plus optional NON-BLOCKERS.

Estimated effort for r2: 30-60 minutes of contract editing + 4 grep verifications + 1 SendMessage to team-lead for AUDIT_ACTIONS confirmation. NO implementation work yet.

After r2 → I will APPROVE if all 9 BLOCKING items addressed cleanly. Per round budget, r2 is the LAST contract revision allowed.

If team-lead authorizes scope expansion (option b) in B-LOC, that escalation can also happen in r2 — flag explicitly so the next contract round absorbs it.

Process notes:
- This review file is durable per P43.
- Next review file (if r3 needed — exceptional only): `sprint-23-contract-review-r2.md`.
- Implementation evaluation file (post-APPROVE): `sprint-23-evaluator-result.md` (P36 evaluator-only).
- Generator must NOT begin implementation until r2 contract APPROVED.
