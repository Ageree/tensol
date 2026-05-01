# Sprint 20 — Implementation Summary

**Generator:** generator-s20 (Sonnet 4.6)
**Date:** 2026-05-01
**Base commit:** `737ba11` (S19 CLOSED)

---

## Gate summary (self-report — R0)

| Gate | Result |
|---|---|
| `bun run lint` | **0 errors** (482 files via biome) |
| `bun run typecheck` | **0 errors** (`tsc -b` silent exit) |
| `bun test --no-database` | **1102 pass / 0 fail / 400 skip** (≥1097 baseline) |
| `rce-pipeline.test.ts` PG (P45 pre-flight) | **5 pass / 0 fail** |
| Full-PG R3 single | **1358 pass / 1 fail / 19 skip** |
| AUDIT_ACTIONS.length | **73** (69 + 4 = 73) |
| ENVELOPE_KINDS.length | **10** (9 + 1 = 10) |
| RBAC_MATRIX.size | **1575** UNCHANGED |
| B6 rollback K | **9** UNCHANGED |
| rce-validator.ts coverage | **100% line coverage** |

**Full-PG 1 fail — pre-existing S11 baseline:**
- `integration :: findings + evidence API (Sprint 11) > PATCH /findings/:id/status — auditor cannot change status (403)` — carried since S15, unchanged.

---

## Files changed

**New files:**
- `services/validator-worker/src/rce-validator.ts` — RCE OOB-confirmation validator
- `services/validator-worker/src/rce-validator.test.ts` — 5 unit test paths (100% coverage)
- `tests/integration/validator/rce-pipeline.test.ts` — 5 IT paths (P45 PG-validated)

**Modified files:**
- `services/validator-worker/src/worker.ts` — `rceHttpClient` dep + `handleRceReplay`
- `services/validator-worker/src/payload-schema.ts` — additive `validateRceReplayPayloadSchema`
- `services/validator-worker/src/index.ts` — export `handleRceReplay` + schema/type
- `apps/api/src/scope-engine/start-decepticon-session.ts` — RCE envelope dispatch with OOB token
- `packages/contracts/src/audit.ts` — 4 new `validator.rce.*` actions (69→73)
- `packages/contracts/src/audit.test.ts` — cardinality test bumped to 73
- `packages/contracts/src/queue-envelope.ts` — `validator.rce.replay` kind (9→10)
- `packages/contracts/src/queue-envelope.test.ts` — cardinality test bumped to 10
- `packages/queue/src/types.ts` — parity bump (9→10)
- `packages/queue/src/index.test.ts` — parity test bumped to 10
- `packages/decepticon-adapter/src/types.ts` — additive `'rce'` in CANDIDATE_TYPES

---

## All codex lessons baked in (no round 2 needed)

| Lesson | Location | Verification |
|---|---|---|
| HIGH-1: cross-asmt BEFORE buildScope | `worker.ts handleRceReplay` step 4 before step 6 | IT path 4 asserts callCount===0 + assessment_mismatch audit |
| HIGH-2: OOB token in outbound URL | `start-decepticon-session.ts` RCE block + `rce-validator.ts` receives token-embedded affectedUrl | IT path 1 asserts `calledUrls[0]` contains token |
| MED-2: config_error on missing deps | `worker.ts` step 2: `!deps.rceHttpClient \|\| !deps.oobCallbackLoader` | Unit test path 5 exercises via worker dep check |
| Null-scope: worker audit+ack, no validator | `worker.ts` step 6 BEFORE validateRceCandidate call | M1 audit ownership table in contract |
| Fetch error terminal audit | `rce-validator.ts` try/catch on httpClient.get | Unit test path 4 + IT path 5: fetch_failed audit + ack |

---

## H4 pre-flight grep (RBAC frozen)

`grep -rn "'xss_reflected'\|'ssrf'\|'lfi'" packages/authz tests/integration/auth apps/api/src/routes`

Result: **empty** — no type-enumeration sites in authz/routes that need `'rce'` added. RBAC_MATRIX stays 1575 unchanged.

---

## P45 compliance

Ran `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/validator/rce-pipeline.test.ts` before SendMessage with SHA. Result: **5 pass / 0 fail**.
