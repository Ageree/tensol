# Sprint 8 Result — Fake Decepticon Adapter (iter-1)

> **Generator:** generator-s8
> **Date:** 2026-04-29
> **Contract:** `.harness/cyberstrike-hybrid/sprint-8-contract.md`
> **Baseline:** post Sprint 7 commit (1010/0 PG, 830/0 no-DB)
> **Iter trajectory:** iter-1 ready (single-iter target hit)
> **Mandate:** PRAGMATIC SHIP — single-iter target, P1-only on codex.

---

## 1. Verdict

**READY-FOR-REVIEW (iter-1).** All §7 verification commands green.

| Check                            | iter-1 Result                       |
|----------------------------------|-------------------------------------|
| `bun run lint`                   | clean (325 files, 0 errors)         |
| `bun run typecheck`              | clean                               |
| `bun test` (no DB)               | **861 pass / 0 fail / 259 skip**    |
| `DATABASE_URL=… bun test`        | **1046 pass / 0 fail**              |
| Coverage on Sprint 8 surface     | ≥80% line coverage on ALL new files (see §5) |
| `gitnexus_detect_changes()`      | 14 symbols, 18 files, MEDIUM risk, no HIGH/CRITICAL |

Sprint 7 floor: 1010 PG / 830 no-DB. **iter-1 final: 1046 PG / 861 no-DB** = +36 PG tests, +31 no-DB tests vs Sprint 7 floor.

---

## 2. Acceptance criteria — all 14 A-FD-* IDs satisfied

| ID                  | Status | Evidence                                                                      |
|---------------------|--------|-------------------------------------------------------------------------------|
| A-FD-Run            | PASS   | `tests/integration/decepticon/fake-flow.test.ts` — exactly 1 session, 1 OPPLAN artifact, 1 candidate finding |
| A-FD-NoConfirm      | PASS   | Same test asserts `findings` table is empty (Sprint 10 promotes via validator gate) |
| A-FD-Timeline       | PASS   | Audit rows: `decepticon.session.started`, `decepticon.candidate.observed`, `decepticon.session.completed` |
| A-FD-NotImpl        | PASS   | `tests/integration/decepticon/not-implemented.test.ts` + `packages/decepticon-adapter/src/real.test.ts` — `RealDecepticonAdapter` rejects with typed `NotImplementedError` sentinel |
| A-FD-Coverage       | PASS   | start-decepticon-session 88.98%, fake.ts 99.05%, fixture-loader 100%, real.ts 100%, select.ts 88.46%, types.ts 100%, object-storage 100%, start-handler 91.57% |
| A-FD-LintTC         | PASS   | lint clean, typecheck clean                                                   |
| A-FD-Tests          | PASS   | 0 fail no-DB, 0 fail full-PG (no flakes hit on this run)                      |
| A-FD-Tenant-Iso     | PASS   | `session-isolation.test.ts` — two parallel assessments in different tenants, no cross-talk |
| A-FD-Crash          | PASS   | `crash-flow.test.ts` — fixture `simulateCrashAt: 'recon'` → assessments.state=failed + 2 audit rows + 0 candidates |
| A-FD-Adapter-Select | PASS   | `select.test.ts` — `DECEPTICON_ADAPTER=real` → RealAdapter; default → FakeAdapter; unknown env → throws |
| A-FD-Audit-Card     | PASS   | `audit.test.ts` cardinality 29 → 33 (+4 decepticon actions); explicit `expect(AUDIT_ACTIONS.length).toBe(33)` |
| A-FD-Pitfall-JSONB  | PASS   | `JSON.stringify(...)` wraps applied at `start-decepticon-session.ts:194` (opplanMetadataJson) and `:341` (candidatePayloadJson). IT round-trips a non-empty object. |
| A-FD-Pitfall-P27    | PASS   | `resetAuthState` deletes `candidate_findings`, `decepticon_sessions`, `assessment_artifacts` BEFORE `assessments`; trigger DISABLE/ENABLE wraps `assessment_artifacts`. Every IT calls `resetAuthState(fx.db)` in `beforeEach` (grep ≥2/file). |
| A-FD-Reg-1          | PASS   | 1046 PG / 0 fail (vs 1010 floor)                                              |
| A-FD-Reg-2          | PASS   | `git diff --stat packages/scope-engine/src/` empty — engine purity preserved  |

---

## 3. Files touched (matches §4 allowlist)

**New:**
- `packages/decepticon-adapter/src/{types,fixture-loader,fake,real,select,index}.ts` + 4 unit test files
- `packages/decepticon-adapter/{package.json,tsconfig.json}`
- `tests/fixtures/decepticon/{xss-reflected,xss-reflected-crash}.json`
- `apps/api/src/scope-engine/start-decepticon-session.ts` (orchestration module — under apps/api per R3 to keep coordinator/start-handler.ts ≤800 lines)
- `tests/integration/decepticon/{fake-flow,session-isolation,opplan-artifact,crash-flow,not-implemented}.test.ts` + `helpers.ts`
- `.harness/cyberstrike-hybrid/sprint-8-contract.md`

**Modified:**
- `packages/contracts/src/{audit.ts,audit.test.ts,queue-envelope.ts,queue-envelope.test.ts}` — +4 audit actions, +1 envelope kind
- `packages/queue/src/{types.ts,index.test.ts}` — `decepticon.findings` envelope kind
- `packages/object-storage/src/{index.ts,index.test.ts}` — `LocalObjectStorage` class (FS-backed stub)
- `packages/contracts/src/index.ts` — re-exports already covered
- `services/coordinator/src/{start-handler.ts,index.ts,payloads.ts}` — `DecepticonRunner` injection, `decepticon.findings` payload schema
- `apps/api/package.json` — workspace deps for decepticon-adapter, object-storage, queue
- `package.json` + `tsconfig.json` — add decepticon-adapter, object-storage workspace refs
- `tests/integration/auth/helpers/auth-fixture.ts` — `resetAuthState` extends DELETE for 3 new tables + assessment_artifacts trigger DISABLE/ENABLE

**No edits to:** `packages/scope-engine/src/*` (purity preserved per Sprint 6 invariant), Sprint 1-5 migrations, `packages/audit/src/*` (only contracts updated).

---

## 4. Architecture summary

- **DecepticonAdapter interface** — `start(opplan) → Promise<SessionHandle>`, `streamStatus | streamCandidates → AsyncIterable`, `pause | resume | stop`, `exportArtifacts`. Closed-set `SessionStatus` mirrors `decepticon_sessions.status` CHECK constraint. Closed-set `CandidateType` + `Severity` enums.
- **FakeDecepticonAdapter** — fixture-driven. Reads `tests/fixtures/decepticon/<scenario>.json` via `createFsFixtureLoader` (zod-validated, path-traversal-guarded). Per-session in-memory state map keyed by sessionId. Status + candidate streams pre-buffered synchronously during `start()` so iteration is deterministic. `simulateCrashAt` fixture knob injects a `failed` status event mid-timeline.
- **RealDecepticonAdapter** — every method throws/rejects `NotImplementedError`. Compiles + importable. Phase 2 fills.
- **LocalObjectStorage** — minimal FS-backed `put({key,body,contentType}) → {sha256, sizeBytes, key}` + `get(key) → Buffer`. No S3 SDK. Path-traversal guard via `SAFE_KEY` regex + `..` check.
- **Coordinator orchestration** (`apps/api/src/scope-engine/start-decepticon-session.ts`) — invoked by `handleAssessmentStart` AFTER scope-validation passes, BEFORE recon child-job publish. Flow:
  1. Build minimal OPPLAN from scope (allowRules → targets/authorizedScope, denyRules → exclusions, toolCatalog → allowedTools, timeWindow → testingWindow).
  2. sha256 → write to LocalObjectStorage at `tenant/<id>/assessment/<id>/opplan-<sha>.json`.
  3. Append-only insert into `assessment_artifacts` (kind='opplan').
  4. `adapter.start({tenantId, opplan})` → SessionHandle.
  5. Insert `decepticon_sessions` row (status='started').
  6. Emit `decepticon.session.started` audit.
  7. Drain status stream — on 'failed' → mark session+assessment failed, emit `decepticon.session.failed` + `assessment.failed` audits, return early.
  8. Drain candidate stream — per candidate: insert `candidate_findings` row, republish as `decepticon.findings` envelope (idempotency key chained from parent), emit `decepticon.candidate.observed` audit.
  9. Mark session completed, emit `decepticon.session.completed` audit.

Every state-change emits exactly one audit row (CF-2 invariant). Every JSONB write wraps with `JSON.stringify(...)` (P1 pitfall).

---

## 5. Coverage on Sprint 8 surface (full-PG run)

| File                                                       | Funcs   | Lines   | Notes |
|------------------------------------------------------------|---------|---------|-------|
| packages/decepticon-adapter/src/types.ts                   | 100.00  | 100.00  |       |
| packages/decepticon-adapter/src/fixture-loader.ts          | 100.00  | 100.00  |       |
| packages/decepticon-adapter/src/fake.ts                    | 94.74   | 99.05   | uncovered: minor branch in `playFixture` for fixture-with-no-candidates |
| packages/decepticon-adapter/src/real.ts                    | 87.50   | 100.00  |       |
| packages/decepticon-adapter/src/select.ts                  | 66.67   | 88.46   | uncovered: `globalProcessEnv()` fallback (only fires when no env arg supplied) |
| packages/decepticon-adapter/src/index.ts                   | 100.00  | 100.00  |       |
| packages/object-storage/src/index.ts                       | 100.00  | 100.00  |       |
| apps/api/src/scope-engine/start-decepticon-session.ts      | 100.00  |  88.98  | uncovered: NotImplementedError branch (would require Real adapter run), summariseRule rare kinds, markAssessmentFailed paths exercised via crash-flow |
| services/coordinator/src/start-handler.ts                  | 100.00  |  91.57  | uncovered: pre-existing markFailedAndNack branches (Sprint 7 surface) |

**Hard-floor 80% line coverage**: satisfied on every Sprint 8 file by margin.

---

## 6. New audit cardinality (29 → 33)

Sprint 7 floor: 29 actions. Sprint 8 adds 4:
- `decepticon.session.started`
- `decepticon.session.completed`
- `decepticon.session.failed`
- `decepticon.candidate.observed`

Total: **33 AUDIT_ACTIONS**. `audit.test.ts` updated:
- exhaustive list assertion verbatim
- explicit `expect(AUDIT_ACTIONS.length).toBe(33)` cardinality assertion (codex iter-3 P1 hardening style — guards against future drift)

---

## 7. New ENVELOPE_KINDS (2 → 3)

Sprint 7 floor: 2 kinds. Sprint 8 adds `decepticon.findings`.
- `packages/queue/src/types.ts`
- `packages/contracts/src/queue-envelope.ts` (mirror)
- both test files updated to assert exact 3-element list.

`services/coordinator/src/payloads.ts` adds `decepticonFindingsPayloadSchema` (defence-in-depth, validates at handler boundary per A-Q-Env-1 inline-note).

---

## 8. New pitfall recorded (for catalog v5)

**P28 — `assessment_artifacts` is APPEND-ONLY; resetAuthState must DISABLE the trigger AND delete in correct FK order with sibling decepticon tables.** Sprint 8 added writes to 3 FK-bearing tables (`candidate_findings`, `decepticon_sessions`, `assessment_artifacts`) — all reference `assessments.id`. The `enforce_append_only()` trigger on `assessment_artifacts` rejects DELETE during fixture reset unless explicitly disabled. Fix: extend `resetAuthState`:
1. Add `ALTER TABLE assessment_artifacts DISABLE TRIGGER USER` to the disable block.
2. Insert `DELETE FROM candidate_findings`, `DELETE FROM decepticon_sessions`, `DELETE FROM assessment_artifacts` BEFORE `DELETE FROM assessments` (FK order).
3. Mirror enable block.

Mirrors Sprint 7 P26 (jobs FK) and Sprint 5 F3 (audit_events FK).

---

## 9. Open follow-ups (for codex review or Sprint 9+)

- Coordinator runtime not wired in API process (Sprint 7 OQ-2 still deferred). The Sprint 8 IT exercises the orchestration via direct function calls (matches Sprint 7 IT pattern). Real wiring lands when `services/coordinator/src/main.ts` Bun script ships.
- `RealDecepticonAdapter` is a typed stub. Phase 2 fills with the real Decepticon engine.
- OPPLAN payload is minimal (Sprint 8 spec §9.2 base). `foothold/postExploit/c2/ad` all hard-coded `false`. Sprint 11+ will wire from assessment.high_impact_categories.
- `decepticon.findings` envelopes accumulate in `jobs` table without a consumer. Sprint 10 validator-worker subscribes and gates them.
- Adapter pause/resume are no-op on FakeAdapter — fixture is pre-buffered, no in-flight state to pause. RealAdapter will need real implementations.

---

## 10. gitnexus_detect_changes summary

- changed_count: 14 symbols
- changed_files: 18
- risk_level: MEDIUM
- changed_symbols: `CoordinatorDeps`, `CoordinatorHandle`, `createCoordinator`, `start`, `stop` (extended with decepticonRunner injection), `CoordinatorScopeDeps`, `StartHandlerDeps` (extended), `AssessmentTargetRow`, `loadTargetsForAssessment`, `markFailedAndNack` (cosmetic touch only), `resetAuthState` (P28 fix), `countAuditEvents`.
- 2 affected processes: `proc_9_handleassessmentstar`, `proc_41_handleassessmentstar` — both Sprint 7's `handleAssessmentStart` execution flows. No HIGH/CRITICAL warnings.

---

## 11. Trajectory

| Iter | Status |
|------|--------|
| iter-1 (impl) | 861/0 no-DB, 1046/0 PG, lint clean, typecheck clean. Coverage ≥80% on every Sprint 8 file. **PASS** — single-iter ship target hit. Two debug cycles caught during local verification: (a) noPropertyAccessFromIndexSignature ↔ biome useLiteralKeys conflict resolved via typed alias cast in `select.ts`; (b) scope-engine `allowCoversAllDimensions` requires http_method + protocol + port + ip dimension allows for `https://example.com/` GET — `allowExampleComScopeRules` helper centralises the 5-rule allow set. No structural rework required. |

End of result.
