// Sprint 9 — observations_browser repo unit test (no DB).
//
// Verifies the P1 JSONB pitfall fix: `console_messages` array is wrapped
// via JSON.stringify before the Kysely insert. Without the wrap, Kysely
// silently writes `{}`. We capture the values fed to insertInto().values()
// via a recording-stub Kysely.

import { describe, expect, test } from 'bun:test';
import type { Kysely } from 'kysely';
import type { Database } from '../schema.ts';
import {
  type InsertObservationBrowserInput,
  insertObservationBrowser,
} from './observations-browser.ts';

interface RecordingDb {
  capturedValues: Record<string, unknown> | null;
}

const buildRecordingDb = (): { db: Kysely<Database>; rec: RecordingDb } => {
  const rec: RecordingDb = { capturedValues: null };
  const dbStub = {
    insertInto: (_table: string) => ({
      values: (vals: Record<string, unknown>) => {
        rec.capturedValues = vals;
        return {
          returning: (_cols: ReadonlyArray<string>) => ({
            executeTakeFirstOrThrow: async () => ({ id: 'test-row-id' }),
          }),
        };
      },
    }),
  };
  return { db: dbStub as unknown as Kysely<Database>, rec };
};

const baseInput: InsertObservationBrowserInput = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  assessmentId: '22222222-2222-2222-2222-222222222222',
  url: 'http://localhost:9999/search?q=x',
  httpStatus: 200,
  screenshotObjectKey: 'k1',
  screenshotSha256: 'a'.repeat(64),
  screenshotSizeBytes: 100,
  harObjectKey: 'k2',
  harSha256: 'b'.repeat(64),
  harSizeBytes: 200,
  traceObjectKey: 'k3',
  traceSha256: 'c'.repeat(64),
  traceSizeBytes: 300,
  consoleMessages: [
    {
      level: 'log',
      text: 'navigated:http://localhost:9999/search?q=x',
      tsIso: '2026-04-29T12:00:00.000Z',
    },
    { level: 'warn', text: 'something', tsIso: '2026-04-29T12:00:01.000Z' },
  ],
};

describe('insertObservationBrowser — JSONB pitfall (P1)', () => {
  test('console_messages is wrapped via JSON.stringify (string type at boundary)', async () => {
    const { db, rec } = buildRecordingDb();
    await insertObservationBrowser(db, baseInput);
    expect(rec.capturedValues).toBeDefined();
    const consoleMessagesField = rec.capturedValues?.console_messages;
    // The boundary requires a JSON string — assert this exactly.
    expect(typeof consoleMessagesField).toBe('string');
    const parsed = JSON.parse(consoleMessagesField as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].text).toContain('navigated:');
  });

  test('size_bytes columns are stringified bigint-friendly form', async () => {
    const { db, rec } = buildRecordingDb();
    await insertObservationBrowser(db, baseInput);
    expect(rec.capturedValues?.screenshot_size_bytes).toBe('100');
    expect(rec.capturedValues?.har_size_bytes).toBe('200');
    expect(rec.capturedValues?.trace_size_bytes).toBe('300');
  });

  test('all artifact key/sha columns flow through unchanged', async () => {
    const { db, rec } = buildRecordingDb();
    await insertObservationBrowser(db, baseInput);
    expect(rec.capturedValues?.screenshot_object_key).toBe('k1');
    expect(rec.capturedValues?.screenshot_sha256).toBe('a'.repeat(64));
    expect(rec.capturedValues?.har_object_key).toBe('k2');
    expect(rec.capturedValues?.har_sha256).toBe('b'.repeat(64));
    expect(rec.capturedValues?.trace_object_key).toBe('k3');
    expect(rec.capturedValues?.trace_sha256).toBe('c'.repeat(64));
  });

  test('returns the inserted row id', async () => {
    const { db } = buildRecordingDb();
    const out = await insertObservationBrowser(db, baseInput);
    expect(out.id).toBe('test-row-id');
  });
});
