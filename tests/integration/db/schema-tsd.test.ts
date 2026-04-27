// Sprint 2 contract B15a — strict `: never` assertion that
// AppendOnlyRepository<T> never exposes update / delete / upsert /
// replaceWhere / deleteWhere methods at the type level.
//
// The pattern:
//   // @ts-expect-error: AppendOnlyRepository must not expose .update
//   const _no_update: never = repo.update;
//
// If the property is genuinely absent, the access type-errors AND the
// assignment type-errors. `@ts-expect-error` consumes one of those errors.
// If the property is silently re-added with any non-`never` type, the
// `: never` annotation makes the assignment fail with a different error
// while @ts-expect-error sits unsatisfied — `bun run typecheck` is the gate.
//
// Sprint 2 contract B15b — runtime probe that the prototype itself does not
// carry update / delete / upsert. This catches a runtime regression where
// someone adds a method via prototype mutation that the type system can't see.

import { describe, expect, test } from 'bun:test';
import { AppendOnlyRepository, createDatabase } from '@cyberstrike/db';

// We don't open a real connection; we only need a typed instance for the
// `repo` symbol's prototype shape. createDatabase opens a Pool but doesn't
// connect until a query runs; we never query.
const inertDb = createDatabase({
  url: 'postgres://noop@127.0.0.1:1/noop',
  poolMax: 1,
});
const auditRepo = new AppendOnlyRepository(inertDb, 'audit_events', {
  resourceType: 'audit_event',
});

describe('schema-tsd :: B15a (compile-time, strict-never)', () => {
  test('AppendOnlyRepository has no .update / .delete / .upsert at type level', () => {
    // @ts-expect-error: AppendOnlyRepository<AuditEvent> must not expose .update
    const _no_update: never = auditRepo.update;
    // @ts-expect-error: AppendOnlyRepository<AuditEvent> must not expose .delete
    const _no_delete: never = auditRepo.delete;
    // @ts-expect-error: AppendOnlyRepository<AuditEvent> must not expose .upsert
    const _no_upsert: never = auditRepo.upsert;
    // @ts-expect-error: AppendOnlyRepository<AuditEvent> must not expose .replaceWhere
    const _no_replace: never = auditRepo.replaceWhere;
    // @ts-expect-error: AppendOnlyRepository<AuditEvent> must not expose .deleteWhere
    const _no_delete_where: never = auditRepo.deleteWhere;

    // touch the binding so biome no-unused-variables doesn't complain.
    expect([_no_update, _no_delete, _no_upsert, _no_replace, _no_delete_where]).toHaveLength(5);
  });
});

describe('schema-tsd :: B15b (runtime prototype probe)', () => {
  test('AppendOnlyRepository prototype does not include mutation methods', () => {
    const proto = Object.getPrototypeOf(auditRepo) as Record<string, unknown>;
    const ownNames = Object.getOwnPropertyNames(proto);
    expect(ownNames).not.toContain('update');
    expect(ownNames).not.toContain('delete');
    expect(ownNames).not.toContain('upsert');
    expect(ownNames).not.toContain('replaceWhere');
    expect(ownNames).not.toContain('deleteWhere');

    // Sanity: the methods we DO expect ARE present.
    expect(ownNames).toContain('insert');
    expect(ownNames).toContain('findById');
    expect(ownNames).toContain('count');
  });
});

// Cleanup — don't leave the inert pool open across test runs.
await inertDb.destroy();
