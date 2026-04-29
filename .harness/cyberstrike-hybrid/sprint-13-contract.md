# Sprint 13 Contract — E2E Real Engagement Integration

**Date:** 2026-04-28  
**Generator:** generator-s13 (Sonnet)  
**Evaluator:** evaluator  
**Team:** cyberstrike-sprint-13

---

## Mission

Wire `RealDecepticonAdapter` (Sprint 12, commit b908b87) into the coordinator so that setting
`DECEPTICON_ADAPTER=real` selects the real adapter, real findings stream through scope-engine +
validator-worker, and confirmed findings are visible in apps/web (Sprint 11 UI).

---

## Acceptance Criteria

### A-13-Wire
`createCoordinator` accepts an optional `decepticonAdapter?: DecepticonAdapter` dep. When provided,
it constructs a `DecepticonRunner` via `createDecepticonRunner(adapter, runnerDeps)` and passes it
to `handleAssessmentStart`. A unit test in `coordinator.test.ts` verifies that when `DECEPTICON_ADAPTER=real`
is resolved, `createCoordinator` wires the real adapter runner (not fake). Probe: pass a mock adapter,
assert the runner is invoked.

### A-13-Flow
`tests/integration/decepticon/real-adapter-mock-langgraph.test.ts` (NEW) — uses
`RealDecepticonAdapter` with injected `mockClientFactory` (Sprint 12 DI surface) + full coordinator
wiring + real DB. Verifies:
- ONE `decepticon_sessions` row created, `status='completed'`, `langgraph_thread_id` populated.
- At least ONE `candidate_findings` row with scope-validated `affected_url`.
- `decepticon.findings` job enqueued per candidate.
- `validate.finding` job enqueued for `xss_reflected` candidates.
- Correct audit trail: `decepticon.session.started`, `decepticon.candidate.observed`, `decepticon.session.completed`.

### A-13-Scope
`scope-engine.decide` is called on every candidate's `affectedUrl` BEFORE the candidate is persisted
or enqueued. Existing `startDecepticonSession` already does this for fake-flow — the real-adapter
test exercises the same code path.

### A-13-Audit
Every state-change emits an `audit_event` row. Verified by the real-adapter IT audit assertions.

### A-13-Coverage
≥80% line coverage on `services/coordinator/src/` and `apps/api/src/scope-engine/start-decepticon-session.ts`
code touched in this sprint.

### A-13-LintTC
`bun run lint` and `bun run typecheck` both clean (0 errors/warnings).

### A-13-Tests
0 failing tests (no-DB mode). ≤3 known flakes (full-PG run, same baseline as S12).

### A-13-FixtureReset
`grep -c resetAuthState tests/integration/decepticon/real-adapter-mock-langgraph.test.ts` ≥ 2.
New `decepticon_sessions` + `candidate_findings` rows cleaned in `resetAuthState` chain (already
present since S8; no new tables needed unless migration adds columns).

### A-13-Migration
Migration 020 adds `langgraph_thread_id text` (nullable) to `decepticon_sessions`. Schema type
updated. `resetAuthState` unaffected (table already in chain).

### A-13-IPSkip (B6)
`publishReconBrowserChildJobs` in `start-handler.ts` wraps IP-kind targets as `http://<ip>/`
instead of passing bare IP strings. No more `invalid_recon_browser_payload` terminal nacks for
IP targets. Covered by unit test in `browser-child-job.test.ts` or `start-handler.test.ts`.

### A-13-Backlog-Carry
B8 (xss-replay parameter selection, `packages/validators/src/xss-replay-driver.ts:139-140`):
inspect — if ≤30 lines to fix, do it; else carry to S14 backlog.

### A-13-README
`README.md` or `docs/` updated with "End-to-end demo" section: how to run real engagement against
localhost lab fixture (env vars, `DECEPTICON_ADAPTER=real`, `DECEPTICON_API_URL=http://localhost:2024`).

---

## Implementation Plan

### 1. Migration 020 — add `langgraph_thread_id` to `decepticon_sessions`
- `packages/db/migrations/020_decepticon_sessions_thread_id.ts`
- `packages/db/src/schema.ts` — add `langgraph_thread_id: string | null` to `DecepticonSessionsTable`

### 2. `createDecepticonRunner` helper — `apps/api/src/scope-engine/create-decepticon-runner.ts`
Factory that wraps a `DecepticonAdapter` + `StartDecepticonDeps` into a `DecepticonRunner` function
(the type expected by `handleAssessmentStart`). This avoids changing `services/coordinator` to
import `@cyberstrike/decepticon-adapter`.

### 3. `CoordinatorDeps` — add optional `decepticonAdapter` field
`services/coordinator/src/index.ts` — new `decepticonAdapter?: DecepticonAdapter` dep.
`createCoordinator` builds the runner from adapter when provided (else falls back to existing
`decepticonRunner` dep if supplied, else no decepticon).

### 4. `selectAdapter` wiring in API startup
`apps/api/src/scope-engine/` — confirm the API startup path already calls `selectAdapter` and
passes the result through `startDecepticonSession` / the new runner helper. No new code needed
if the existing path already handles it; otherwise add the glue.

### 5. `real-adapter-mock-langgraph.test.ts`
Full IT with mock `DecepticonClient` (Sprint 12 interface), real coordinator, real DB.
Exercises scope → candidate → validator-worker dispatch path end-to-end.

### 6. B6 — IP-kind target browser publish fix
`services/coordinator/src/start-handler.ts` lines 218-220: wrap IP targets as `http://<ip>/`.

### 7. B8 — inspect and decide

---

## Risks

| ID | Risk | Mitigation |
|----|------|-----------|
| R1 | Migration rollback test (B6 assertion) may need updating for table 020 | Add 020 to B6 rollback assertion list |
| R2 | `decepticon_sessions` FK chain in `resetAuthState` already correct from S8 — no change needed | Verify before IT |
| R3 | `langgraph_thread_id` write in `startDecepticonSession` requires schema type update — JSONB pitfall not relevant (text column) | Straightforward `set` |
| R4 | `coordinator` package importing `@cyberstrike/decepticon-adapter` would create a new dep — avoid by keeping runner as injected function | Use `createDecepticonRunner` in API layer |
| R5 | B8 xss-replay may be > 30 lines — carry to S14 if so | Inspect first |
