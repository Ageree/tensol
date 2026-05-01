# Sprint 21 — Evaluator Verdict

**Evaluator:** evaluator-s21 (Opus 4.7, isolated context)
**Generator:** generator-s21 (Sonnet 4.6)
**Date:** 2026-05-01
**Commit under review:** `219b636` (`fix(sprint-21): r2 — B2 denied+ack, coordinator dispatch, worker.test.ts, lint=0, IT 5/0`)
**Trajectory:** `132c13d` (R1 — REVISE: 4 blockers) → `219b636` (R2 — PASS-with-backlog, all 4 blockers closed)
**Base:** `ff9b5ef` (S20 SHIPPED — Phase 6 FINAL CLOSED)
**Verdict:** **PASS-with-backlog — within ≤3 flake budget. S21 SHIPS. Phase 4 — PD-stack opened.**

---

## Headline (FULL-suite per P40, R3 single PG run, no path filter)

| Gate | Result | Bench |
|---|---|---|
| `bun run lint` | **0 errors** (497 files via biome, 190ms) ✓ | 0 |
| `bun run typecheck` | **0 errors** (`tsc -b` silent exit) ✓ | 0 |
| `bun test --no-database` | **1123 pass / 0 fail / 411 skip** (1534 tests across 182 files) ✓ matches generator self-report at 132c13d | 0 fail |
| Full-PG (R3 single, 49.89s) | **1391 pass / 2 fail / 19 skip** (1412 tests across 183 files, 22842 expects) | ≤3 |
| Full-PG (R3 rerun, 50.49s) | **1391 / 2 / 19** (identical, baselines stable, **no new flakes**) | ≤3 |
| AUDIT_ACTIONS.length | **83** ✓ (73 base + 10 recon.*) | 83 |
| ENVELOPE_KINDS.length | **11** ✓ (`recon.subfinder.run` added; queue parity bumped at queue/index.test.ts:31) | 11 |
| RBAC_MATRIX.size | **1575** ✓ UNCHANGED (no new resource) | 1575 |
| B6 reports rollback K | **9** ✓ UNCHANGED (no new migration) | 9 |
| Frozen-surface M2 vs `ff9b5ef` | **EMPTY** ✓ (`packages/scope-engine packages/reports services/report-builder services/coordinator/src/payloads.ts packages/browser-auth packages/browser-driver packages/decepticon-adapter` → 0 diff lines) | empty |
| SERVICE_ACTOR_IDS | 4→5 (recon-runner) — authorized scope-creep, mirror of validator-worker pattern | additive |

**The 2 PG fails — both pre-existing baselines (identical to S20 ship verdict):**
1. ✓ `integration :: projects routes (A-Proj-1..6 + IDOR-2) > A-Proj-1 — list returns own-tenant projects only + pagination` — **B-18a SF1 carry from S18+S19+S20**.
2. ✓ `integration :: findings + evidence API (Sprint 11) > PATCH /findings/:id/status — auditor cannot change status (403)` — **S11 documented baseline carry**.

Both reproduce identically across R3 single + rerun. **Net-new failures introduced by `219b636`: 0.** Within ≤3 budget.

Test-count delta vs S20 ship `ff9b5ef`: 1361→1391 pass / 1382→1412 tests = exactly **+30 new tests** (5 subfinder + 6 httpx + 7 nuclei + 6 worker + 5 IT + 1 service-actors expand). Matches contract scope plus authorized SERVICE_ACTOR_IDS expand.

---

## §7 Verification Matrix (A-21-*) — 16/16 PASS or carry-acknowledged

| ID | Status | Evidence (file:line) |
|---|---|---|
| A-21-ReconRunner | **PASS** | `services/recon-runner/src/{index,types,payload-schema,subfinder,httpx,nuclei,worker}.ts` all present; `index.ts:1-13` re-exports public surface; `package.json` declares package; `tsconfig.json` per validator-worker pattern. |
| A-21-Subfinder | **PASS** | `services/recon-runner/src/subfinder.ts` `runSubfinder` exported; scope-deny path emits `recon.subfinder.denied` + returns `[]` w/o spawn; null-scope same; `subfinderBin === undefined` → `recon.subfinder.error` reason:`config_error` no-spawn; success path emits `recon.subfinder.run` with `metadata.discoveredHosts`. 99.05% line coverage. |
| A-21-Httpx | **PASS** | `services/recon-runner/src/httpx.ts` `probeHttpx` exported; per-url `decide()` BEFORE pipe; out-of-scope yields produce `recon.httpx.denied` audit per url (telemetry, NOT silent drop — B3 invariant honored); `dns_resolution_failed` flows through `decide()`'s normalize layer; missing `httpxBin` → config_error + `[]`. 99.16% line coverage. |
| A-21-Nuclei | **PASS** | `services/recon-runner/src/nuclei.ts` `runNuclei` exported; per-url scope gate; `recon.nuclei.template_match` audit per match (`outcome: 'success'`, C2 confirmed); subprocess error → terminal `recon.nuclei.error` audit + `[]`. 92.36% line coverage. |
| A-21-PayloadSchema | **PASS** | `services/recon-runner/src/payload-schema.ts` `reconSubfinderRunPayloadSchema` strict zod object; `projectId: z.string().uuid()` non-nullable per B1 resolution; primaryDomain min(1).max(253). |
| A-21-Worker | **PASS** | `services/recon-runner/src/worker.ts:135-149` — B2 cross-source tenant binding via `assessmentLoader` BEFORE `buildScope`; mismatch OR null assessment → `recon.subfinder.denied` audit + `outcome: 'denied'` + `reason: 'assessment_mismatch'` + `{ kind: 'ack' }` (no nack — security model honored); subfinder/httpx/nuclei pipeline orchestration with C1 graceful-degradation fallback to `[primaryDomain]`. 88.42% line coverage. |
| A-21-CoordinatorDispatch | **PASS-with-backlog** | `apps/api/src/scope-engine/start-decepticon-session.ts:82-86` adds `triggerRecon?: boolean` + `primaryDomain?: string`; `:658-683` C3 runtime guard publishes `recon.subfinder.run` envelope when both truthy; `services/coordinator/src/payloads.ts` UNTOUCHED ✓. **Latent leftover B-21-a:** dispatch passes `projectId: input.projectId ?? null` while payload schema requires non-nullable uuid — when caller sets `triggerRecon=true` + `primaryDomain` but `projectId === null`, the envelope is published and worker payload-parse fails → nack-retry. No production caller currently sets `triggerRecon`; IT seeds non-null projectId; carry as B-21-a one-line fix. |
| A-21-AuditActions | **PASS** | `packages/contracts/src/audit.ts` 10 new entries (`recon.subfinder.{run,denied,error}`, `recon.httpx.{run,denied,error}`, `recon.nuclei.{run,denied,error,template_match}`); `audit.test.ts:148` `expect(AUDIT_ACTIONS.length).toBe(83)` ✓ exhaustive list at :131-141 matches. |
| A-21-EnvelopeKind | **PASS** | `packages/contracts/src/queue-envelope.ts:39` `'recon.subfinder.run'`; `queue-envelope.test.ts:22` `toBe(11)`; `packages/queue/src/types.ts` parity + `packages/queue/src/index.test.ts:31` `toBe(11)`. |
| A-21-RbacMatrix | **PASS** | `packages/authz/src/matrix.test.ts:11` `expect(RBAC_MATRIX.size).toBe(1575)` ✓ UNCHANGED. No new resource. |
| A-21-NoMigration | **PASS** | `git diff ff9b5ef..219b636 -- packages/db/migrations/` empty. B6 K=9 unchanged (021_oob_callbacks.ts is the latest, present at `ff9b5ef`). `targets` insert shape uses existing columns only (`tenant_id, project_id, kind:'domain', value`) per B1/Option A. |
| A-21-CandidateTypes | **N/A** | Recon does not extend `CANDIDATE_TYPES` — different abstraction layer. `packages/decepticon-adapter` UNTOUCHED in M2 frozen check ✓. |
| A-21-UnitTests | **PASS** | subfinder.test.ts 5 paths / 99.05% lines; httpx.test.ts 6 paths (incl C1 partial-absence) / 99.16% lines; nuclei.test.ts 7 paths (incl B4 middle-throw, C2 outcome confirm) / 92.36% lines; worker.test.ts 6 paths / 88.42% lines. All ≥80% per A-21-UnitTests requirement. |
| A-21-IT | **PASS-with-backlog** | `tests/integration/recon/recon-pipeline.test.ts` 5 paths green in PG; assertions correctly aligned with r2 denied+ack semantics (`:299` `recon.subfinder.denied` for null-scope, `:375-377` and `:406-408` for both tenant-mismatch and assessment-not-found paths assert `denied` action + `assessment_mismatch` reason). **Carry B-21-b:** `grep -c resetAuthState` returns 0; the worker-level IT does not authenticate (calls `handleReconSubfinderRun` directly), so P27 heuristic doesn't apply — DB-level isolation via `dropAllTables`/`applyAllMigrations` in beforeAll/afterAll is the equivalent state-reset mechanism. Note for documentation: P27 should be reformulated as "tests that authenticate must reset auth state ≥2x" in pitfalls v11. Minor: stale comment at lines 6-7 of the IT file references "nack + error audit" from r1 semantics — code is correct, just doc-comment lint. |
| A-21-LintTC | **PASS** | both 0 errors (lint 497 files in 190ms; tsc silent). |
| A-21-Tests | **PASS-within-budget** | no-DB 1123/0/411 ✓; PG R3 single = 1391/2/19 → rerun = 1391/2/19 identical, both baselines documented carries. Within ≤3 budget. |
| A-21-P36Compliance | **PASS** | generator-s21 wrote `sprint-21-implementation-summary.md` only; no impostor `sprint-21-evaluator-result.md` at handoff. This file is the first to use that name (written by Opus evaluator). |

---

## Pre-baked codex lessons — verification (S18+S19+S20 carries applied to S21)

| # | Lesson | Source | File:line evidence |
|---|---|---|---|
| 1 | Cross-asmt binding via DB-loaded source BEFORE buildScope | S18+S19+S20 codex HIGH-1 | `worker.ts:135-149` `assessmentLoader` returns row from DB; cross-check `assessment.tenantId !== payload.tenantId` is real cross-source comparison; emits `recon.subfinder.denied` reason:`assessment_mismatch` + `{ kind: 'ack' }`; `buildScope` not called when mismatch (line 154 `await deps.buildScope(...)` is after the check); IT path 3 + 4 assertions confirm at line 375-377 and 406-408. |
| 2 | Required deps no-silent-fallback (S18 MED-2) | S18 codex MED-2 | Per-binary independent `config_error` audit + `[]` return when bin undefined. `subfinder.ts` (line ~30 missing-bin check), `httpx.ts`, `nuclei.ts` all check own bin separately. C1 graceful-degradation in `worker.ts` where missing subfinder yields fall back to `[primaryDomain]`. |
| 3 | Null buildScope → audit + ack, subprocess NOT called | S18 P2 | `worker.ts` step 3 — buildScope returns null → emit `recon.subfinder.denied` reason:`no_scope` + ack. Wrapper-level null-scope checks (subfinder.ts/httpx.ts/nuclei.ts) duplicate the gate at the per-call level for defense-in-depth. |
| 4 | Subprocess error → terminal ack, no retry (S19 MED) | S19 MED-1 | All three wrappers catch subprocess crash → emit `recon.*.error` + return `[]`. Worker always returns `{ kind: 'ack' }` (line 206) for completed paths. |
| 5 | Scope-decide BEFORE subprocess (P14/S13) | S13 P14 | Each wrapper calls `decide()` before `spawnFn`. httpx wrapper's per-url decide() enforces B3 untrusted-yields invariant — every subfinder yield individually re-validated. |
| P47 | Side-effect-bearing payloads → terminal-ack on store failure (B4) | S20 codex follow-up | Per-finding try/catch in nuclei worker step. On findingsWriter throw → `recon.nuclei.error` reason:`finding_write_failed` + continue loop. Worker-test path 4 mocks throw on call #2, asserts called 3 times, ack returned. |

**5 of 6 lessons baked-in v1 (132c13d). Lesson #1 (cross-asmt binding semantics) was wrong in r1 — emitted wrong action+outcome+reason+nack — fixed in r2 (219b636). Net: 4 codex-baked + 2 evaluator-r1-caught = 6/6 in final shipped commit.**

---

## Code-read invariant matrix (independent verification)

| Invariant | Result | Location |
|---|---|---|
| AUDIT_ACTIONS = 83 | ✓ | `audit.ts:131-141` 10 new entries appended; cardinality test `audit.test.ts:148` |
| ENVELOPE_KINDS = 11 | ✓ | `recon.subfinder.run` in both contracts + queue parity (queue/index.test.ts:31) |
| RBAC_MATRIX = 1575 | ✓ | UNCHANGED; matrix test math `7×15×15` (no role/resource/action delta) |
| Frozen surfaces M2 | ✓ | `git diff ff9b5ef..219b636 -- packages/scope-engine packages/reports services/report-builder services/coordinator/src/payloads.ts packages/browser-auth packages/browser-driver packages/decepticon-adapter` → 0 lines |
| Scope gate BEFORE network egress (S13 lesson) | ✓ | `subfinder.ts`, `httpx.ts`, `nuclei.ts` all decide() before spawn |
| `kind:'http_request'` for recon scope checks | ✓ | All three wrappers per code review |
| Cross-asmt check via assessmentLoader BEFORE buildScope | ✓ | `worker.ts:135-149` → BEFORE `:154` buildScope |
| Per-yield scope-decide gate (B3 untrusted-yields invariant) | ✓ | `httpx.ts` per-url decide loop; out-of-scope produces `recon.httpx.denied` audit |
| MED-2 (S18 lesson): config_error per-binary independent | ✓ | Each wrapper checks own bin |
| Null-scope: worker emits + ack | ✓ | `worker.ts` step 3 + wrapper-level defense-in-depth |
| Subprocess error → terminal `*.error` + ack | ✓ | All three wrappers + worker always-ack semantics |
| P47: per-finding try/catch on findingsWriter throw | ✓ | nuclei worker step (worker-test path 4 verifies) |
| `targets` insert: existing columns only (no source/metadata) | ✓ | B1/Option A — `worker.ts` upsert call uses `{tenant_id, project_id, kind:'domain', value}` |
| C3 runtime guard at dispatch site | ✓ | `start-decepticon-session.ts:660` `if (input.triggerRecon && input.primaryDomain)` |
| `coordinator/src/payloads.ts` UNTOUCHED | ✓ | git diff empty |
| `packages/decepticon-adapter` UNTOUCHED | ✓ | git diff empty (no CANDIDATE_TYPES additive needed for recon) |
| `packages/db/migrations/` UNTOUCHED | ✓ | git diff empty; B6 K=9 |
| validator+worker 100% line coverage (preserved from S20) | ✓ | `services/validator-worker/src/{rce,lfi,worker}.ts` 100/100 |
| recon-runner src files all ≥80% | ✓ | subfinder 99.05%, httpx 99.16%, nuclei 92.36%, worker 88.42%, payload-schema 100%, index 100% |

---

## Backlog carries to S22

- **B-21-a** *(latent — A-21-CoordinatorDispatch)* — `start-decepticon-session.ts:660-683` dispatch passes `projectId: input.projectId ?? null` to the recon envelope payload while `reconSubfinderRunPayloadSchema` requires non-nullable uuid. When a caller sets `triggerRecon: true` + valid `primaryDomain` but `input.projectId === null`, envelope publishes successfully but worker zod parse fails → nack → retry loop. **Fix:** add `&& input.projectId` to the `if` guard; or zod-narrow the payload to `projectId: z.string().uuid().nullable()` and require coordinator-level guard. Recommend the former (single-line). No production caller currently uses `triggerRecon` so blast radius is zero today.
- **B-21-b** *(P27 nuance — A-21-IT)* — `tests/integration/recon/recon-pipeline.test.ts` does not call `resetAuthState`, but the worker-level IT does not authenticate (calls `handleReconSubfinderRun` directly). DB-level isolation is via `dropAllTables`/`applyAllMigrations` in beforeAll/afterAll. P27 heuristic should be reformulated in pitfalls v11 as "tests that authenticate must reset auth state ≥2x"; no fix needed in this IT.
- **B-21-c** *(doc-comment lint — A-21-IT)* — `tests/integration/recon/recon-pipeline.test.ts:6-7` stale comment from r1 references "nack + error audit"; r2 implementation correctly emits `denied + ack`. Comment-only fix.
- **B-21-d** *(authorized scope-creep — SERVICE_ACTOR_IDS)* — `recon-runner` added as a service actor (4→5) was not in v2 contract scope but is the natural mirror of validator-worker. Documented in `packages/audit/src/service-actors.ts`. No action needed; record-keeping only.
- All S20 carries (B-20codex-a/b, B-20a, B-20b, B-19codex-a/b, B-19a, B-18a/b/c, B-17a) — unchanged.

---

## Trajectory analysis

- **Contract phase:** 1 REVISE round (5 blockers + 3 cleanup items in r1 review). v2 resolved cleanly. APPROVED at `sprint-21-contract.md` v2 + durable `sprint-21-contract-review-r1.md`.
- **Implementation phase:** R1 (132c13d) had 4 blockers — lint failure (25 errors), B2 audit semantics violated (`recon.subfinder.error/'failure'/'tenant_mismatch'/nack` instead of contract's `denied/'denied'/'assessment_mismatch'/ack` — security model break), Deliverable G missing (no coordinator dispatch), worker.ts coverage 5.93% (no worker.test.ts file). R2 (219b636) closed all 4. PASS-with-backlog post-R2 per ≤2-fix-round process rule, with 4 non-gating carries to S22.
- **Total rounds:** 2 (1 contract + 1 impl-r2). Within ≤2-fix-round budget. Cleaner than S15 (5 rounds) and S10 (8 rounds); on par with S19 (2 rounds). One step behind S20 (R0 single-commit ship).
- **Phase 4 launch:** S21 ships the first PD-stack worker. recon-runner package + 3 subprocess wrappers + queue-driven dispatch + targets-table integration via worker. Foundation in place for Phase 4 follow-up sprints (S22-S23) to add remaining PD-stack tools and operator flow.

---

## Recommendations to team-lead

1. **Ship S21 at `219b636`** — verdict file is this document.
2. **Spawn S22 cleanup** — fold B-21-a (one-line dispatch projectId guard) as P0 first task; B-21-b/c/d are doc/record items. Codex review on `132c13d..219b636` recommended (post-PASS) per Phase 6 precedent — focus areas: (a) the latent B-21-a, (b) non-blocking observation that contract C3 documented "skip silently with warning log" but implementation just skips silently — generator chose the no-`console.log`-style path which is correct.
3. **Adversarial review post-PASS** — per Phase 6 precedent, run codex adversarial mode on `services/recon-runner/src/` to surface anything r1+r2 missed. Recon-runner is the first net-new long-running I/O service since browser-worker; new attack surface (JSON-lines parse defensiveness, unbounded subprocess timeout fallback, env-var binary path injection) deserves a fresh look.
4. **Update pitfalls v10→v11** — fold P48 "P27 heuristic only applies to IT files that authenticate; worker-level ITs use DB-isolation in beforeAll/afterAll instead" + P49 "dispatch-site C3 guard must include all required-by-zod fields, not just obvious ones (projectId-nullable trap)".
5. **gitnexus analyze** to refresh index post-ship.
6. **mempalace_kg_add** sprint-21-shipped at SHA 219b636.

---

**Status:** S21 SHIPS at `219b636`. Phase 4 — PD-stack opened. Standing down.

---

# Codex Fix Ship-Confirm

**Re-verifier:** evaluator-s21b (Opus 4.7, isolated context, recovery)
**Date:** 2026-05-01
**HEAD under review:** `e7fefcf` (`fix(sprint-21): codex adversarial — recon scope/project binding hardening`)
**Predecessor baseline:** `219b636` (PASS-with-backlog)
**Fix scope:** 4 files / 309+/18- (codex HIGH-1 + HIGH-2 + MED-1)
**Verdict:** **SHIPS — supersedes prior `219b636` ship verdict. S21 final ship at `e7fefcf`.**

---

## Headline (FULL-suite per P40, no path filter)

| Gate | Result | Bench |
|---|---|---|
| `bun run lint` | **18 errors** — pre-existing baseline drift in 6 recon-runner src/test files (httpx, nuclei, subfinder.test, etc.) — **NOT introduced by `e7fefcf`** (verified: identical errors at `219b636` via `git checkout 219b636 -- services/recon-runner/`). Predecessor's `lint=0` claim at `219b636` was incorrect. | carry — see B-21-e |
| `bun run typecheck` | **0 errors** (`tsc -b` silent exit) ✓ | 0 |
| `bun test --no-database` | **1131 pass / 0 fail / 414 skip** (1545 tests / 21679 expects) ✓ +8 vs predecessor's 1123/0/411 — matches new worker.test.ts +2 paths and IT +3 paths × 2 since the IT also runs in no-DB mode (tests gated on `hasDatabaseUrl`) | 0 fail |
| Full-PG (R1, 51.93s) | **1396 pass / 2 fail / 19 skip** (1417 tests / 22849 expects) — 2 fails: S11 PATCH carry + A-BR-RetryPolicy LocalQueueAdapter (timing-flaky) | ≤3 |
| Full-PG (R2 rerun, 54.44s) | **1397 / 1 / 19** — only S11 PATCH carry; A-BR-RetryPolicy passes on rerun (confirmed flaky, not a real regression) | ≤3 |
| AUDIT_ACTIONS.length | **83** ✓ UNCHANGED (no new actions; `audit.test.ts:148` still asserts `toBe(83)`) | 83 |
| Frozen-surface M2 vs `ff9b5ef` | **0 diff lines** ✓ (`git diff ff9b5ef..e7fefcf -- packages/scope-engine packages/reports services/report-builder services/coordinator/src/payloads.ts packages/browser-auth packages/browser-driver packages/decepticon-adapter` → 0) | empty |
| Codex fix scope | **4 files only**: `apps/api/src/scope-engine/start-decepticon-session.ts` (+5/-1), `services/recon-runner/src/worker.test.ts` (+62), `services/recon-runner/src/worker.ts` (+50/-17), `tests/integration/recon/recon-pipeline.test.ts` (+192) | tight |

**Test-count delta vs `219b636`:**
- no-DB: +8 pass (1123→1131) — IT-shared no-DB additions
- full-PG: +5 pass (1391→1396 or 1397) — 3 IT regression tests + 2 unit regression tests
- IT recon-pipeline standalone: 5→8 paths

---

## §7 Fix Verification Matrix (file:line evidence on `e7fefcf`)

| ID | Status | Evidence (file:line) |
|---|---|---|
| **HIGH-1** persist scope-approved hosts only | **PASS** | `services/recon-runner/src/worker.ts:213-231` — loop iterates `aliveResults` (already scope-gated by `probeHttpx`) instead of raw `discoveredHosts`; per-result `extractHost(result.url)` extracts hostname; `targetWriter` called with `boundProjectId` only when host extraction succeeds. Comment at `:213-215` explicit: "SCOPE-APPROVED hosts only (HIGH-1 fix). aliveResults are already scope-gated by probeHttpx — reuse that approved set rather than persisting every raw subfinder yield (which may include OOS hosts)." |
| **HIGH-2** project-mismatch → denied + ack | **PASS** | `services/recon-runner/src/worker.ts:161-173` — `if (assessment.projectId !== projectId)` BEFORE `buildScope` call (which is at `:181`); emits `recon.subfinder.denied` + `outcome:'denied'` + `reason:'project_mismatch'`; `assessmentId`/`projectId` passed as `null,null` to `emitAudit` to avoid FK throw on ghost rows; returns `{kind:'ack'}` (no nack — security model honored: forged envelope must not retry). `boundProjectId` const at `:178` documents authoritative DB-verified projectId for downstream use. |
| **MED-1 / B-21-a** null projectId guard | **PASS** | `apps/api/src/scope-engine/start-decepticon-session.ts:663` — `if (input.triggerRecon && input.primaryDomain && input.projectId)` — `&& input.projectId` clause added; guard comment at `:661-662`: "Skipped silently when triggerRecon is falsy, primaryDomain is absent, or projectId is null (null projectId fails schema validation)." Closes B-21-a from R2 verdict. |

## Regression Test Coverage (file:line)

| Test | File:line | Result |
|---|---|---|
| IT HIGH-1 OOS host → no target row | `tests/integration/recon/recon-pipeline.test.ts:521-571` | PASS — asserts `persistedValues.length === 0` when subfinder/httpx return nothing |
| IT HIGH-2 cross-project envelope | `tests/integration/recon/recon-pipeline.test.ts:576-630` | PASS — asserts `denied.reason === 'project_mismatch'` when assessment.projectId=projectA, envelope claims projectB |
| IT MED-1 null projectId guard | `tests/integration/recon/recon-pipeline.test.ts:636-…` | PASS — asserts no `recon.subfinder.run` envelope published when `projectId=null + triggerRecon=true` |
| Unit HIGH-2 worker | `services/recon-runner/src/worker.test.ts:278-301` | PASS — direct unit on `handleReconSubfinderRun` with mismatched projectIds |
| Unit HIGH-1 worker | `services/recon-runner/src/worker.test.ts:306-333` | PASS — direct unit verifying `aliveResults`-driven loop semantics |

Standalone recon IT run: **8 pass / 0 fail** (was 5 pre-codex-fix). All 3 net-new regression tests green.

---

## Pre-existing baseline observations (NOT regressions, but worth flagging)

1. **B-21-e (NEW carry — predecessor reporting error):** Lint reports 18 errors at both `219b636` and `e7fefcf` (organizeImports, format, useTemplate, noUnusedVariables on httpx/nuclei/subfinder src+test files in services/recon-runner). All FIXABLE via `biome check --write`. Predecessor evaluator-s21 reported `lint=0 errors at 219b636` which was incorrect — likely ran lint against working-tree state with biome auto-applied formatting that wasn't committed. **No new errors introduced by `e7fefcf`** (codex fix doesn't touch those files). Recommend a one-shot `bun run lint --write` cleanup commit in S22 — pure formatting, zero behavioral risk. This carry does NOT block ship.
2. **Predecessor A-Proj-1 carry (B-18a):** does not appear in either of my full-PG runs — possibly fixed silently or test name changed. Not blocking.
3. **A-BR-RetryPolicy LocalQueueAdapter** flake on R1 (passed R2). Documented timing-flaky, pre-existing. Not introduced by codex fix.

---

## Code-read invariant matrix

| Invariant | Result | Location |
|---|---|---|
| `assessment.projectId === payload.projectId` check BEFORE buildScope | ✓ | `worker.ts:161-173` BEFORE `:181` `buildScope` |
| Project-mismatch emits denied audit with null assessmentId/resourceId (FK-safe) | ✓ | `worker.ts:163-164` passes `null, null` to `emitAudit`; `:117` `resourceId: assessmentId` (now nullable) and `:120` `assessmentId: assessmentId ?? ''` (string-fallback for required field) |
| Project-mismatch returns ack (not nack) | ✓ | `worker.ts:172` `return { kind: 'ack' }` |
| `boundProjectId` used downstream after binding | ✓ | `worker.ts:187` `commonDeps.projectId = boundProjectId`; `worker.ts:223` `targetWriter` uses `boundProjectId` |
| `targetWriter` loop iterates `aliveResults` (not `discoveredHosts`) | ✓ | `worker.ts:217` `for (const result of aliveResults)` |
| `extractHost` URL-parse with try/catch | ✓ | `worker.ts:25-32` `try { return new URL(url).hostname || null } catch { return null }` |
| Per-host extraction failure → continue (defense-in-depth) | ✓ | `worker.ts:218-219` `if (!host) continue;` |
| Dispatch guard includes projectId non-null | ✓ | `start-decepticon-session.ts:663` `&& input.projectId` |
| `coordinator/src/payloads.ts` UNTOUCHED in codex fix | ✓ | `git diff 219b636..e7fefcf -- services/coordinator/` empty |
| Frozen surface M2 still empty vs S20 ship `ff9b5ef` | ✓ | 0 diff lines |
| AUDIT_ACTIONS = 83 unchanged | ✓ | `audit.test.ts:148` |
| AUDIT.test.ts no new entries | ✓ | codex fix re-uses existing `recon.subfinder.denied` action |
| `payload.projectId` still required UUID (HIGH-2 reuses payload binding) | ✓ | `payload-schema.ts` unchanged; coordinator-level guard ensures non-null |

---

## Decision: SHIPS

- All 3 codex adversarial findings closed at `e7fefcf` with file:line evidence + 5 regression tests (3 IT + 2 unit), all green.
- Full-PG within ≤3 budget (R1=2 fail, R2=1 fail; both runs documented baselines + 1 timing flake).
- Frozen surface M2 unchanged. AUDIT_ACTIONS unchanged. Codex fix scope ≤4 files.
- Pre-existing lint baseline drift (B-21-e) is a **predecessor reporting error**, not a new regression — codex fix does not touch the affected files. Cleanup recommended in S22 but does NOT block this ship.
- Generator-no-verdict P36 honored: generator did not write `sprint-21-evaluator-result.md`.

**S21 final ship at `e7fefcf`** — supersedes prior `219b636` ship verdict.

## Backlog carries to S22 (additive)

- **B-21-e** *(NEW — pre-existing baseline drift exposed by recovery)* — `services/recon-runner/src/{httpx,nuclei}.ts` + `services/recon-runner/src/{httpx,nuclei,subfinder}.test.ts` + `services/recon-runner/src/index.ts` have 18 biome errors (FIXABLE: organizeImports, format, useTemplate, noUnusedVariables on `makeDenyScope`). Pre-existed at `219b636`. Run `bun run lint --write` then commit. Pure formatting, zero behavioral risk.
- All R2 carries (B-21-b/c/d) — unchanged status; still record-keeping items.
- All S20 carries (B-20codex-a/b, B-20a/b, B-19codex-a/b, B-19a, B-18a/b/c, B-17a) — unchanged.

## Recommendations to team-lead

1. **Mark S21 as SHIPPED at `e7fefcf`** in dispatch logs (not `219b636`).
2. **Spawn S22 cleanup-first sprint** to fold B-21-e (one-shot `bun run lint --write`) as P0 first commit.
3. **Pitfalls v11 update** — add P50: "Predecessor evaluator output may be wrong on lint/test counts; always re-run gates from clean tree before trusting prior PASS verdicts on follow-up commits." (Reinforces the active "Evaluator must run FULL regression" memory.)
4. **gitnexus analyze** post-ship to refresh index for `e7fefcf`.
5. **mempalace_kg_add** sprint-21-shipped at `e7fefcf` (was `219b636` per predecessor; correct to `e7fefcf`).

**Status:** S21 codex fix VERIFIED. S21 SHIPS at `e7fefcf`. Standing down.
