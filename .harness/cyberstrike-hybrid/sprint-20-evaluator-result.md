# Sprint 20 — Evaluator Verdict

**Evaluator:** evaluator-s20 (Opus 4.7, isolated context)
**Generator:** generator-s20 (Sonnet 4.6)
**Date:** 2026-05-01
**Commit under review:** `ee77b8a` (`feat(sprint-20): RCE validator with OOB-augmented shell payload confirmation`)
**Trajectory:** `ee77b8a` (R0 single-commit ship — no fix rounds needed)
**Base:** `737ba11` (S19 CLOSED)
**Verdict:** **PASS — within ≤3 flake budget. S20 SHIPS. Phase 6 FINAL — CLOSED.**

---

## Headline (FULL-suite per P40, R3 single PG run, no path filter)

| Gate | Result | Bench |
|---|---|---|
| `bun run lint` | **0 errors** (482 files via biome, 201ms) ✓ | 0 |
| `bun run typecheck` | **0 errors** (`tsc -b` silent exit) ✓ | 0 |
| `bun test --no-database` | **1102 pass / 0 fail / 400 skip** (1502 tests across 177 files, 1.39s) ✓ matches generator self-report | 0 fail |
| Full-PG (R3 single, 50.90s) | **1357 pass / 2 fail / 19 skip** (1378 tests across 177 files, 22701 expects) | ≤3 |
| Full-PG (R3 rerun, 50.69s) | **1357 / 2 / 19** (identical, baselines stable, **no new flakes**) | ≤3 |
| AUDIT_ACTIONS.length | **73** ✓ (69 base + 4 RCE) | 73 |
| ENVELOPE_KINDS.length | **10** ✓ (`validator.rce.replay` added; queue-envelope.test + queue/index.test parity) | 10 |
| RBAC_MATRIX.size | **1575** ✓ UNCHANGED (no new resource) | 1575 |
| B6 reports rollback K | **9** ✓ UNCHANGED (no new migration) | 9 |
| Frozen-surface M2 vs `737ba11` | **EMPTY** ✓ (`packages/scope-engine packages/reports services/report-builder services/coordinator/src/payloads.ts packages/browser-auth packages/browser-driver` → 0 diff lines) | empty |
| `decepticon-adapter` additive (M2 exception) | exactly `+ 'rce',` single line ✓ | additive |

**The 2 PG fails — both pre-existing baselines (identical to S19 ship verdict):**
1. ✓ `integration :: projects routes (A-Proj-1..6 + IDOR-2) > A-Proj-1 — list returns own-tenant projects only + pagination` — **B-18a SF1 carry from S18+S19**.
2. ✓ `integration :: findings + evidence API (Sprint 11) > PATCH /findings/:id/status — auditor cannot change status (403)` — **S11 documented baseline** (carried since S15 through S19).

Both reproduce identically across R3 single + rerun. **Net-new failures introduced by `ee77b8a`: 0.** Within ≤3 budget.

Test-count delta vs S19 ship `737ba11`: 1347→1357 pass / 1368→1378 tests = exactly **+10 new tests** (5 unit RCE + 5 IT RCE), all green. Matches contract scope.

---

## §7 Verification Matrix (A-20-*) — all green

| ID | Status | Evidence (file:line) |
|---|---|---|
| A-20-RceValidator | **PASS** | `services/validator-worker/src/rce-validator.ts:84` `validateRceCandidate` exported; `:37` `scope: EffectiveScope` (non-null, M1); `:91-95` `decide()` BEFORE network egress; `:97-103` engine-deny path emits `validator.rce.replay_denied` and returns `out_of_scope` (validator owns engine-deny audit per M1); `:107-115` try/catch wrapping `httpClient.get` → `validator.rce.fetch_failed` audit + `fetch_failed` terminal status (S19 MED-1 lesson baked in); `:118-131` OOB poll loop (500ms interval, `oobVerifyTimeoutMs ?? 10_000`) mirroring SSRF :110-124; `:122-127` confirmed audit + return; `:134-138` unmatched audit + return; **does NOT insert finding** (M2). 100% line coverage. |
| A-20-RceWorkerWiring | **PASS** | `services/validator-worker/src/worker.ts:865` `handleRceReplay` exported; `:180` `rceHttpClient?: { get(url: string): Promise<void>; readonly callCount: number }` dep added; `:882` `if (!deps.rceHttpClient \|\| !deps.oobCallbackLoader)` — config_error audit + nack `ScopeDenyError('rce_config_error', ['rce_deps_not_configured'])`; `:916` `'rce_candidate_not_found'` nack on null candidate or `type !== 'rce'`; `:920-940` cross-assessment binding `if (candidate.assessmentId !== payload.assessmentId \|\| candidate.tenantId !== payload.tenantId)` → audit `validator.rce.replay_denied` reason:`assessment_mismatch` + ack-no-retry — **BEFORE** buildScope at `:954`; `:955-973` worker emits `validator.rce.replay_denied` reason:`no_scope` + terminal ack on null buildScope (M1 ownership — validator NOT called); `:975-993` validator invocation; `:995-1018` findingsWriter on `confirmed` with `type:'rce'`, `severity:'critical'`, `confidence:'high'`, `reproduction:{ token, affectedUrl }` (token-embedded URL preserved); `affectedUrl: candidate.affectedUrl` for finding record (DB origin), `payload.affectedUrl` for the fetch (token-embedded). M2 — worker owns finding insertion. 100% line coverage. |
| A-20-RceCoordinatorDispatch | **PASS** | `apps/api/src/scope-engine/start-decepticon-session.ts:539` `if (candidate.type === 'rce')`; `:543` `rceToken = ${candidateFindingId}.${input.tenantId}.${randomHex8}` — same format as SSRF; `:544-546` token embedded in `affectedUrl` via `_cs_token=` query param (S18 HIGH-2 lesson — appended via `?` or `&` per existing query string presence); `:552` `kind: 'validator.rce.replay'`; `:553` idempotencyKey suffix `:rce:${candidateFindingId}`; `:563` `candidateType: 'rce'`; `:564-565` `affectedUrl: rceReplayUrl, token: rceToken`; `:569` `queueAdapter.publish(rceEnvelope)`. **`services/coordinator/src/payloads.ts` diff vs `737ba11` = empty ✓** (M2 frozen). |
| A-20-RcePayloadSchema | **PASS** | `services/validator-worker/src/payload-schema.ts:59` additive `validateRceReplayPayloadSchema`; `:65` `candidateType: z.literal('rce')`; `:66` `affectedUrl: z.string().url()` (mirror SSRF, intentional vs LFI); `:72` `ValidateRceReplayPayload` type export. Existing exports unchanged. |
| A-20-AuditActions | **PASS** | `packages/contracts/src/audit.ts:129-132` 4 new entries (`replay_denied`/`confirmed`/`unmatched`/`fetch_failed`); `audit.test.ts:137` `expect(AUDIT_ACTIONS.length).toBe(73)` cardinality green. |
| A-20-EnvelopeKind | **PASS** | `packages/contracts/src/queue-envelope.ts:37` `'validator.rce.replay'`; `queue-envelope.test.ts:18,20` `toBe(10)`; `packages/queue/src/types.ts:42` + `packages/queue/src/index.test.ts:27,29` parity bumped. |
| A-20-RbacMatrix | **PASS** | `packages/authz/src/matrix.test.ts:11-12` `toBe(1575)` UNCHANGED. H4 pre-flight grep `'xss_reflected'\|'ssrf'\|'lfi'` on `packages/authz tests/integration/auth apps/api/src/routes` → **empty** (no type-enumeration sites need updating; baseline still holds at `ee77b8a`). |
| A-20-NoMigration | **PASS** | `git diff 737ba11..ee77b8a -- packages/db/migrations/` empty. `tests/integration/db/migrations.test.ts` rollback K still 9. `schema-shape.test.ts` clean in PG run. |
| A-20-CandidateTypes | **PASS** | `packages/decepticon-adapter/src/types.ts:75` `+'rce',` single-line additive (authorized M2 exception, mirrors S19 `+'lfi'` precedent); zod schema auto-extends; schema-shape tests green. |
| A-20-UnitTests | **PASS** | `services/validator-worker/src/rce-validator.test.ts` covers all 5 required paths (scope-deny, OOB-confirmed, unmatched timeout, fetch-error fetch_failed terminal, cross-assessment via worker test). rce-validator.ts at **100% line coverage**. |
| A-20-IT | **PASS** | `tests/integration/validator/rce-pipeline.test.ts` 5 paths (happy/deny/unmatched/cross-asmt/fetch_error). P27 `grep -c resetAuthState` = **3** (≥2 ✓). **HIGH-2 regression** (S18) — happy path `:217` asserts `httpClient.callCount === 1` and `:220` `expect(httpClient.calledUrls[0]).toContain(rceToken)` (token-in-outbound-URL). **HIGH-1 regression** (S18+S19) — cross-asmt path `:625` `callCount === 0`, `:644` `reason === 'assessment_mismatch'`. **MED regression** (S19) — fetch_failed path `:784` asserts `validator.rce.fetch_failed` audit row. All 5 IT cases green in PG R3 single + rerun. |
| A-20-LintTC | **PASS** | both 0 errors. |
| A-20-Tests | **PASS-within-budget** | no-DB 1102/0/400 (matches generator self-report exactly). PG R3 single = 1357/2/19 → rerun = 1357/2/19 identical, both baselines documented carries. Within ≤3 budget. |
| A-20-P36Compliance | **PASS** | generator-s20 wrote `sprint-20-implementation-summary.md` only; no impostor `sprint-20-evaluator-result.md` at handoff. This file is the first to use that name (written by Opus evaluator). |

---

## Pre-baked codex lessons — all 5 verified at first commit (no codex round needed)

The strict R0 enforcement requirement was that all 5 pre-baked codex lessons be present in the FIRST commit (so the codex round becomes a no-op). All five are verified:

| # | Lesson | Source | File:line evidence |
|---|---|---|---|
| 1 | Cross-assessment binding BEFORE buildScope | S18 + S19 codex HIGH-1 | `worker.ts:920-940` (check) precedes `:954` (buildScope). Audit `validator.rce.replay_denied` reason:`assessment_mismatch`. IT path 4 asserts callCount===0, no finding, audit row exists. |
| 2 | OOB token embedded in URL via `_cs_token=` | S18 HIGH-2 | `start-decepticon-session.ts:544-546` `${candidate.affectedUrl}?\|&_cs_token=${rceToken}`. IT happy path `:220` asserts `expect(httpClient.calledUrls[0]).toContain(rceToken)`. |
| 3 | Required deps no-silent-fallback → config_error | S18 MED-2 | `worker.ts:882-905` `if (!deps.rceHttpClient \|\| !deps.oobCallbackLoader)` — emit `validation.inconclusive` audit + nack `ScopeDenyError('rce_config_error', ['rce_deps_not_configured'])`. NO silent fallback for `rceHttpClient`/`oobCallbackLoader`/`candidateLoader`/`assessmentLoader` (loader nulls also nack). |
| 4 | Null buildScope → worker emits + ack, validator NOT called | S18 P2 | `worker.ts:954-973` `if (!scope) { ... emit reason:'no_scope' ... return ack }` BEFORE the `validateRceCandidate` invocation at `:975`. M1 ownership: validator never sees null scope (`rce-validator.ts:37` types it as non-null `EffectiveScope`). |
| 5 | Fetch error → fetch_failed audit + terminal ack | S19 MED-1 | `rce-validator.ts:107-115` try/catch wrapping `deps.httpClient.get()` → audit `validator.rce.fetch_failed` + return `{ status: 'fetch_failed', reason }`. IT path 5 asserts `result.kind === 'ack'` (terminal — not nack/retry) + audit row. |

**All 5 lessons baked-in v1. The codex review round becomes a no-op for these patterns** (this is by design — S20 was specifically architected to absorb the S18+S19 codex findings up-front).

---

## Code-read invariant matrix (independent verification)

| Invariant | Result | Location |
|---|---|---|
| AUDIT_ACTIONS = 73 | ✓ | `audit.ts:129-132` 4 new entries appended; cardinality test `audit.test.ts:137` |
| ENVELOPE_KINDS = 10 | ✓ | `validator.rce.replay` in both contracts + queue parity |
| RBAC_MATRIX = 1575 | ✓ | UNCHANGED; matrix test math `7×15×15` (no role/resource/action delta) |
| Frozen surfaces M2 | ✓ | `git diff 737ba11..ee77b8a -- packages/scope-engine packages/reports services/report-builder services/coordinator/src/payloads.ts packages/browser-auth packages/browser-driver` → 0 lines |
| Decepticon-adapter additive (M2 exception) | ✓ | `git diff 737ba11..ee77b8a -- packages/decepticon-adapter` = exactly `+ 'rce',` (single-line additive in `CANDIDATE_TYPES`, zod schema-shape preserved) |
| Scope gate BEFORE network egress (S13 lesson) | ✓ | `rce-validator.ts:91-103` decide() returns first; `:108` httpClient.get only on allow |
| `kind:'http_request'` for RCE replay | ✓ | `rce-validator.ts:93` |
| Cross-assessment check BEFORE buildScope | ✓ | `worker.ts:920` (check) precedes `:954` (buildScope) — symmetric to SSRF :553/584 and LFI :756/788 |
| OOB token embedded in dispatch URL via `_cs_token=` | ✓ | `start-decepticon-session.ts:544-546` |
| MED-2 (S18 lesson): config_error audit + nack on missing deps | ✓ | `worker.ts:882-905` |
| Null-scope: worker emits + ack (M1) | ✓ | `worker.ts:954-973` reason:`no_scope` BEFORE validator call |
| Fetch error → fetch_failed audit + terminal | ✓ | `rce-validator.ts:107-115` (mirror SSRF :100-108 + LFI :119-127) |
| RCE finding severity = `'critical'` | ✓ | `worker.ts:1002` |
| `payload.affectedUrl` used for fetch (token-embedded) | ✓ | `worker.ts:981` |
| `candidate.affectedUrl` used for finding record | ✓ | `worker.ts:1004` |
| `reproduction: { token, affectedUrl }` jsonb shape | ✓ | `worker.ts:1005` |
| coordinator/payloads.ts UNTOUCHED | ✓ | `git diff` empty |
| `decryptCredential` NOT in apps/api | ✓ | grep empty (S15 invariant carried) |
| P27 grep ≥2 per new IT | ✓ | rce-pipeline.test.ts = 3 |
| validator + worker 100% line coverage | ✓ | rce-validator.ts 100/100, worker.ts 100/100 in PG run |

All security invariants intact. Frozen surfaces clean (with single authorized M2 exception).

---

## Authorized M2 exception (decepticon-adapter additive — `+'rce'`)

S20 required adding `'rce'` to `packages/decepticon-adapter/src/types.ts:75` (`CANDIDATE_TYPES` tuple). Without this, `if (candidate.type === 'rce')` at `start-decepticon-session.ts:539` would be dead code (TS narrowing → TS2367) — RCE envelopes would never publish in production.

**Authorization rationale:**
- Single-line additive change to a string-literal tuple (zod schema auto-extends).
- Preserves engine logic of decepticon-adapter unchanged (no behavioral diff).
- Mirrors the S19 `'lfi'` precedent (which itself mirrored the S18 baseline pattern of `'ssrf'`).

**Verification:** `git diff 737ba11..ee77b8a -- packages/decepticon-adapter` returns exactly `+ 'rce',` — no other lines, no test changes, no schema breakage. Schema-shape tests pass.

---

## Frozen-surface M2 vs `737ba11` — clean

`git diff --stat 737ba11..ee77b8a` scope (16 files, 1836+/4-):
- `.harness/cyberstrike-hybrid/sprint-20-{contract,implementation-summary}.md` (2 files, harness contracts — not code)
- `apps/api/src/scope-engine/start-decepticon-session.ts` (+36 RCE dispatch — A-20-RceCoordinatorDispatch authorized)
- `packages/contracts/src/audit.ts` + test (+5 / +9 — AUDIT cardinality 69→73)
- `packages/contracts/src/queue-envelope.ts` + test (+2 / +3 — ENVELOPE_KINDS 9→10)
- `packages/decepticon-adapter/src/types.ts` (+1 line `'rce',` — authorized M2 exception, mirror S19 precedent)
- `packages/queue/src/{types,index.test}.ts` (+2 / +3 — parity bump)
- `services/validator-worker/src/{index,payload-schema,rce-validator,rce-validator.test,worker}.ts` (RCE new files + worker handler)
- `tests/integration/validator/rce-pipeline.test.ts` (NEW IT file with 5 paths)

`git diff 737ba11..ee77b8a -- packages/scope-engine packages/reports services/report-builder services/coordinator/src/payloads.ts packages/browser-auth packages/browser-driver` → **0 lines** (all locked surfaces clean).

---

## Trajectory — single-commit ship (no fix rounds)

| Stage | SHA | Verdict | Notes |
|---|---|---|---|
| Contract phase r1 | `sprint-20-contract.md` v1 | **APPROVE** | All 5 pre-baked codex lessons explicit at correct file:line locations; 4 soft notes (non-blocking, generator addressed inline). Zero REVISE rounds for contract. |
| R0 (impl) | `ee77b8a` | **PASS** | lint 0 + tsc 0; no-DB 1102/0/400 (+5 vs S19 baseline 1097); full-PG R3 single 1357/2/19 stable across rerun, both fails are documented carries. All 13 A-20-* PASS. All 5 codex lessons baked in v1. |

**Zero fix rounds. Zero contract REVISE rounds. Single-commit ship.** This is the cleanest sprint trajectory yet — by design, S20 was architected to absorb every S18+S19 codex lesson up-front, eliminating the need for follow-up fix rounds.

---

## P45 compliance — generator PG-validated new IT before ready trigger

Generator self-reported PG-validating `tests/integration/validator/rce-pipeline.test.ts` BEFORE the SendMessage with SHA (`5/0/0` subset PG). My full-PG verification confirms all 5 IT paths pass within the suite-mode run (suite-level 1357/2/19 stable across runs). **P45 compliance verified — no IT-only column-read or seed-isolation surprises** (the failure mode that hit S19 R1 is absent here).

---

## P40 compliance — single PG run, no path filter

Both PG runs invoked `bun test` with NO path filter. Full suite ran end-to-end (177 files, 1378 tests, 50.69-50.90s). No subset filtering, no early-exit short-circuit.

---

## Soft findings (CARRY to S21, not blockers)

**SF-20a — Validator naming consistency.**
`rce-validator.ts:34` documents `affectedUrl` as "Token-embedded URL" but the contract design rationale also discusses the candidate's raw `affectedUrl` from DB. Naming `replayUrl` (mirror SSRF input field) might be clearer for future readers. Soft B-20a candidate (rename `RceValidatorInput.affectedUrl` → `replayUrl` to match SSRF symmetry — single search-replace, no behavior change). Not ship-blocking.

**SF-20b — RCE poll loop default timeout reuses SSRF default.**
`rce-validator.ts:88` `oobVerifyTimeoutMs ?? 10_000` — same default as SSRF. Reasonable, but RCE shell execution may have different latency profile than SSRF redirect callbacks. Worth a future tunable per validator type. Soft B-20b carry.

**SF-20c — SSRF fetch_failed coverage gap (S19 carry).**
`ssrf-validator.ts:102-106` still at 93.15% line coverage (the codex MED-2 fetch_failed branch). LFI mirror is fully covered, RCE mirror is fully covered, but SSRF lacks a dedicated unit test. Recommend S21 backlog **B-19codex-a** (1 SSRF unit test mirroring lfi-validator.test.ts:323-362).

**SF-20d — Pre-existing carries from S17/S18/S19.**
- B-19codex-b — SSRF cross-assessment IT path clone into ssrf-pipeline.test.ts.
- B-19a — comment at `packages/audit/src/writer.ts:82` explaining `outcome+metadata` nested in `after_state` jsonb.
- B-18a — projects.test.ts suite-mode isolation flake (re-confirmed in S20 PG runs).
- B-18b — oob-receiver socket-mock unit tests (`http-listener.ts` + `dns-listener.ts` at 0%/4.85% line coverage).
- B-18c — factory.ts / roles.ts coverage cleanup.
- B-17a — four-step rollback test for mig 020.

**No SF rises to P1/P2 ship-blocker level.**

---

## Process notes

- **Contract phase: 1 round** (APPROVE r1 — no REVISE needed). Soft notes documented in contract-review diary entry; generator addressed all in v1 implementation.
- **Implementation phase: 1 round** (R0 PASS — no fix rounds, no narrow exception rounds). Cleanest sprint trajectory of the Phase 6 program.
- **R3 PG discipline:** ONE PG run + ONE rerun for flake confirm. 1357/2/19 stable across both runs. DB schema reset between runs to ensure clean migration ordering.
- **P36 generator-no-verdict held.** No impostor `sprint-20-evaluator-result.md` at handoff. Catalog hold.
- **P40 enforced** — both PG runs invoked `bun test` with NO path filter.
- **P44 explicit-SendMessage handoff held** — generator SendMessages with SHA at the ready transition; I did not poll on file presence.
- **P45 enforced** — generator PG-validated `rce-pipeline.test.ts` before "ready for review" trigger; my full-suite verification confirms zero new flakes.
- **All 13 acceptance criteria** PASS.
- **All 5 pre-baked codex lessons** verified at first commit (no follow-up codex round needed for these patterns).

---

## Decision

**PASS — S20 SHIPS at `ee77b8a`. Phase 6 FINAL — CLOSED.**

All gates green:
- lint 0/482 ✓
- tsc 0 ✓
- no-DB 1102/0/400 (+5 vs S19 baseline) ✓
- full-PG 1357/2/19 (R3 single + rerun stable, both fails documented carries) within ≤3 budget ✓
- All 13 A-20-* criteria PASS
- All 5 pre-baked codex lessons baked into first commit (cross-asmt, token-embed, no-silent-fallback, no_scope, fetch_failed)
- Frozen surfaces M2 clean (decepticon-adapter `+'rce'` additive authorized)
- AUDIT_ACTIONS / ENVELOPE_KINDS / RBAC_MATRIX cardinality verified
- B6 K=9 unchanged (no new migration)
- HIGH-1 / HIGH-2 / MED-1 / MED-2 / null-scope / scope-gate-first / payload-shape / unmatched-audit-shape / RBAC-grep all S18+S19-lesson invariants honored
- Validator + worker 100% line coverage

**Phase 6 sprint 3 (FINAL) — RCE validator with OOB-augmented shell payload confirmation — SHIPPED.**

Recommend team-lead next steps:
1. **Codex review + adversarial-review** post-ship per Phase-3+4+6 mandate. Both run with base `737ba11`. **Expected behavior:** zero P1/P2 findings on the 5 baked-in codex lessons (cross-asmt, token-embed, no-silent-fallback, no_scope, fetch_failed). If P3+ carry-class findings emerge → S21 backlog. If any P1/P2 emerges, follow-up commit on top of `ee77b8a`.
2. **`npx gitnexus analyze`** to refresh the index over `ee77b8a`.
3. **`mempalace_kg_add`** tagged `cyberstrike-hybrid` drawer `sprint-20-shipped` (final SHA `ee77b8a`, baseline `737ba11`).
4. **TeamDelete cyberstrike-sprint-20 agents** before S21 PD-stack spawn.
5. **Phase 6 FINAL — close out.** Phase 6 program (S18 SSRF + S19 LFI + S20 RCE) has now shipped 3 OOB-augmented validators with full S13/S18/S19 codex-lesson assimilation. Begin Phase 7 / Phase 4 (PD-stack) per the Phase-3+4+6 master plan.

Standing down. ★★★★★

---

## S20 backlog carries (to S21)

- **B-20a** — Rename `RceValidatorInput.affectedUrl` → `replayUrl` for SSRF symmetry (single search-replace, no behavior change).
- **B-20b** — Per-validator OOB poll timeout tunables (currently SSRF + RCE share 10s default).
- **B-19codex-a** — SSRF fetch_failed unit test (ssrf-validator.ts :102-106 at 93.15% line cov).
- **B-19codex-b** — SSRF cross-assessment IT path clone into ssrf-pipeline.test.ts.
- **B-19a** — comment at `packages/audit/src/writer.ts:82` explaining `outcome+metadata` nested in `after_state` jsonb.
- **B-18a** — projects.test.ts suite-mode isolation flake (re-confirmed in S20 PG).
- **B-18b** — oob-receiver socket-mock unit tests (`http-listener.ts` + `dns-listener.ts` at 0%/4.85% line cov).
- **B-18c** — factory.ts / roles.ts coverage cleanup.
- **B-17a** — four-step rollback test for mig 020.

---

## Test artifacts retained

- `/tmp/s20-pg-r1.err` — full PG R3 single (50.90s, 1357/2/19, only baselines).
- `/tmp/s20-pg-rerun.err` — full PG rerun (50.69s, 1357/2/19 identical).
- `/tmp/s20-nodb.err` — no-DB run (1102/0/400, 1502 tests, 1.39s).

---
---

# Codex Fix Ship-Confirm — Re-verifier: evaluator-s20 (Opus 4.7, isolated context, codex follow-up)

**Date:** 2026-05-01
**HEAD under review:** `ff9b5ef` (`fix(sprint-20): codex (regular + adversarial) — RCE token placement + poll-failure isolation`)
**Trajectory atop prior PASS:** `ee77b8a` → `ff9b5ef` (single codex follow-up commit)
**Base for frozen-surface check:** `737ba11` (S19 ship)
**Verdict:** **PASS — S20 SHIPS at `ff9b5ef`** (supersedes prior `ee77b8a` ship verdict)

---

## Headline (FULL-suite per P40, no path filter)

| Gate | Result | Bench |
|---|---|---|
| `bun run lint` | **0 errors** (483 files via biome, 199ms) ✓ | 0 |
| `bun run typecheck` | **0 errors** (`tsc -b` silent exit) ✓ | 0 |
| `bun test --no-database` | **1103 pass / 0 fail / 404 skip** (1507 tests, 178 files, 1.42s) ✓ matches generator self-report | 0 fail |
| Full-PG (R3 single, 47.48s) | **1360 pass / 2 fail / 19 skip** (1381 tests, 178 files) | ≤3 |
| Full-PG (R3 rerun, 47.69s) | **1361 pass / 1 fail / 19 skip** (1381 tests, 178 files) — B-18a transient, S11 baseline persists | ≤3 |
| AUDIT_ACTIONS.length | **73** ✓ UNCHANGED (`oob_lookup_error` + `token_placeholder_missing` are metadata reasons on existing `replay_denied`, not new actions) | 73 |
| ENVELOPE_KINDS.length | **10** ✓ UNCHANGED | 10 |
| RBAC_MATRIX.size | **1575** ✓ UNCHANGED | 1575 |
| B6 reports rollback K | **9** ✓ UNCHANGED (no migration) | 9 |
| Frozen-surface M2 vs `737ba11` | **EMPTY** ✓ on locked surfaces (decepticon-adapter `+'rce'` carry from prior PASS unchanged; no codex-fix touched these) | empty |

**The PG fails — both pre-existing baselines:**
1. ✓ `integration :: projects routes (A-Proj-1..6 + IDOR-2) > A-Proj-1` — **B-18a SF1 carry** (transient suite-mode flake; passed on rerun).
2. ✓ `integration :: findings + evidence API (Sprint 11) > PATCH /findings/:id/status — auditor cannot change status (403)` — **S11 documented baseline** (carried since S15).

**Net new failures introduced by `ff9b5ef`: 0.** Within ≤3 budget. The R3-single→rerun transition (1360/2/19 → 1361/1/19) is exactly the B-18a flake that has carried since S18 — it is non-deterministic, confirmed unrelated to the codex fix scope (which touches zero project-route code).

Test-count delta vs prior PASS `ee77b8a`: 1357→1361 pass / 1378→1381 tests = exactly **+3 net new tests** (1 unit `oob_lookup_error` + 2 IT `rce-token-placement.test.ts`), all green, exactly matching the codex fix scope.

---

## §7 Codex Fix Verification Matrix — file:line evidence

| ID | Severity | Status | Evidence |
|---|---|---|---|
| HIGH-1 (RCE token placement — sibling `_cs_token=` cannot reach shell) | HIGH | **PASS** | `apps/api/src/scope-engine/start-decepticon-session.ts:544-595` `if (candidate.type === 'rce')` block; `:545` `if (!candidate.affectedUrl.includes('<TOKEN>'))` reject-on-missing; `:550` audit emit `'validator.rce.replay_denied'`; `:562` `metadata: { reason: 'token_placeholder_missing', affectedUrl }`; `:565` `continue` (skip envelope publish — fail-closed); `:571` `candidate.affectedUrl.replaceAll('<TOKEN>', rceToken)` placeholder substitution. **Critical security property:** the shell command on the target reads the literal `affectedUrl`, NOT surrounding query params — sibling `_cs_token=` would never reach the OOB receiver. The codex finding correctly identified this as a HIGH/P1 (the prior `ee77b8a` design was structurally broken for the RCE class and would have produced no OOB callbacks in production). |
| HIGH-2 (token-in-URL regression test updated) | HIGH | **PASS** | `tests/integration/decepticon/rce-token-placement.test.ts:359` `expect(publishedUrl).not.toContain('<TOKEN>')` (substitution verified at envelope publish); `:240` `expect(deniedAfter?.reason).toBe('token_placeholder_missing')` (reject path); `tests/integration/validator/rce-pipeline.test.ts:175,193,231-232` `oobQueriedTokens` tracking + `expect(oobQueriedTokens[0]).toBe(rceToken)` (OOB receiver observes the exact token — proves end-to-end token-flow). |
| MED-1 (OOB poll failure — re-execution risk) | MED | **PASS** | `services/validator-worker/src/rce-validator.ts:54` `RceValidationStatus` gains `'inconclusive'`; `:127-138` while-loop body wraps `oobCallbackLoader(input.token)` in try/catch; `:132` audit emit `'validator.rce.replay_denied'`; `:133` `metadata: { reason: 'oob_lookup_error' }`; `:137` returns `{ status: 'inconclusive', reason: 'oob_lookup_error' }` (terminal — NO retry, NO re-execution of shell payload). **Critical security property:** if the OOB store is unavailable mid-poll, retry would re-fire the shell command on the target — codex correctly flagged this. The fix returns terminal `inconclusive` so the worker acks and never re-queues. |
| MED-2 (worker handles `inconclusive` → terminal ack) | MED | **PASS** | `services/validator-worker/src/worker.ts` — `handleRceReplay` only invokes `findingsWriter` on `result.status === 'confirmed'` (worker.ts:995); `inconclusive` falls through to `return { kind: 'ack' }` at the end of the handler. No nack, no re-queue, no shell re-execution. Validator's terminal `inconclusive` is honored. Mapping at `worker.ts:186` confirms `inconclusive: 'validation.inconclusive'` audit action exists for downstream auditing if ever needed. |

### New tests verified

| Test | Location | Result |
|---|---|---|
| Unit — oobCallbackLoader throw → callCount===1 + replay_denied audit reason:`oob_lookup_error` | `services/validator-worker/src/rce-validator.test.ts:332-337` | green ✓ |
| IT — RCE candidate without `<TOKEN>` → reject + audit | `tests/integration/decepticon/rce-token-placement.test.ts:126-241` | green ✓ |
| IT — RCE candidate with `<TOKEN>` → substitute + envelope published | `tests/integration/decepticon/rce-token-placement.test.ts:243-360` | green ✓ |
| IT — happy-path oobQueriedTokens assertion (codex follow-up) | `tests/integration/validator/rce-pipeline.test.ts:175,193,231-232` | green ✓ |

P27 `grep -c resetAuthState tests/integration/decepticon/rce-token-placement.test.ts` = **3** (≥2 ✓).

---

## Frozen-surface M2 vs `737ba11` — clean

`git diff ee77b8a..ff9b5ef --stat` scope (6 files, 463+/7-):
- `apps/api/src/scope-engine/start-decepticon-session.ts` (+33 — RCE token placement HIGH/P1)
- `services/validator-worker/src/rce-validator.{ts,test.ts}` (+22/+32 — try/catch + new unit test 6)
- `services/validator-worker/src/worker.ts` (+5 — inconclusive handling)
- `tests/integration/decepticon/rce-token-placement.test.ts` (NEW IT file +364 lines)
- `tests/integration/validator/rce-pipeline.test.ts` (+14/-7 — oobQueriedTokens + reproduction.affectedUrl token check)

`git diff ee77b8a..ff9b5ef -- packages/scope-engine packages/reports services/report-builder services/coordinator/src/payloads.ts packages/browser-auth packages/browser-driver packages/decepticon-adapter packages/contracts/src` → **0 lines** (all locked surfaces clean — codex fix is purely additive on top of v1's wiring).

`git diff 737ba11..ff9b5ef -- packages/decepticon-adapter`:
```
+ 'rce',
```
Single-line additive carry from prior PASS `ee77b8a` — unchanged in `ff9b5ef`. **No behavioral diff in `ff9b5ef` over `ee77b8a` for this surface.**

---

## Code-read invariants (re-verified independently after codex fix)

| Invariant | Result |
|---|---|
| AUDIT_ACTIONS.length === 73 | ✓ UNCHANGED (codex used metadata reasons, not new action names — correct design choice) |
| ENVELOPE_KINDS.length === 10 | ✓ UNCHANGED |
| RBAC_MATRIX.size === 1575 | ✓ UNCHANGED |
| `<TOKEN>` placeholder substitution at coordinator | ✓ `start-decepticon-session.ts:571` `replaceAll('<TOKEN>', rceToken)` |
| Reject-on-missing `<TOKEN>` (fail-closed) | ✓ `start-decepticon-session.ts:545,565` `if (!includes) ... continue` (skip envelope publish entirely) |
| `token_placeholder_missing` audit at coordinator | ✓ `start-decepticon-session.ts:550-563` |
| `oobCallbackLoader` wrapped in try/catch | ✓ `rce-validator.ts:127-138` |
| `oob_lookup_error` → terminal `inconclusive` (no retry) | ✓ `rce-validator.ts:137` `{ status: 'inconclusive', reason: 'oob_lookup_error' }` |
| Worker acks on `inconclusive` (no nack/re-queue) | ✓ `worker.ts:995` only inserts on `'confirmed'`; default fall-through to `ack` |
| All 5 prior-PASS codex lessons still honored (cross-asmt, token-embed, no-silent-fallback, no_scope, fetch_failed) | ✓ Re-verified at unchanged file:line locations |
| Validator + worker line coverage | ✓ rce-validator.ts at 100% (per coverage table in PG run); worker.ts at 100% |

All security invariants intact. No regression on any A-20-* criterion. The codex fix tightens the security envelope on a class of failures that v1 didn't anticipate (specifically: shell-payload-vs-query-string semantics + OOB-store-availability mid-poll).

---

## Why codex caught what the v1 design + my v1 review missed

**HIGH/P1 — Token placement in shell command vs query string.**
v1 used `_cs_token=${rceToken}` as a sibling query parameter, mirroring SSRF/LFI exactly. For SSRF (server-side fetch) and LFI (server reads file path from URL), the server-side code reads the full URL including query params. For RCE, the shell command on the target is the literal text **inside** `?cmd=$(...)` — the OS shell never sees the surrounding `&_cs_token=...`. The token was being embedded at the wrong layer. Codex correctly flagged this as a **structural design flaw, not a fix-up** — without the placeholder pattern, RCE confirmation could never work in production. My v1 review approved the symmetric pattern from SSRF/LFI without modeling the shell-execution layer; codex caught it. Lesson worth preserving for any future shell-payload validators.

**MED/P2 — Re-execution risk on OOB poll failure.**
v1 had no try/catch around `oobCallbackLoader`. If the OOB store became unavailable mid-poll, the worker would nack → queue would retry → coordinator would resend → shell would re-fire on the target. RCE shell payloads have side effects (often non-idempotent — file writes, network calls, logs). Codex caught this. The fix returns terminal `inconclusive` so retry is impossible — the side effect happens at most once.

Both are real security tightenings, not just cleanup. Worth folding into pitfalls catalog as **P46 (shell-payload token-placement layer)** and **P47 (side-effect-bearing payloads must terminal-ack on store failure)**.

---

## Soft findings (CARRY — not ship-blocking)

**SF-20codex-1 — Inconclusive audit reason name.**
The codex fix audits `validator.rce.replay_denied` with `metadata.reason: 'oob_lookup_error'`. Functionally correct, but `replay_denied` semantically suggests scope-engine denial — `oob_lookup_error` is a system error, not a denial. Future readers may find the action/reason mismatch confusing. Possible refinement: `validator.rce.replay_denied reason:'oob_store_error'` (more accurate noun) OR introduce dedicated `validator.rce.inconclusive` action. Both are deferred — current fix is correct enough to ship. **B-20codex-a candidate.**

**SF-20codex-2 — Decepticon-adapter `<TOKEN>` requirement undocumented.**
The contract between decepticon and coordinator now requires RCE candidates' `affectedUrl` to embed `<TOKEN>`. This is enforced via the reject-on-missing audit, but no static type-level check (zod schema doesn't enforce). Future RCE candidate generators could silently produce non-bearing URLs. Defer to S21+. **B-20codex-b candidate.**

**SF-20codex-3 — Pre-existing carries from prior PASS** (B-19codex-a, B-19codex-b, B-19a, B-18a/b/c, B-17a, B-20a, B-20b) — all unchanged.

Neither SF rises above SF — production code is correct + complete, all 13 A-20-* criteria still PASS, the codex follow-up commit is itself bug-free per the new unit + IT tests + the full-PG suite.

---

## Decision

**PASS — S20 SHIPS at `ff9b5ef`** (supersedes the `ee77b8a` ship verdict from prior PASS section above). Phase 6 FINAL — CLOSED.

All gates green:
- lint 0 / tsc 0 / no-DB 1103/0/404 / full-PG 1360-2-19 (R3 single) → 1361-1-19 (rerun, B-18a transient flake — only documented carries)
- AUDIT_ACTIONS / ENVELOPE_KINDS / RBAC_MATRIX cardinality UNCHANGED (codex used metadata reasons — design-correct)
- All 4 codex blockers (HIGH/P1 token placement, HIGH/P2 substitution test, MED/P1 OOB poll isolation, MED/P2 worker inconclusive handling) verified at file:line with audit-action + ack-no-retry + reject-on-missing semantics
- Frozen surfaces M2 still clean
- Validator + worker line coverage 100%
- All prior 13 A-20-* criteria still PASS
- All 5 v1 baked-in codex lessons still honored

**S20 final SHA: `ff9b5ef`** (post-codex). Phase 6 sprint 3 (FINAL) — RCE validator with OOB-augmented shell payload confirmation + codex regular + adversarial fixes — **CLOSED**.

Recommend team-lead next steps:
1. `npx gitnexus analyze` to refresh index over `ff9b5ef`.
2. `mempalace_kg_add` cyberstrike-hybrid drawer `sprint-20-shipped-final` SHA `ff9b5ef`, baseline `737ba11`.
3. **Fold P46+P47 into pitfalls catalog v10** (shell-payload token-placement + side-effect-bearing payloads must terminal-ack on store failure).
4. **Fold SF-20codex-1/2 into S21 backlog** as B-20codex-a/b.
5. TeamDelete cyberstrike-sprint-20 before S21 spawn.
6. **Phase 6 FINAL CLOSED** — S18 SSRF + S19 LFI + S20 RCE all shipped with full S13/S18/S19/S20 codex-lesson assimilation. Begin Phase 4/7 PD-stack per master plan.

Standing down. ★★★★★

---

## Test artifacts retained (Codex Fix Ship-Confirm)

- `/tmp/s20codex-nodb.err` — no-DB run (1103/0/404, 1507 tests, 1.42s).
- `/tmp/s20codex-pg-r1.err` — full-PG R3 single (47.48s, 1360/2/19, only baselines).
- `/tmp/s20codex-pg-rerun.err` — full-PG rerun (47.69s, 1361/1/19, B-18a transient confirmed).
