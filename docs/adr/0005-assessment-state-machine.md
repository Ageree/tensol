# ADR 0005 — Assessment State Machine + Idempotency Cache + Approval Storage + Temporal Gate

- **Status:** Accepted (Sprint 5, 2026-04-27)
- **Supersedes:** N/A
- **Superseded by:** N/A
- **Tags:** state-machine, idempotency, approval, testing-window, temporal-gate

## Context

Sprint 5 lands the projects / targets / assessments CRUD surface and the
assessment lifecycle state machine. Three architectural choices warrant an
ADR because each is referenced by multiple Sprints' worth of forward work:

1. **Where the state graph lives.** Sprint 7's coordinator dispatches queue
   envelopes that drive the same transitions. If the API and the coordinator
   each encoded their own copy of the graph, the two would drift.
2. **What the idempotency cache stores.** A naive "cache every response"
   policy creates two security surfaces: replaying a 5xx forever after a
   transient outage clears, and replaying a 403 after a role upgrade.
3. **Where approval metadata lives.** The audit invariant requires
   reconstructing *who approved what when, with which targets and
   categories*, while the hot read path (list/summary) must avoid joining
   an append-only history table on every read.

Plus one operational rule that ADR 0005 pins so future agents don't move
it: the `testingWindow` temporal gate runs at the route layer, not inside
the state machine.

## Decision

The four load-bearing rules of Sprint 5:

1. **The state machine is a pure function in `packages/contracts`. The Sprint 7 coordinator imports the same function — there is no parallel state graph.** `apps/api/src/routes/assessments/*` and the future `services/coordinator` both call `transition(current, command)`. A CI grep test fails if any route file under `apps/api/src/routes/assessments/` contains a string literal matching `'draft'|'submitted'|'approved'|'running'|'paused'|'cancelled'|'completed'|'failed'` outside the state-machine import (the `state` JSON field name in DTOs is allow-listed).

2. **The 8-state enum from migration 004 is reused as-is. `starting`/`resuming`/`cancelling` intermediate states are deferred to Sprint 7 with the queue-dispatch work.** Adding them in Sprint 5 would silently expand the schema in a sprint nominally about CRUD, and Sprint 7 is where transient mid-flight states actually have a consumer (the coordinator dispatching a `running` enqueue, observing the engine's progress, etc.). The migration to widen the enum belongs to Sprint 7's contract.

3. **The idempotency cache only persists 2xx responses; the insert path AND the lookup path both gate on `[200, 300)`.** 4xx and 5xx responses never write a cache row, and a cached row outside `[200, 300)` (which can only land via a future code path) is treated as a miss. Defense-in-depth.
   - **No 5xx caching.** A first-call DB outage would otherwise replay 500 forever, blocking recovery once the underlying cause clears.
   - **No 4xx caching.** A first-call 403 (actor lacked permission) would otherwise return 403 from cache after a role upgrade, bypassing the post-upgrade auth re-check. The auth pipeline must be invoked on every retry that wasn't a confirmed success.

4. **`testingWindow` temporal gate fires at the route layer, AFTER `transition('approved','start')` succeeds and BEFORE the DB write commits.** The state machine stays pure (no clock dependency). The route evaluates `now` against `testingWindow.start` and `testingWindow.end`; on out-of-window the DB tx rolls back, the response is `422 testing_window_{expired,not_yet_open}`, and a separate `assessment.start.denied` audit row is emitted (`outcome='denied'`, `metadata.reason ∈ {'window_expired','window_not_yet_open'}`). The `assessment.started` audit is NOT emitted on the deny path — the action did not happen.

5. **Approval metadata is split across two surfaces. Append-only `assessment_approvals` (forensic record) + hot-path columns `approved_by` and `approved_at` on `assessments` (fast list/summary reads).** Both writes happen in the same transaction as the `state = 'approved'` UPDATE.
   - **Why a dedicated `assessment_approvals` table over `assessment_artifacts`:** `assessment_artifacts` was sized in Sprint 2 for blob refs (object_storage_key + sha256 + size_bytes per B23). Approval is metadata, not a blob. Single-purpose tables keep query cost predictable and make the append-only retention rules clearer per surface.
   - **Why hot-path columns on `assessments`:** every list / summary endpoint already reads `assessments`; joining `assessment_approvals` for `approved_at` would double the read cost. The append-only history table is for audit reconstruction, not for the read hot path.

## Consequences

**Sprint 7 inherits:**
- The same `transition()` function — no duplicate graph in the coordinator. Adding `starting/resuming/cancelling` is a contract-update + migration concern, not a "rewrite the state machine" exercise.
- The R8 temporal-gate pattern can extend to other clock-dependent transitions (e.g. enforcing `testingWindow.end` mid-run on `running → paused/completed/failed`).
- The idempotency cache pattern carries forward — the queue's outbox will reuse the `idempotency_keys` shape.

**Sprint 5 trade-offs:**
- The state machine is intentionally limited to 8 states. Coordinator code in Sprint 7 that wants finer-grained progress reporting will need either richer status fields (Path A) or the `starting/resuming/cancelling` enum widening (Path B); either is an additive change.
- The 2xx-only cache means a 5xx-then-2xx retry pattern bills the handler twice, and the second call's audit row is the canonical one. This is the correct semantics: the first call did not succeed.
- Approval forks the data into two write paths. The hot-path columns + the append-only row must always be written in the same transaction (route-level invariant); a future test or migration that drops one without the other would be a regression.

## Alternatives considered

- **Encoding the state graph in routes** (rejected). Violates single-source-of-truth — the coordinator and the API would inevitably drift.
- **Including `starting`/`resuming`/`cancelling`** (rejected this sprint). Schema churn for transient values without a consumer.
- **Caching all responses** (rejected). 5xx replay + 403-after-upgrade are real attack/operational surfaces.
- **Approval as JSONB on `assessments`** (rejected). Loses forensic history; complicates audit reconstruction.
- **Approval in `assessment_artifacts`** (rejected). Wrong shape for metadata vs blobs.
- **Temporal gate inside the state machine** (rejected). Couples a pure function to wall-clock time; breaks unit testability.

## Limitations

- **L-1.** No queue dispatch on `start` (Sprint 7).
- **L-2.** No scope-engine evaluation (Sprint 6); scope rules are stored, not enforced.
- **L-3.** No real ownership-verification flow (Phase 9). `POST /ownership-proof` accepts the claim and audits; status stays `pending` until a future admin-only endpoint flips it.
- **L-4.** No `Idempotency-Key` for non-mutating GETs.
- **L-5.** 3 deferred LRUs from Sprint 3 (TOTP-replay, pre-auth-token, rate-limit) stay deferred.

## References

- Sprint 5 contract: `.harness/cyberstrike-hybrid/sprint-5-contract.md`
- Migration 004 (assessments + assessment_scope_rules), migration 011
  (`enforce_append_only` trigger function).
- Sprint 4 ADR 0004 §Decision rules #3 (actor-tenant attribution) and #4
  (audit-write failure → 500), both inherited.
- Sprint 5 runbook: `docs/runbooks/assessment-lifecycle.md`.
