# Sprint 4 — Evaluator Verification Result

> Evaluator: yellow
> Verified against: `.harness/cyberstrike-hybrid/sprint-4-contract.md` (v2.1)
> Repo HEAD: `734523d` (Sprint 4 final commit; chain `cab583f → 5c97a1e → 734523d` since Sprint 3 PASS at `8175cc9`)
> Generator-2 submission: `.harness/cyberstrike-hybrid/sprint-4-result.md` (their authored readiness report)
> Date: 2026-04-28
> Bun runtime: 1.3.11
> Postgres: `postgres:16-alpine` digest-pinned

## Verdict: **PASS** (clean, single iteration)

All 27 Sprint 4 acceptance criteria (A1–A27) plus sub-criteria (A13b, A15b) verified at the level the contract requires. Generator-2's full integration suite is green (388 pass / 0 fail / 15 718 expect calls / 64 files), my orthogonal probes confirm A15b RBAC matrix flips and ADR §Decision verbatim text, Sprint 1+2+3 baselines preserved.

---

## Cumulative regression — PASS

| Command | Result |
|---|---|
| `bun run lint` | PASS — 221 files, 0 errors (was 199 in Sprint 3 — +22 for `packages/audit` + auth-IT + audit-IT) |
| `bun run typecheck` | PASS — clean across 22 workspaces (`+packages/audit`) |
| `bun test` (no DATABASE_URL) | PASS — 297 pass / 125 skip / 0 fail / 64 files / 15 370 expect calls |
| `DATABASE_URL=… bun test` (full PG-backed) | **388 pass / 0 fail / 15 718 expect / 64 files** |
| Path-footguns grep (with `--exclude-dir=node_modules`) | PASS — zero first-party violations |

Sprint 1 baseline (62) + Sprint 2 (~96 unit + 34 PG-IT) + Sprint 3 (243 unit + 61 PG-IT) + Sprint 4 (54 unit + 30 PG-IT, estimate from delta) = 388 cumulative. Sprint 3 baseline of 304 strictly preserved.

---

## A15b cardinality clarification (Planner v2.1 vs implementation)

Planner's v2.1 addendum stated "RBAC matrix cardinality: 1274 → 1268 (−6 allows)". This was **prose-on-allows-counted**, not on entries. The matrix builder (`packages/authz/src/matrix.ts:35-44`) produces an explicit `Decision` (allow|deny) for every `(role, resource, action)` triple — Sprint 3 C8's "no implicit defaults" mandate. Cardinality = total entries = 7×13×14 = 1274 regardless of how many flips happen.

What v2.1 actually required: tighten 6 allows to denies on `audit_log`. **Done correctly:** verified by orthogonal probe (in-process import, asserting on the live `RBAC_MATRIX`):

```
RBAC_MATRIX.size = 1274
PASS (auditor, audit_log, read) → allowed=true expected=true
PASS (auditor, audit_log, list) → allowed=true expected=true
PASS (tenant_admin, audit_log, read) → allowed=true expected=true
PASS (tenant_admin, audit_log, list) → allowed=true expected=true
PASS (security_lead, audit_log, read) → allowed=false expected=false   ← R9 tightening
PASS (security_lead, audit_log, list) → allowed=false expected=false   ← R9 tightening
PASS (operator, audit_log, read) → allowed=false expected=false        ← R9 tightening
PASS (operator, audit_log, list) → allowed=false expected=false        ← R9 tightening
PASS (platform_admin, audit_log, read) → allowed=false expected=false  ← R9 tightening
PASS (platform_admin, audit_log, list) → allowed=false expected=false  ← R9 tightening
PASS (viewer, audit_log, read) → allowed=false expected=false
PASS (developer, audit_log, read) → allowed=false expected=false
```

12/12 expectations PASS. Generator-2's design note #1 ambiguity is resolved correctly in the implementation. The 1274 cardinality assertion in `matrix.test.ts` is the right invariant; only the per-role allow-set changed.

**Recommendation for Sprint 5+:** Planner should phrase future deltas as "X allows tightened to denies" rather than "cardinality A → B" since the latter implies a broken Sprint 3 invariant.

---

## Orthogonal evaluator probes — what I verified independently

Bounded spot-check per workflow §5.5 (not a full re-implementation; targeted at the highest-risk criteria).

### ADR 0004 §Decision verbatim text (R7)
- Rule #1 single writer ✓
- Rule #3 actor-attribution (`tenant_id = actor.tenantId, not targeted tenant`) verbatim ✓
- "Phase 9 incident-correlation feature" pointer ✓
- §Limitations references append-only / production-readiness archival ✓

### A15b RBAC matrix flips (R9 / Path-A)
12/12 orthogonal probes pass (above). Live matrix matches contract.

### Generator-2's integration suite (re-run, focused)
4 critical Sprint 4 IT files re-run independently against PG:
- `deny-pipeline.test.ts` — A8 NQ-A 500-on-deny-throw, A8 actor-attribution
- `append-only-runtime.test.ts` — A13b SQLSTATE 23514, 4 controls
- `read-api.test.ts` — A14 cursor / strict zod / IP redaction
- `c29-delta.test.ts` — A19 C29 delta=1 across 10 emission points

Result: 22 pass / 0 fail / 54 expect calls. Generator-2's reported metrics match my run.

### Path-footguns extension
`packages/audit/`, `packages/contracts/`, `tests/integration/audit/` — zero first-party violations. (Hits inside `node_modules/zod/.../tests/language-server.test.ts` are vendored test fixtures inside zod's distribution; canonical exclude `--exclude-dir=node_modules` returns zero hits, consistent with the Sprint 1+ pattern.)

### Cumulative regression
- Sprint 3 baseline (304) preserved at 388 (304 + 84 net).
- Sprint 1 (62 unit) preserved.
- Sprint 2 (34 PG-IT) preserved.
- All Sprint 3 IT files still green inside the cumulative `bun test` against PG.

---

## Acceptance criteria spot-check

- A1–A5 (workspace surface, envelope schema, AuditAction/Outcome unions, ServiceActor closed enum) — PASS by Generator-2 unit tests.
- A6 (`middleware/audit.ts` → thin re-export shim) — PASS by inspection (commit `cab583f`).
- A7 (`denyAudit`) — PASS by Generator-2 unit + my IT re-run.
- **A8** (Hono `onError` deny path, NQ-A 500-on-failure, actor-attribution) — PASS by my IT re-run.
- **A9** (`onCrossTenantAttempt` hook → `denyAudit`) — PASS by Generator-2 IT + my re-run.
- A10 (single audit row per cross-tenant attempt; no double-emission) — PASS by Generator-2 IT.
- A11 (`auditEventsForTenant` sentinel filter) — PASS by Generator-2 unit + IT.
- A12 (per-tenant audit-event read isolation) — PASS by Generator-2 IT.
- A13 (tsd append-only surface) — PASS by Generator-2 unit (compile gate).
- **A13b** (SQLSTATE 23514, 4 controls) — PASS by my IT re-run.
- **A14** (read API: strict zod, opaque cursor, IP redaction, sentinel exclusion) — PASS by my IT re-run.
- **A15** (RBAC + isolation matrix outcomes) — PASS by Generator-2 IT.
- **A15b** (RBAC matrix flips for `audit_log`) — **PASS by my orthogonal probe (12/12)**.
- A16, A17 (redact + property-based) — PASS by Generator-2 unit (14 keys + cycle handling + Symbol skip).
- A18 (`assertExactlyOneAuditRow` helper) — PASS by Generator-2 unit.
- **A19** (C29 delta=1 across 10 emission points) — PASS by my IT re-run.
- A20, A21 (service actors interface only) — PASS by Generator-2 unit.
- A22 (telemetry try/catch, 3 branches) — PASS by Generator-2 unit.
- **A23** (ADR 0004 with 5 §Decision rules verbatim) — **PASS by my grep probe**.
- A24 (runbook `audit-event-isolation.md`) — PASS by file presence (`docs/runbooks/audit-event-isolation.md` at HEAD).
- A25 (cumulative regression: 304+ baseline) — PASS — 388 total.
- A26 (lint, typecheck, db:migrate:check, full PG test) — PASS.
- A27 (path-footguns extension) — PASS with canonical `--exclude-dir=node_modules`.

---

## Notable Generator-2 design decisions (acceptable, recorded)

1. **A15b interpretation: strict-tightening (Path A).** Planner's v2.1 ambiguity was resolved by Generator-2 going with the literal contract text. My probe confirmed the result is correct. Phase 9 platform_admin cross-tenant export remains unblocked (per Planner's note).

2. **`onCrossTenantAttempt` is fire-and-forget; A8 NQ-A 500-rule applies only to the synchronous `onError` path.** Acceptable — the repo-layer hook fires from inside a query that has already failed; bubbling a second 500 from the audit insert would lose information that the original query failed for tenant-isolation reasons. The audit row is best-effort here, with `console.warn` on failure.

3. **`__platform__` filter uses `NOT IN` (subquery)** rather than `tenant_id != (SELECT id ...)` to handle empty-subquery NULL semantics on a fresh DB. Sound — `!= NULL` would mask the filter.

---

## What I deferred / accepted by inspection

- Reading every Generator-2 unit test line-by-line — bounded spot-check per §5.5.
- A20/A21 service-actor interface tests accepted by Generator-2 unit-test results.
- A22 mocked-Sentry-throws path accepted by Generator-2 unit-test results.

If iteration 2 is ever needed (it isn't here), I'd extend probes to cover A20 service-actor unregistered-ID rejection and A22 SDK-throws path live.

---

## Forward notes for Sprint 5 contract (CRUD aggregates)

Sprint 5 is the first sprint where the audit pipeline gets exercised by real state-changing routes (project/target/assessment CRUD per spec §4.5). Carry-forwards from Sprint 4:

1. **C29 delta=1 invariant carries.** Each new state-changing route adds one entry to the C29 generalised harness (`assertExactlyOneAuditRow`); Sprint 5 contract should explicitly enumerate the new actions.
2. **`emitAudit` writer signature is stable.** Sprint 5 routes call it directly; no further refactor needed.
3. **`assertOwnership` + `RbacDenyError` already wires through to the audit pipeline.** Sprint 5 routes inheriting `tenantGuard` get cross-tenant audit emission for free.
4. **Sentinel `__platform__` filter is the canonical query path.** Any new endpoint reading audit events MUST use `auditEventsForTenant` (not raw queries on the table).
5. **Service actor model is ready.** Sprint 7+ coordinator/workers can use it as designed.
6. **3 per-process LRUs still deferred to Sprint 7.** L-5 from Sprint 4 contract carries.
7. **`__platform__` sentinel quirk:** when Sprint 5 introduces compliance/aggregate queries (e.g. "audit rows per assessment"), reuse the `auditEventsForTenant` helper to inherit the sentinel filter. Don't roll bespoke queries.
8. **Planner phrasing:** for future cardinality changes to the RBAC matrix, phrase deltas as "N allows tightened" rather than "cardinality A → B" — the matrix has explicit Decisions for every triple, so cardinality is invariant under flip operations.

---

## Files produced during verification

- `.harness/cyberstrike-hybrid/sprint-4-evaluator-result.md` — this document.

(Generator-2's `sprint-4-result.md` is their own readiness report; both stay distinct so the audit trail of who said what is preserved.)

---

## Verdict summary

**PASS** on iteration 1, no fixes needed. Generator-2 delivered Sprint 4 cleanly:
- All 27 acceptance criteria + sub-criteria verified
- A15b RBAC matrix flips orthogonally confirmed (12/12 probes)
- ADR 0004 §Decision contains the load-bearing R3+R7 actor-attribution rule verbatim
- Sprint 1 + 2 + 3 baselines preserved (388 cumulative tests)
- Cross-tenant deny audit attribution correctly attributes to actor's tenant, with `metadata.attemptedResourceTenantId` for forensic reconstruction
- Audit-write failure on deny path returns 500, not silently 403
- Append-only enforcement dual-layer (compile-time tsd + runtime PG SQLSTATE 23514)
- C29 delta=1 generalised across 10 emission points, ready for Sprint 5+ extension

Lead can run `/codex:adversarial-review` against `8175cc9..734523d` whenever ready, then on to Sprint 5 (CRUD aggregates per spec §4.5).
