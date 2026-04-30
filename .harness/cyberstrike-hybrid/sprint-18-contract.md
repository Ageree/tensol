# Sprint 18 Contract v2 — OOB Callback Service + SSRF Replay Validator

**Generator:** generator-s18 (Sonnet 4.6)
**Phase:** 6 — Validation expansion (sprint 1)
**Base commit:** `75f9919` (S17 CLOSED)
**Baseline:** no-DB 1053/0/379, full-PG 1293/2/19, AUDIT_ACTIONS=61, ENVELOPE_KINDS=7, RBAC_MATRIX=1470
**v2 changes from evaluator REVISE r1:** R1 DISABLE TRIGGER pattern added; R2 candidate_id FK resolved as soft pointer (no FK); R3 TRUNCATE case added to append-only test; R4 deny IT asserts callCount=0; R5 all 7 role files explicitly named; R6 scope-decide http_request + DNS-via-normalizeAction clarified; R7 coordinator payloads.ts stays frozen, schema in validator-worker only; B-17a demoted to non-gating stretch section.

---

## Deliverables summary

| ID | Deliverable |
|---|---|
| A | `services/oob-receiver` — HTTP+DNS listener, OOB token binding |
| B | `services/validator-worker` SSRF validator extension |
| C | Migration `021_oob_callbacks` — table + append-only triggers |
| D | AUDIT_ACTIONS 61 → 64 (3 new `validator.ssrf.*` actions) |
| E | ENVELOPE_KINDS 7 → 8 (`validator.ssrf.replay`) |
| F | RBAC_MATRIX 1470 → 1575 (+1 resource `oob_callback`, all 7 role files updated) |
| G | Tests: unit + IT (full OOB pipeline) + resetAuthState chain extended |
| H | B6 mig rollback bump K=8→9 for mig 021 |
| I | B23 schema-shape clean (oob_callbacks uses text/jsonb/uuid, NO bytea) |

---

## Stretch goal (non-gating — not in verification matrix)

### B-17a — Four-step rollback test for mig 020

Per S17 backlog: dedicated file `tests/integration/db/mig020-rollback.test.ts` with four-step verification and `afterAll` re-applying all migrations. **Not a gate for S18 PASS verdict.** If skipped, carry to S19.

---

## Acceptance Criteria

### A-18-OobService — OOB HTTP listener

- `services/oob-receiver` package exists with `src/index.ts` (HTTP server entry) and `src/http-listener.ts`.
- Binds to `process.env.OOB_HTTP_PORT ?? 5082`.
- Accepts any HTTP method and path; logs to `oob_callbacks` table: `id` (UUID, auto), `token` (extracted from path/query param `_cs_token`), `tenant_id` (parsed from token second segment as UUID), `candidate_id` (parsed from token first segment as UUID), `kind='http'`, `method`, `path`, `headers` (jsonb — `Authorization` and `Cookie` values replaced with `'[REDACTED]'` before insert), `body` (text, truncated at 64KB), `source_ip`, `created_at`.
- Token format: `<rid>.<tenant>.<random8>` — first segment = candidate UUID, second = tenant UUID, third = 8 hex chars. On unrecognised/missing token: insert row with `token=null`, `tenant_id=null`, `candidate_id=null`.
- Health endpoint `GET /healthz` returns HTTP 200 `{"ok":true,"count":<n>}` where n = `SELECT COUNT(*) FROM oob_callbacks`.
- NOT wired to prod compose; dev/lab fixture only (analogous to S9 lab XSS fixture at port 5081).

### A-18-OobDns — OOB DNS listener

- `services/oob-receiver/src/dns-listener.ts` binds UDP `process.env.OOB_DNS_PORT ?? 5353`.
- Accepts DNS queries; logs to `oob_callbacks`: `kind='dns'`, `token` extracted from the leftmost label of `qname` if it matches token format, `qname`, `qtype`, `source_ip`, `created_at`. `tenant_id`/`candidate_id` parsed from token same as HTTP path.
- Always responds NXDOMAIN (no real resolution). Errors in DNS packet parsing → log warning and continue, do not crash the process.

### A-18-OobTable — `oob_callbacks` table

- Migration `021_oob_callbacks.ts` in `packages/db/migrations/`.
- Columns: `id uuid PK default gen_random_uuid()`, `tenant_id uuid nullable`, `candidate_id uuid nullable`, `token text nullable`, `kind text NOT NULL CHECK (kind IN ('http','dns'))`, `method text nullable`, `path text nullable`, `qname text nullable`, `qtype text nullable`, `headers jsonb nullable`, `body text nullable`, `source_ip text nullable`, `created_at timestamptz NOT NULL default now()`.
- **No FK constraints on `tenant_id` or `candidate_id`** — both are soft pointers (R2 option a). The OOB receiver runs at network edge and must not be blocked by candidate row presence. Token-based correlation is the design.
- **NO bytea columns** (B23 clean — schema-shape test passes without exempt-list changes).
- `DELETE` trigger: `oob_callbacks_no_delete_stmt` BEFORE DELETE FOR EACH STATEMENT EXECUTE FUNCTION `enforce_append_only()`.
- `TRUNCATE` trigger: `oob_callbacks_no_truncate` BEFORE TRUNCATE FOR EACH STATEMENT EXECUTE FUNCTION `enforce_append_only()`.
- (Two triggers only — no UPDATE trigger needed; rows have no updatable fields.)
- Indexes: `idx_oob_callbacks_tenant` on `(tenant_id)` WHERE `tenant_id IS NOT NULL`; `idx_oob_callbacks_token` on `(token)` WHERE `token IS NOT NULL`.

### A-18-OobTableAppendOnly — append-only invariant (DELETE + TRUNCATE)

- `tests/integration/db/append-only.test.ts` includes **two** cases for `oob_callbacks` (R3):
  1. `DELETE FROM oob_callbacks` → throws with message containing `append_only`.
  2. `TRUNCATE oob_callbacks` → throws with message containing `append_only`.
- Both cases use the existing pattern: seed a row, wrap attempt in a transaction, catch error, assert on message, rollback.

### A-18-SsrfValidator — SSRF replay validator in validator-worker

- New file `services/validator-worker/src/ssrf-validator.ts` implementing `validateSsrfCandidate(input, deps)` → `ValidationResult`.
- Input fields: `candidateFindingId`, `tenantId`, `assessmentId`, `affectedUrl`, `replayUrl` (URL with OOB token embedded), `token` (the embedded OOB token string), `scope`, `traceId`.
- **Scope gate FIRST — before any network egress.** Calls `decide(scope, { kind: 'http_request', url: replayUrl, method: 'GET' }, scopeDeps)` (R6).
  - DNS resolution of the OOB callback host is handled inside `normalizeAction` via the injected DNS resolver — the `http_request` normalizer already covers the DNS-fail-closed path (empty `resolvedIps` → `dns_resolution_failed` → deny). The SSRF validator does NOT issue a separate `dns_lookup` decide call.
  - `decision.allowed === false` → emit `validator.ssrf.replay_denied` audit via injected `AuditEmitter`; return `{ status: 'out_of_scope', reason: decision.reason, ... }`. **Zero HTTP calls made** — injected `httpClient` is never invoked.
- Replay (only reached if scope gate passes): sends HTTP GET to `replayUrl` via injected `httpClient` (no real network in tests). Any outgoing headers with `Authorization` or `Cookie` keys are REDACTED before logging.
- Verify: polls injected `oobCallbackLoader(token): Promise<boolean>` up to `oobVerifyTimeoutMs` (default 10000ms; injected for tests to pass a short value). Match found → return `{ status: 'confirmed', ... }`, emit `validator.ssrf.confirmed`. Timeout elapsed without match → return `{ status: 'inconclusive', reason: 'timeout', ... }`, emit `validator.ssrf.timeout`.

### A-18-SsrfWorkerWiring — SSRF handler in validator-worker

- `services/validator-worker/src/worker.ts` extended: `handleValidateFinding` routes on `candidateType`. When `candidateType === 'ssrf'` → delegates to `validateSsrfCandidate`. Existing `xss_reflected` path unchanged.
- New fields in exported `ValidatorWorkerDeps`: `oobCallbackLoader: (token: string) => Promise<boolean>` and `oobVerifyTimeoutMs?: number`.
- Scope gate audit for SSRF reuses existing `emitLifecycleAudit` helper and `AuditEmitter` interface — no new audit plumbing.
- `services/validator-worker/src/payload-schema.ts` gains additive export `validateSsrfReplayPayloadSchema` (Zod) for `{ tenantId, projectId, assessmentId, candidateFindingId, candidateType: z.literal('ssrf'), replayUrl, token, traceId }`. All existing exports unchanged (R7).

### A-18-SsrfCoordinatorDispatch — coordinator SSRF envelope dispatch

- `apps/api/src/scope-engine/start-decepticon-session.ts` extended: when `candidate.type === 'ssrf'`, publish a `validator.ssrf.replay` envelope in addition to `decepticon.findings`. Payload is an inline object literal (same as existing XSS dispatch pattern at line ~456): `{ tenantId, projectId, assessmentId, candidateFindingId, candidateType: 'ssrf', replayUrl: candidate.affectedUrl, token: generatedToken, traceId }`.
- Token generated at dispatch time: `${candidateFindingId}.${tenantId}.${randomHex8}` where `randomHex8` is 8 hex chars; generation via `crypto.randomBytes(4).toString('hex')` or an injected `deps.randomHex8?: () => string` test seam.
- `services/coordinator/src/payloads.ts` is **NOT modified** (M2 frozen). The SSRF payload schema for consumption lives in `services/validator-worker/src/payload-schema.ts` only (R7).
- The `xss_reflected` dispatch path is unchanged.

### A-18-AuditActions — AUDIT_ACTIONS cardinality bump 61 → 64

- `packages/contracts/src/audit.ts` AUDIT_ACTIONS gains 3 new entries at the end:
  - `'validator.ssrf.replay_denied'`
  - `'validator.ssrf.confirmed'`
  - `'validator.ssrf.timeout'`
- `packages/contracts/src/audit.test.ts`:
  - Test description updated to include `Sprint 18 SSRF validator (3)`.
  - Expected array includes all 3 under comment `// Sprint 18 — SSRF validator (3).`
  - `expect(AUDIT_ACTIONS.length).toBe(64); // Sprint 18: 61 + 3 = 64`

### A-18-EnvelopeKind — ENVELOPE_KINDS cardinality bump 7 → 8

- `packages/contracts/src/queue-envelope.ts` ENVELOPE_KINDS gains `'validator.ssrf.replay'` with comment `// Sprint 18 — validator-worker subscribes to replay SSRF candidates.`
- If a standalone `ENVELOPE_KINDS.length` assertion exists in tests, update to `toBe(8)`. Type-checking on the `kind` enum must pass.

### A-18-RbacMatrix — RBAC_MATRIX cardinality bump 1470 → 1575

- `packages/authz/src/resources.ts` RESOURCES gains `'oob_callback'` as the 15th entry.
- **All 7 role files in `packages/authz/src/matrix/` updated** with an explicit `oob_callback` key (R5):
  - `platform_admin.ts`: `oob_callback: ['read', 'list']`
  - `security_lead.ts`: `oob_callback: ['read', 'list']`
  - `auditor.ts`: `oob_callback: []`
  - `developer.ts`: `oob_callback: []`
  - `operator.ts`: `oob_callback: []`
  - `tenant_admin.ts`: `oob_callback: []`
  - `viewer.ts`: `oob_callback: []`
- `packages/authz/src/matrix.test.ts`:
  - `expect(RBAC_MATRIX.size).toBe(1575); // Sprint 18: 7 roles × 15 resources × 15 actions = 1575`
  - `expect(ROLES.length * RESOURCES.length * ACTIONS.length).toBe(1575);`

### A-18-MigRollback — B6 mig 021 rollback test

- `tests/integration/db/migrations.test.ts`: `for (let i = 0; i < 8; i++)` at line ~177 bumped to `for (let i = 0; i < 9; i++)` with math comment: `// 9 = down(021)→down(020)→down(019)→down(018)→down(017)→down(016)→down(015)→down(014)→down(013); oob_callbacks table dropped when 013 reverts.`
- P38: `rg "for.*i < [0-9].*migrateDown"` confirms only one such loop — bump applied.
- New B6 test: `'B6 — oob_callbacks table present after migration 021, absent after rollback'` — applyAllMigrations; verify table exists + `pg_trigger` shows `oob_callbacks_no_delete_stmt` and `oob_callbacks_no_truncate`; migrateDown once (021); verify table absent; applyAllMigrations re-apply.

### A-18-SchemaShape — B23 no-bytea

- `oob_callbacks` uses `text`, `jsonb`, `uuid`, `timestamptz` only. No `bytea`.
- `tests/integration/db/schema-shape.test.ts` passes without adding `oob_callbacks` to any exempt list.

### A-18-ResetAuthChain — resetAuthState extended (P3+P27, R1)

- `tests/integration/auth/helpers/auth-fixture.ts` `resetAuthState` updated in three places (R1):
  1. **DISABLE block** — `ALTER TABLE oob_callbacks DISABLE TRIGGER USER;` alongside existing append-only tables, with comment `-- Sprint 18: oob_callbacks is append-only; disable trigger before DELETE.`
  2. **DELETE block** — `DELETE FROM oob_callbacks;` placed after `DELETE FROM findings;` and before `DELETE FROM candidate_findings;` (soft pointer — no FK constraint on `candidate_id`; position is for logical ordering).
  3. **ENABLE block** — `ALTER TABLE oob_callbacks ENABLE TRIGGER USER;` alongside existing re-enables.
- Every new IT file under `tests/integration/validator/` contains `resetAuthState` called at least twice (P27: `grep -c resetAuthState <file> ≥ 2`).

### A-18-UnitTests — unit tests

- `services/oob-receiver/src/http-listener.test.ts`: token parsing (valid → segments extracted; invalid format → all null; missing → all null); header redaction (`Authorization` → `[REDACTED]`, `Cookie` → `[REDACTED]`, other headers pass through).
- `services/oob-receiver/src/dns-listener.test.ts`: leftmost-label token extraction (valid → parsed; non-token label → token=null); NXDOMAIN response emitted; malformed DNS packet → no crash, warning logged.
- `services/validator-worker/src/ssrf-validator.test.ts`:
  - (a) **Scope deny path:** `decide` returns `allowed=false` → `status='out_of_scope'` returned, `validator.ssrf.replay_denied` audit emitted, injected `httpClient.callCount === 0` (no network egress) (R4).
  - (b) **Confirmed path:** scope gate passes, `oobCallbackLoader` returns `true` → `status='confirmed'`, `validator.ssrf.confirmed` audit emitted.
  - (c) **Timeout path:** scope gate passes, `oobCallbackLoader` always returns `false` within `oobVerifyTimeoutMs` → `status='inconclusive'` with `reason='timeout'`, `validator.ssrf.timeout` audit emitted.
- Coverage ≥80% for `services/oob-receiver/src/` and new `ssrf-validator.ts` code.

### A-18-IT — integration test: full SSRF pipeline

- `tests/integration/validator/ssrf-pipeline.test.ts`.
- `resetAuthState` called in `beforeEach` AND `afterAll` (P27: `grep -c resetAuthState ssrf-pipeline.test.ts ≥ 2`).
- **Happy path:** fake decepticon emits SSRF candidate → `startDecepticonSession` dispatches `validator.ssrf.replay` envelope → validator-worker handler calls `validateSsrfCandidate` → HTTP GET to lab OOB HTTP fixture (ephemeral port) → fixture inserts `oob_callbacks` row → `oobCallbackLoader` finds row → validator confirms. Asserts: `oob_callbacks` row with correct token present; `validator.ssrf.confirmed` audit row in `audit_events`; `findings` row created with `type='ssrf'`.
- **Deny path:** replayUrl is out-of-scope → `validator.ssrf.replay_denied` audit emitted; injected `httpClient.callCount === 0` (R4 — no network egress); no `oob_callbacks` row inserted; no `findings` row inserted.
- Lab fixture is a real Bun HTTP server on an ephemeral port (port 0) — no real external DNS.

### A-18-P39Preflight — OOB receiver IT isolation (P39)

- OOB HTTP listener uses ephemeral port (port 0) per test run. Top of `ssrf-pipeline.test.ts` includes comment: `// OOB listener binds to port 0 (ephemeral) to avoid cross-test port conflicts (P39).`
- If a shared server is used across IT files, add a pre-flight assertion: two concurrent calls with distinct tokens produce two distinct rows and `oobCallbackLoader` resolves independently for each.

### A-18-LintTC — lint and typecheck clean

- `bun run lint` → 0 errors.
- `bun run typecheck` → 0 errors.

### A-18-Tests — full suite within budget

- No-DB: ≥1053 pass / 0 fail (≥ baseline).
- Full-PG (`DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`, no path filter per P40): ≤3 fail (≤3 flake budget; both documented baseline fails permitted).

### A-18-P36Compliance — generator does NOT write evaluator-result.md

- Generator writes `sprint-18-implementation-summary.md` only.
- No file named `sprint-18-evaluator-result.md` created by generator at any handoff.

---

## R# Risk notes (for evaluator)

| R | Risk | Mitigation |
|---|---|---|
| R1 | OOB DNS UDP 5353 conflicts with system resolver in CI | Behind env var; IT uses HTTP-only ephemeral-port fixture; DNS listener tested in isolation only |
| R2 | P39 — shared OOB server port conflict | Ephemeral port (port 0) per test run; P39 pre-flight comment in IT file |
| R3 | Frozen surface — coordinator start-decepticon-session.ts | Authorized in brief; only `if candidate.type === 'ssrf'` block + inline publish added; payloads.ts untouched |
| R4 | scope-decide kind wrong for SSRF | `kind: 'http_request'` confirmed; DNS of OOB host handled by normalizeAction injected resolver (S6 flow); no separate dns_lookup decide |
| R5 | P38 rollback loop stale elsewhere | rg sweep confirms only one `for.*i < [0-9].*migrateDown` loop at line 177; K bumped 8→9 |
| R6 | candidate_id FK causes DELETE ordering headache | No FK on candidate_id (option a); DELETE order is independent |
| R7 | Coordinator payloads.ts (M2 frozen) needs SSRF schema | Schema additive export in validator-worker/src/payload-schema.ts only; coordinator dispatch uses inline object literal; payloads.ts diff = empty |

---

## Verification matrix (evaluator will check)

| Gate | Method |
|---|---|
| A-18-OobService | Read + unit tests |
| A-18-OobDns | Read + unit tests |
| A-18-OobTable | Migration DDL; `\d oob_callbacks`; no FK on candidate_id/tenant_id |
| A-18-OobTableAppendOnly | append-only.test.ts: DELETE case + TRUNCATE case both present and PG-pass |
| A-18-SsrfValidator | ssrf-validator.ts scope-gate-first; dns-via-normalizeAction; 3 paths; callCount=0 on deny |
| A-18-SsrfWorkerWiring | worker.ts routing; new deps fields; payload-schema.ts additive export |
| A-18-SsrfCoordinatorDispatch | start-decepticon-session.ts SSRF block; `git diff -- services/coordinator/src/payloads.ts` = empty |
| A-18-AuditActions | AUDIT_ACTIONS.length === 64 in no-DB run |
| A-18-EnvelopeKind | ENVELOPE_KINDS.length === 8 |
| A-18-RbacMatrix | RBAC_MATRIX.size === 1575; all 7 role files touched (grep each) |
| A-18-MigRollback | i<9 math comment; new B6 oob_callbacks test; rg sweep clean |
| A-18-SchemaShape | schema-shape.test.ts passes; no bytea; no new exemptions |
| A-18-ResetAuthChain | DISABLE + DELETE + ENABLE all present; P27 ≥2 resetAuthState in IT file |
| A-18-UnitTests | 3 ssrf-validator paths; OOB receiver tests; callCount=0 on deny |
| A-18-IT | happy path confirms; deny path callCount=0 + no oob_callbacks + no findings |
| A-18-P39Preflight | Ephemeral port comment or pre-flight isolation assertion present |
| A-18-LintTC | 0/0 |
| A-18-Tests | ≥1053/0 no-DB; ≤3 PG fail (P35+P40) |
| A-18-P36Compliance | grep sprint-18-evaluator-result.md → not found in generator output |

---

## Pure-fn values (code-verified per P37)

- `AUDIT_ACTIONS.length` after S18: **64** (61 base + 3 = 64)
- `ENVELOPE_KINDS.length` after S18: **8** (7 base + 1 = 8)
- `RBAC_MATRIX.size` after S18: **1575** (7 × 15 × 15 = 1575; was 7 × 14 × 15 = 1470)
- Rollback loop K: **9** (down(021)→...→down(013) = 9 steps)
- Migration filename: `021_oob_callbacks.ts`
- Role files touched: **7** (`auditor.ts`, `developer.ts`, `operator.ts`, `platform_admin.ts`, `security_lead.ts`, `tenant_admin.ts`, `viewer.ts`)
