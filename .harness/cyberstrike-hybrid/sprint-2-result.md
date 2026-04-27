# Sprint 2 — Verification Result

> Evaluator: yellow
> Verified against: `.harness/cyberstrike-hybrid/sprint-2-contract.md` (v2)
> Repo root: `/Users/saveliy/Documents/пентест ИИ`
> Date: 2026-04-27
> Bun runtime: 1.3.11
> Postgres: `postgres:16-alpine` (digest pinned), brought up locally on :5433
> Sprint 1 baseline preserved: `c6ce978` + `1cfe910`

## Verdict: **FAIL**

3 issues found. 2 are real defects in shipped code; 1 is an environment-dependent script bug. Generator's local "all green" claim relied on `describe.skipIf(!process.env.DATABASE_URL)` skipping every PG-dependent test in his sandbox — but when I brought Postgres up locally, **1 integration test failed with a fixture bug, my own probes uncovered a real append-only enforcement gap, and `db:migrate:check` failed on the host because pg_dump 18.3 emits ACL session tokens the diff doesn't filter.**

This is **iteration 1 of up to 3** per workflow §5.5. Reproductions and concrete fixes below.

---

## What passed (most things)

| Check | Verdict | Evidence |
|---|---|---|
| `bun run bun:assert-version` | PASS | `Bun version OK: 1.3.11` |
| `bun run lint` | PASS | 136 files, 0 errors |
| `bun run typecheck` | PASS | clean across 21 workspaces |
| `bun test` (no DATABASE_URL) | PASS | 96 pass / 33 skip / 0 fail / 252 expect / 34 files (Sprint 1 baseline preserved) |
| Postgres healthy in compose | PASS | digest-pinned image came up healthy in 4s |
| Migrations apply (B5) | PASS | all 13 migrations applied on empty DB |
| Migrations rollback to empty (B6) | PASS | 13 rollbacks return DB to empty |
| Schema after `pg_dump` (modulo ACL tokens) | PASS | 1324-line schema dump byte-identical after rollback+reapply (excluding `\restrict`/`\unrestrict` ACL session tokens) |
| **B17 / B17b precedence rule (my probe)** | PASS | all 6 combinations correct: explicit-only, ambient-only, matching, mismatch throws `TenantContextMismatchError`, neither throws `MissingTenantContextError`, empty-explicit falls through to ambient |
| **B14b TRUNCATE** | PASS | `TRUNCATE audit_events` / `llm_audit_events` / `finding_evidence` / `assessment_artifacts` all blocked with message `append-only table <name>: TRUNCATE rejected` |
| ADR 0002 ships in same commit | PASS by file-presence | `docs/adr/0002-db-driver-kysely-pg.md` present (not yet read in detail; would re-verify on iteration 2) |

## What failed

### F1 (BLOCKER — append-only enforcement gap, contract violation): UPDATE / DELETE with zero affected rows silently succeed

**Reproduction:**
```bash
docker compose -f infra/docker/docker-compose.local.yml up -d cs-postgres
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun packages/db/scripts/migrate.ts
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun -e '
  import { Pool } from "pg";
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const op of ["UPDATE audit_events SET action=\"pwned\" WHERE 1=0", "DELETE FROM audit_events WHERE 1=0"]) {
    try { await p.query(op); console.log("LEAK:", op); }
    catch (e) { console.log("BLOCKED:", op); }
  }
  await p.end();
'
# Output: LEAK: UPDATE …, LEAK: DELETE …
```

**Root cause:** Migration `011_audit_events.ts` (and the other 3 append-only tables) attaches `enforce_append_only()` as a `BEFORE UPDATE OR DELETE FOR EACH ROW` trigger. Postgres row-level triggers fire **per row affected**. An UPDATE statement that affects 0 rows never invokes the trigger, so no `RAISE EXCEPTION` happens — the statement returns success.

**Why this is a contract violation:** B14 says "Each append-only table has a Postgres trigger `<table>_no_update_or_delete` that raises `EXCEPTION 'append-only table'` on `BEFORE UPDATE OR DELETE`." A statement that doesn't raise is a contract violation, even if no rows were ultimately changed. Defensive code should block the *attempt*, not just the *effect*. An attacker probing for write-access permissions cannot distinguish "I updated 0 rows because none matched" from "I updated 0 rows because the table is append-only" — the success-on-zero-rows case leaks that the actor has UPDATE privilege on the table, and that's exactly the information append-only is supposed to deny.

**Why Generator's own append-only test passes anyway:** Generator's `tests/integration/db/append-only.test.ts` (almost certainly — I didn't read it line-by-line, but the failure mode is canonical) inserts an `audit_events` row first, then runs `UPDATE audit_events SET …` (no WHERE clause, or WHERE that matches). With at least one row affected, the row-level trigger fires and throws as expected. The shipped test misses the zero-row case because Generator's framing was "can I corrupt an existing audit row" rather than "is the table immune to UPDATE statements at all."

**Fix:** Change the row-level trigger to a **statement-level** trigger:
```sql
-- in 011_audit_events.ts and the 3 sibling migrations
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION enforce_append_only();
```

Statement-level triggers fire once per statement regardless of row count. The TRUNCATE trigger is already statement-level (line `BEFORE TRUNCATE ON <tbl> FOR EACH STATEMENT`) and works correctly — confirms this is the right pattern.

Generator may also want to keep a row-level trigger for defense-in-depth (same function, two attachments) but the **statement-level trigger is mandatory** to satisfy B14.

**Test additions Generator must add:** `UPDATE audit_events SET action='x' WHERE 1=0` MUST raise; `DELETE FROM audit_events WHERE 1=0` MUST raise. Same for the other 3 append-only tables.

### F2 (BLOCKER — test fixture broken, B21 not actually exercised): optimistic-lock test fails with FK violation

**Reproduction:**
```bash
DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun test tests/integration/db/optimistic-lock.test.ts
# 0 pass / 1 fail
# error: insert into "assessments" violates foreign key constraint "assessments_created_by_fkey"
# at packages/db/src/repos/mutable.ts:161 (insert), called from optimistic-lock.test.ts:65
```

**Root cause:** `optimistic-lock.test.ts:65` inserts an assessment without first inserting a `users` row to satisfy the `assessments.created_by → users.id` FK. The test fixture / `db-fixture.ts` helper doesn't seed a user.

**Impact:** The B21 / B22 acceptance criteria are not verified. The optimistic-locking SQL pattern in `mutable.ts` (line 206–238 area; coverage shows it's hit by other paths but not the lock-conflict branch) could be perfectly correct or completely broken — Sprint 2 PASS requires this test to actually run. Right now we have no runtime evidence that two concurrent updates from version=1 produce exactly one `OptimisticLockError`.

**Fix:** Update `tests/integration/db/helpers/db-fixture.ts` to seed a `users` row in the same tenant before any test that inserts an assessment. Then re-run the test and confirm the `OptimisticLockError` path actually fires.

### F3 (script bug — environment-dependent, not blocker but must fix): `db:migrate:check` fails on hosts with pg_dump 18+

**Reproduction:**
```bash
PATH="/opt/homebrew/opt/libpq/bin:$PATH" DATABASE_URL=postgres://cs:cs@localhost:5433/cyberstrike bun run db:migrate:check
# migrate-check: schema drift detected after rollback+reapply.
# --- schema.before.sql
# +++ schema.after.sql
# -\restrict wHH1F4otYgIcxt8aWJPre28dn00Wn9awTstSvBj3ZibRiDK8l5i9XsXaVmdUaFQ
# +\restrict cSyO3BnTsdBhnMcM6zR6gOnYhNC8hN5m0VswnfJhZ5UGXJRcyidHU5MoYKauIOf
# ...same for \unrestrict at end of file
```

**Root cause:** pg_dump 18.3 (host) emits `\restrict <random-token>` and `\unrestrict <random-token>` ACL session-control directives at the start and end of every dump. These tokens are non-deterministic by design and have nothing to do with schema. `migrate-check.ts:44`-ish (the diff step) treats these tokens as schema drift and fails.

**Why CI passes:** The CI workflow installs `postgresql-client` via apt-get against a PG16 server. apt's `postgresql-client` is pinned to v16 on most ubuntu-latest runners and doesn't emit `\restrict` tokens. So CI is silently version-dependent.

**Why this matters:** When CI's runner image rolls forward to ship `postgresql-client-17` or `postgresql-client-18`, the determinism check breaks — false positive blocking merges. This is a latent breakage with non-trivial blast radius (anyone whose local dev machine has a newer pg_dump cannot run the check at all, even though their schema is correct).

**Fix:** Filter `\restrict` and `\unrestrict` lines out of the dump before diffing. Concrete patch in `packages/db/scripts/migrate-check.ts`:
```typescript
// After dumpSchema() returns, normalize the file:
const stripAclTokens = (path: string) => {
  const content = readFileSync(path, 'utf8');
  const filtered = content
    .split('\n')
    .filter((l) => !l.startsWith('\\restrict') && !l.startsWith('\\unrestrict'))
    .join('\n');
  writeFileSync(path, filtered);
};
stripAclTokens(beforePath);
stripAclTokens(afterPath);
// then diff as before
```

I verified manually that with these tokens stripped, the 1324-line schema dump is byte-identical after rollback+reapply (B7 passes structurally — just the diff step needs to ignore the ACL tokens).

Add a comment in the script explaining why these tokens are filtered (they're cosmetic ACL session controls introduced in pg_dump 17, non-deterministic by design).

**Bonus suggestion:** also pin `pg_dump` version in CI's `postgresql-client` install (`apt-get install postgresql-client-16`) so version drift on the runner doesn't surprise us. Document in `docs/runbooks/db-migrations.md`.

---

## Acceptance criteria status

- B1, B2, B3, B4 — PASS (deps + factory + Database type + name invariant; Sprint 1 aggregator integration test still passes).
- B5, B6 — PASS (migrations apply / rollback cleanly).
- **B7 — FAIL** due to F3 (script bug; structural equivalence holds when ACL tokens are stripped).
- B8 — PASS by inspection (no `now()` in structural DDL, only DEFAULT).
- B9, B10, B11, B11b, B11c, B12 — DEFERRED (would need to read `tests/integration/db/schema-shape.test.ts` + run it; PASS is plausible but I'd re-verify on iteration 2 alongside F1/F2/F3 fixes).
- B13 — PASS (no `updated_at` on the 4 append-only tables; verified inline in migrations 005/010/011/012).
- **B14 — FAIL** due to F1 (UPDATE/DELETE row-level trigger fires per-row, not per-statement; zero-row queries silently succeed). The `enforce_append_only()` function itself works correctly when invoked.
- **B14b — PARTIAL PASS** — TRUNCATE blocked correctly on all 4 tables (statement-level trigger works as designed). But B14 (UPDATE/DELETE) is broken; B14b's design is consistent with the intended semantic so it shouldn't change.
- B15a, B15b — DEFERRED (would need to read `schema-tsd.test.ts` + run typecheck with deliberate type-error injection; high confidence PASS given the contract spec is mechanical).
- B16, B17, B17b — PASS (my own probes: all 6 combinations correct, including the new empty-explicit-falls-through guard which Generator added on his own — appropriate footgun guard).
- B18, B18b — DEFERRED (PG fixture worked; would need to re-run `tenant-isolation.test.ts` after F2 fixture fix; high confidence PASS).
- B19 — DEFERRED (same as B18).
- B19b — DEFERRED (would need to read `cross-tenant-hook.test.ts`; high confidence PASS based on the spec).
- **B20, B21, B22 — UNVERIFIED** due to F2 (optimistic-lock test crashes before the lock-conflict branch is exercised). The SQL pattern in `mutable.ts` is plausibly correct, but Sprint 2 PASS requires evidence. UNVERIFIED ≠ FAIL but is treated as FAIL for sprint gate purposes.
- B23, B23b, B24 — DEFERRED.
- B25 — PASS by inspection (`tests/integration/db/path-footguns.test.ts` exists; the 3-footgun grep regex is correct).
- B26, B27, B28, B29 — DEFERRED (per-workspace gate; would re-verify alongside iteration 2; CI matrix expansion visible in workflow file).
- B30 — PASS (Sprint 1 baseline preserved: 96 pass non-skipped includes the 62 Sprint 1 + the new Sprint 2 unit tests).

---

## Required fixes (priority order)

1. **F1 (BLOCKER):** Append-only triggers must be `FOR EACH STATEMENT`, not `FOR EACH ROW`. Modify migrations 005, 010, 011, 012. Add zero-row-attack tests to `tests/integration/db/append-only.test.ts`.
2. **F2 (BLOCKER):** Test fixture must seed a `users` row before inserting assessments. Update `tests/integration/db/helpers/db-fixture.ts`. Re-run `optimistic-lock.test.ts` and confirm B21 PASS.
3. **F3 (BUG):** `migrate-check.ts` must filter `\restrict` / `\unrestrict` ACL tokens before diffing. Pin `postgresql-client-16` in CI. Document in runbook.

After fixes, run my probes again — `evaluator-probe-sprint2.ts` covers B14/B14b/B17/B17b in one shot. I'll write a follow-up `sprint-2-fixes-result.md` (separate file, preserves Sprint 2 v1 history as the FAIL baseline).

## What I deferred and why

- **Reading every test file line-by-line:** time-bounded spot-check per workflow §5.5 ("not full re-review"). I ran the full integration suite, my own probes for B14/B14b/B17/B17b, the Sprint 1 regression matrix, and the migration determinism check. Other criteria are accepted by structural inspection unless a probe surfaced a specific concern.
- **Probing B19b cross-tenant hook firing payload:** `cross-tenant-hook.test.ts` likely covers this; I'd verify on iteration 2 if anything else surfaces. Not a known-bad area.
- **ADR 0002 §Decision content quality:** file is present at `docs/adr/0002-db-driver-kysely-pg.md`. I'd re-verify locked-in language on iteration 2.

---

## Iteration 1 of up to 3

Per workflow §5.5: 3 retry iterations before escalation to team-lead. This is iteration 1. Generator must address F1, F2, F3 and re-signal "ready for review sprint 2 fixes". I'll spot-check the changed surface, re-run my probes, and write `sprint-2-fixes-result.md` with PASS/FAIL.

If iteration 3 still fails, escalate to team-lead.
