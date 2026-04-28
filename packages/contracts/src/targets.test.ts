import { describe, expect, test } from 'bun:test';
import {
  OWNERSHIP_PROOF_METHODS,
  TARGET_KINDS,
  TARGET_OWNERSHIP_STATUSES,
  ownershipProofSchema,
  targetCreateSchema,
  targetPatchSchema,
} from './targets.ts';

describe('contracts :: targets DTOs', () => {
  test('TARGET_KINDS = url|domain|ip|cidr|cloud_account|k8s_namespace|repo', () => {
    expect([...TARGET_KINDS]).toEqual([
      'url',
      'domain',
      'ip',
      'cidr',
      'cloud_account',
      'k8s_namespace',
      'repo',
    ]);
  });

  test('TARGET_OWNERSHIP_STATUSES = unverified|pending|verified', () => {
    expect([...TARGET_OWNERSHIP_STATUSES]).toEqual(['unverified', 'pending', 'verified']);
  });

  test('A-Tgt-2: create rejects client-provided ownership_status', () => {
    const r = targetCreateSchema.safeParse({
      kind: 'url',
      value: 'https://x.io',
      ownership_status: 'verified',
    });
    expect(r.success).toBe(false);
  });

  test('create requires kind + value', () => {
    expect(targetCreateSchema.safeParse({ kind: 'url' }).success).toBe(false);
    expect(targetCreateSchema.safeParse({ value: 'x' }).success).toBe(false);
  });

  test('A-Tgt-4: patch only allows value, not kind', () => {
    const r = targetPatchSchema.safeParse({ value: 'new' });
    expect(r.success).toBe(true);
    expect(targetPatchSchema.safeParse({ kind: 'url' }).success).toBe(false);
  });

  test('A-Tgt-5 R1: ownership-proof evidence capped at 8KB', () => {
    expect(
      ownershipProofSchema.safeParse({
        method: 'dns_txt',
        evidence: 'a'.repeat(8192),
      }).success,
    ).toBe(true);
    expect(
      ownershipProofSchema.safeParse({
        method: 'dns_txt',
        evidence: 'a'.repeat(8193),
      }).success,
    ).toBe(false);
  });

  test('A-Tgt-5: method limited to 3 values', () => {
    expect([...OWNERSHIP_PROOF_METHODS]).toEqual(['dns_txt', 'http_meta', 'manual_attestation']);
    expect(ownershipProofSchema.safeParse({ method: 'made_up', evidence: 'x' }).success).toBe(
      false,
    );
  });
});
