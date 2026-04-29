import { describe, expect, test } from 'bun:test';
import {
  VALIDATION_PROOF_TYPES,
  VALIDATION_STATUSES,
  type ValidationResult,
  validationInputSchema,
  validationResultSchema,
} from './contract.ts';

const VALID_RESULT: ValidationResult = {
  status: 'confirmed',
  confidence: 'high',
  proofType: 'dom_nonce_echo',
  requestReplayable: true,
  sideEffectRisk: 'low',
  evidenceIds: [],
  reason: 'two_runs_dom_echo',
  validatedAt: '2026-04-29T12:00:00.000Z',
  log: [{ run: 1 }, { run: 2 }],
};

describe('validators :: contract', () => {
  test('VALIDATION_STATUSES is the closed set in declared order', () => {
    expect([...VALIDATION_STATUSES]).toEqual([
      'confirmed',
      'rejected',
      'inconclusive',
      'needs_human_review',
      'out_of_scope',
    ]);
    expect(VALIDATION_STATUSES.length).toBe(5);
  });

  test('VALIDATION_PROOF_TYPES is the closed set', () => {
    expect([...VALIDATION_PROOF_TYPES]).toEqual([
      'dom_nonce_echo',
      'console_nonce_echo',
      'network_from_script',
      'alert_only',
      'none',
    ]);
  });

  test('validationResultSchema accepts a well-formed confirmed result', () => {
    expect(validationResultSchema.safeParse(VALID_RESULT).success).toBe(true);
  });

  test('validationResultSchema rejects unknown status', () => {
    expect(validationResultSchema.safeParse({ ...VALID_RESULT, status: 'lol' }).success).toBe(
      false,
    );
  });

  test('validationResultSchema rejects extra keys (.strict)', () => {
    expect(
      validationResultSchema.safeParse({
        ...VALID_RESULT,
        surprise: 1,
      }).success,
    ).toBe(false);
  });

  test('validationInputSchema requires uuid + 32-hex traceId + URL affectedUrl', () => {
    const ok = {
      tenantId: '11111111-1111-1111-1111-111111111111',
      projectId: null,
      assessmentId: '22222222-2222-2222-2222-222222222222',
      candidateFindingId: '33333333-3333-3333-3333-333333333333',
      candidateType: 'xss_reflected' as const,
      affectedUrl: 'http://localhost/search?q=x',
      payload: { foo: 1 },
      traceId: '0123456789abcdef0123456789abcdef',
    };
    expect(validationInputSchema.safeParse(ok).success).toBe(true);
    expect(validationInputSchema.safeParse({ ...ok, affectedUrl: 'not-a-url' }).success).toBe(
      false,
    );
    expect(validationInputSchema.safeParse({ ...ok, traceId: 'not-hex' }).success).toBe(false);
  });
});
