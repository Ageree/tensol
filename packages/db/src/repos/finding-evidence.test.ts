import { describe, expect, test } from 'bun:test';
import { insertFindingEvidence } from './finding-evidence.ts';

const stubDb = (capture: { values?: Record<string, unknown> }): unknown => ({
  insertInto: () => ({
    values: (v: Record<string, unknown>) => {
      capture.values = v;
      return {
        returning: () => ({
          executeTakeFirstOrThrow: async (): Promise<{ id: string }> => ({
            id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          }),
        }),
      };
    },
  }),
});

describe('finding_evidence repo :: JSONB stringify wrap (P1)', () => {
  test('insertFindingEvidence wraps metadata via JSON.stringify', async () => {
    const capture: { values?: Record<string, unknown> } = {};
    const out = await insertFindingEvidence({
      // biome-ignore lint/suspicious/noExplicitAny: stub.
      db: stubDb(capture) as any,
      tenantId: '11111111-1111-1111-1111-111111111111',
      findingId: '22222222-2222-2222-2222-222222222222',
      kind: 'screenshot',
      objectStorageKey: 'tenant/x/finding/y/screenshot-1-aaa.png',
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
      metadata: { attempt: 1, mime: 'image/png' },
    });
    expect(out.id).toMatch(/^[a-f0-9-]{36}$/);
    const v = capture.values ?? {};
    expect(typeof v.metadata).toBe('string');
    const parsed = JSON.parse(String(v.metadata)) as { attempt: number; mime: string };
    expect(parsed.attempt).toBe(1);
    expect(parsed.mime).toBe('image/png');
    expect(v.size_bytes).toBe('100'); // BIGINT → string
    expect(v.kind).toBe('screenshot');
  });
});
