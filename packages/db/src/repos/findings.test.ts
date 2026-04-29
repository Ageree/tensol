// Sprint 10 — DirectInsertForbidden surface tests for findings repo.
// No-DB. Asserts (a) the ValidationStatusInvariantError guard, (b) the
// JSONB stringify wrap, (c) the module surface (no raw-insert export).

import { describe, expect, test } from 'bun:test';
import * as findingsModule from './findings.ts';
import { ValidationStatusInvariantError, insertConfirmedFinding } from './findings.ts';

const stubDb = (capture: { values?: unknown }): unknown => ({
  insertInto: () => ({
    values: (v: unknown) => {
      capture.values = v;
      return {
        returning: () => ({
          executeTakeFirstOrThrow: async (): Promise<{ id: string }> => ({
            id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          }),
        }),
      };
    },
  }),
});

const baseArgs = (): Parameters<typeof insertConfirmedFinding>[0] => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub.
  db: stubDb({}) as any,
  tenantId: '11111111-1111-1111-1111-111111111111',
  assessmentId: '22222222-2222-2222-2222-222222222222',
  candidateFindingId: '33333333-3333-3333-3333-333333333333',
  type: 'xss_reflected',
  severity: 'high',
  confidence: 'high',
  affectedUrl: 'http://localhost/search?q=x',
  reproduction: { steps: ['nav', 'inject'], nonce: 'a'.repeat(32) },
  validatorLog: [{ run: 1 }, { run: 2 }],
  validatedAt: new Date('2026-04-29T00:00:00.000Z'),
  validatedBy: { status: 'confirmed' },
});

describe('findings repo :: DirectInsertForbidden surface', () => {
  test('module exports ONLY the named-and-allowed symbols (no rawInsert / unsafeInsert)', () => {
    const exported = Object.keys(findingsModule).sort();
    expect(exported).toEqual(
      [
        'ValidationStatusInvariantError',
        'findFindingByCandidateId',
        'insertConfirmedFinding',
        'listFindingsByAssessment',
      ].sort(),
    );
    // Negative assertions — these must NOT exist on the module surface.
    expect(exported).not.toContain('rawInsert');
    expect(exported).not.toContain('unsafeInsert');
    expect(exported).not.toContain('insertWithoutValidation');
  });

  test('rejects validatedBy.status="rejected" with ValidationStatusInvariantError', async () => {
    let caught: unknown = null;
    try {
      await insertConfirmedFinding({
        ...baseArgs(),
        validatedBy: { status: 'rejected' },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof ValidationStatusInvariantError).toBe(true);
    expect((caught as Error).name).toBe('ValidationStatusInvariantError');
  });

  test('rejects each non-confirmed status (rejected/inconclusive/needs_human_review/out_of_scope)', async () => {
    for (const status of [
      'rejected',
      'inconclusive',
      'needs_human_review',
      'out_of_scope',
    ] as const) {
      let caught: unknown = null;
      try {
        await insertConfirmedFinding({
          ...baseArgs(),
          validatedBy: { status },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught instanceof ValidationStatusInvariantError).toBe(true);
    }
  });

  test('confirmed status passes the guard + wraps reproduction/validator_log via JSON.stringify', async () => {
    const capture: { values?: Record<string, unknown> } = {};
    const out = await insertConfirmedFinding({
      ...baseArgs(),
      // biome-ignore lint/suspicious/noExplicitAny: stub.
      db: stubDb(capture) as any,
    });
    expect(out.id).toMatch(/^[a-f0-9-]{36}$/);
    const v = capture.values ?? {};
    expect(typeof v.reproduction).toBe('string');
    expect(typeof v.validator_log).toBe('string');
    // Round-trip the wrap.
    const reproductionParsed = JSON.parse(String(v.reproduction)) as {
      steps: string[];
      nonce: string;
    };
    expect(reproductionParsed.steps.length).toBe(2);
    expect(reproductionParsed.nonce.length).toBe(32);
    const validatorLogParsed = JSON.parse(String(v.validator_log)) as Array<{ run: number }>;
    expect(validatorLogParsed.length).toBe(2);
  });
});
