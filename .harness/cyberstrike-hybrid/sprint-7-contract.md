# Sprint 7 Contract — Queue + `assessment.start` Envelope (v2)

> **Author:** Generator (cyberstrike-sprint-7)
> **Sprint:** 7 — `packages/queue` + `services/coordinator` + API enqueue wiring
> **Source spec:** `.harness/cyberstrike-hybrid/product-spec.md` lines 344-373
> **Baseline:** HEAD `9f5a732` + Sprint 6 working-tree (scope-engine landed, pure, 1477 symbols indexed)
> **Mandate:** PRAGMATIC SHIP. Single-iter target. Re-use Sprint 6 patterns. No over-engineering.
>
> **Revision history**
> - **v2 (2026-04-29):** Evaluator R1-R3 folded in.
>   - **R1** crash-recovery probe extended — adds truncated-JSONL case (file half-written mid-line; assert no parse-error crash, DB row claimed exactly once, no dupe row). See A-Q-Local-6 + `crash-recovery-truncated-file.test.ts`.
>   - **R2** new A-Q-Concurrent-1 criterion + `concurrent-subscribers.test.ts` — two `subscribe()` loops on same DB+baseDir, N=20 envelopes, sum-of-handler-invocations === 20 with zero dupes (proves SKIP LOCKED as file-lock substitute per OQ-1).
>   - **R3** A-Q-Local-5 (notBefore) promoted to two-part probe — (a) handler-not-invoked-while-future, (b) handler-invoked-once-after-clock-passes; tested against the SQL `WHERE (not_before IS NULL OR not_before <= NOW())` predicate, not just engine clock injection.
>   - **Inline notes** added on A-Q-Env-1 (per-kind payload validation at handler boundary, not at envelope boundary) and A-Q-Audit-2 (allow-path emits NO additional coordinator audit; only `assessment.started` from the route — no per-target child-publish drip).

---

## 1. Goal

Land the **minimum viable** in-process queue plumbing the spec asks for:

1. `packages/queue` — `QueueAdapter` interface + `LocalQueueAdapter` (file-FIFO under `./.queue-local/`) + Zod-validated envelope + retry classifier + `jobs`-table mirror.
2. `services/coordinator` — subscribes `assessment.start`, scope-validates each declared target via the existing scope-engine, deny → `failed_terminal` audit, success → publishes per-target `recon.browser.placeholder` child jobs (no-op consumer acks).
3. `apps/api` `POST /assessments/:id/start` — atomically transition `approved → running` AND insert a row into `jobs` (outbox pattern) in a single DB tx; the coordinator polls/drains visible rows.

**Not delivered (carry-forward to later sprints):** Decepticon adapter (S8), real recon workers (S9), validators (S10), findings UI (S11), report builder (S12), Redis-backed adapter, LLM gateway integration, distributed lock managers.

---

## 2. Hard invariants (carry from prior sprints — non-negotiable)

1. **Scope-first.** Coordinator MUST call `decide()` from `@cyberstrike/scope-engine` for every declared target before publishing any child job. Any deny → `failed_terminal`, audit `scope.validate.denied` (reuse Sprint 6 emission point), assessment moved to `failed`.
2. **Tenant isolation.** Envelope carries `tenantId`; every `jobs` row carries `tenant_id`; `subscribe()` MUST scope-filter rows it claims by tenant when a tenant filter is supplied. A T1 publish MUST NOT be deliverable to a T2 subscriber. Tested.
3. **Idempotency.** `jobs` table has `UNIQUE (tenant_id, idempotency_key)` (already in migration 006). Re-publishing the same envelope (crash recovery, replay) MUST NOT create duplicate rows — adapter catches the unique-violation and treats it as success-of-prior-publish.
4. **Append-only audit.** No UPDATE/DELETE on audit_events. `scope.validate.denied` and `assessment.started` rows persist verbatim.
5. **Auditability.** Every state-changing decision (start enqueue, scope-deny terminal, success transition) emits exactly one audit row.
6. **Cost caps never block.** Out of scope.
7. **Outbox.** Start route's DB tx writes BOTH `assessments.state='running'` AND the `jobs` row in the SAME transaction. If either fails, both roll back; the engine state never drifts from queue state.

---

## 3. Carry-forwards from prior sprints (locked in)

| #    | Carry-forward                                                                                                                                          | Where it lands  |
|------|---------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------|
| CF-1 | `denyAudit`/`audit()` is the canonical helper. Sprint 7 reuses for `scope.validate.denied` (coordinator path) and a NEW `assessment.failed` action.    | A-Q-Audit-1     |
| CF-2 | C29 delta=1 — every state-changing action emits exactly one audit row. Coordinator's terminal-failure path emits exactly one `scope.validate.denied`.  | A-Q-Audit-2     |
| CF-3 | JSONB pitfall (Sprint 5 F5) — every `jobs.payload` insert MUST `JSON.stringify(envelope)` wrap. Engine envelope is structured; serialize at boundary.  | A-Q-DB-1        |
| CF-4 | Scope-engine purity preserved — coordinator imports `decide()`, `nodeDnsResolver`, etc. — but the engine package itself stays I/O-free.                | A-Q-Pure-1      |
| CF-5 | Test fixture isolation (Sprint 5 F1) — IT tests use `uniqSlug(base)` per-tenant. Sprint 7 IT lives in `tests/integration/queue/`.                       | §9              |
| CF-6 | DB.Database type already has `jobs: JobsTable` (Sprint 2 migration 006 + Sprint 5 schema wiring). NO new migration needed.                              | A-Q-DB-2        |
| CF-7 | RBAC — `start` action grant on `assessment` already exists (Sprint 5 §5.4). No matrix changes.                                                          | (no change)     |

---

## 4. Files / dirs touched (allowlist)

Generator may add or modify files under:

- `packages/queue/src/` — fill the existing scaffold:
  - `envelope.ts` — Zod schema for `JobEnvelope`; `parseEnvelope(raw)`.
  - `retry-classifier.ts` — `classifyError(err) → 'transient' | 'terminal'`; `nextDelayMs(attempt, baseMs?, capMs?)` exponential backoff with jitter.
  - `types.ts` — public `QueueAdapter` interface, `JobEnvelope` type, `EnvelopeKind` enum, `PublishResult`, `SubscribeOptions`.
  - `local-adapter.ts` — `LocalQueueAdapter` file-FIFO; atomic publish via tmp + `fs.rename`; subscribe loop reads JSONL lines, claims via DB `UPDATE … RETURNING` + file marker; ack/nack updates DB row + appends marker.
  - `db-adapter.ts` — `DbBackedAdapter` thin wrapper that handles `jobs` table mirror inserts/updates (used internally by `LocalQueueAdapter`).
  - `index.ts` — public re-exports.
  - `*.test.ts` — co-located unit tests (envelope, classifier, local adapter unit-only with tmp dirs).
  - `package.json` — add deps: `zod`, `@cyberstrike/db`, `@cyberstrike/contracts`, `kysely`.
- `services/coordinator/src/`:
  - `index.ts` — `createCoordinator(deps) → { start(), stop() }`; subscribes `assessment.start`.
  - `start-handler.ts` — `handleAssessmentStart(deps, env) → Promise<HandlerResult>`; loads assessment, calls `decide()` per target, branches deny/allow.
  - `child-job.ts` — `publishReconChildJobs(adapter, envelope, normalizedTargets)` — per-target child envelopes of `kind='recon.browser.placeholder'`.
  - `placeholder-consumer.ts` — `subscribeReconPlaceholder(adapter)` — no-op handler that immediately acks (Sprint 9 will replace).
  - `*.test.ts` — co-located unit tests with mocked adapter.
  - `package.json` — deps: `@cyberstrike/queue`, `@cyberstrike/scope-engine`, `@cyberstrike/db`, `@cyberstrike/audit`, `@cyberstrike/contracts`, `kysely`.
- `apps/api/src/routes/assessments/assessments.ts` — modify `handleStartAssessment`:
  - The transition update + audit emission is now wrapped in a `db.transaction().execute(async tx => …)` block; inside the tx, also insert the `assessment.start` envelope row into `jobs` (outbox).
  - On transaction failure, no state change, no audit, no enqueue (atomicity).
  - Resolve `Sprint 7: enqueue assessment.start envelope here` placeholder comment with real call.
- `apps/api/src/routes/assessments/jobs.ts` — **new** read-only `GET /api/v1/assessments/:id/jobs` route handler, returns the `jobs` rows for the assessment (RBAC: same as timeline read; tenant-isolated).
- `apps/api/src/routes/register-routes.ts` — wire the new GET route.
- `packages/contracts/src/queue-envelope.ts` — **new** Zod schema mirror (alias of `packages/queue` envelope; shared so API can validate). Exported via `index.ts`.
- `packages/contracts/src/audit.ts` — **modify** `AUDIT_ACTIONS`: add `'assessment.failed'` if not already present (used when coordinator marks terminal-failed). Re-use `'scope.validate.denied'` for the deny path.
- `tests/integration/queue/` — **new** suite. Required test files:
  - `publish-consume.test.ts` — happy path: publish → subscribe → ack; row goes pending → running → succeeded.
  - `tenant-isolation.test.ts` — T1 publish, T2 subscribe with tenant filter, MUST NOT deliver.
  - `idempotency.test.ts` — duplicate publish (same idempotencyKey) → second insert raises unique-violation → adapter swallows (no dupe row, no dupe consume).
  - `scope-deny-start.test.ts` — start an assessment whose declared target is in deny scope → coordinator marks job `failed_terminal`, assessment → `failed`, audit row written.
  - `start-outbox.test.ts` — `POST /assessments/:id/start` returns 200, asserts BOTH state=running AND `jobs` row inserted in same tx (rollback simulated by injecting tx-fault → no state change).
  - `crash-recovery.test.ts` — case A (file-write-failure-injection): DB row exists, file write throws → next subscribe pass still claims the DB row (DB canonical).
  - `crash-recovery-truncated-file.test.ts` (**R1**) — case B (file half-written): write the JSONL row fully, then `fs.truncate(filepath, lastLineByteOffset+10)` to corrupt mid-line. Restart subscribe loop. Assert: (i) parse errors do NOT crash the loop, (ii) the canonical DB row is still claimed exactly once, (iii) no second jobs row is inserted, (iv) the corrupted line is logged + skipped.
  - `concurrent-subscribers.test.ts` (**R2**) — spin up two `LocalQueueAdapter.subscribe()` loops on the same DB+baseDir. Publish N=20 envelopes. Both handlers share a `Map<jobId, count>`. Assert: every jobId has count===1, total invocations===20, zero duplicates. Proves SKIP LOCKED is the file-lock substitute (per OQ-1).
  - `not-before.test.ts` (**R3**) — publish one envelope with `notBefore = now() + 1s`. Run subscribe loop for 500ms with batchSize=10. Assert: (a) row status remains `pending`, handler was NOT invoked. Then advance fake clock past `notBefore` (or sleep), re-poll. Assert: (b) row transitions `pending → running → succeeded`, handler invoked exactly once. Tests the SQL `WHERE (not_before IS NULL OR not_before <= NOW())` predicate explicitly.

Generator **must not** touch:

- `.omx/plans/*`, `PROJECT-SPECS-*`, `STACK-*`, `.harness/cyberstrike-hybrid/product-spec.md` (read-only).
- Sprint 1-5 migrations (frozen). Sprint 6 scope-engine package (engine.ts, decide.ts, normalize/* — read-only consumption).
- Sprints 1-4 routes, auth, audit-events. Sprint 5 projects/targets/assessments routes EXCEPT `handleStartAssessment` (allowlisted change; gitnexus_impact must run before edit).
- The 3 deferred LRUs (still deferred; rate-limit counter remains injected per-process from S6).
- No new external runtime deps beyond what's already in workspace (zod, kysely all present).

---

## 5. Acceptance criteria (binary, testable)

> Coverage threshold: **80%** lines on `packages/queue/src/**` and `services/coordinator/src/**`. Adapter file-IO boundary (read/write JSONL files) exempt from unit-coverage gate but exercised in IT.

### 5.1. Envelope schema

**A-Q-Env-1.** `packages/queue/src/envelope.ts` exports `jobEnvelopeSchema` (Zod). Required fields: `jobId` (uuid), `tenantId` (uuid), `assessmentId` (uuid). Optional: `projectId` (uuid|null), `notBefore` (ISO datetime). Required: `kind` (z.enum closed-set: `'assessment.start' | 'recon.browser.placeholder'`), `idempotencyKey` (string ≥1, ≤255), `createdAt` (ISO datetime), `attempt` (int ≥0), `maxAttempts` (int ≥1, ≤10), `traceId` (string ≥1), `payload` (z.unknown — opaque at envelope layer).

**Per-kind payload validation (inline note, evaluator R1-followup).** The envelope's `payload: z.unknown()` is intentional — the envelope schema is transport-layer. **Per-kind payload validation MUST happen at the consumer/handler boundary**, not at the envelope schema. Specifically:
- `assessment.start` handler validates `payload` against `assessmentStartPayloadSchema = z.object({ assessmentId: z.string().uuid(), targetIds: z.array(z.string().uuid()).min(1) })` BEFORE invoking scope-engine.
- `recon.browser.placeholder` handler validates `payload` against `reconPlaceholderPayloadSchema = z.object({ targetId: z.string().uuid(), targetUrl: z.string() })` even though it acks immediately (defence in depth; Sprint 9 will use the value).
- Handler-side schemas live in `services/coordinator/src/payloads.ts`. Handlers MUST NOT trust an opaque `payload`.

**A-Q-Env-2.** `parseEnvelope(raw): { ok: true; envelope } | { ok: false; reason }` is the single boundary; ALL publish + subscribe paths funnel through it. Malformed raw → `ok: false`, never throws.

**A-Q-Env-3.** Envelope kind enum is closed; an unknown `kind` (`'foo.bar'`) → `parseEnvelope` returns `{ok: false}`. Forward-compat: adding kinds requires a code change.

### 5.2. Retry classifier

**A-Q-Retry-1.** `classifyError(err): 'transient' | 'terminal'`:
- Transient: `Error.name` ∈ {`'NetworkError'`, `'TimeoutError'`}, OR err message matches `/ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|5\d\d/` (HTTP 5xx-shaped strings).
- Terminal: anything else, AND any error tagged `terminal: true` on the error object, AND scope-engine deny errors (instances exposing `__terminal: true` OR `name === 'ScopeDenyError'`).
- Default: `terminal` (fail-closed forward-compat).

**A-Q-Retry-2.** `nextDelayMs(attempt, baseMs=200, capMs=30_000)` — exponential `baseMs * 2^attempt` capped at `capMs`, with ±25% jitter. `attempt=0 → ~200ms`, `attempt=10 → 30_000ms` (capped).

**A-Q-Retry-3.** Terminal envelopes are NEVER retried regardless of `attempt < maxAttempts`. The retry decision is `transient AND attempt+1 < maxAttempts` ELSE terminal.

### 5.3. LocalQueueAdapter

**A-Q-Local-1.** `LocalQueueAdapter` constructor takes `{db, baseDir, clock?, randomUUID?}`. `baseDir` defaults to `./.queue-local/`. The adapter creates the dir on first use (idempotent `mkdir({recursive: true})`).

**A-Q-Local-2.** `publish(envelope)` does:
1. Validate envelope via `parseEnvelope`. Invalid → throw `EnvelopeValidationError` (terminal-classifier flagged).
2. Insert row into `jobs` (status=`pending`, payload=`JSON.stringify(envelope)` per CF-3) inside a transaction. Unique-violation on `(tenant_id, idempotency_key)` → swallow + return `{deduped: true, jobId: existingRowId}`.
3. After commit, append the envelope as a JSONL line to `${baseDir}/${kind}.queue` via tmp+`fs.rename` (atomic).
4. Return `{deduped: false, jobId}`.

**A-Q-Local-3.** `subscribe(queueName, handler, options?)` polls every `pollIntervalMs` (default 100ms in tests, configurable). Per cycle:
1. `SELECT … FROM jobs WHERE kind=$queue AND status='pending' AND (not_before IS NULL OR not_before <= NOW()) AND (tenant_id = $tenantFilter OR $tenantFilter IS NULL) ORDER BY created_at ASC LIMIT $batchSize FOR UPDATE SKIP LOCKED`. (Single-process safe; postgres FOR-UPDATE-SKIP-LOCKED is the file-lock substitute.)
2. For each claimed row: UPDATE status='running', attempt=attempt+1.
3. Invoke `handler(envelope)`; expects `{kind: 'ack'}` or `{kind: 'nack', error}`.
4. Ack → status='succeeded'.
5. Nack → `classifyError(error)`: transient + `attempt < maxAttempts` → status='pending', `not_before = now() + nextDelayMs`, `last_error=err.message`. Else status='failed_terminal'.

**A-Q-Local-4.** `ack(envelopeId)` and `nack(envelopeId, reason)` are also exposed as direct methods (used when handlers want fire-and-forget rather than the auto-ack from the subscribe loop). Direct ack/nack updates the same row state-machine as the auto path.

**A-Q-Local-5 (R3 — promoted to two-part probe).** `notBefore` honoured — the SQL claim predicate is `WHERE (not_before IS NULL OR not_before <= NOW())`. Two binary assertions:
- (a) Publish envelope with `notBefore = now() + 1s`. Run `subscribe()` loop for 500ms (batchSize=10). Assert: row status remains `pending`, handler was NOT invoked.
- (b) Advance fake clock (or sleep) past `notBefore`. Re-poll. Assert: row transitions `pending → running → succeeded`, handler invoked exactly once.

This proves the DB-side predicate, not just engine clock injection. Test in `not-before.test.ts`.

**A-Q-Local-6 (R1 — extended).** Crash recovery has two cases:
- **Case A (file-write-failure injection).** If the file write fails AFTER the DB insert, the next subscribe pass still claims the DB row (DB is canonical). Test simulates file-write failure with a `failingWrite` injection; assert the row is still claimed and processed.
- **Case B (truncated JSONL line — file half-written).** Write a complete JSONL row, then `fs.truncate(filepath, lastLineByteOffset+10)` to corrupt mid-line. Restart subscribe loop. Assert:
  1. Parse errors on the corrupted line do NOT crash the loop.
  2. The canonical DB row is still claimed exactly once via SKIP LOCKED.
  3. No second `jobs` row is inserted (no replay-as-publish).
  4. The corrupted line is logged + skipped (best-effort metadata).

Test in `crash-recovery-truncated-file.test.ts`. JSONL parser MUST be line-by-line with `try/catch` per line (never swallow loop-level exceptions; per-line error → skip + log + continue).

**A-Q-Concurrent-1 (R2 — exactly-once under two subscribers).** Two `LocalQueueAdapter.subscribe()` loops on the SAME database + `baseDir`. Publish N=20 envelopes from a third caller. Both subscribers share a `Map<jobId, count>`. Assert at end of run:
- For every jobId 1..20, count===1 (no duplicates).
- Sum of counts === 20 (no losses).
- Both subscribers contributed at least one invocation (load-balanced; not all-on-one).

This proves PostgreSQL `FOR UPDATE SKIP LOCKED` provides exactly-once delivery semantics — the file-lock substitute promised in OQ-1. Test in `concurrent-subscribers.test.ts`.

### 5.4. Coordinator

**A-Q-Coord-1.** `createCoordinator(deps) → { start(): void, stop(): Promise<void> }`. `deps`: `{adapter, db, scopeEngineDeps: {dns, clock, rateLimit}, audit, logger}`. `start()` subscribes `assessment.start` AND `recon.browser.placeholder`. `stop()` unsubscribes and awaits in-flight handlers.

**A-Q-Coord-2.** `assessment.start` handler:
1. Load assessment + scope via `loadAssessmentMeta` + `buildScopeForAssessment` (reuse Sprint 6 helpers).
2. Load all `assessment_targets` for the assessment.
3. For each target: build a `ScopeActionInput` of kind `'http_request'` (for `domain`/`url` targets) or kind matching the target type, call `decide(scope, action, scopeEngineDeps)`. Any deny → emit `scope.validate.denied` audit, mark coordinator result `denied`, break.
4. Deny → return `{kind: 'nack', terminal: true, error: ScopeDenyError(reason, matchedRuleIds)}`. Subscribe loop → status='failed_terminal'. Coordinator ALSO updates `assessments.state='failed'` in the same DB transaction. Audit `assessment.failed` with `metadata.cause='scope_deny'`, `matchedDenyRuleIds`.
5. Allow → publish per-target `recon.browser.placeholder` child envelopes, each with the same `traceId` and `tenantId`/`projectId`/`assessmentId`. Return `{kind: 'ack'}`.

**A-Q-Coord-3.** `recon.browser.placeholder` handler — no-op acks. Stub for Sprint 9 to replace. Asserts on shape in tests; nothing more.

**A-Q-Coord-4.** Trace propagation — every child envelope inherits `traceId` from the parent `assessment.start` envelope. Test asserts identity end-to-end (API request → start envelope → child envelope → DB job row trace_id).

### 5.5. API enqueue

**A-Q-Api-1.** `handleStartAssessment` (modified):
1. Existing RBAC + ownership + state-machine + temporal-window logic preserved.
2. AFTER all gates pass, open `db.transaction().execute(async tx => …)`:
   - UPDATE assessments SET state='running' WHERE id AND tenant AND version (existing optimistic lock).
   - INSERT INTO jobs (kind='assessment.start', status='pending', tenant_id, assessment_id, project_id, idempotency_key, trace_id, payload, attempt=0, max_attempts=3) — payload is `JSON.stringify(envelope)`.
   - On any tx failure → throw, caller sees 5xx, no state change, no audit.
3. AFTER tx commits, emit `assessment.started` audit (existing).
4. Return refreshed assessment.

**A-Q-Api-2.** Idempotency — the `idempotency_key` for the envelope is derived from the `Idempotency-Key` request header (already required by the `idem` middleware on the start route, Sprint 5 R6). The `(tenant_id, idempotency_key)` unique constraint on `jobs` ensures duplicate POSTs that cleared the idempotency middleware (rare race) still don't create duplicate jobs.

**A-Q-Api-3.** `GET /api/v1/assessments/:id/jobs` returns a list of `{id, kind, status, attempt, maxAttempts, createdAt, updatedAt, lastError}` for the assessment. RBAC: same as `assessment.timeline` (Sprint 5 R7) — tenant_admin, security_lead, operator, auditor, developer-on-own-project. 200 / 403 / 404 same as Sprint 5 patterns.

### 5.6. Tenant isolation

**A-Q-Tenant-1.** Publish from T1 with `tenantId=T1`, subscribe with `tenantFilter=T2` → MUST NOT deliver. Tested with two seeded tenants and asserted that T2's handler never sees the T1 envelope.

**A-Q-Tenant-2.** GET /jobs is tenant-scoped via existing `assertOwnership`. T1 cookie + T2 assessmentId → 403 + `rbac.deny` audit (CF-8 attribution to T1). Tested.

### 5.7. Idempotency

**A-Q-Idem-1.** Two `publish()` calls with the same `(tenant_id, idempotency_key)` — second returns `{deduped: true, jobId: <first row id>}`, no second row inserted, no second handler invocation in subscribe loop.

**A-Q-Idem-2.** A handler that throws transient → row goes back to pending with bumped attempt. The SAME envelope being processed again uses the same `jobId` and same `idempotency_key`; the unique constraint is satisfied. Retry is via row-state-machine, not re-publish.

### 5.8. Scope-deny terminal failure

**A-Q-Scope-1.** Fixture: create assessment with target `https://attacker.example` AND deny rule `domain: attacker.example`. POST start → 200. Coordinator processes envelope → `decide()` returns `allowed:false`. Coordinator marks job failed_terminal AND assessment state='failed' in same tx; emits `scope.validate.denied` audit (action='scope.validate.denied', metadata.matchedDenyRuleIds includes the deny rule id, metadata.cause='coordinator_pre_dispatch') AND `assessment.failed` audit. Two distinct audit rows. Tested.

**A-Q-Scope-2.** No child `recon.browser.placeholder` job is published when scope denies. Asserted by checking jobs table after coordinator processes — only the parent `assessment.start` row exists, status `failed_terminal`.

### 5.9. Audit emission

**A-Q-Audit-1.** New audit emission points for Sprint 7:
- `scope.validate.denied` — re-used from Sprint 6 (same action constant, different metadata.cause discriminator).
- `assessment.failed` — NEW, added to `AUDIT_ACTIONS`. Coordinator-emitted when a scope deny terminates. Metadata includes `{cause, matchedDenyRuleIds, jobId}`.

**A-Q-Audit-2.** C29 delta=1 holds — the start route emits exactly one `assessment.started` per successful POST; the coordinator emits exactly one `scope.validate.denied` + one `assessment.failed` per scope-deny terminal. No extras.

**Allow-path emits NO additional coordinator audit (inline note, evaluator R1-followup).** When `decide()` returns `allowed:true` for every declared target, the coordinator publishes per-target `recon.browser.placeholder` child envelopes and ack's the parent `assessment.start`. No coordinator-side audit row is emitted on the allow path — the route's `assessment.started` is the single audit record for the successful start. Per-target child publishes do NOT drip audit rows (would inflate audit volume + break C29 delta=1 invariant). Sprint 9 may add per-child-job audit at the worker boundary; Sprint 7 does not. Tested explicitly in `publish-consume.test.ts`: assert audit_events count delta === 1 (the route's `assessment.started`) for an allow-path E2E.

### 5.10. Database

**A-Q-DB-1.** No new migration. The Sprint 2 migration 006 already provides the `jobs` table with the required columns + unique constraint.

**A-Q-DB-2.** All Sprint 1-6 migrations continue to apply cleanly.

**A-Q-DB-3.** Every `jobs.payload` write is `JSON.stringify(envelope)` per CF-3. Test: insert envelope, read back, parsed JSON deep-equal to original.

### 5.11. Cumulative regression

**A-Q-Reg-1.** All Sprint 1-6 tests pass at full PG scope. `bun run lint`, `bun run typecheck`, `bun test` (no DB), `DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test` — all green. Sprint 6 baseline is the floor.

**A-Q-Reg-2.** Engine purity grep (Sprint 6 A-SE-Pure-1) still passes — `packages/scope-engine/src/**` has zero forbidden imports. Sprint 7 does NOT touch engine source.

**A-Q-Reg-3.** Path-footguns scan extended to `packages/queue/src/`, `services/coordinator/src/`, `tests/integration/queue/`. Zero hits.

---

## 6. Open questions (Evaluator to resolve)

- **OQ-1.** **Local-adapter persistence — file-FIFO vs DB-only?** Spec says "file-backed FIFO" but the DB row is the source of truth (FOR UPDATE SKIP LOCKED). Generator recommends: **file is metadata-only** (debug visibility / spec compliance); DB is canonical for claim/ack/nack. CF-3's JSONL append happens AFTER the DB insert and is best-effort. Crash mid-write doesn't cause double-delivery because the DB is canonical.
- **OQ-2.** **Coordinator process lifecycle — separate Bun process or in-API thread?** Spec calls it `services/coordinator` (separate dir suggesting separate process). Generator recommends: **importable module** that the API process can `createCoordinator(deps).start()` in dev/test, AND can be invoked as a standalone Bun script (`services/coordinator/src/main.ts`) in prod. Sprint 7 tests run in-process for simplicity.
- **OQ-3.** **`assessment.failed` action name** — Generator recommends adding to AUDIT_ACTIONS (mirrors existing `assessment.started`/`assessment.start.denied`). Alternative: re-use `scope.validate.denied`. Generator says no — distinct semantic event (state-machine-terminal vs read-only deny).
- **OQ-4.** **Child envelope idempotencyKey derivation** — `${parent.idempotencyKey}:${targetId}`. Stable + deterministic, so coordinator re-runs of the same parent envelope dedupe child publishes via the unique constraint. Recommended.
- **OQ-5.** **Subscribe poll mechanism — long-poll or NOTIFY/LISTEN?** Generator recommends **simple SELECT-loop with `pollIntervalMs`** (default 100ms in tests, 1000ms in prod). PG NOTIFY/LISTEN is a future optimization. Spec says "single-process safe"; SKIP LOCKED is sufficient.
- **OQ-6.** **`stop()` semantics** — drain in-flight or hard stop? Generator recommends: **drain** (await current handler invocations) with a configurable timeout (default 5000ms); after timeout, abort. Tests use `stop({timeoutMs: 50})` for fast teardown.
- **OQ-7.** **Coordinator → assessments tx atomicity** — when coordinator marks job failed_terminal due to scope-deny, the `assessments.state='failed'` UPDATE is in the same tx as the `jobs.status='failed_terminal'` UPDATE. Audit emissions happen AFTER tx commit (audit-write failure on deny path returns 500 per Sprint 4 ADR 0004 §4 — but coordinator can't return HTTP; instead, audit failure logs + leaves the tx committed; failures observable via metrics). Recommended.

---

## 7. Verification commands (Evaluator copy-paste)

```bash
cd "/Users/saveliy/Documents/пентест ИИ"

bun run lint
bun run typecheck

docker compose -f infra/docker/docker-compose.local.yml up -d
bun run db:migrate:check

bun test  # no DB

DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test  # full

DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test --coverage \
  packages/queue \
  services/coordinator \
  apps/api/src/routes/assessments/jobs.ts \
  tests/integration/queue

bun run check:path-footguns

# Manual probes
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/queue/scope-deny-start.test.ts
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/queue/tenant-isolation.test.ts
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/queue/idempotency.test.ts
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/queue/start-outbox.test.ts
# v2 R1-R3 probes
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/queue/crash-recovery-truncated-file.test.ts
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/queue/concurrent-subscribers.test.ts
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/queue/not-before.test.ts
```

---

## 8. Test strategy

| Layer                          | Tooling                       | Where |
|--------------------------------|-------------------------------|-------|
| Unit (envelope parse)          | `bun test`                    | `packages/queue/src/envelope.test.ts` |
| Unit (retry classifier)        | `bun test`                    | `packages/queue/src/retry-classifier.test.ts` |
| Unit (local adapter w/ tmpdir) | `bun test`                    | `packages/queue/src/local-adapter.test.ts` |
| Unit (coord start-handler)     | `bun test` w/ mocked adapter  | `services/coordinator/src/start-handler.test.ts` |
| Unit (coord placeholder)       | `bun test`                    | `services/coordinator/src/placeholder-consumer.test.ts` |
| Integration (PG)               | `bun test` w/ `DATABASE_URL`  | `tests/integration/queue/*.test.ts` |
| Cumulative regression          | full PG-backed run            | floor = Sprint 6 final count |

---

## 9. Risks & limitations (explicitly out of scope)

- **R1.** No Redis/persistent multi-process queue — file+DB hybrid is local-only. Sprint 12 / production prep may swap.
- **R2.** No back-pressure mechanism — subscribe loop pulls `batchSize` per cycle. If handlers slow, queue depth grows; surfaced via the GET /jobs endpoint.
- **R3.** Coordinator failures during processing leave the row in `running`. A future "stuck-job recovery" sweeper is out of scope; Sprint 7 documents the gap.
- **R4.** No observability/metrics surface — internal logger calls only.
- **R5.** No `paused`/`canceled`-mid-flight semantics — if assessment is paused during coordinator processing, the in-flight envelope still completes. Pause takes effect on NEXT envelope. Documented.
- **R6.** No multi-coordinator coordination — SKIP LOCKED works for many subscribers, but Sprint 7 assumes one coordinator process per API instance. Multi-instance Sprint 12+.
- **R7.** No DLQ — failed_terminal jobs stay in the table; no separate dead-letter queue. GET /jobs surfaces them.
- **R8.** No envelope schema evolution — adding new `kind` requires code change. Future migration path documented in §6 OQ-3.

---

## 10. Sliced delivery

1. **Slice 1** — `packages/queue/src/{types,envelope,retry-classifier}.ts` + unit tests. Lint+typecheck+no-DB tests pass.
2. **Slice 2** — `packages/queue/src/{db-adapter,local-adapter}.ts` + unit tests w/ tmpdir (no DB). Lint+typecheck+no-DB tests pass.
3. **Slice 3** — `services/coordinator/src/{start-handler,child-job,placeholder-consumer,index}.ts` + unit tests w/ mocked adapter. Lint+typecheck pass.
4. **Slice 4** — `apps/api/src/routes/assessments/jobs.ts` + register-routes wiring + start-route outbox tx + RBAC pass.
5. **Slice 5** — `tests/integration/queue/*.test.ts` + full PG run. Coverage gate ≥80%.
6. **Slice 6** — `sprint-7-result.md` with cumulative test count, audit emission delta, follow-ups.

Slices are advisory.

---

## 11. Workflow

1. Evaluator reviews; resolves OQ-1..7; sends revisions or approval.
2. Generator implements per slice plan. TDD throughout. **Pre-edit gitnexus_impact** on shared symbols: `handleStartAssessment`, `register-routes`, `audit()`, `JobsTable`, `AUDIT_ACTIONS`. Any HIGH/CRITICAL risk surfaces in `sprint-7-result.md`.
3. Verify: lint+typecheck+no-DB+full-PG+coverage+path-footguns all green before claiming done.
4. `gitnexus_detect_changes()` confirms only §4 allowlist scope.
5. Generator writes `sprint-7-result.md` with cumulative test count + new audit emissions.
6. PASS → codex review run. P1-only fixes applied (P2 deferred per pragmatic mandate).
7. FAIL → up to 2 Generator↔Evaluator iterations.

End of contract.
