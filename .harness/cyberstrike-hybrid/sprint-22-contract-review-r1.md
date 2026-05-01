# Sprint 22 Contract Review — Round 1

**Evaluator:** evaluator-s22 (Opus 4.7, isolated context)
**Verdict:** REVISE (also pending team-lead strategic confirmation)
**Reviewed file:** `.harness/cyberstrike-hybrid/sprint-22-contract.md` (mtime 2026-05-01 after generator-s22 SendMessage)
**Baseline:** `e7fefcf` (S21 codex-fix ship)

---

## 0. Strategic alignment escalation (BLOCKING)

This contract is the **CLEANUP** sprint (RBAC→admin, drop multi-tenant, inline browser-worker, BYTEA drop, ~30-40% LOC reduction). However:

- The previous on-disk `sprint-22-contract.md` (mtime 06:15) was titled **"Recon-Runner Hardening"** with 5 codex blockers (P1-HIGH-A audit FK, P1-HIGH-B findingsWriter, P1-HIGH-C OOS subfinder, P2-MED-A httpx-absent, P2-MED-B null projectId envelope).
- Team-lead's **most recent durable directive** (received 2026-05-01 ~03:50, see SendMessage transcript): *"Decision: ACCEPT S22 = recon-runner hardening per on-disk contract. Roadmap revised: S22 = hardening, S23 = cleanup, S24 = SaaS, S25 = Yandex Cloud."*
- Generator-s22 has now overwritten the hardening contract with this cleanup contract, contradicting team-lead's directive.
- Working tree still has uncommitted recon-runner WIP (`services/recon-runner/src/{httpx,nuclei,subfinder,index}.{ts,test.ts}`) presumably fixing HIGH-A/B/C/MED-A/B from the abandoned hardening contract.
- Task list updated to "S22 ship + spawn S23 cleanup (was SaaS)" — implying a *third* reversal back to cleanup, but no SendMessage from team-lead confirms this latest reversal.

**Action:** I am pausing APPROVE pending explicit one-shot confirmation from team-lead:
> "S22 = CLEANUP per current on-disk contract. Discard recon-runner WIP. P1-HIGH-A audit FK throw + P1-HIGH-B findingsWriter dead code → defer to S23 (or backlog) with explicit production-bug carry."

If team-lead instead re-confirms hardening, generator-s22 must restore the prior hardening contract from git or re-author from the original 5-blocker spec.

---

## 1. R1 BLOCKERS on the cleanup contract content

These apply ONLY if team-lead confirms cleanup direction.

### B1 — Frozen-surface authorization gaps

Contract authorizes modification of: `packages/authz/`, `packages/db/migrations/022+`, `packages/contracts/audit.ts`, `packages/contracts/queue-envelope.ts`, `services/browser-worker/` (delete), `packages/browser-auth/crypto.ts` (delete).

But deliverable **C** modifies `apps/api/src/middleware/` for `DEFAULT_TENANT_ID` fallback, and deliverable **F** modifies `services/coordinator/` (queue subscriber registrations + envelope publish→direct-call refactor). Neither path is in the authorized list, but both are required by the deliverable text.

**Fix:** Add to authorized list:
- `apps/api/src/middleware/` — for DEFAULT_TENANT_ID env fallback (C)
- `services/coordinator/src/` (excluding `payloads.ts` — keep frozen) — for envelope→direct-call refactor (F)
- `packages/queue/src/types.ts` — for ENVELOPE_KINDS prune (F)
- Auth fixture helpers under `tests/integration/auth/helpers/` — for role→admin migration (B)
- Numerous emit call-site files for E (audit prune)

Also missing **STILL FROZEN** entry: `tests/integration/browser/` IT tests should adapt only their import paths (D), not their assertions, so add explicit "test files in still-frozen suites: imports may move, assertions must not change."

### B2 — Deliverable E target inconsistency

- Header: "83 → ~20"
- Keep-list (counted): **37 entries** (auth.* 8, rbac/audit/tenant 3, project/target 6, assessment 5, finding 2, report 3, scope 1, decepticon 3, validator 3, recon 2 = 36, ±1 ambiguity on assessment.completed-vs-approved rename)
- Verification gate: `AUDIT_ACTIONS.length ≤ 45`
- Acceptance A-22-E1: "≤ 45"

**Fix:** Pick ONE target and reconcile all three locations. Recommend: realistic target is **~37** (the actual keep list), gate ≤40 to allow ±3 tolerance. Update: header text, gate threshold, A-22-E1, evaluation matrix.

Also: "assessment.completed (→ rename from assessment.approved?)" — resolve the rename now in contract, not as a question. If renaming, that's a contract change to spec out (action name change requires audit_events row migration consideration — **flag**: existing audit rows have old action name; pruning the action removes future emissions but old rows remain; document this is acceptable since append-only triggers preserve historical actions).

### B3 — Deliverable C is not real "drop multi-tenant"

The contract claims C drops multi-tenant overhead but actually:
- Keeps `tenant_id` columns (correct — destructive migration risk too high)
- Keeps multi-tenant IT isolation (correct — P2 pitfall)
- Adds an env var fallback for single-tenant SaaS deploy
- LOC **delta is +30, not a reduction**

**Fix:** Reframe deliverable C accurately as "Single-tenant SaaS deploy fallback" (additive, no LOC reduction, no architectural simplification). The strategic_inflection memory's "drop multi-tenant overhead" goal is **deferred** — note in contract that real multi-tenant column drop is S23+ post-launch decision.

This affects the LOC reduction math: B (~−350) + C (~+30) + D (~0) + E (~−100) + F (~−150) + G (~−200) = ~−800 lines. **That's ~1% of 73k, not 25%.**

The 25% / ≥18k LOC target in the verification gates is **mathematically impossible** with the current deliverable scope. Either:
- (a) Lower the LOC reduction gate to a realistic ~3-5% (~2-3k lines), OR
- (b) Add additional cleanup deliverables (e.g., delete unused middleware, remove dead Sprint 7+ commented code, drop unused contracts entries) to actually hit 25%, OR
- (c) Acknowledge in contract that "30-40% LOC drop" was an aspirational team-lead figure and actual delivery is "structural simplification, not bulk LOC reduction."

**This is the single largest risk** — generator will hit verification fail on the LOC gate at evaluation time.

### B4 — E2E smoke pipeline gate missing

Team-lead's wake-up brief explicitly required: *"verify all E2E smoke tests still pass (decepticon → recon → validator → report)"* and listed it as a critical risk flag. The contract's verification gates table has no E2E smoke entry. Without it, cleanup that silently breaks the chained pipeline (e.g., F's queue→direct-call refactor breaking decepticon→coordinator dispatch) can pass all listed gates and ship broken.

**Fix:** Add gate row:
```
| E2E smoke pipeline | tests/integration/e2e/smoke-pipeline.test.ts pass |
```
And add A-22-Smoke-1 acceptance criterion: "decepticon → recon → validator → report E2E IT passes after all 7 deliverables landed."

If no such test currently exists, contract must specify creating one as part of S22 OR explicitly waive it with risk acceptance from team-lead.

### B5 — Append-only trigger preservation gate missing

Team-lead's brief listed as critical risk flag: *"Findings/evidence/reports append-only triggers dropped"*. Deliverable G (BYTEA drop migration 022) operates on `target_credentials` not findings/evidence/reports, so should be safe — but contract has no explicit gate verifying findings/evidence/reports append-only triggers remain post-migration-022.

**Fix:** Add gate:
```
| Append-only triggers preserved | findings/evidence/reports trigger DDL unchanged in migration 022 |
```
And A-22-G7: "verify pg_trigger metadata for findings_append_only, evidence_append_only, reports_append_only post-migration."

### B6 — Frozen-surface gate vs lifted authorization conflict

Team-lead's brief said *"Frozen-surface check: ALL items in STILL FROZEN list above must show 0-line diff vs `e7fefcf`"*. The contract STILL FROZEN list includes `services/recon-runner/`. But working tree shows recon-runner WIP from the abandoned hardening contract. If generator commits cleanup at `e7fefcf` baseline without first reverting the recon-runner WIP, S22 will ship recon-runner changes that violate the frozen-surface invariant.

**Fix:** Generator must explicitly state in implementation plan: "git checkout -- services/recon-runner/" before starting cleanup work, OR include recon-runner WIP commit as a separate ship-with-backlog carry from the abandoned hardening sprint (NOT cleanly attributable to S22).

If the latter, contract must be honest: "S22 ships hardening WIP from abandoned contract + cleanup deliverables A-G in single bundle."

### B7 — Production bug carries from abandoned hardening contract

If we accept cleanup direction, the 5 codex blockers from the prior hardening contract become unresolved production bugs:
- **P1-HIGH-A** (audit FK throw on ghost assessmentId → NACK loop) — ACTIVE production bug in `services/recon-runner/src/worker.ts`
- **P1-HIGH-B** (findingsWriter missing → nuclei findings never persisted) — ACTIVE production bug
- **P1-HIGH-C** (OOS subfinder hosts persisted as targets) — team-lead said "already fixed in `e7fefcf`" — verify
- **P2-MED-A** (httpx absence kills nuclei stage) — ACTIVE
- **P2-MED-B** (null projectId envelope) — team-lead said "already fixed in `e7fefcf`" — verify

**Fix:** Contract must include a "Carries from abandoned hardening contract" section explicitly listing all 5 with their `e7fefcf`-status (resolved vs unresolved) and routing to S23 backlog. Without this, the bugs vanish from sprint tracking.

### B8 — Migration 022 down-path risk

G says: `down: reverse (add bytea columns back as nullable)`. But if `recipe_text` data exists when down runs, that data is silently dropped (no migration to bytea). Acceptable for v1 dev-reset world, but contract must explicitly state: "down is destructive of recipe_text data — only safe pre-launch."

Add A-22-G8: "down migration documented as destructive (recipe_text data lost) — acceptable v1 pre-launch."

### B9 — Codex review hook timing

Task #3 says "S22 codex review + adversarial-review post-PASS". Cleanup sprints have unique risk: codex round will likely find dead-code references, broken imports, RBAC bypass surface that the structural cleanup left dangling. Contract should pre-commit to:
- ≤2 evaluator fix rounds (already specified)
- THEN codex round, with budget of ≤2 codex fix rounds before ship-with-backlog

Without this, codex round can extend the sprint indefinitely (S15 8-round / S20 5-round retro precedent).

### B10 — Test count drift expectation

Verification gates say: `bun test --no-database` ≥900 pass, full-PG ≥900 pass. Baseline is 1131 no-DB and 1397 full-PG. That's a tolerated **20% drop in no-DB and 36% drop in full-PG** — large.

Contract should bound which test files are deletion-authorized:
- `tests/integration/auth/rbac-matrix-e2e.test.ts` — explicitly deleted (B)
- `packages/browser-auth/src/crypto.test.ts` — explicitly deleted (G)
- Any others must be enumerated, not implicit.

**Fix:** Add explicit "test files deleted" enumeration. After enumeration, recompute realistic test count target: baseline tests in deleted files − count = expected post-cleanup count. Set gate to "expected ±5%" not "≥900 (i.e. anything goes)."

---

## 2. R1 NON-BLOCKERS (acknowledge, address in contract revision)

- N1: Deliverable D LOC delta is "0 (move not delete)". True, but actually adds the package.json/tsconfig deletion saving (~5 files). Note this in contract.
- N2: Deliverable F: "decepticon.findings → coordinator dispatch: CAN be direct call" — verify decepticon-adapter is also single-process before this. If decepticon runs as separate process, this is wrong.
- N3: Deliverable G step 4 "Update apps/api/src/routes/targets/targets.ts" — but the STILL FROZEN list says `apps/api/src/routes/`. Either lift `targets.ts` from frozen for G, or refactor G to write recipe_text via existing route shape without changing the route file. Pick one and document.
- N4: Deliverable B step 8 "Auth fixtures... update to use 'admin' everywhere" — list specific files to avoid sprawl. Probably 3-5 files based on prior audit.
- N5: Migration 022 needs B6 rollback test update from K=9 → K=10 — already in G step 7. ✓
- N6: B-21-c stale comment fix from prior contract should still happen as a free 1-line carry — add to contract.

---

## 3. Required REVISE actions for r2 contract

Generator must, in r2 contract:
1. **Get team-lead one-shot confirmation** that cleanup is the sprint direction (resolves §0).
2. Address all B1-B10 blockers above with concrete contract edits.
3. Add explicit "Production bugs carried to S23" section listing 5 codex blockers.
4. Add E2E smoke + append-only trigger gates.
5. Reconcile LOC reduction target with realistic deliverable math OR add cleanup deliverables to hit it.
6. Enumerate deleted test files with expected count delta.
7. Add codex round budget (≤2 codex fix rounds post-PASS).
8. Add recon-runner WIP disposition (revert vs bundle as carry).
9. Add migration 022 down-path destructive note.
10. Resolve `targets.ts` in-frozen-list-but-touched conflict.

---

## 4. Items that look correct (no change needed)

- Deliverable A — pure `biome --write`, zero behavioral change. ✓
- Deliverable B mechanics — keeping `assertCan` signature + matrix.get for defense-in-depth is the correct migration shape. ✓
- Deliverable F process-boundary analysis — the keep/drop classification is sound. ✓
- Deliverable G overall direction — BYTEA→text drops 158 lines + KEK env requirement. ✓
- Cardinality targets (RBAC=225, ENVELOPE=7, AUDIT≤45) — directionally correct. ✓
- ≤2 fix rounds + PASS-with-backlog default — standard.

---

## 5. Verdict

**REVISE** — generator must produce r2 contract addressing §0 + all 10 R1 blockers above. Estimated effort: 1-2 hours of contract editing, no implementation work yet.

After r2 contract APPROVED → generator may begin implementation (with explicit recon-runner WIP disposition first move).

Process notes:
- This review file is durable per P43.
- Next review file (if r3 needed): `sprint-22-contract-review-r2.md`.
- Implementation evaluation file (post-APPROVE): `sprint-22-evaluator-result.md` (P36 evaluator-only).
