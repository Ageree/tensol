# Sprint 4 — Implementation Result

> **Status:** READY FOR REVIEW
> **Author:** Generator-2
> **Date:** 2026-04-27
> **Baseline:** HEAD `8175cc9` (Sprint 3 PASS at commit `976cd81` for the result doc)

---

## Summary

All 27 acceptance criteria (A1–A27 + A8b/A13b/A15b) implemented. The Sprint 4
audit pipeline is in place: a single `packages/audit` workspace owns the audit
envelope, writer, deny helper, redact primitive, service-actor closed enum,
and the re-usable `assertExactlyOneAuditRow` test harness. The two
previously-dangling deny channels (`RbacDenyError` and
`MutableRepository.onCrossTenantAttempt`) are wired to `denyAudit`. A new
tenant-aware read API (`GET /api/v1/audit-events`) ships with strict zod,
opaque base64 cursor, IP/userAgent redaction, and the `__platform__` sentinel
filter baked in.

## Cumulative test results

| Suite | Pre-Sprint-4 (HEAD 8175cc9) | Post-Sprint-4 |
|-------|----|----|
| `bun test` (no DB) | 243 pass / 85 skip / 0 fail | **297 pass / 116 skip / 0 fail** |
| `DATABASE_URL=… bun test` | 304 pass / 0 fail | **388 pass / 0 fail** |
| `bun run lint` | clean | clean |
| `bun run typecheck` | clean | clean |
| `bun run db:migrate:check` | green | green (no new migration) |

## Coverage

- `packages/audit`: 100% line / 83-100% func / 100% statement / branch.
- `packages/contracts/src/audit.ts`: 100% line / 100% func.
- New `apps/api/src/routes/audit/events.ts` covered by integration tests.
- New `packages/db/src/repos/audit-events.ts`: 83-100% covered (cursor +
  count paths).

## Acceptance criteria — implementation map

| # | What it asks | Where it landed | How it's tested |
|---|---|---|---|
| A1 | `packages/audit` workspace exists | `packages/audit/src/{index,envelope,writer,deny,redact,service-actors,testing}.ts` | Compiles + 48 unit tests pass |
| A2 | `AuditEventEnvelope` zod schema + strict | `packages/contracts/src/audit.ts:auditEventEnvelopeSchema` | `audit.test.ts` — strict reject extra keys, reject unregistered service id |
| A3 | `AuditAction` exhaustive union (11 entries) | `packages/contracts/src/audit.ts:AUDIT_ACTIONS` | `audit.test.ts` — assertEqual on the 11-entry tuple |
| A4 | `AuditOutcome` exhaustive union (11 entries) | `packages/contracts/src/audit.ts:AUDIT_OUTCOMES` | `audit.test.ts` — assertEqual on the 11-entry tuple |
| A5 | `ServiceActor` closed enum (4 entries) | `packages/contracts/src/audit.ts:SERVICE_ACTOR_IDS` + `packages/audit/src/service-actors.ts` | `service-actors.test.ts` — exhaustive |
| A6 | `apps/api/src/middleware/audit.ts` is thin re-export | Replaced body with `export * from '@cyberstrike/audit'` | Sprint 3 auth-route audit tests still green (44 PG-IT auth) |
| A7 | `denyAudit(deps, args)` exported | `packages/audit/src/deny.ts` | `deny.test.ts` — row shape, throws propagate |
| A8 | Hono `onError` → `RbacDenyError` → synchronous `denyAudit` → 403; 500 on insert throw | `apps/api/src/factory.ts:app.onError` | `tests/integration/audit/deny-pipeline.test.ts` — 3 cases incl. NQ-A 500 |
| A9 | `buildRepositories({onCrossTenantAttempt})` from `createApp` | `apps/api/src/factory.ts:createApp` | `tests/integration/db/cross-tenant-hook.test.ts` extension |
| A10 | One audit row per cross-tenant attempt — no double | `tests/integration/audit/deny-pipeline.test.ts` | Asserted directly |
| A11 | `auditEventsForTenant` + `__platform__` exclusion | `packages/db/src/repos/audit-events.ts:findForTenantPage` | `tests/integration/audit/read-api.test.ts` |
| A12 | T1/T2 isolation on `GET /audit-events` | `apps/api/src/routes/audit/events.ts` | `tests/integration/audit/read-api.test.ts` |
| A13 | tsd-style append-only surface guard | (Sprint 2's `AppendOnlyRepository` already enforces; no `update`/`delete`/`truncate` exposed) | Existing schema-tsd tests; would fail compile if drift |
| A13b | Runtime PG trigger SQLSTATE 23514 + positive control | `tests/integration/audit/append-only-runtime.test.ts` | UPDATE/DELETE/TRUNCATE rejected; INSERT succeeds |
| A14 | `GET /api/v1/audit-events` w/ strict zod, opaque base64 cursor, IP redaction | `apps/api/src/routes/audit/events.ts` + `packages/db/src/repos/audit-events.ts` | `tests/integration/audit/read-api.test.ts` — R1 R2 R8 all asserted |
| A15 | RBAC + isolation matrix | A15b matrix flips + `tests/integration/audit/rbac-gate.test.ts` | 7 roles tested (5 deny + 2 allow) |
| A15b | `audit_log` allowed for auditor + tenant_admin only | Flipped `platform_admin` / `security_lead` / `operator` to `[]` in their per-role matrix specs | `matrix.test.ts` adds A15b describe block; `rbac-gate.test.ts` end-to-end |
| A16 | `redact(input, config?)` with default + extended secret keys | `packages/audit/src/redact.ts` | `redact.test.ts` |
| A17 | Property-based tests (fast-check) | `packages/audit/src/redact.property.test.ts` | 5 properties × 30-50 runs |
| A18 | `assertExactlyOneAuditRow` harness | `packages/audit/src/testing.ts` | `testing.test.ts` — count 0/1/2 paths |
| A19 | C29 delta=1 across 10 emission points | `tests/integration/audit/c29-delta.test.ts` | All 10 actions tested |
| A20 | Service-actor emission test | `service-actors.test.ts` + `serviceActor()` factory | Closed-set + factory output |
| A21 | No service-actor wired to coordinator code | (intentionally — services don't exist yet) | N/A |
| A22 | Telemetry try/catch + 3 branches | `packages/audit/src/writer.ts:emitAudit` | `writer.test.ts` — 4 branches inc. console.warn structured |
| A23 | `docs/adr/0004-audit-pipeline.md` | Created with 5 verbatim §Decision rules | Manual probe-able |
| A24 | `docs/runbooks/audit-event-isolation.md` | Created with §1-§7 procedures | Manual probe-able |
| A25 | Sprint 1+2+3 cumulative tests pass | 388 PG / 297 no-DB | Verified |
| A26 | All static checks green | lint + typecheck + db:migrate:check | Verified |
| A27 | Path-footguns extension to `packages/audit/`, `tests/integration/audit/` | `tests/integration/db/path-footguns.test.ts` | 1 test pass |

## Files added

```
packages/contracts/src/audit.ts                        # A2/A3/A4/A5
packages/contracts/src/audit.test.ts
packages/audit/src/envelope.ts                         # A1 (re-export)
packages/audit/src/writer.ts                           # A6/A22
packages/audit/src/writer.test.ts
packages/audit/src/deny.ts                             # A7
packages/audit/src/deny.test.ts
packages/audit/src/redact.ts                           # A16
packages/audit/src/redact.test.ts
packages/audit/src/redact.property.test.ts             # A17
packages/audit/src/service-actors.ts                   # A5/A20
packages/audit/src/service-actors.test.ts
packages/audit/src/testing.ts                          # A18
packages/audit/src/testing.test.ts
packages/audit/src/index.ts                            # A1 surface
packages/db/src/repos/audit-events.ts                  # A11/A14 cursor + sentinel
packages/db/src/repos/audit-events.test.ts
apps/api/src/routes/audit/events.ts                    # A14/A15
tests/integration/audit/deny-pipeline.test.ts          # A8/A10
tests/integration/audit/read-api.test.ts               # A11/A12/A14
tests/integration/audit/rbac-gate.test.ts              # A15/A15b
tests/integration/audit/append-only-runtime.test.ts    # A13b
tests/integration/audit/c29-delta.test.ts              # A19
docs/adr/0004-audit-pipeline.md                        # A23
docs/runbooks/audit-event-isolation.md                 # A24
```

## Files updated

```
apps/api/src/factory.ts                                # A8/A9 wiring
apps/api/src/middleware/audit.ts                       # A6 thin re-export
apps/api/src/routes/_test/resource.ts                  # propagate RbacDenyError to global onError
apps/api/src/routes/register-routes.ts                 # mount /api/v1/audit-events
apps/api/package.json                                  # +@cyberstrike/audit, +@cyberstrike/contracts
packages/authz/src/errors.ts                           # RbacDenyError gains targetedTenantId (R3+R7)
packages/authz/src/matrix/security_lead.ts             # A15b: audit_log → []
packages/authz/src/matrix/operator.ts                  # A15b
packages/authz/src/matrix/platform_admin.ts            # A15b
packages/authz/src/matrix.test.ts                      # A15b describe block
apps/api/src/middleware/assert-ownership.ts            # passes targetedTenantId
packages/db/src/index.ts                               # exports AuditEventsRepo
packages/db/src/repos/aggregates.ts                    # auditEventsForTenant
packages/contracts/package.json                        # +zod
packages/audit/package.json                            # deps
package.json (root)                                    # +@cyberstrike/audit, +@cyberstrike/contracts
tests/integration/db/cross-tenant-hook.test.ts         # A9 extension
tests/integration/db/path-footguns.test.ts             # A27 extension
```

## Design decisions worth flagging

1. **A15b strict-read interpretation.** Pre-Sprint-4 the matrix allowed
   `platform_admin` / `security_lead` / `operator` to read+list audit_log.
   The contract A15b says only `auditor` + `tenant_admin` may; we flipped
   the three to `[]`. Cardinality stays 1274. `matrix.test.ts:A15b describe`
   pins this. (Planner was pinged on the ambiguity; no response received
   before slice 3 closed — chose recommendation A as documented in the
   ping.)
2. **`onCrossTenantAttempt` is fire-and-forget.** The hook in
   `factory.ts:createApp` calls `void denyAudit(...)`. Errors from
   `denyAudit` would surface as unhandled rejections; the contract's NQ-A
   500-on-deny-throw rule applies only to the synchronous A8 onError path
   (where the response shape changes). For the repo-layer hook, a throw
   would be a real bug worth a fail-fast — same exit semantics as A8 in
   spirit, but the hook never has a response to alter.
3. **`__platform__` sentinel filter via `NOT IN`.** Initially used `!=`
   but PG's three-valued logic returns NULL when the subquery is empty
   (e.g. fresh DB before any unattributed event). `NOT IN` with an empty
   subquery returns true, which is what we want — no rows match the
   filter, which means all rows pass. Semantics asserted by
   `read-api.test.ts:A11`.
4. **`/_test/resource/:id` no longer locally catches `RbacDenyError`.**
   Sprint 3 caught and converted to 403 in-route; Sprint 4 propagates so
   the global `onError` handles emission + body sanitisation uniformly.
   The Sprint 3 IDOR test still passes (it only asserts 403 status, not
   audit count).
5. **Cursor uses lex-pair `(occurred_at, id) < (cursor.occurredAt, cursor.id)`.**
   PG row constructor comparison handles same-timestamp ties via id.
   Cursor is `base64(JSON.stringify({occurredAt, id}))`.

## Open items

- **Adversarial-review**: not yet run; Lead may invoke `/codex:adversarial-review`
  against `8175cc9..HEAD`.
- **Planner unresponsive on A15b**: sent a ping at slice-1 boundary; no
  response. Proceeded with strict-read interpretation (recommendation A).
  If Planner intended pragmatic-read, the A15b matrix flip is reversible
  in a follow-up commit.

## Verification commands (matches contract §7)

```bash
cd "/Users/saveliy/Documents/пентест ИИ"
bun run bun:assert-version
bun run lint
bun run typecheck
docker compose -f infra/docker/docker-compose.local.yml up -d
bun run db:migrate:check
bun test
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test --coverage \
  packages/audit tests/integration/audit
bun test tests/integration/db/path-footguns.test.ts
psql postgres://cs:cs@localhost:5433/cyberstrike \
  -c "UPDATE audit_events SET action='tampered' WHERE 1=1;" \
  # expected: ERROR: append-only table audit_events: UPDATE rejected
```

End of result.
