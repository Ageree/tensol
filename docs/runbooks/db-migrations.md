# Runbook — Database migrations

This runbook explains how to author and operate the migration suite for
`packages/db`. Sprint 2 contract §3.5 + ADR 0002.

## Scripts

| Script                               | Purpose                                            |
|--------------------------------------|----------------------------------------------------|
| `bun run db:migrate:up`              | Apply all pending migrations.                      |
| `bun run db:migrate:rollback`        | Rollback the most recently applied migration.      |
| `bun run db:migrate:redo`            | Rollback latest then re-apply (developer aid).     |
| `bun run db:migrate:check`           | CI gate: up → pg_dump → rollback → up → diff.      |

All four read `DATABASE_URL` from the environment.

## Authoring a new migration

1. Pick the next sequential number: `packages/db/migrations/NNN_short_name.ts`.
   Lexical order matches semantic order. The Sprint 2 baseline ends at `013`.
2. Export `up(db)` and `down(db)` async functions taking
   `Kysely<any>` (the structural handle is intentional — migrations should
   not depend on the typed `Database` interface, which evolves).
3. Use the helpers in `_common.ts` (`attachAppendOnlyTriggers`,
   `dropAppendOnlyTriggers`) for any append-only table.
4. Record the JSONB paper trail (B23b): every `JSONB` column needs a
   `COMMENT ON COLUMN <tbl>.<col>` matching the regex
   `purpose=.+; expected_size_bytes=\d+; if_larger=...`.
5. No inline blobs. Object-storage references use the
   `(object_storage_key TEXT, sha256 CHAR(64), size_bytes BIGINT)` triple
   with `CHECK (sha256 ~ '^[a-f0-9]{64}$')`.
6. Never bake `now()` / `gen_random_uuid()` into structural DDL — only as
   column defaults. The migration must produce identical schemas across
   reapplications, which `db:migrate:check` verifies.
7. Update `packages/db/src/schema.ts` so the Kysely `Database` interface
   matches the new table.

## The append-only trigger contract

Migration `011_audit_events.ts` creates a single shared plpgsql function:

```sql
CREATE OR REPLACE FUNCTION enforce_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % rejected',
    TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
```

Every append-only table attaches **two** triggers via `attachAppendOnlyTriggers(db, 'tbl')`:

1. `<tbl>_no_update_delete` — `BEFORE UPDATE OR DELETE FOR EACH ROW` (catches
   row-level mutations).
2. `<tbl>_no_truncate` — `BEFORE TRUNCATE FOR EACH STATEMENT` (catches the
   one operation that doesn't fire row triggers).

Down paths drop the triggers in reverse order.

## CI / digest pinning

The Postgres image is pinned by sha256 digest in BOTH:

- `infra/docker/docker-compose.local.yml` (developer use)
- `.github/workflows/ci.yml` `services.postgres.image` (CI)

To bump the digest:

```sh
docker pull postgres:16-alpine
docker images --digests postgres
# copy the sha256 line into both files; CI re-runs the schema dump diff
# after the bump to catch any drift in default extensions or system catalogs.
```

## Authoring a broken-migration test fixture

Place under `tests/fixtures/migrations/broken/_NNN_<name>.ts`. Example: a
migration that creates a table then throws — the integration test asserts
(a) the error propagates, (b) the partial schema artifact does NOT exist
in `information_schema.tables` (transaction rolled back), (c) the
`kysely_migration` bookkeeping table records the migration as not-applied.

## Common pitfalls

- **Cyrillic path bug.** Any new path-handling script under
  `packages/db/scripts/` MUST use
  `import { fileURLToPath } from 'node:url'; const here = fileURLToPath(new URL('.', import.meta.url));`
  rather than `URL.pathname` directly. Also avoid `path.dirname(import.meta.url)`
  (keeps the `file://` scheme prefix) and bare `__dirname` (CommonJS-only).
  Sprint 2 contract B25 + `tests/integration/db/path-footguns.test.ts` enforce
  this rule.
- **`_common.ts` shadowing.** The Kysely `FileMigrationProvider` is wrapped
  by `FilteredFileMigrationProvider` so it ignores any module starting with
  `_`. Never name a real migration with a leading underscore.
- **JSONB > 64 KiB.** Cannot be enforced statically. The `COMMENT ON COLUMN`
  paper trail (B23b) is the soft enforcement. If a column repeatedly exceeds
  the documented size, externalise to an artifact row with the
  `(object_storage_key, sha256, size_bytes)` triple.
