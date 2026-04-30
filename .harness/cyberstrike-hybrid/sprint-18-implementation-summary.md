# Sprint 18 — Implementation Summary

## Deliverables

### A — services/oob-receiver (NEW package)
- `src/token.ts` — `parseToken()` / `extractTokenFromPath()` for `<candidateUUID>.<tenantUUID>.<random8hex>` format
- `src/redact.ts` — `redactHeaders()` strips Authorization + Cookie values
- `src/http-listener.ts` — `startHttpListener()` via `Bun.serve`, port 0 capable (P39), healthz endpoint
- `src/dns-listener.ts` — `startDnsListener()` via `node:dgram` UDP, always NXDOMAIN responses
- `src/index.ts` — exports all + `name = 'services/oob-receiver'` (workspace-names invariant)
- Unit tests: `http-listener.test.ts`, `dns-listener.test.ts`

### B — SSRF replay validator
- `services/validator-worker/src/ssrf-validator.ts` — `validateSsrfCandidate()` with scope gate BEFORE any network egress (S13 per-candidate lesson)
- `services/validator-worker/src/ssrf-validator.test.ts` — 3 unit tests: deny/confirmed/timeout paths
- `ValidatorWorkerDeps` extended: `oobCallbackLoader?`, `oobVerifyTimeoutMs?`, `ssrfHttpClient?`
- `handleSsrfReplay` exported from worker + index

### C — Migration 021_oob_callbacks
- Append-only table (2 triggers: DELETE stmt + TRUNCATE — no UPDATE trigger, rows never mutate)
- No FK on tenant_id / candidate_id (receiver runs at network edge per contract R2)
- `COMMENT ON COLUMN oob_callbacks.headers` added for B23b compliance
- `dropAllTables` fixture updated to include `oob_callbacks`

### D — AUDIT_ACTIONS 61→64 (+3)
- `validator.ssrf.replay_denied`, `validator.ssrf.confirmed`, `validator.ssrf.timeout`

### E — ENVELOPE_KINDS 7→8
- `validator.ssrf.replay` added to both `packages/contracts` AND `packages/queue/src/types.ts`

### F — RBAC_MATRIX 1470→1575
- `oob_callback` added to `RESOURCES` (15th entry)
- All 7 role files touched; auditor auto-gets `read+list` via `buildAuditorSpec()` loop
- `allows` count: 256→262 (+6: platform_admin×2 + security_lead×2 + auditor×2)

### G — Tests
- Unit: `ssrf-validator.test.ts` (3 cases), `http-listener.test.ts`, `dns-listener.test.ts`
- IT: `tests/integration/validator/ssrf-pipeline.test.ts` (happy path + deny path, P39 ephemeral port, P27 resetAuthState ×2)
- `tests/integration/db/append-only.test.ts`: B14+B14b for oob_callbacks DELETE+TRUNCATE guards
- `tests/integration/db/migrations.test.ts`: B6 for migration 021, all B6 rollback offsets bumped +1 for new latest migration

### H — B6 rollback loop K=8→9 (P33+P38)
- B5 reports rollback loop: 8→9 steps
- All B6 sub-tests that popped N migrations now pop N+1 (021 is new latest)
- Confirmed only 1 rollback loop existed (P38)

### I — B23 schema-shape clean
- No bytea columns in oob_callbacks (contract §C2 B23 exemption not needed)

## Test Results (pre-commit)
- **lint**: 0 errors ✓
- **typecheck**: 0 errors (tsc -b clean) ✓
- **no-DB**: 1074 pass / 0 fail ✓
- **full-PG**: 1319 pass / 2 fail (both pre-existing: findings-api auditor 403 + browser retry-transient) ✓ (≤3 threshold)

## Key Fixes During Implementation
- `queue/src/types.ts` lacked `'validator.ssrf.replay'` — added alongside `contracts/queue-envelope.ts`
- `c.nullable()` not a Kysely column builder method — columns are nullable by default, removed callback
- Scope stubs in unit tests used wrong shape (`rules:[]` + wrong platformPolicy) — replaced with `buildEffectiveScope()` + correct `rawRules` format
- DNS stub resolving to `127.0.0.1` (loopback) triggered platformIpGuard — switched to `203.0.113.42` (TEST-NET-3 public)
- `dropAllTables` missing `oob_callbacks` — dirty DB state after failed migration run; fixed
- All B6 rollback tests needed `+1` migration pop since 021 is now latest
