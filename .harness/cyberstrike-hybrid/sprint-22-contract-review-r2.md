# Sprint 22 Contract Review — Round 2

**Evaluator:** evaluator-s22 (Opus 4.7, isolated context)
**Verdict:** REVISE r2 (last round before APPROVE per ≤2-round budget)
**Reviewed file:** `.harness/cyberstrike-hybrid/sprint-22-contract.md` (mtime 2026-05-01 07:21)
**Hardening prefix `0fcf33b`:** APPROVED as cleanup baseline (separate verdict)

---

## 0. Hardening prefix verdict (separate from cleanup contract)

The 3 hardening commits on top of e7fefcf are technically clean:
- `e1023e0` biome format pass (deliverable A)
- `5858f14` HIGH-B findingsWriter wired + MED-A httpx-skipped fallback + 2 unit tests
- `0fcf33b` B-21-c stale comment fix + summary doc

Diff vs e7fefcf: 10 files, +290/-45, all within `services/recon-runner/` + `tests/integration/recon/recon-pipeline.test.ts` + summary doc. Frozen-surface clean. Generator-reported gates plausible (lint 0, tsc 0, full-PG 1398/2/19 with 0 net-new failures).

**Hardening prefix accepted as cleanup baseline `0fcf33b`.** Carries B-22-h1 (P1-HIGH-A audit FK throw on ghost assessmentId — production NACK loop) to S23 P1 opener per team-lead. B-22-h2 (HIGH-B) and B-22-h3 (MED-A) resolved in `5858f14`.

P50 clean-tree verification deferred to final implementation evaluation (post-cleanup deliverables B-G ship).

---

## 1. Cleanup contract r2 status against R1 blockers

| R1 # | Blocker | r2 status | Comment |
|---|---|---|---|
| 0 | Strategic ambiguity | ✓ RESOLVED | hardening prefix kept, cleanup atop 0fcf33b |
| B1 | Frozen-surface gaps | ⚠️ PARTIAL | authorized list line 70-77 still missing `apps/api/src/middleware/`, `services/coordinator/src/`, `packages/queue/src/types.ts`, `tests/integration/auth/helpers/`, audit emit call-site files |
| B2 | Audit target | ✓ EXCELLENT | locked at exactly 13, named, gate `=== 13` |
| B3 | LOC math | ❌ STILL WRONG | gate line 306 still says "≥25% / ≥18k". Team-lead lock = ≥15%. NOT updated |
| B4 | E2E smoke gate | ❌ MISSING | no smoke-pipeline gate row. Team-lead listed as critical risk flag |
| B5 | Append-only trigger gate | ⚠️ PARTIAL | line 358 lists as out-of-scope (good), but no explicit gate row. A-22-E5 only verifies audit_events drop, not findings/evidence/reports preservation |
| B6 | Recon-runner WIP | ✓ RESOLVED | hardening committed; recon-runner in STILL FROZEN line 85 + 354 |
| B7 | Production bug carries | ✓ GOOD | lines 23-33 enumerate B-22-h1/h2/h3 with status + S23 routing |
| B8 | Mig destructive down | ❌ MISSING | G's down-path adds bytea back nullable, no "v1 pre-launch waiver — destructive" note |
| B9 | Codex round budget | ❌ MISSING | no "≤2 codex fix rounds post-PASS" rule in process section |
| B10 | Test count gates loose | ❌ STILL LOOSE | gates `≥900 pass`. Team-lead lock = full-PG ≥1100 absolute. NOT updated |

**Team-lead specific corrections (from his ~04:01 message):**
- Action 4 (Deliverable C reframe to ~5 LOC seed/start hardcode): ❌ NOT applied. C still describes "+30 LOC env fallback in middleware".
- Action 5 (Deliverable G keeps `apps/api/src/routes/targets/targets.ts` frozen): ❌ NOT applied. G step 4 (line 274) still says "Update `apps/api/src/routes/targets/targets.ts`" but that path is in STILL FROZEN line 87.

---

## 2. R2 BLOCKERS (must address before APPROVE)

### B1-r2 — Frozen-surface gaps (carry from R1, partial fix needed)

Add to authorized M2 list (currently lines 70-77):
```markdown
- `apps/api/src/middleware/` — for DEFAULT_TENANT_ID resolver edit (C, only if Action 4 reframe rejected)
- `services/coordinator/src/` (excluding `payloads.ts`) — for envelope→direct-call refactor (F) + browser-worker inline (D)
- `packages/queue/src/types.ts` — for ENVELOPE_KINDS prune (F)
- `tests/integration/auth/helpers/` — for role→admin migration (B)
- Audit emit call-site files: enumerate via `grep -r "auditEmitter\|emitAudit\|emit.*audit" --include="*.ts" services/ apps/ packages/` and list explicitly
```

### B3-r2 — LOC reduction gate (carry from R1, NOT addressed)

Verification gate line 306 says "≥25% / ≥18k". Team-lead's most recent lock: **≥15%** (~11k of 73k). Update gate row:

```markdown
| LOC reduction | ≥15% vs baseline ~73k (≥11k lines removed) per team-lead lock 2026-05-01 |
```

Also update `LOC target post-cleanup` line 9: `~43-51k (30-40% reduction)` → `~62k (15% reduction floor)`.

Also: A-22-LOC-1 acceptance criterion is missing entirely from the criteria summary table — add it.

### B4-r2 — E2E smoke gate (carry from R1, NOT addressed)

Add gate row:
```markdown
| E2E smoke pipeline | tests/integration/e2e/smoke-pipeline.test.ts pass (decepticon → recon → validator → report) |
```

And A-22-Smoke-1 acceptance: "Smoke pipeline test passes after all 7 deliverables landed."

If `tests/integration/e2e/smoke-pipeline.test.ts` does not currently exist, contract MUST either:
(a) spec creating one as deliverable H, OR
(b) explicitly waive with team-lead written approval citing existing test coverage

Generator must check `tests/integration/e2e/` and `tests/integration/smoke/` for existing files BEFORE writing r3 contract; report which path is taken.

### B5-r2 — Append-only trigger gate (carry from R1, partial fix)

Add gate row:
```markdown
| Append-only triggers preserved | findings/evidence/reports retain DELETE+TRUNCATE FOR EACH STATEMENT triggers post-mig 022+023 |
```

And A-22-Triggers-1 acceptance: "Verify `pg_trigger` metadata for `findings_append_only`, `evidence_append_only`, `reports_append_only` post-migration."

This is separate from A-22-E5 which only verifies audit_events trigger removal.

### B8-r2 — Migration destructive down (carry from R1, NOT addressed)

Add to deliverable G section:
```markdown
**Down-path note:** Migration 023 down adds bytea columns back as nullable, but
recipe_text data populated post-up is silently dropped. v1 pre-launch only —
no production data exists yet. Document in migration file comment:
`-- v1 pre-launch: down silently drops recipe_text data; safe because no prod data`.
```

And new acceptance A-22-G7: "Migration 023 down-path destructive note documented in migration file."

### B9-r2 — Codex round budget (carry from R1, NOT addressed)

Add to process rules section:
```markdown
- Post-PASS codex round: ≤2 codex fix rounds hard limit; if codex round 3 needed,
  ship-with-backlog and escalate to team-lead. (S15 8-round / S20 5-round precedent.)
```

### B10-r2 — Test count gates (carry from R1, NOT addressed)

Verification gates lines 304-305:
```markdown
| `bun test --no-database` | ≥900 pass, 0 fail (some tests deleted in B/E/G) |
| Full-PG | ≥900 pass, ≤3 fail |
```

Update per team-lead lock 2026-05-01:
```markdown
| `bun test --no-database` | ≥905 pass (≈80% of 1131 baseline), 0 fail |
| Full-PG | ≥1100 pass absolute, ≤3 fail |
```

Plus enumerate deletes:
```markdown
**Test files deleted by cleanup:**
- `tests/integration/auth/rbac-matrix-e2e.test.ts` (B) — multi-role matrix paths
- `packages/browser-auth/src/crypto.test.ts` (G) — encryption-specific tests
- (any others — enumerate before APPROVE)
```

### Team-lead Action 4 — Deliverable C reframe (NOT applied)

Replace deliverable C content (lines 129-146) with:
```markdown
**What:**
- Hardcode `DEFAULT_TENANT_ID` env constant in seed/start (`packages/config/`).
- Multi-tenant path stays untouched in middleware; this is purely a dev/SaaS-deploy
  convenience constant. NO middleware edit required.
- IT fixtures unchanged (each IT creates its own tenant for P2 isolation).

**LOC delta:** ~+5 lines (single env constant declaration + one config export).
```

Update authorized M2 list to **remove** `apps/api/src/middleware/` (no longer needed if Action 4 applied).

If generator believes middleware edit is unavoidable (e.g. config doesn't reach the resolver), escalate to team-lead BEFORE shipping.

### Team-lead Action 5 — Deliverable G frozen-surface conflict (NOT applied)

Deliverable G step 4 (line 274) currently says: *"Update `apps/api/src/routes/targets/targets.ts` credential insert: replace AES encrypt call with plain `recipe_text` store."*

But `apps/api/src/routes/` is in STILL FROZEN (line 87, 356) for S23 API contract stability.

Two options per team-lead Action 5:
- (a) Refactor the encrypt() helper that targets.ts calls into a pass-through. Keep targets.ts file 0-line diff. Authorize the helper file path explicitly (e.g. `packages/browser-auth/src/encrypt.ts` if that's where it lives).
- (b) Escalate to team-lead BEFORE r3 if (a) is infeasible.

r3 contract MUST pick (a) or (b) and document the chosen approach. Targets.ts MUST stay 0-line diff if (a). API surface unchanged either way.

### NEW-r2 — audit_events append-only trigger drop authorization

A3 (line 63) and migration 022 (line 206-209, A-22-E5) **drop the append-only trigger on `audit_events`**. This was NOT in team-lead's earlier brief and changes a security invariant.

Team-lead's wake-up brief listed as critical risk flag: *"Findings/evidence/reports append-only triggers dropped"* — `audit_events` was not listed, but it's the same class of invariant.

Generator must EITHER:
- (a) Get explicit team-lead approval to drop audit_events trigger (via SendMessage), OR
- (b) Remove this drop from migration 022. Keep audit_events trigger intact. Audit prune (E) only changes the AUDIT_ACTIONS string array, not the table-level DDL.

Default position for r3 should be (b) unless team-lead approves (a). The append-only trigger costs nothing at runtime; dropping it gains nothing for solo SaaS.

---

## 3. R2 NON-BLOCKERS (acknowledge, address opportunistically in r3)

- N1: Migration ordering: r2 has E using migration 022, G using migration 023. Acceptance A-22-G4 says "K === 11" (9 + 2). Internally consistent. ✓
- N2: Deliverable D LOC delta acknowledged as 0 (move not delete). Honest. ✓
- N3: A3 audit consolidation introduces `metadata.tool` and `metadata.kind` fields. Make sure r3 contract specifies these fields are added to the audit envelope schema (if not already nullable JSON), and update emission test cardinality. Otherwise emission tests for old action names will fail with "unknown action."

---

## 4. Items already correct in r2 (carry forward, no change)

- §0 strategic resolution. ✓
- §1 hardening carries enumerated. ✓
- A1 RBAC keep-shape correctly applied to deliverable B. ✓
- A2 browser-worker→coordinator/src/browser/ correctly applied to D. ✓
- A3 audit list of exactly 13, named. ✓
- B6 recon-runner in STILL FROZEN. ✓
- Process rules: one-commit-per-deliverable, gitnexus impact mandatory, ≤2 fix rounds, P36 P44 P45 carries. ✓
- Out-of-scope section line 348-360 well-scoped. ✓

---

## 5. Required REVISE actions for r3 contract (FINAL — last round)

Generator must, in r3 contract:

1. **B1-r2**: enumerate frozen-surface authorization additions (5 paths/file groups).
2. **B3-r2**: LOC gate ≥15% (~11k), update header line 9 + gate row + add A-22-LOC-1.
3. **B4-r2**: E2E smoke gate row + A-22-Smoke-1; check existing smoke test or spec deliverable H.
4. **B5-r2**: append-only trigger preservation gate + A-22-Triggers-1 (separate from A-22-E5).
5. **B8-r2**: migration 023 down-path destructive note + A-22-G7.
6. **B9-r2**: ≤2 codex fix rounds post-PASS rule in process section.
7. **B10-r2**: test count gates absolute (≥905 no-DB, ≥1100 full-PG) + enumerate deleted test files.
8. **Action 4**: deliverable C reframe to ~5 LOC seed/start hardcode; remove middleware authorization.
9. **Action 5**: deliverable G — pick option (a) helper pass-through or (b) escalate; targets.ts must be 0-line diff.
10. **NEW-r2**: audit_events trigger drop — escalate for team-lead approval OR remove from migration 022.

After r3 → APPROVE (sustained trade-off: I will accept r3 with up to 2 small unaddressed items if generator notes them as known carries, since this is round 2 of the ≤2 contract round budget and forcing an r4 would delay implementation).

---

## 6. Verdict

**REVISE r2** — 10 specific changes required. Generator should produce r3 contract addressing all items above. Estimated effort: 30-45 min of contract editing, no implementation work yet.

After r3 APPROVED → generator may begin deliverables B through G implementation per process rules already in r2 (one-commit-per-deliverable, gitnexus impact mandatory, etc.).

If team-lead agrees to relax the "≥15% LOC" floor further (because deliverable LOC math still doesn't honestly hit 15%), that's a separate escalation generator can raise in r3.

Process notes:
- This review file is durable per P43.
- r3 contract review file (if needed): `sprint-22-contract-review-r3.md` (rare — only for blocking errors, ≤2 round budget consumed).
- Implementation evaluation file (post-APPROVE): `sprint-22-evaluator-result.md` (P36 evaluator-only).
