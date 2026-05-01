# Sprint 22 Contract — Recon-Runner Hardening [OBSOLETE]

> **STATUS: OBSOLETE — superseded by sprint-22-contract.md (cleanup sprint)**
> This file preserved for traceability per team-lead directive 2026-05-01.
> The hardening work described here was originally S22 per the on-disk contract
> written by an intermediate session, but team-lead accepted the cleanup pivot,
> making this hardening sprint moot. The 3 unfixed blockers below are carried
> as B-22-h1/h2/h3 to S23 backlog.

**Generator:** (intermediate session, pre-generator-s22)
**Phase:** 4 — PD-stack recon (Sprint 2 of phase)
**Base commit:** `219b636` (S21 R2 ship)
**Baseline:** no-DB 1103/0/404, full-PG 1391/2/19, AUDIT_ACTIONS=83, ENVELOPE_KINDS=11, RBAC_MATRIX=1575, B6 K=9

---

## Context

S21 shipped the recon-runner PD-stack integration (subfinder + httpx + nuclei subprocess wrappers). Post-PASS codex adversarial review at `219b636` surfaced 3 HIGH + 2 MEDIUM findings in the integrated worker path.

S21 evaluator also noted 4 non-gating carries (B-21-a through B-21-d); B-21-a is subsumed by the codex P2-MED finding below.

---

## Opening blockers (from codex adversarial review)

### P1-HIGH-A: B2 audit FK throw before ack (worker.ts:137-149)

The denied-path emits an audit with the envelope's `assessmentId` BEFORE returning ack. `audit_events.assessment_id` has a NOT NULL FK to `assessments`. A ghost or cross-tenant assessmentId causes the audit INSERT to throw → uncaught → nack → retry loop.

**Fix:** Pass `resourceId: null, assessmentId: null` for the denied audit so no FK can fire.

> **Status at e7fefcf:** NOT FIXED. Carried as B-22-h1 to S23 backlog.

### P1-HIGH-B: findingsWriter missing from ReconWorkerDeps → B4 dead code (worker.ts:196-203)

`runNuclei` accepts an optional `findingsWriter` but `ReconWorkerDeps` has no such field. The worker calls `runNuclei` without one. In the integrated pipeline, nuclei findings emit audits but are never persisted. The B4 per-finding try/catch is effectively dead code.

**Fix:** Add `findingsWriter?` to `ReconWorkerDeps` and wire it through.

> **Status at e7fefcf:** NOT FIXED. Carried as B-22-h2 to S23 backlog.

### P1-HIGH-C: Out-of-scope subfinder yields persisted as targets (worker.ts:172-190)

The worker persists every `discoveredHosts` value via `targetWriter`, regardless of whether the host passed the httpx scope gate.

**Fix (Option A):** `probeHttpx` already returns only alive+approved results; persist `aliveResults.map(r => extractHostFromUrl(r.url))` instead of `discoveredHosts`.

> **Status at e7fefcf:** FIXED. Loop iterates `aliveResults` not `discoveredHosts`.

### P2-MED-A: httpx absence kills nuclei stage (C1 degraded mode broken) (worker.ts:178-204)

`probeHttpx` returns `[]` when `httpxBin` is absent. The worker only calls `runNuclei` when `aliveResults.length > 0`. Missing httpx silently disables nuclei.

**Fix:** Track whether httpx was skipped due to missing binary. If skipped, pass `nucleiUrls = probeUrls`.

> **Status at e7fefcf:** NOT FIXED. Carried as B-22-h3 to S23 backlog.

### P2-MED-B: B-21-a — null projectId publishes invalid recon envelope

`triggerRecon=true` + null `projectId` publishes envelope with null projectId → worker zod parse fails → nack-retry.

**Fix:** Extend C3 guard to include `&& input.projectId`.

> **Status at e7fefcf:** FIXED. Guard at `start-decepticon-session.ts:663`.

---

## Acceptance criteria (original — superseded)

| ID | Criterion |
|---|---|
| A-22-1 | `bun run lint` → 0 errors |
| A-22-2 | P1-HIGH-A fixed: real DB emitter B2 IT path returns ack without throwing on ghost assessmentId |
| A-22-3 | P1-HIGH-B fixed: `findingsWriter` wired through |
| A-22-4 | P1-HIGH-C fixed: targetWriter receives only scope-approved hosts |
| A-22-5 | P2-MED-A fixed: httpx absent → nuclei runs against primaryDomain fallback |
| A-22-6 | P2-MED-B fixed: C3 guard includes projectId non-null |
| A-22-7 | B-21-c stale comment fixed in IT file |
| A-22-8 | Full-PG regression: ≥1391 pass, ≤2 fail |
