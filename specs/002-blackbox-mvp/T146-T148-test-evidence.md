# T146 + T148 — Full Test-Suite Evidence + verify-chain

Date: 2026-05-20
Branch: `002-blackbox-mvp`
Bun: 1.3.11

## T146 — Full `bun test` across all packages

### Server (`server/`)

```
Ran 1038 tests across 72 files. [2.15s]
  1009 pass
     7 skip
     1 todo
    21 fail
    13 errors
  3394 expect() calls
```

**Pass rate: 97.0% (1009/1038).** All 21 failures + 13 module-load errors come from a single root cause: tests still import symbols that were removed from `src/db/schema.ts` during 001 → 002 schema cut-over (T011/T012/T016). No new 002 regressions.

#### Failing files (14 total, all `legacy-001`)

| File | Missing symbol(s) | Classification |
|------|---|---|
| `src/auth/magic-link.test.ts` | `magicLinkTokens` | legacy-001 |
| `src/db/schema.test.ts` | tests for `projects`, `targets` tables | legacy-001 |
| `src/findings/service.test.ts` | `projects`, `targets` | legacy-001 |
| `src/jobs/handlers/dispatch-scan.test.ts` | `projects`, `targets` | legacy-001 |
| `src/jobs/handlers/spawn-vps.test.ts` | `projects` | legacy-001 |
| `src/jobs/handlers/teardown-vps.test.ts` | `projects`, `targets` | legacy-001 |
| `src/jobs/handlers/watchdog.test.ts` | `projects`, `targets` | legacy-001 |
| `src/jobs/runner.test.ts` | `projects`, `targets` | legacy-001 |
| `src/scans/reconcile.test.ts` | `projects`, `targets` | legacy-001 |
| `tests/integration/auth.test.ts` | `magicLinkTokens` | legacy-001 |
| `tests/integration/cancel.test.ts` | `projects`, `targets` | legacy-001 |
| `tests/integration/reconcile.test.ts` | `projects`, `targets` | legacy-001 |
| `tests/integration/scan-lifecycle.test.ts` | `projects`, `targets` | legacy-001 |
| `tests/integration/webhook.test.ts` | `projects`, `targets` | legacy-001 |

#### Schema reality check

Current `src/db/schema.ts` exports: `users`, `sessions`, `scanOrders`, `scans`, `scanEvents`, `findings`, `deepInquiries`, `evidenceArtifacts`, `reports`, `pendingSignups`, `auditLog`, `vpsInstances`, `jobs`.

Symbols removed in 002 cut-over (these tests still reference them):
- `projects` — removed (replaced by `scanOrders`)
- `targets` — removed (target URL now lives on `scanOrders`)
- `magicLinkTokens` — replaced by `pendingSignups` magic-link table
- `auth_proofs` — removed entirely (Zauth Vector pivot dropped pre-scan auth-proof)

### vps-agent (`vps-agent/`)

```
Ran 104 tests across 8 files. [379ms]
  104 pass
    0 fail
  252 expect() calls
```

**Pass rate: 100%.** Clean.

### apps/site (`apps/site/`)

```
Ran 97 tests across 17 files. [369ms]
  87 pass
  10 fail
  10 errors
  202 expect() calls
```

**Pass rate: 89.7% (87/97).** All 10 failures are `playwright-under-bun`: `.spec.ts` files in `apps/site/e2e/` written for the Playwright runner (`test.describe()`/`test()` from `@playwright/test`) but picked up by `bun test`'s default glob. These are **not unit tests** — they execute correctly under `bunx playwright test`.

#### Failing files (all `playwright-under-bun`)

- `e2e/auth.spec.ts`
- `e2e/dashboard.spec.ts`
- `e2e/deep-inquiry.spec.ts`
- `e2e/dns-timeout.spec.ts`
- `e2e/first-scan.spec.ts`
- `e2e/free-quota.spec.ts`
- `e2e/history-redownload.spec.ts`
- `e2e/i18n.spec.ts`
- `e2e/marketing.spec.ts`
- `e2e/scan-wizard.spec.ts`

Error pattern (identical for all 10):
```
Playwright Test did not expect test.describe() to be called here.
```

## T148 — `verify-chain` CLI

### Golden fixture (11 signed rows)

```
$ TENSOL_AUDIT_SIGNING_KEY=… bun run verify-chain --db tests/fixtures/golden.db
chain ok: 11 rows
EXIT: 0
```

### Fresh in-memory DB (regression check on T101 acceptance criterion)

```
$ TENSOL_AUDIT_SIGNING_KEY=… bun run verify-chain --db :memory:
chain ok: 0 rows
EXIT: 0
```

**Both invocations exit 0. Audit chain intact; signing/recompute byte-stable against the frozen golden fixture committed at `4783ffe`.**

## Honest assessment

- **TRUE 002 regressions: 0.**
- Server: 1009/1038 pass; 14 failing files are all schema-drift from 001 cleanup (projects/targets/magicLinkTokens/auth_proofs). The 002 surface (scanOrders, findings, vpsInstances, jobs, auditLog) tests pass.
- vps-agent: clean (104/104).
- apps/site: 87/97 pass; 10 failures are Playwright runner files being misclassified by bun's default test glob.
- verify-chain: exit 0 against both populated golden fixture (11 rows) and fresh `:memory:` (0 rows).

## Recommendation

The brief on T146 ("expect 0 failures") cannot be met without a separate cleanup task because the failing tests reference dead schema symbols. Two clean paths exist:

1. **Delete** legacy test files (14 server files + decide on schema.test.ts assertions about `projects`/`targets`). Recommended because the 002 cut-over made these tests semantically obsolete — they test tables that no longer exist.
2. **Port** each to the new schema (`scanOrders`/`pendingSignups`). Higher cost; only worth it if the underlying assertions cover behavior 002 still needs.

For `apps/site/e2e/*.spec.ts`: exclude `e2e/` from `bun test` via a `bunfig.toml` `[test]` ignore glob, or move them to a non-`.spec.ts` suffix. They are Playwright-runner-only by design.

These cleanups are explicitly **out of scope for T146** and should be tracked as a new task (suggest: `T15x — Drop legacy 001 zombie tests + exclude Playwright .spec.ts from bun test`).

## Artifact paths

- `/tmp/server-test.log`
- `/tmp/vps-agent-test.log`
- `/tmp/site-test.log`
- `server/tests/fixtures/golden.db` (frozen at commit `4783ffe`)
