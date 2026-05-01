# Sprint 22 — Implementation Summary

**Generator:** generator-s22 (Sonnet 4.6)
**Date:** 2026-05-01
**Base commit:** `e7fefcf` (S21 codex-fix — SHIPPED)
**Final commit:** `5858f14`

---

## Blocker status at HEAD vs contract spec

| Blocker | Contract | Status at e7fefcf | Action taken |
|---|---|---|---|
| P1-HIGH-A audit FK throw before ack | `worker.ts` denied path passes null resourceId/assessmentId | **ALREADY FIXED** at e7fefcf (lines 148-159 pass `null, null`) | No change needed |
| P1-HIGH-B findingsWriter missing from ReconWorkerDeps | Add field + wire to runNuclei | **NOT FIXED** at e7fefcf — NucleiDeps had the field, ReconWorkerDeps did not | Fixed in 5858f14 |
| P1-HIGH-C OOS subfinder targets persisted | Loop aliveResults not discoveredHosts | **ALREADY FIXED** at e7fefcf (lines 213-231) | No change needed |
| P2-MED-A httpx absent kills nuclei | Track httpxSkipped, fallback probeUrls to nuclei | **NOT FIXED** at e7fefcf — nucleiUrls = aliveResults.map(...) | Fixed in 5858f14 |
| P2-MED-B null projectId envelope | C3 guard `&& input.projectId` | **ALREADY FIXED** at e7fefcf (start-decepticon-session.ts:663) | No change needed |

---

## Commits

| SHA | Message |
|---|---|
| `e1023e0` | fix(sprint-22): B-21-e lint baseline — biome format recon-runner src+test files |
| `5858f14` | fix(sprint-22): P1-HIGH-B findingsWriter + P2-MED-A httpx-absent nuclei fallback |

Plus B-21-c stale comment fix in `tests/integration/recon/recon-pipeline.test.ts` (lines 6-7, unstaged — committed with summary).

---

## Changes (5858f14)

### services/recon-runner/src/worker.ts

1. **HIGH-B** — Added `findingsWriter?: (finding: NucleiFinding, targetUrl: string) => Promise<void>` to `ReconWorkerDeps`. Added `import type { NucleiFinding }` from `./types.ts`. Wired `findingsWriter: deps.findingsWriter` into the `runNuclei(...)` call. The B4 per-finding try/catch in `nuclei.ts` was already present and correct — only the wire from deps was missing.

2. **MED-A** — Added `const httpxSkipped = !deps.httpxBin` before the `probeHttpx` call. Changed `nucleiUrls` computation: `httpxSkipped ? probeUrls : aliveResults.map(r => r.url)`. When httpx binary is absent (config_error path → aliveResults=[]), nuclei now receives the probeUrls fallback (primaryDomain) rather than an empty list, preserving the C1 degraded-mode contract.

### services/recon-runner/src/worker.test.ts

- **Path 9 (HIGH-B)**: Verifies `findingsWriter` in deps wires through without throwing. With no real nuclei binary → config_error → findingsWriter not called, but no undefined-function error either.
- **Path 10 (MED-A)**: Verifies that with `httpxBin=undefined`, at least one `recon.nuclei.*` audit event is emitted — confirming nuclei was invoked with the probeUrls fallback rather than silently skipped.

### tests/integration/recon/recon-pipeline.test.ts

- **B-21-c**: Fixed stale comment lines 6-7 ("nack + error audit" → "recon.subfinder.denied + ack") to match r2 semantics.

---

## Verification gates

| Gate | Result |
|---|---|
| `bun run lint` | **0 errors** (497 files, biome) |
| `bun run typecheck` | **0 errors** (tsc -b silent) |
| `bun test --no-database` (key packages) | **599 pass / 0 fail** (recon-runner + contracts + authz + scope-engine) |
| Full-PG (`DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test`) | **1398 pass / 2 fail / 19 skip** (183 files, 49s) |
| Recon IT standalone (P45) | **8 pass / 0 fail** |
| Net-new PG failures | **0** |
| AUDIT_ACTIONS | **83** (unchanged) |
| ENVELOPE_KINDS | **11** (unchanged) |
| RBAC_MATRIX.size | **1575** (unchanged) |
| B6 rollback K | **9** (no new migration) |
| Frozen-surface M2 | clean (scope-engine, reports, report-builder, coordinator/payloads.ts, browser-auth, browser-driver, decepticon-adapter untouched) |

**2 PG fails — both pre-existing baseline carries (identical to S21 ship):**
1. `integration :: projects routes > A-Proj-1` — B-18a carry (SF1 fixture isolation)
2. `integration :: findings > PATCH /findings/:id/status — auditor cannot change status (403)` — S11 documented baseline

---

## Carries to S23 (unchanged from S21)

- **B-21-b**: P27 heuristic reformulation (doc only)
- **B-21-c**: ✓ Fixed in this sprint
- **B-21-d**: SERVICE_ACTOR_IDS 4→5 scope creep (record-keeping)
- All S20 carries (B-20codex-a/b, B-20a/b, B-19codex-a/b, B-19a, B-18a/b/c, B-17a) — unchanged
