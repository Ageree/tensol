// Sprint 4 A22 — unit tests for the writer's telemetry isolation guarantee.
// We use a fake Kysely-shaped DB stub so we can assert the writer never
// blocks the audit row even if telemetry throws.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { type EmitAuditArgs, type TelemetryEmit, emitAudit } from './writer.ts';

interface FakeDb {
  readonly inserts: Array<{ table: string; row: Record<string, unknown> }>;
}

const makeDb = (): { db: FakeDb; mock: unknown } => {
  const fake: FakeDb = { inserts: [] };
  const insertInto = (table: string) => ({
    values: (row: Record<string, unknown>) => ({
      execute: async () => {
        fake.inserts.push({ table, row });
      },
    }),
  });
  return { db: fake, mock: { insertInto } };
};

const baseArgs: EmitAuditArgs = Object.freeze({
  tenantId: '00000000-0000-4000-8000-000000000001',
  action: 'auth.login.password',
  outcome: 'success',
  actorType: 'user',
  actorId: 'u1',
  actorName: 'Alice',
  resourceType: 'user',
  resourceId: '00000000-0000-4000-8000-000000000002',
  ip: '10.0.0.1',
  userAgent: 'curl/8.0',
  traceId: '0123456789abcdef0123456789abcdef',
});

const ORIGINAL_SENTRY_DSN = process.env.SENTRY_DSN;

describe('packages/audit :: writer telemetry (A22)', () => {
  beforeEach(() => {
    process.env.SENTRY_DSN = undefined;
  });
  afterEach(() => {
    process.env.SENTRY_DSN = ORIGINAL_SENTRY_DSN;
  });

  test('SENTRY_DSN unset → telemetry call skipped, audit row written', async () => {
    const { db, mock: dbMock } = makeDb();
    const telemetry = mock<TelemetryEmit>(() => {});
    // biome-ignore lint/suspicious/noExplicitAny: stub
    await emitAudit({ db: dbMock as any, telemetry }, baseArgs);
    expect(db.inserts).toHaveLength(1);
    expect(telemetry).toHaveBeenCalledTimes(0);
  });

  test('telemetry succeeds → telemetry called once, audit row written', async () => {
    const { db, mock: dbMock } = makeDb();
    const telemetry = mock<TelemetryEmit>(() => {});
    await emitAudit(
      // biome-ignore lint/suspicious/noExplicitAny: stub
      { db: dbMock as any, telemetry, sentryEnabled: true },
      baseArgs,
    );
    expect(db.inserts).toHaveLength(1);
    expect(telemetry).toHaveBeenCalledTimes(1);
  });

  test('telemetry throws → audit row still written, no exception bubbles, console.warn called', async () => {
    const { db, mock: dbMock } = makeDb();
    const telemetry = mock<TelemetryEmit>(() => {
      throw new Error('SDK exploded');
    });
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn as unknown as typeof console.warn;
    try {
      await emitAudit(
        // biome-ignore lint/suspicious/noExplicitAny: stub
        { db: dbMock as any, telemetry, sentryEnabled: true },
        baseArgs,
      );
    } finally {
      console.warn = originalWarn;
    }
    expect(db.inserts).toHaveLength(1);
    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const arg = warn.mock.calls[0]?.[0] as string;
    const payload = JSON.parse(arg);
    expect(payload).toEqual({
      event: 'telemetry_failure',
      traceId: baseArgs.traceId,
    });
  });

  test('audit row carries the outcome inside after_state', async () => {
    const { db, mock: dbMock } = makeDb();
    // biome-ignore lint/suspicious/noExplicitAny: stub
    await emitAudit({ db: dbMock as any }, { ...baseArgs, metadata: { reason: 'x' } });
    const row = db.inserts[0]?.row as { after_state: { outcome: string; reason: string } };
    expect(row.after_state.outcome).toBe('success');
    expect(row.after_state.reason).toBe('x');
  });
});
