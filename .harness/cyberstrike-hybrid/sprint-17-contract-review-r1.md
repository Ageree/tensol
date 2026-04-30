# Sprint 17 Contract — Evaluator Review R1

**Evaluator:** evaluator-s17 (Opus 4.7, isolated context)
**Date:** 2026-04-30
**Verdict:** **REVISE** (r1) — 5 hard blockers, 3 soft notes. Rerun ≤1 more contract round; r2 auto-approves unless catastrophic per harness rules.

---

## Hard blockers (B-prefix) — must fix before APPROVE

### B1 [P37] — S11 timeline response shape mis-claimed

Contract §A claims:
> "Existing behavior (S11): Returns `{ rows: [...], nextCursor: string|null }`"

Actual code:

- `apps/api/src/routes/assessments/queries.ts:122` — `c.json({ rows: page.rows.map(...), nextCursor: page.nextCursor })` — backend DOES return `{ rows, nextCursor }` ✓ (this part is correct).
- **BUT** `apps/web/src/api/assessments.ts:36` — `api.get<{ events: TimelineEvent[] }>('/api/v1/assessments/:id/timeline')` — the **web client typing** says `{ events: [...] }`.
- `apps/web/src/pages/AssessmentPage.tsx:32` — `const events = timelineData?.events ?? []` — actually consumes `events`.

Conclusion: the web client is **already broken** (typing claims `events`, backend returns `rows` — runtime sends `undefined` to render, hence `events ?? []` papers it over to empty array).

**Required contract fix:**
1. Document the existing **schism**: backend returns `rows`, web client types/reads `events`. The `events ?? []` fallback hides this in S11.
2. State which side gets fixed in S17. Recommended: backend keeps both `rows` (S11 alias) AND adds `items` (new); web client gets retyped to read `rows` (real backend shape) **AND** continues to function as before. Otherwise the S17 implementation will silently not affect the broken pre-existing rendering.
3. Confirm whether the `tests/integration/assessments/assessments.test.ts:522` IT asserts `rows` (likely) — re-state the exact assertion key, if any.
4. The cursor field name: existing `decodeCursor` accepts `{ occurredAt, id }` — stick with this; do NOT rename to `emittedAt` in cursor payload. Response field for browser obs can use `emittedAt` but cursor encoding stays `(occurredAt, id)`.

### B2 [P32 / P5] — `target_credentials` is APPEND-ONLY: ADD COLUMN trigger compatibility risk understated

Contract §C says:
> "`target_credentials` is append-only (trigger from S15) → the ADD COLUMN is safe (no UPDATE of existing rows; DEFAULT applies only to new inserts)."

This is wrong/misleading on two counts:

1. **PostgreSQL ADD COLUMN with `NOT NULL DEFAULT ''` performs a table rewrite or, in modern PG, fast-path constant default storage in `pg_attrdef`. Either way, **PG does NOT fire row-level UPDATE triggers** for the metadata-only fast path on PG12+. ✓ on the trigger side.
2. **HOWEVER** the contract proposes `last_used_at`'s value will eventually be **updated** ("updated by browser-worker on decrypt — out of scope for S17, stays NULL"). This contradicts append-only. If S18 wants to mutate `last_used_at`, the trigger BLOCKS that UPDATE. Either:
   - (a) The plan to update `last_used_at` is fundamentally incompatible with the append-only invariant — must drop trigger or remove `last_used_at`, OR
   - (b) `last_used_at` lives on a separate sibling table (e.g. `target_credential_usage`) keyed by `credential_id` — a normal mutable table.

**Required contract fix:** pick (a) or (b). I recommend (b) for S18 cleanliness, but (a) is acceptable if you explicitly state "S18 will redesign credential lifecycle to drop append-only or move to a sibling table." Either way, the current contract paragraph misleads — must be corrected.

Also: the contract's `down` migration drops `name`/`status`/`last_used_at` but **does not address what happens if any rows have non-empty `name`/`status`** (DROP COLUMN is destructive — fine in test rollback, dangerous in prod, but acceptable for now).

### B3 [P36 + P34 invariant] — generator file ownership not strict enough

Contract §"Pitfalls v8 P36" says:
> "Generator does NOT write `sprint-17-evaluator-result.md`. Writes only `sprint-17-implementation-summary.md`."

Good in spirit, but **structural enforcement is missing**. Per S15+S16 retrospective (P36 carry), generator-Sonnet keeps relapsing. The contract should declare:
1. The exact ready-for-review handoff filename: `.harness/cyberstrike-hybrid/sprint-17-implementation-summary.md` — generator writes ONLY this.
2. Generator's ready-for-review SendMessage MUST include the SHA + filename + count summary in the message body — NOT in a `*-evaluator-result.md` file.
3. Add an explicit guard: "If `.harness/cyberstrike-hybrid/sprint-17-evaluator-result.md` exists at handoff time, the generator MUST flag this as a P36 violation and team-lead aborts."

Without these explicit rules, P36 will recur. This is harness discipline, not implementation.

### B4 [P33] — B6 loop bump comment math is wrong

Contract §C says:
> "8 = down(020)→down(019)→down(018)→down(017)→down(016)→down(015)→down(014)→down(013); reports table dropped at 013-down."

That's 8 rollback steps from 020 down to 014 (020, 019, 018, 017, 016, 015, 014 = 7 steps). 8 steps is 020→013. Verify: was the S16 comment `7 = down(019)→down(018)→down(017)→down(016)→down(015)→down(014)→down(013)`? Per evaluator-s16 verdict (line 78 of `sprint-16-evaluator-result.md`) — yes, 7 steps from 019 down to 013 with reports dropped at 013. So **020→013 = 8 steps** ✓ matches the bumped count, but the contract example chain only listed 8 entries; let me recount: 020, 019, 018, 017, 016, 015, 014, 013 — that's 8 explicit entries, all rollback targets. ✓ math actually works out.

**HOWEVER** — the contract chain text includes `down(014)` AND `down(013)` (8 explicit calls = 8 loop iters). This is correct. **Adjust the comment for clarity:** `// 8 = applies down() 8 times: 020→019→018→017→016→015→014→013; reports table dropped at down(013).` (Currently the prose chain is fine but slightly ambiguous — fix to count iterations explicitly.)

This is a SOFT note actually — downgrading from B4 to S0. **Skip if pressed for time.** Real B4 follows ↓.

### B4 (real) [P9 / cardinality] — AUDIT_ACTIONS bump ≠ 1, may need 2

Contract claims AUDIT_ACTIONS 60→61 with one new action `auth.credential.read.viewed`. Verify:
1. Does the SF1 BrowserContext pooling change require a new audit action? E.g. `browser.context.recycled` if a context is replaced after error (Option A "context closed only on shutdown" → no, but if there's a health-check restart path, yes). State explicitly: **either NO new action for SF1 (recommended)** OR bump to 62.
2. Does SF3 unit test for "observer disposal on context-close" verify NO additional audit emission? — that's just a unit-test assertion, no new action needed. ✓ same conclusion.

**Required contract fix:** Confirm the +1 (60→61) cardinality is exhaustive. State explicitly: "no other AUDIT_ACTIONS additions in S17." If SF1 needs a recycle audit, bump to 62.

### B5 [Carry] — ADR 0007 closure must match S15+S16 reality, not just declare

Contract §"ADR 0007 Closure" status update says:
> "Status: Proposed → Accepted: raw Playwright + RealBrowserDriver; StagehandBrowserDriver deferred to Phase 4"

The ADR body argues for Stagehand. Just changing the status line to "Accepted: raw Playwright + ..." creates an inconsistent ADR — the body still says "use Stagehand". Fix:

1. **Required:** The Status line MUST reference the Outcome section, e.g. `Status: Accepted (with deviation — see Outcome)`.
2. **Required:** Add an explicit "Outcome (2026-04-30)" section AT THE BOTTOM of the ADR documenting:
   - What ADR proposed: StagehandBrowserDriver
   - What was actually shipped: raw Playwright + RealBrowserDriver
   - Why: Stagehand v3 not yet stable; ship velocity > tooling-perfection (per S15+S16 process update)
   - When Stagehand reconsidered: Phase 4 (S20+) per current roadmap
3. Do NOT delete or re-write the ADR body — append-only ADR convention.

### B6 [Critical pre-flight] — CredentialAPI repo function `listTargetCredentials` SELECT shape

Contract §B says:
> "`listTargetCredentials` repo update: Include `name`, `status`, `last_used_at` in SELECT."

Verify (P37): does `packages/db/src/repos/target-credentials.ts` `listTargetCredentials(db, tenantId, targetId)` exist today? My grep confirms it does (line 83). Required contract clarifications:

1. State the existing function signature verbatim. Especially: tenant scoping (filter `tenant_id = ?`), ordering (`created_at DESC`?), whether it currently returns `encrypted_blob`/`iv`/`auth_tag` fields (which MUST be filtered before serialization in the new handler — the contract IS explicit on this point ✓).
2. State whether `listTargetCredentials` returns `Selectable<TargetCredentialsTable>` rows directly (would expose `encrypted_blob` etc.) or a projected DTO. If raw, the API handler MUST do the projection — state where (`apps/api/src/routes/targets/targets.ts` `mapCredentialRowToListItem(row)`).
3. Add an A-17-CredentialsAPI sub-criterion: **`expect(response.credentials[0]).not.toHaveProperty('encrypted_blob')`** + `iv` + `auth_tag` + `created_by`-PII fields.

---

## Soft notes (S-prefix) — non-blocking but advisable

### S1 [P3 / fixture] — `target_credentials` already in resetAuthState DELETE chain

Contract §C confirms this. Verify (P27 too): `tests/integration/auth/helpers/auth-fixture.ts` — `target_credentials` DELETE present at L238 per S15 evaluator. Mig 020 doesn't add new tables, only ALTER COLUMN, so no new DELETE entries needed. ✓. **No fix; just confirm in implementation summary that auth-fixture.ts is unchanged (or document the diff).**

### S2 [TanStack Virtual] — peerDeps + React 19 compat

Contract says `bun add @tanstack/react-virtual`, pin `^3.0.0`. Verify (P37):
- `@tanstack/react-virtual ^3.x` requires React 18+; works with React 19 per recent npm peerDeps changelog (3.10+ confirmed React 19 in peerDeps).
- Pin **`^3.10.0`** specifically (not just `^3.0.0`) for React 19 compat. State the resolved version in implementation summary.

### S3 [B19 reuse] — POST `/assessments/:id/target-credentials` (S16) vs new `GET /targets/:id/credentials` (S17)

Two different routes for the same resource: S16 uses `assessment` scope, S17 uses `target` scope. Document the intended invariant: **same `target_credentials` row written under assessment.target_id is visible under that target_id**. Tenant scoping makes this safe. State this in the contract so reviewers don't flag a "two API surfaces for one resource" issue.

---

## Frozen surface check (M2) — pre-flight verification

The contract correctly lists frozen surfaces. Confirm in implementation summary: `git diff main..HEAD -- packages/scope-engine packages/decepticon-adapter packages/reports services/report-builder services/coordinator services/validator-worker packages/browser-auth/src/crypto.ts packages/browser-auth/src/executor.ts packages/browser-driver` returns empty.

Note: `packages/browser-auth/src/crypto.ts` is frozen ✓ — but `packages/browser-auth/src/index.ts` (re-exports) is NOT in the frozen list, so adding/removing exports is fine if needed.

---

## Process reminders

1. **R3 single-PG discipline** — generator runs full-PG ONCE in ready-for-review. Re-run ONCE only to disambiguate flake from real fail. Document both runs.
2. **P35 FULL-suite counts** — implementation summary must report `pass/fail/skip` for **the entire test suite**, not just new tests.
3. **≤2 fix-round limit** — after R2 verdict, ship-with-backlog if no codex P1+P2 / no audit-invariant fail / no new flake.
4. **P36** — generator writes ONLY `sprint-17-implementation-summary.md`. The `sprint-17-evaluator-result.md` filename is OWNED by evaluator-s17.

---

## Blocker summary table

| ID | Severity | Topic | Required action |
|----|---|---|---|
| B1 | HARD | S11 timeline response shape (`events` vs `rows`) | State actual schism; fix path |
| B2 | HARD | append-only + `last_used_at` UPDATE plan | Pick separate table OR drop trigger plan |
| B3 | HARD | P36 file ownership enforcement | Add explicit handoff rules |
| B4 | HARD | AUDIT_ACTIONS exhaustive bump | Confirm 60→61 (or →62 if SF1 audits) |
| B5 | HARD | ADR 0007 outcome consistency | Append Outcome section, don't rewrite body |
| B6 | HARD | listTargetCredentials projection | State signature + DTO filter location |
| S1 | SOFT | resetAuthState unchanged | Confirm in impl summary |
| S2 | SOFT | tanstack-virtual React 19 peerDep | Pin `^3.10.0` |
| S3 | SOFT | dual route for same resource | Document invariant |

---

## Decision

**REVISE — round 1.** Address B1-B6 in a contract v2. Soft notes optional but recommended. After contract v2 (round 2) the harness rule auto-approves unless the gaps are catastrophic. Recommend addressing all hard blockers in v2; soft notes can land in implementation as inline comments + summary.

Generator: respond with `sprint-17-contract.md` v2 (overwrite v1). Do NOT start implementation until APPROVE arrives.
