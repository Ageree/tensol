# Sprint 10 Contract — XSS Validator + OOB-less Browser Replay

> **Author:** generator-s10
> **Sprint:** 10 — `packages/validators` + `services/validator-worker` + findings/finding_evidence repos + coordinator wiring
> **Source spec:** `.harness/cyberstrike-hybrid/product-spec.md` lines 448-482
> **Baseline:** HEAD post Sprint 9 ship (1099/0 PG, 909/0/274-skip no-DB; 38 audit actions; 4 envelope kinds; migrations 0→016)
> **Mandate:** PRAGMATIC SHIP. Single-iter target. Re-use Sprint 6/7/8/9 patterns (FakeDriver/RealDriver split, payloadSchema injection, in-process handler with injected emitAudit/repos, P27 resetAuthState, JSONB stringify wrap).
> **Acceptance IDs:** 20 total — A-V-Confirm, A-V-Reject, A-V-Inconclusive, A-V-Scope, A-V-Idempotent, A-V-AlertOnly, A-V-Hang, A-V-Evidence, A-V-NonceUnique, A-V-DirectInsertForbidden, A-V-Coverage, A-V-LintTC, A-V-Tests, A-V-FixtureReset, A-V-Audit-Card, A-V-Envelope, A-V-Driver-Select, A-V-NotImpl, A-V-Reg-1, A-V-Reg-Engine.
> **Revision:** v2 (2026-04-29) — adds A-V-Hang (timeout→inconclusive) per evaluator round-1 E1. Spec line 482 binding edge case.

---

## 1. Goal

Land the XSS validator vertical slice:

1. `packages/validators` (NEW guts; replaces Sprint 7 placeholder) — shared `Validator.validate(input) → ValidationResult` contract; `validateXssReflected` implementation; `generateNonce` deterministic factory; `evidenceCollector` helper that hashes screenshot/trace bytes and stages them for object storage.
2. `services/validator-worker` (NEW guts; replaces placeholder) — subscribes to `validate.finding` envelope kind, loads candidate row + scope, dispatches to `validators.byType[candidate.type]`, on `confirmed` writes evidence + findings rows, on `rejected`/`inconclusive`/`out_of_scope` skips the findings write, emits lifecycle audits.
3. **Hard rule (DirectInsertForbidden):** `findings` rows are ONLY produced via `insertConfirmedFinding({db, validatedBy: ValidationResult, ...})` in `packages/db/src/repos/findings.ts`. The repo function REQUIRES `validatedBy` and asserts `validatedBy.status === 'confirmed'`. No bare `insertInto('findings')` exists outside this single function. `grep` proof in acceptance.
4. Browser-replay seam: `XssReplayDriver` interface + `FakeXssReplayDriver` (deterministic, fetch + scripted nonce-echo detection — re-uses Sprint 9 pattern) + `RealXssReplayDriver` (Playwright-stub, throws `NotImplementedError`). Re-uses `selectXssReplayDriver(env)` env switch (`XSS_REPLAY_DRIVER=fake|real`, default fake).
5. Coordinator publishes `validate.finding` envelopes after a `decepticon.candidate.observed` audit lands (Sprint 8 flow): one envelope per candidate, idempotency-keyed on candidate id.
6. Idempotency: `findings` row carries `created_from_candidate_id UNIQUE` (already in migration 010). Two parallel `validate.finding` runs for the same candidate produce exactly one row; the loser receives an `OptimisticLockError`/duplicate-key error which the worker swallows (already-validated) and ack's.

**Not delivered (carry-forward):** Real Playwright XSS replay (RealXssReplayDriver stub only — Phase 2). MinIO/S3 (LocalObjectStorage reused). Validators for non-XSS candidate types (`xss_stored`, `sqli`, `csrf`, etc. — Sprint 11+). Findings UI (Sprint 11). OOB confirmation (`needs_human_review` path documented but no tests). Real browser dialog/console/network listeners (FakeDriver simulates them deterministically). Evidence inspection API endpoint (placeholder kept; Sprint 11+).

---

## 2. Hard invariants (carry-forward — non-negotiable)

1. **Scope-first.** Validator builds the EffectiveScope and runs `decide(scope, http_request{url=candidate.affectedUrl})` BEFORE any browser launch. Deny → status `out_of_scope`. No replay attempt is issued. No findings row.
2. **Findings only after validation (THIS SPRINT enforces it).** `findings` insert path requires `validatedBy: ValidationResult` with `status === 'confirmed'`. Direct `insertInto('findings')` outside the repo is FORBIDDEN. Grep gate runs in CI.
3. **Browser-first for web** (Sprint 9 carry). XSS replay runs through `XssReplayDriver` — never raw fetch from worker output path.
4. **Tenant isolation.** Each replay launches a fresh driver session. Two parallel validations across tenants share no state.
5. **Auditability.** Every state change emits exactly one audit row: `validation.started`, `validation.confirmed`, `validation.rejected`, `validation.inconclusive`, `validation.out_of_scope`, `finding.created`. Total +6 audit actions vs Sprint 9 floor of 38 → 44.
6. **JSONB pitfall (P1).** All array writes — `findings.reproduction`, `findings.validator_log`, `finding_evidence.metadata` — go through `JSON.stringify(arr/obj)` in their repo functions.
7. **Test fixture isolation (P27).** Every IT under `tests/integration/validator/` MUST `await resetAuthState(fx.db)` in `beforeEach`. `resetAuthState` MUST DELETE `finding_evidence` BEFORE `findings` (FK), and `findings` BEFORE `candidate_findings` (FK), and BOTH BEFORE `assessments` (FK). No new triggers added. `grep -c resetAuthState` ≥2 per IT file.
8. **`DATABASE_URL` runbook.** ITs run via `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`. Single PG run only (R3 from Sprint 7 — no parallel measurement-divergence).
9. **Engine purity.** `packages/scope-engine/src/*` not touched.
10. **Decepticon-adapter surface frozen.** `packages/decepticon-adapter/src/*` not touched.
11. **Browser-worker surface frozen.** `services/browser-worker/src/*` not touched (Sprint 9 surface stays clean).

---

## 3. Carry-forwards from prior sprints

| #     | Carry-forward                                                                                              | Where it lands         |
|-------|------------------------------------------------------------------------------------------------------------|------------------------|
| CF-1  | DB tables `findings` + `finding_evidence` already exist (mig 010). NO new migration.                       | A-V-DirectInsertForbidden |
| CF-2  | DB table `candidate_findings` exists (mig 009). Read-only here; written by Sprint 8 decepticon flow.       | A-V-Confirm |
| CF-3  | `audit()` helper from Sprint 4. Sprint 10 adds 6 new actions (see §6).                                     | A-V-Audit-Card |
| CF-4  | `LocalObjectStorage` reused for evidence; key shape `tenant/<tenantId>/finding/<findingId>/<kind>-<sha>.<ext>`. | A-V-Evidence |
| CF-5  | New envelope kind `validate.finding` added to `ENVELOPE_KINDS` (4 → 5).                                    | A-V-Envelope |
| CF-6  | RBAC unchanged. Sprint 11 adds findings UI permissions.                                                    | (no change) |
| CF-7  | FakeDriver / RealDriver pattern from Sprint 8/9 mirrored exactly. `XSS_REPLAY_DRIVER=fake|real` env.        | A-V-Driver-Select |
| CF-8  | Sprint 8 candidate stream (`decepticon.candidate.observed` + `candidate_findings` row insert) is the upstream input. | §4 — coordinator delta |

---

## 4. Files / dirs touched (allowlist)

### NEW
- `packages/validators/src/`:
  - `contract.ts` — `Validator` interface, `ValidationStatus` closed-set (`confirmed|rejected|inconclusive|needs_human_review|out_of_scope`), `ValidationResult` zod schema, `ValidationInput` zod schema, exported types.
  - `nonce.ts` — `generateNonce({randomUUID?})`, `nonceMatchesEcho(nonce, body)`, `taggedConsoleMessage(nonce, level, text)` helpers. Pure.
  - `xss-replay-driver.ts` — `XssReplayDriver` interface, `XssReplayResult` shape (DOM hit, alert hit, console hit, network-from-script hit). `BrowserReplayTimeoutError` typed sentinel (`extends Error`, `override readonly name = 'BrowserReplayTimeoutError'`). `FakeXssReplayDriver` impl (fetch-backed, deterministic; supports `simulateTimeout?: boolean` opt that throws `BrowserReplayTimeoutError`). `RealXssReplayDriver` impl (NotImplementedError stub). `selectXssReplayDriver(env, opts)` factory.
  - `xss.ts` — `validateXssReflected({input, scope, scopeDeps, driver, randomUUID, clockIso}) → ValidationResult`. Generates nonce → builds payload `<script>console.log("[NONCE]"+window.name)</script>` (or contract-specified shape) → invokes driver TWICE (reproducibility), confirms only when both runs return non-trivial DOM/console echo of nonce. Falls back to `inconclusive` on alert-only. Pure-decision; capture happens in driver.
  - `evidence-collector.ts` — `collectEvidence(driverResults, deps) → ReadonlyArray<{kind, body, contentType}>`. Builds the 2 evidence blobs (screenshot + trace) per replay run.
  - `index.ts` — public re-exports.
  - `*.test.ts` — co-located unit tests (contract zod, nonce uniqueness/echo, xss-replay-driver fake + real + select, xss decision logic full grid, evidence-collector hash determinism).
  - `package.json` — workspace deps: `@cyberstrike/contracts`, `@cyberstrike/scope-engine`, `zod`.
- `services/validator-worker/src/`:
  - `worker.ts` — `handleValidateFinding(deps, envelope) → HandlerOutcome`. Loads candidate, builds scope, runs validator, on `confirmed` writes evidence + findings rows via injected repo. On any non-confirmed status: NO findings row, audit emitted, ack. On unique-violation race (idempotency): swallow, ack.
  - `select.ts` — `selectXssReplayDriver(env, opts)` re-export from validators or local mirror; `selectValidatorByType` resolves candidate.type → Validator. Sprint 10 wires only `xss_reflected`.
  - `payload-schema.ts` — `validateFindingPayloadSchema` (zod): `{tenantId, projectId|null, assessmentId, candidateFindingId, candidateType, traceId}`. Defence-in-depth; matches the payload published by coordinator.
  - `index.ts` — public re-exports of handler + payload schema + dep types.
  - `*.test.ts` — co-located unit tests covering the handler decision tree (confirm/reject/inconclusive/out-of-scope/idempotent-race/driver-error-transient).
  - `package.json` — workspace deps: `@cyberstrike/audit`, `@cyberstrike/contracts`, `@cyberstrike/db`, `@cyberstrike/object-storage`, `@cyberstrike/queue`, `@cyberstrike/scope-engine`, `@cyberstrike/validators`, `zod`.
- `packages/db/src/repos/findings.ts` — `insertConfirmedFinding({db, tenantId, assessmentId, candidateFindingId, type, severity, confidence, affectedUrl, reproduction, validatorLog, validatedAt, validatedBy})`. REQUIRES `validatedBy: ValidationResult` and asserts `validatedBy.status === 'confirmed'`; throws `ValidationStatusInvariantError` otherwise. Wraps reproduction + validatorLog via `JSON.stringify`. Returns `{id}`. Plus `findFindingByCandidateId({db, tenantId, candidateFindingId})` and `listFindingsByAssessment(...)`.
- `packages/db/src/repos/findings.test.ts` — no-DB unit tests for the validation guard + JSONB wrap shape + status invariant.
- `packages/db/src/repos/finding-evidence.ts` — `insertFindingEvidence({db, tenantId, findingId, kind, objectStorageKey, sha256, sizeBytes, metadata})`. Append-only. Wraps metadata via `JSON.stringify`. Returns `{id}`.
- `packages/db/src/repos/finding-evidence.test.ts` — no-DB JSONB wrap test.
- `tests/integration/validator/`:
  - `helpers.ts` — `buildValidatorHandlerDeps(...)`, `seedCandidateForXssLab(...)`, `withLabAndStorage()`, `stubValidatorScopeDeps`. Wires emitAudit + findings repos + LocalObjectStorage + FakeXssReplayDriver against a real PG fixture.
  - `confirm-xss.test.ts` — A-V-Confirm: lab `/search?q=<NONCE_PAYLOAD>` → driver replays twice → both report DOM echo of nonce → `findings` row inserted with `created_from_candidate_id` populated, severity=high, confidence=high, status='open', validator_log non-trivial. `finding_evidence` rows for screenshot + trace exist with sha256.
  - `reject-non-vuln.test.ts` — A-V-Reject: candidate at lab `/healthz` (non-vulnerable; never reflects a nonce) → driver replays → no echo → `validation.rejected` audit, NO `findings` row, NO `finding_evidence` rows.
  - `out-of-scope.test.ts` — A-V-Scope: candidate referencing `https://evil.example/x` (no allow rule covers it) → status `out_of_scope`, NO replay attempt issued (recording fetch stub asserts 0 fetches AGAINST evil.example), NO findings row, NO retry (handler returns ack with status=out_of_scope, NOT a transient nack). `validation.out_of_scope` audit emitted.
  - `idempotent-parallel.test.ts` — A-V-Idempotent: launch the same candidate envelope TWICE concurrently. Exactly one `findings` row exists at end. The loser's worker run swallows the duplicate-key error and ack's the envelope. Two `validation.confirmed` audit events ARE allowed (one per worker invocation).
  - `alert-only-inconclusive.test.ts` — A-V-AlertOnly: candidate where the FakeDriver returns alert hit but NO DOM nonce echo → status `inconclusive`. NO findings row. `validation.inconclusive` audit emitted.

### MODIFY
- `packages/queue/src/types.ts` — add `'validate.finding'` to `ENVELOPE_KINDS` (4 → 5). Sprint 7 `recon.browser.placeholder` retained; deprecation comment unchanged.
- `packages/queue/src/index.test.ts` — assert `ENVELOPE_KINDS.length === 5`.
- `services/coordinator/src/payloads.ts` — add `validateFindingPayloadSchema` mirroring the worker's payload-schema.
- `services/coordinator/src/start-handler.ts` — after the candidate stream drain (Sprint 8), publish ONE `validate.finding` envelope per candidate with `idempotencyKey = ${parent.idempotencyKey}:validate:${candidateFindingId}`. Implementation lives in `apps/api/src/scope-engine/start-decepticon-session.ts` (where the candidate stream is currently drained — see line 343). The coordinator passes a `publishValidateFinding` injection (default seam = `deps.adapter.publish(envelope)`). Sprint 8 ITs that don't supply this injection keep working unchanged.
- `apps/api/src/scope-engine/start-decepticon-session.ts` — append a single `await publishValidateFinding({...})` call inside the candidate-drain loop, AFTER the existing `decepticon.candidate.observed` audit. Wrapped in optional injection so Sprint 8 ITs are unaffected.
- `services/validator-worker/src/index.ts` — re-exports.
- `packages/contracts/src/audit.ts` — add 6 new actions; cardinality bumped 38 → 44.
- `packages/contracts/src/audit.test.ts` — exhaustive-list assertion + cardinality update.
- `packages/db/src/index.ts` — re-export new repos (insertConfirmedFinding, findFindingByCandidateId, listFindingsByAssessment, insertFindingEvidence + types).
- `packages/db/src/repos/aggregates.ts` — add `findings` + `finding_evidence` to the buildRepositories map if needed (consistency with existing pattern).
- `tests/integration/auth/helpers/auth-fixture.ts` — `resetAuthState` adds:
  - `DELETE FROM finding_evidence` BEFORE `DELETE FROM findings` (FK).
  - `DELETE FROM findings` BEFORE `DELETE FROM candidate_findings` (FK).
  - Both BEFORE the existing `DELETE FROM candidate_findings` line (which already comes before `DELETE FROM assessments`).
  - `finding_evidence` is APPEND-ONLY in schema.ts but DOES NOT have an `enforce_append_only` trigger in current migrations — verified, no DISABLE/ENABLE needed.

### Excluded (NOT touched)
- `packages/scope-engine/src/*` — purity preserved.
- `packages/decepticon-adapter/src/*` — Sprint 8 frozen.
- `services/browser-worker/src/*` — Sprint 9 frozen.
- Sprint 1-9 migrations (010 already provisioned the tables).
- `services/report-builder/`, `apps/web/` — Sprint 11/12.

---

## 5. Acceptance criteria (A-V-* IDs)

| ID                  | Criterion |
|---------------------|-----------|
| **A-V-Confirm**     | `tests/integration/validator/confirm-xss.test.ts` — feed the worker a candidate produced by Sprint 8's decepticon flow at lab `/search`. Driver runs replay TWICE; both runs report DOM echo of the generated nonce. Result: exactly one `findings` row with `tenant_id`, `assessment_id`, `created_from_candidate_id`, `type='xss_reflected'`, `severity='high'`, `confidence='high'`, `status='open'`, `affected_url` matching candidate, `reproduction` JSONB containing the payload + nonce + 2-run reproducibility, `validator_log` JSONB recording both runs' driver outputs, `validated_at` set. Two `finding_evidence` rows (screenshot + trace) with valid 64-char-hex sha256 and matching `objectStorage.get(key).byteLength === size_bytes`. |
| **A-V-Reject**      | `tests/integration/validator/reject-non-vuln.test.ts` — candidate against `/healthz` (no nonce echo possible). Driver runs twice; both empty. Status `rejected`. **NO** `findings` row exists for the assessment. `validation.rejected` audit row emitted with `metadata.candidateFindingId`. |
| **A-V-Inconclusive** | (Covered by A-V-AlertOnly + a unit-level test.) Worker properly distinguishes `inconclusive` from `rejected`; status `inconclusive` does NOT create a finding but DOES emit `validation.inconclusive`. |
| **A-V-Scope**       | `tests/integration/validator/out-of-scope.test.ts` — candidate.affectedUrl = `https://evil.example/x` with no allow rule covering it. Validator runs scope-decide BEFORE driver call. A `recordingFetch` stub injected into `FakeXssReplayDriver` asserts 0 fetches against `evil.example`. Status `out_of_scope`. NO `findings` row. `validation.out_of_scope` audit emitted. Handler returns `ack` (terminal, no retry). |
| **A-V-Idempotent**  | `tests/integration/validator/idempotent-parallel.test.ts` — two `handleValidateFinding` calls run concurrently against the same candidate via `Promise.all`. Exactly one `findings` row at end (`SELECT count(*)` = 1, query keyed on `created_from_candidate_id`). Both invocations return `{kind:'ack'}`. |
| **A-V-AlertOnly**   | `tests/integration/validator/alert-only-inconclusive.test.ts` — driver configured to return alert hit but zero DOM/console nonce echoes (a "weak proof" simulation). Status `inconclusive`. NO `findings` row. `validation.inconclusive` audit emitted. |
| **A-V-Hang**        | XSS validator catches a `BrowserReplayTimeoutError` (typed sentinel exported from `packages/validators/src/xss-replay-driver.ts`) thrown by the driver and returns `ValidationResult{status:'inconclusive', reason:'timeout', proofType:'none'}`. Worker emits `validation.inconclusive` audit (NOT `validation.rejected`, NOT a transient nack — the candidate stays a candidate; this validation attempt is just inconclusive). NO `findings` row. Tested at unit level in `packages/validators/src/xss.test.ts` (driver-throws-`BrowserReplayTimeoutError` → `inconclusive` with `reason:'timeout'`) AND at IT level in `tests/integration/validator/hang-timeout-inconclusive.test.ts`: FakeXssReplayDriver constructed with `simulateTimeout: true`, handler returns `ack`, `findings` row count = 0, `validation.inconclusive` audit row exists with `metadata.reason === 'timeout'`. |
| **A-V-Evidence**    | A-V-Confirm IT additionally asserts: each `finding_evidence` row's `objectStorage.get(key)` returns bytes whose sha256 matches the persisted column AND sizeBytes match `Buffer.byteLength`. `kind` ∈ `{screenshot, trace}` (both present, exactly 2 rows). |
| **A-V-NonceUnique** | `packages/validators/src/nonce.test.ts` — 1000 calls to `generateNonce()` produce 1000 distinct values. Format invariant: `/^[a-z0-9]{32}$/` (or contract-specified alphabet/length). `nonceMatchesEcho(nonce, body)` returns false for unrelated body, true when body contains nonce. |
| **A-V-DirectInsertForbidden** | (a) Static grep gate — `grep -rn "insertInto\(['\"]findings['\"]" apps/ services/ packages/` returns ONLY occurrences inside `packages/db/src/repos/findings.ts`. (b) `insertConfirmedFinding` parameter list includes `validatedBy: ValidationResult` and the function body throws `ValidationStatusInvariantError` if `validatedBy.status !== 'confirmed'`. Unit test asserts both: a `rejected`/`inconclusive`/`out_of_scope` ValidationResult passed in throws; a `confirmed` ValidationResult inserts the row. (c) Repo file does NOT export a `rawInsert` / `unsafeInsert` / `insertWithoutValidation` helper. (d) `packages/db/src/repos/findings.test.ts` includes an explicit "no raw insert" surface test that imports the module and asserts the exported names equal exactly `['insertConfirmedFinding','findFindingByCandidateId','listFindingsByAssessment','ValidationStatusInvariantError']`. |
| **A-V-Coverage**    | ≥80% line coverage on `packages/validators/src/**` AND `services/validator-worker/src/**`. `RealXssReplayDriver` carve-out (NotImplementedError stub, 100% throw paths covered via unit test) mirrors Sprint 8/9 carve-outs. |
| **A-V-LintTC**      | `bun run lint` clean (0 errors). `bun run typecheck` clean. |
| **A-V-Tests**       | `bun test` (no DB) 0 fail. `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` 0 engine fail (3 known pre-existing flakes acceptable: A-Proj-1 pagination, C29 audit-emission, B14 append-only). Single PG run only — R3 discipline. Full-PG count must NOT drop below Sprint 9 floor of 1099. |
| **A-V-FixtureReset** | `resetAuthState` deletes `finding_evidence` BEFORE `findings` BEFORE `candidate_findings` BEFORE `assessments` (FK order — verified by orphan-row delete probe). Every IT under `tests/integration/validator/` calls `await resetAuthState(fx.db)` in `beforeEach`. `grep -c resetAuthState <each-file>` returns ≥2. |
| **A-V-Audit-Card**  | `AUDIT_ACTIONS` length transitions 38 → 44 (+6 new). `audit.test.ts` cardinality assertion updated. Exhaustive-list assertion includes the 6 new actions in declared order. |
| **A-V-Envelope**    | `ENVELOPE_KINDS` length transitions 4 → 5 (+1 `validate.finding`). `queue/index.test.ts` cardinality assertion updated. `validateFindingPayloadSchema` zod-rejects unknown extra keys (`.strict()`). |
| **A-V-Driver-Select** | `XSS_REPLAY_DRIVER=real` env causes `selectXssReplayDriver()` to return `RealXssReplayDriver`; default and `fake` return `FakeXssReplayDriver`; unknown value throws (`unknown_xss_replay_driver:<value>`). Tested. |
| **A-V-NotImpl**     | `import { RealXssReplayDriver } from '@cyberstrike/validators'; new RealXssReplayDriver().replay({...})` rejects with `NotImplementedError` (typed `instanceof` + `.name === 'NotImplementedError'`). |
| **A-V-Reg-1**       | No regression: full-PG suite ≥1099 pass / 0 engine fail (vs Sprint 9 floor). no-DB suite ≥909 pass. |
| **A-V-Reg-Engine**  | Scope-engine purity preserved (`git diff --stat packages/scope-engine/src/` empty). Decepticon-adapter surface preserved (empty diff). Browser-worker surface preserved (empty diff). |

---

## 6. New audit actions (38 → 44)

Sprint 10 adds:
- `validation.started` — outcome `success`
- `validation.confirmed` — outcome `success`
- `validation.rejected` — outcome `success` (the validation itself succeeded; the candidate was just not vulnerable)
- `validation.inconclusive` — outcome `success`
- `validation.out_of_scope` — outcome `denied`
- `finding.created` — outcome `success`

`AUDIT_ACTIONS` cardinality assertion: `expect(...).toBe(38)` → `expect(...).toBe(44)`.

`audit.test.ts` exhaustive list: append the 6 new actions in the same order at the end of the existing list.

The validator-worker emits exactly one `validation.started` row at the top of the handler, then exactly one of the four terminal validation actions (confirmed/rejected/inconclusive/out_of_scope), and additionally one `finding.created` IFF status is `confirmed`.

---

## 7. New ENVELOPE_KINDS (4 → 5)

Sprint 9 floor: 4 kinds (`assessment.start`, `recon.browser.placeholder`, `decepticon.findings`, `recon.browser`).

Sprint 10 adds: `validate.finding`.

- `packages/queue/src/types.ts`
- `packages/queue/src/index.test.ts` — `expect(ENVELOPE_KINDS.length).toBe(5)`.

`services/coordinator/src/payloads.ts` adds `validateFindingPayloadSchema`:

```
{
  tenantId: uuid,
  projectId: uuid | null,
  assessmentId: uuid,
  candidateFindingId: uuid,
  candidateType: 'xss_reflected' (Sprint 10 only — extended in later sprints),
  traceId: 32-hex string,
}
```

`.strict()` to reject unknown keys.

---

## 8. Coordinator delta

`apps/api/src/scope-engine/start-decepticon-session.ts` — inside the `for await (const candidate of deps.adapter.streamCandidates(...))` loop, AFTER the existing `candidate_findings` insert + `decepticon.candidate.observed` audit, publish a single `validate.finding` envelope:

```
await deps.adapter.publish({
  jobId: randomUUID(),
  tenantId: input.tenantId,
  projectId: input.projectId ?? null,
  assessmentId: input.assessmentId,
  kind: 'validate.finding',
  idempotencyKey: `${input.parentEnvelope.idempotencyKey}:validate:${candidateFindingId}`,
  createdAt: clockIso(),
  attempt: 0,
  maxAttempts: 3,
  traceId: input.traceId,
  payload: {
    tenantId: input.tenantId,
    projectId: input.projectId ?? null,
    assessmentId: input.assessmentId,
    candidateFindingId,
    candidateType: candidate.type,
    traceId: input.traceId,
  },
});
```

The coordinator's `index.ts` does NOT auto-subscribe `validate.finding` (matches Sprint 9 carry-forward B4 — handler invoked by validator-worker daemon when shipped; ITs invoke the handler directly). Sprint 8 ITs that don't inspect `validate.finding` are unaffected.

---

## 9. Test plan

### Unit (no DB)
- `packages/validators/src/contract.test.ts` — zod parses ValidationResult shape, rejects unknown status, accepts each closed-set status.
- `packages/validators/src/nonce.test.ts` — 1000-collision check, format invariant, echo matcher.
- `packages/validators/src/xss-replay-driver.test.ts` — Fake driver's replay output (DOM echo, no echo, alert-only, network-from-script, `simulateTimeout`→throws `BrowserReplayTimeoutError`). Real driver throws `NotImplementedError`. Selector covers `fake`/`real`/unset/unknown. `BrowserReplayTimeoutError instanceof Error` + `.name === 'BrowserReplayTimeoutError'` asserted.
- `packages/validators/src/xss.test.ts` — decision matrix:
  - both runs DOM echo → `confirmed` (high confidence)
  - one run DOM echo, one empty → `inconclusive`
  - both empty → `rejected`
  - both alert-only, no DOM/console echo → `inconclusive`
  - DOM echo + alert + console echo → `confirmed`
  - scope deny → `out_of_scope` (no driver call)
  - driver throws `BrowserReplayTimeoutError` → `ValidationResult{status:'inconclusive', reason:'timeout', proofType:'none'}` (A-V-Hang unit half)
  - driver throws other `Error` (non-timeout) → bubble up to worker (transient nack, NOT a ValidationResult)
- `packages/validators/src/evidence-collector.test.ts` — sha256 determinism, 2 blobs per run.
- `services/validator-worker/src/worker.test.ts` — handler grid:
  - confirmed → calls insertConfirmedFinding once + emits 2 audits + ack
  - rejected → no findings insert + 1 audit + ack
  - inconclusive (alert-only origin) → no findings insert + 1 audit + ack
  - inconclusive (timeout origin via `BrowserReplayTimeoutError`) → no findings insert + `validation.inconclusive` audit with `metadata.reason === 'timeout'` + ack (terminal — NOT a transient nack)
  - out_of_scope → no driver call + 1 audit + ack
  - duplicate-key on findings insert → swallow + ack (idempotent race)
  - candidate not found → terminal nack
  - assessment not found → terminal nack
  - driver throws non-timeout `Error` → transient nack (matches Sprint 9 transient classification pattern)
- `packages/db/src/repos/findings.test.ts` — invariant guard: throws on rejected/inconclusive/out_of_scope; succeeds on confirmed (mocked db); JSONB stringify wrap; module-level surface assertion (no rawInsert export).
- `packages/db/src/repos/finding-evidence.test.ts` — JSONB stringify wrap on metadata.
- `packages/contracts/src/audit.test.ts` — +6 actions cardinality + list.
- `packages/queue/src/index.test.ts` — +1 envelope kind cardinality.

### Integration (PG)
Every IT MUST call `await resetAuthState(fx.db)` in `beforeEach` (P27). Single sequential PG run (R3). Lab fixture started in `beforeAll`, stopped in `afterAll`.

- `tests/integration/validator/confirm-xss.test.ts`
- `tests/integration/validator/reject-non-vuln.test.ts`
- `tests/integration/validator/out-of-scope.test.ts` — also asserts the recording-fetch stub on FakeXssReplayDriver shows zero hits to denied origins.
- `tests/integration/validator/idempotent-parallel.test.ts`
- `tests/integration/validator/alert-only-inconclusive.test.ts`
- `tests/integration/validator/hang-timeout-inconclusive.test.ts` — A-V-Hang IT: FakeXssReplayDriver constructed with `simulateTimeout: true` → handler returns `ack`, `findings` count = 0, `validation.inconclusive` audit row exists with `metadata.reason === 'timeout'`.

---

## 10. Risks (R1..R6)

| R# | Risk | Mitigation |
|----|------|------------|
| **R1** | **Real Playwright Chromium not in CI / heavy install footprint.** | `RealXssReplayDriver` is NotImplementedError stub. `FakeXssReplayDriver` is fetch-backed with deterministic nonce-detection. Mirrors Sprint 9 RealBrowserDriver pattern. |
| **R2** | **DirectInsertForbidden bypass — someone adds a raw `insertInto('findings')` later.** | (a) Single-function repo, (b) static grep gate in CI (acceptance A-V-DirectInsertForbidden static probe), (c) unit test asserts repo exports exactly the 4 named symbols, (d) `validatedBy: ValidationResult` required parameter — TS compilation fails for any caller forgetting it. |
| **R3** | **Single PG run discipline (Sprint 7 measurement-divergence lesson).** | Run `bun test` PG suite exactly ONCE during verification. No retry-loop, no parallel runs. Known flakes accepted; only NEW failures count. |
| **R4** | **Idempotency-race produces 2 findings rows.** | `findings.created_from_candidate_id` UNIQUE (mig 010 line 14). Worker catches the unique-violation error and ack's. IT exercises `Promise.all([handleA, handleB])` and asserts `count = 1`. |
| **R5** | **Confirmation false-positive — alert-only payload masquerades as confirmed.** | Decision logic requires DOM/console nonce echo, NOT just alert dispatch. Alert-only path explicitly returns `inconclusive`. Unit + IT cover this. The user's "weak fallback" requirement is enforced in `validateXssReflected` decision tree. |
| **R6** | **JSONB pitfall recurrence on `reproduction`/`validator_log`/`metadata`.** | Three repo functions are the only writers; each wraps with `JSON.stringify`. Unit tests round-trip non-empty objects. Mirrors P1 catalog entry. |

---

## 11. File-size discipline (R3 carry from Sprint 8/9)

- `packages/validators/src/xss.ts` ≤200 lines.
- `services/validator-worker/src/worker.ts` ≤200 lines.
- `packages/db/src/repos/findings.ts` ≤120 lines.
- `apps/api/src/scope-engine/start-decepticon-session.ts` delta ≤25 lines.

---

## 12. Out of scope (deferred)

- Real Playwright Chromium replay — `RealXssReplayDriver` stub only.
- MinIO/S3 object storage — `LocalObjectStorage` reused.
- Validators for non-XSS types (`xss_stored`, `sqli`, `csrf`, etc.) — Sprint 11+.
- Findings UI (`apps/web`) — Sprint 11.
- OOB confirmation path — `needs_human_review` value reserved in the contract; no producer in Sprint 10.
- Findings status workflow transitions (open → triaged → ...) — Sprint 11.
- Evidence inspection API endpoint (`GET /findings/:id/evidence/:kind`) — Sprint 11.
- Validator-worker daemon process boot — handler runs in-process via IT injection (matches Sprint 8/9 pattern; B1/B4 carry-forward).
- LLM-augmented validator decisions — explicitly forbidden by invariant #5 (deterministic only).

End of contract.
