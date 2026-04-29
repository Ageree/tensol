# Sprint 8 Contract — Fake Decepticon Adapter

> **Author:** generator-s8
> **Sprint:** 8 — `packages/decepticon-adapter` + coordinator wiring
> **Source spec:** `.harness/cyberstrike-hybrid/product-spec.md` lines 377-410
> **Baseline:** HEAD post Sprint 7 commit (queue + outbox landed, 1010/0 PG, 830/0 no-DB)
> **Mandate:** PRAGMATIC SHIP. Single-iter target. Re-use Sprint 6/7 patterns. Minimum viable.

---

## 1. Goal

Land the deterministic in-process Decepticon stand-in:

1. `packages/decepticon-adapter` (NEW) — `DecepticonAdapter` interface, `FakeDecepticonAdapter` (fixture-backed), `RealDecepticonAdapter` (NotImplemented stub).
2. Coordinator wiring — after the existing scope-validation in `assessment.start` flow, start a session, drain the candidate stream, persist `decepticon_sessions` row + `candidate_findings` rows + OPPLAN artifact in `assessment_artifacts`.
3. New envelope kind `decepticon.findings` — coordinator multiplexes the candidate stream into queue messages so a future Sprint 10 validator can subscribe.
4. Adapter selection via env `DECEPTICON_ADAPTER=fake|real`, default `fake`.
5. Fixture `tests/fixtures/decepticon/xss-reflected.json` — emits ONE `xss_reflected` candidate referencing placeholder URL `http://localhost:9999/xss?q=` (Sprint 9 lab will own this URL).

**Not delivered (carry-forward):** real Decepticon engine (Phase 2), object-storage MinIO (S9), validator gate (S10), real recon worker (S9), report builder (S12). Object storage is stubbed via the existing `packages/object-storage` filesystem-style key contract — adapter generates a deterministic key string + sha256 hash + size, stores body in a sub-directory under a configurable base, no S3 client.

---

## 2. Hard invariants (carry from prior sprints — non-negotiable)

1. **Scope-first.** Decepticon session is started ONLY after Sprint 7's `decide()` per-target loop passes. Scope deny stays terminal — no session, no candidate.
2. **Findings only after validation.** Sprint 8 NEVER inserts into `findings` table. ONLY `candidate_findings`. Validator gate (Sprint 10) will promote candidates → findings.
3. **Tenant isolation.** Two assessments running in parallel in different tenants → separate sessions, no fixture cross-talk. Tested.
4. **Append-only audit.** Decepticon session lifecycle emits one or more audit rows; `assessment_artifacts` insert is append-only.
5. **Auditability.** Every state change (session.started, session.completed, session.failed) emits exactly one audit row.
6. **JSONB pitfall (Sprint 5 F5 / P1):** `candidate_findings.payload` insert MUST `JSON.stringify(payload)` wrap. Same for any other jsonb column.
7. **Test fixture isolation (P27):** every IT file MUST `await resetAuthState(fx.db)` in `beforeEach` AND `resetAuthState` must DELETE `decepticon_sessions`, `candidate_findings`, `assessment_artifacts` (in correct FK order BEFORE assessments).
8. **`DATABASE_URL` runbook:** ITs run via `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`.
9. **No engine purity violation:** `packages/scope-engine/src/*` not touched.

---

## 3. Carry-forwards from prior sprints

| #    | Carry-forward                                                                                                                  | Where it lands |
|------|--------------------------------------------------------------------------------------------------------------------------------|----------------|
| CF-1 | DB schema already has `decepticon_sessions`, `candidate_findings`, `assessment_artifacts` tables (mig 005, 007, 009). NO new migration. | A-FD-DB-1   |
| CF-2 | `audit()` helper from Sprint 4. Sprint 8 adds new actions: `decepticon.session.started`, `decepticon.session.completed`, `decepticon.session.failed`, `decepticon.candidate.observed`. | A-FD-Audit-1 |
| CF-3 | Sprint 7 outbox tx pattern reused — no re-entry. Sprint 8 wires INSIDE the coordinator's `handleAssessmentStart` allow-path branch. | A-FD-Coord-1 |
| CF-4 | New envelope kind `decepticon.findings` added to `ENVELOPE_KINDS` in `packages/queue/src/types.ts`. Defence-in-depth payload schema in `services/coordinator/src/payloads.ts`. | A-FD-Queue-1 |
| CF-5 | RBAC unchanged. Timeline RBAC already covers reading the lifecycle audit rows. | (no change) |
| CF-6 | Test fixture pattern from Sprint 7: `beforeEach(resetAuthState)` mandatory in ALL queue/decepticon ITs. | §9 |
| CF-7 | Object-storage stub uses local FS — base dir test seam, deterministic key `tenant/<tenantId>/assessment/<assessmentId>/opplan-<sha256>.json`, sha256 computed via Bun's `Bun.CryptoHasher` or node's `crypto.createHash('sha256')`. | A-FD-Opplan-1 |

---

## 4. Files / dirs touched (allowlist)

Generator may add or modify files under:

- `packages/decepticon-adapter/` (NEW workspace package):
  - `src/types.ts` — `DecepticonAdapter` interface, `OpplanInput`, `SessionHandle`, `StatusEvent`, `CandidateFinding`, `Artifact`, `NotImplementedError` (typed sentinel).
  - `src/fake.ts` — `FakeDecepticonAdapter` class. Reads fixtures from a configurable `fixturesDir` (default `tests/fixtures/decepticon/`). Per-session in-memory state map. Status & candidate streams as `AsyncIterable`.
  - `src/real.ts` — `RealDecepticonAdapter` class. Every method throws `NotImplementedError`.
  - `src/fixture-loader.ts` — load + validate `<scenario>.json` via zod.
  - `src/select.ts` — `selectAdapter(env, opts)` reads `DECEPTICON_ADAPTER` env, defaults `fake`.
  - `src/index.ts` — public re-exports.
  - `src/*.test.ts` — co-located unit tests.
  - `package.json` — workspace deps: `zod`.
- `tests/fixtures/decepticon/`:
  - `xss-reflected.json` — fixture: status events + ONE `xss_reflected` candidate.
- `apps/api/src/scope-engine/` (Sprint 6 helper dir) — extend with `start-decepticon-session.ts` (new) that the coordinator calls after scope-validation passes. Pure function, takes `{db, adapter, tenantId, projectId, assessmentId, scope, traceId, objectStorage}` → resolves to `{sessionId, opplanArtifactId, candidateIds[]}`. Allows IT to call directly without a queue.
- `services/coordinator/src/start-handler.ts` (MODIFY) — after the per-target decide loop allows, BEFORE publishing recon child jobs, start the Decepticon session and await its completion (fake = ms-fast). Drain candidate + status streams, persist rows, emit audit.
- `services/coordinator/src/index.ts` (MODIFY) — extend `CoordinatorDeps` with optional `decepticonAdapter`, optional `objectStorage` (filesystem stub).
- `packages/queue/src/types.ts` (MODIFY) — add `'decepticon.findings'` to `ENVELOPE_KINDS`.
- `services/coordinator/src/payloads.ts` (MODIFY) — add `decepticonFindingsPayloadSchema`.
- `apps/api/src/server.ts` or wherever coordinator is wired (MODIFY) — pass `selectAdapter(process.env)` into `createCoordinator`.
- `packages/object-storage/src/index.ts` (MODIFY) — add minimal `LocalObjectStorage` class: `put({key, body, contentType}) → {sha256, sizeBytes, key}`, `get(key) → Buffer`. Filesystem-backed, base dir injected.
- `packages/contracts/src/audit.ts` (MODIFY) — add 4 new actions; `audit.test.ts` cardinality bumped 29 → 33.
- `packages/contracts/src/index.ts` (MODIFY) — re-export decepticon contracts.
- `packages/contracts/src/decepticon.ts` (NEW) — `candidateFindingSchema`, `statusEventSchema` (zod, public types).
- `tests/integration/auth/helpers/auth-fixture.ts` (MODIFY) — add `DELETE FROM candidate_findings`, `DELETE FROM decepticon_sessions`, `DELETE FROM assessment_artifacts` to `resetAuthState` BEFORE `DELETE FROM assessments` (FK order).
- `tests/integration/decepticon/` (NEW dir):
  - `fake-flow.test.ts` — start an approved assessment with `DECEPTICON_ADAPTER=fake`, assert ONE `decepticon_sessions` row + ONE OPPLAN artifact (with sha256 hex) + ONE `candidate_findings` row + timeline shows lifecycle audit events.
  - `session-isolation.test.ts` — two parallel assessments in different tenants → 2 sessions, fixtures don't cross-talk.
  - `opplan-artifact.test.ts` — OPPLAN artifact has correct sha256 + size + object_storage_key + JSON content matches expected shape.
  - `not-implemented.test.ts` — `RealDecepticonAdapter.start({})` rejects with `NotImplementedError`.
  - `helpers.ts` — shared helpers, including `setDecepticonEnv('fake'|'real', cb)` and `withFixturesDir(dir, cb)`.

**Excluded** (NOT touched):
- `packages/scope-engine/src/*` — purity preserved.
- Sprint 1-5 migrations.
- `packages/audit/src/*` — only contracts updated.
- `services/browser-worker/`, `services/validator-worker/` — Sprint 9+.
- `findings` table — Sprint 10+.

---

## 5. Acceptance criteria (A-FD-* IDs)

| ID | Criterion |
|----|-----------|
| **A-FD-Run** | Starting an approved assessment with `DECEPTICON_ADAPTER=fake` produces: exactly ONE `decepticon_sessions` row (status=`completed`), exactly ONE `assessment_artifacts` row of `kind='opplan'` with valid sha256, and exactly ONE `candidate_findings` row of `type='xss_reflected'`. All with the correct `tenant_id` + `assessment_id`. |
| **A-FD-NoConfirm** | After A-FD-Run completes, the `findings` table has zero rows for that assessment. |
| **A-FD-Timeline** | `GET /assessments/:id/timeline` returns rows including `decepticon.session.started` and `decepticon.session.completed` audit actions. |
| **A-FD-NotImpl** | `import { RealDecepticonAdapter } from '@cyberstrike/decepticon-adapter'; new RealDecepticonAdapter().start({...})` rejects with `NotImplementedError` (typed: `instanceof NotImplementedError === true`, `error.name === 'NotImplementedError'`). |
| **A-FD-Coverage** | ≥80% line coverage on `packages/decepticon-adapter/src/**` and on the coordinator wiring delta in `start-handler.ts` + new `start-decepticon-session.ts`. |
| **A-FD-LintTC** | `bun run lint` clean (0 errors). `bun run typecheck` clean. |
| **A-FD-Tests** | `bun test` (no DB) 0 fail. `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` 0 engine fail (3 known pre-existing flakes acceptable: A-Proj-1 pagination, C29 audit-emission, B14 append-only). |
| **A-FD-Tenant-Iso** | Two assessments in different tenants run in parallel → 2 sessions, no fixture cross-talk, candidate counts isolated. |
| **A-FD-Crash** | Adapter session crash mid-stream → coordinator marks assessment `failed` + emits `decepticon.session.failed` audit + `assessment.failed` audit. Tested via injected fixture with `simulateCrashAt: 'recon'`. |
| **A-FD-Adapter-Select** | `DECEPTICON_ADAPTER=real` env causes `selectAdapter()` to return `RealDecepticonAdapter`; default and `fake` return `FakeDecepticonAdapter`. Tested. |
| **A-FD-Audit-Card** | `AUDIT_ACTIONS` length transitions 29 → 33 (+4 new). `audit.test.ts` cardinality assertion updated. |
| **A-FD-Pitfall-JSONB** | `candidate_findings.payload` and `assessment_artifacts.metadata` writes use `JSON.stringify(...)` wrap. Verified via grep + integration assertion that round-trips a non-empty object. |
| **A-FD-Pitfall-P27** | `resetAuthState` includes `DELETE FROM candidate_findings; DELETE FROM decepticon_sessions; DELETE FROM assessment_artifacts;` BEFORE `DELETE FROM assessments`. Every new IT calls `await resetAuthState(fx.db)` in `beforeEach`. |
| **A-FD-Reg-1** | No regression: full PG suite ≥1010 pass / 0 engine fail (vs Sprint 7 floor). |
| **A-FD-Reg-2** | Scope engine purity preserved (NO edits to `packages/scope-engine/src/`). |

---

## 6. Risks (R1..R5)

| R# | Risk | Mitigation |
|----|------|------------|
| R1 | Object-storage stub becomes a tar pit (S3 client, MinIO docker). | Filesystem-backed `LocalObjectStorage` ONLY. Single class, ~50 lines. Sha256 via `crypto.createHash`. No S3 SDK. |
| R2 | Audit cardinality test surface drift across 4 new actions. | Add all 4 actions in the same commit; update `audit.test.ts` array assertion verbatim; assert delta=+4 explicitly. |
| R3 | Coordinator `start-handler.ts` blowout (currently 249 lines) → over-800-line file. | Extract decepticon orchestration into new `start-decepticon-session.ts` module under `apps/api/src/scope-engine/` (mirrors Sprint 6 location). `start-handler.ts` only adds 1-2 calls. |
| R4 | Session crash audit ordering. | Crash path emits in order: `decepticon.session.failed` → `assessment.failed`. Update `assessments.state='failed'` BEFORE second audit. Mirrors Sprint 7 deny-path pattern in `markFailedAndNack`. |
| R5 | P27 leak on parallel ITs. | All new IT files call `resetAuthState(fx.db)` in `beforeEach`. Grep gate: `grep -c resetAuthState tests/integration/decepticon/*.test.ts` ≥2 per file. |

---

## 7. Verification commands

```bash
# Lint + typecheck
bun run lint
bun run typecheck

# Tests (no DB)
bun test

# Tests (full PG)
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test

# Coverage on Sprint 8 surface
bun test --coverage tests/integration/decepticon packages/decepticon-adapter

# JSONB grep gate
grep -nE 'JSON\.stringify\(' apps/api/src/scope-engine/start-decepticon-session.ts services/coordinator/src/start-handler.ts

# P27 grep gate
grep -c resetAuthState tests/integration/decepticon/*.test.ts

# Path-footgun grep
grep -rE '\.\./|\\\.\\\.' packages/decepticon-adapter/src/ services/coordinator/src/ apps/api/src/scope-engine/start-decepticon-session.ts tests/integration/decepticon/

# Scope-engine purity
git diff --stat packages/scope-engine/src/ # must be empty
```

---

## 8. Trajectory plan

- **iter-1 (impl):** All deliverables landed in one pass. Single fixture (`xss-reflected.json`), single happy-path + crash + isolation IT each, unit tests for adapter interface.
- **iter-2 (only if FAIL):** Surgical fix of evaluator-flagged gaps. ≤2 fix iters total.

---

## 9. Contract v2 inline notes (evaluator R1-R5 folded 2026-04-29)

> Pattern mirrors Sprint 7 v2 inline-notes appendix. Original §1-§8 content stays
> authoritative; this appendix tightens the binary-checkability of A-FD-* IDs.

### R1 (A-FD-OpplanShape made explicit)

A-FD-Run row 3 (the OPPLAN artifact) now requires `opplan-artifact.test.ts` to
assert the parsed OPPLAN JSON has all **12 named fields** with the spec-mandated
literals:

```
assessmentId         (string uuid, equals seeded assessmentId)
targets              (string[])
authorizedScope      (string[])
exclusions           (string[])
testingWindow        ({start: string|null, end: string|null})
allowedTools         (string[])
unavailableTools     (string[])
engagementProfile    (string)
foothold === false   (literal boolean — defence-in-depth)
postExploit === false
c2 === false
ad === false
```

Implementation: 12 distinct `expect(...)` assertions on the parsed JSON in
`opplan-artifact.test.ts`. Without this, "valid sha256" alone would pass for
any payload shape.

### R2 (Crash audit ordering — A-FD-Crash teeth)

`crash-flow.test.ts` MUST query
`audit_events ORDER BY occurred_at ASC, id ASC` (deterministic tiebreak —
`occurred_at` may collide at sub-ms within the same tx) filtered to
`tenant_id` + `assessment_id`, and assert the row index of
`decepticon.session.failed` is **strictly less than** the row index of
`assessment.failed`. This binds R4 mitigation (crash-path emits in the order:
`session.failed` → `assessment.failed`) to a verifiable test.

### R3 (Single full-PG run discipline)

§7 verification commands extended:

```
# Run `bun test` PG ONCE in iter-1. If it returns non-deterministic counts
# across re-runs, FIRST verify P27 hygiene before escalating:
grep -c resetAuthState tests/integration/decepticon/*.test.ts   # ≥2 per file
```

No looping retries. If first PG run is green and `grep -c` ≥ 2 per file, ship.
This is a contract-level discipline carry-over from Sprint 7's monotonic-drain
false alarm (P27).

### R4 (A-FD-Tenant-Iso — distinct fixtures)

`session-isolation.test.ts` MUST run T1 against the `xss-reflected` fixture
(emits one `xss_reflected` candidate) and T2 against a NEW
`sqli-demo.json` fixture (emits one `sqli` candidate, type from
`CANDIDATE_TYPES` closed set). Assertions:

1. T1's `candidate_findings` rows for `tenant_id=T1` ALL have `type='xss_reflected'`.
2. T2's `candidate_findings` rows for `tenant_id=T2` ALL have `type='sqli'`.
3. Cross-tenant SELECT
   `WHERE tenant_id=T1 AND assessment_id=T2_assessmentId` returns 0 rows
   (already in the contract; restated for completeness).
4. The two scenarios are wired via the `scenarioForAssessment` test seam on
   `FakeAdapterDeps` (already exposed in `packages/decepticon-adapter/src/fake.ts`).

Without distinct scenarios, "no cross-talk" can pass with shared fixtures.

### R5 (Adapter selection production wiring scope)

§4 file allowlist clarified: `selectAdapter(process.env)` is invoked **once at
boot** by whichever module wires `createCoordinator` in production
(`apps/api/src/factory.ts` or `apps/api/src/server.ts`). It is NOT called
per-request. Unit test `select.test.ts` covers env permutations against an
injected `env` argument.

**Sprint 8 deliverable scope clarification**: the production wiring point
(coordinator runtime) is not yet active in Sprint 7 — `services/coordinator`
ships only the importable factory (Sprint 7 OQ-2 still deferred). Therefore:
- The IT exercises orchestration via direct `startDecepticonSession(...)`
  function calls (mirrors Sprint 7 IT pattern for `handleAssessmentStart`).
- `selectAdapter()` is fully unit-tested end-to-end against env permutations
  (fake, real, default, unknown).
- The "wired at boot" assertion is recorded as a follow-up for when
  `services/coordinator/src/main.ts` ships, NOT a Sprint 8 blocker.

---

End of contract (v2 with R1-R5 inline notes).
