// Sprint 4 A2-A5: AuditEventEnvelope schema, AuditAction/Outcome exhaustive
// unions, ServiceActor closed enum.

import { describe, expect, test } from 'bun:test';
import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  type AuditAction,
  type AuditOutcome,
  SERVICE_ACTOR_IDS,
  type ServiceActorId,
  auditActionSchema,
  auditEventEnvelopeSchema,
  auditOutcomeSchema,
  serviceActorIdSchema,
} from './audit.ts';

const validUuid = '00000000-0000-4000-8000-000000000001';
const validTrace = '0123456789abcdef0123456789abcdef';
const validIso = '2026-04-27T12:00:00.000Z';

const baseEnvelope = {
  id: validUuid,
  actor: { type: 'user' as const, id: 'u1', name: 'Alice' },
  tenantId: validUuid,
  projectId: null,
  assessmentId: null,
  action: 'auth.login.password' as AuditAction,
  resourceType: 'user',
  resourceId: validUuid,
  ip: '10.0.0.1',
  userAgent: 'curl/8.0',
  traceId: validTrace,
  outcome: 'success' as AuditOutcome,
  occurredAt: validIso,
};

describe('contracts :: AuditAction (A3)', () => {
  test('AUDIT_ACTIONS is the exhaustive set including Sprint 5 lifecycle (16) + Sprint 6 (1) + Sprint 7 (1)', () => {
    const expected = [
      'auth.register',
      'auth.login.password',
      'auth.login.mfa',
      'auth.logout',
      'auth.mfa.enable',
      'auth.mfa.verify',
      'auth.password.reset.request',
      'auth.password.reset.confirm',
      'rbac.deny',
      'tenant.cross_tenant_attempt',
      'audit.append_only_violation',
      // Sprint 5 — projects (3).
      'project.created',
      'project.updated',
      'project.archived',
      // Sprint 5 — targets (4).
      'target.created',
      'target.updated',
      'target.deleted',
      'target.ownership_proof.submitted',
      // Sprint 5 — assessments success (8).
      'assessment.created',
      'assessment.updated',
      'assessment.submitted',
      'assessment.approved',
      'assessment.started',
      'assessment.paused',
      'assessment.resumed',
      'assessment.cancelled',
      // Sprint 5 — assessment deny (R8 testing-window gate).
      'assessment.start.denied',
      // Sprint 6 — scope engine deny event (A-SE-Audit-1).
      'scope.validate.denied',
      // Sprint 7 — coordinator scope-deny terminal failure (A-Q-Audit-1, OQ-3).
      'assessment.failed',
    ];
    expect([...AUDIT_ACTIONS]).toEqual(expected);
  });

  test('zod rejects unknown action', () => {
    expect(auditActionSchema.safeParse('not.a.real.action').success).toBe(false);
  });
});

describe('contracts :: AuditOutcome (A4)', () => {
  test('AUDIT_OUTCOMES is the exhaustive set including Sprint 4 deny outcomes', () => {
    const expected = [
      'success',
      'failure',
      'mfa_required',
      'gone',
      'no_session',
      'issued',
      'miss',
      'replay',
      'denied',
      'forbidden',
      'cross_tenant',
    ];
    expect([...AUDIT_OUTCOMES]).toEqual(expected);
  });

  test('zod rejects unknown outcome', () => {
    expect(auditOutcomeSchema.safeParse('totally_made_up').success).toBe(false);
  });
});

describe('contracts :: ServiceActor closed enum (A5)', () => {
  test('SERVICE_ACTOR_IDS contains exactly the 4 reserved IDs', () => {
    const expected: ServiceActorId[] = [
      'coordinator',
      'browser-worker',
      'validator-worker',
      'report-builder',
    ];
    expect([...SERVICE_ACTOR_IDS]).toEqual(expected);
  });

  test('zod rejects unregistered service-actor id', () => {
    expect(serviceActorIdSchema.safeParse('made-up-worker').success).toBe(false);
  });
});

describe('contracts :: AuditEventEnvelope (A2)', () => {
  test('parses a well-formed user-actor envelope', () => {
    const result = auditEventEnvelopeSchema.safeParse(baseEnvelope);
    expect(result.success).toBe(true);
  });

  test('parses a well-formed service-actor envelope', () => {
    const result = auditEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      actor: { type: 'service', id: 'coordinator', name: 'Coordinator Service' },
    });
    expect(result.success).toBe(true);
  });

  test('rejects extra keys (.strict)', () => {
    const result = auditEventEnvelopeSchema.safeParse({ ...baseEnvelope, surprise: 'extra' });
    expect(result.success).toBe(false);
  });

  test('rejects service-actor with unregistered id', () => {
    const result = auditEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      actor: { type: 'service', id: 'rogue-worker', name: 'Rogue' },
    });
    expect(result.success).toBe(false);
  });

  test('rejects malformed traceId', () => {
    const result = auditEventEnvelopeSchema.safeParse({ ...baseEnvelope, traceId: 'not-hex' });
    expect(result.success).toBe(false);
  });

  test('rejects non-UUID id', () => {
    const result = auditEventEnvelopeSchema.safeParse({ ...baseEnvelope, id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  test('allows null projectId, null assessmentId, null resourceId, null ip, null userAgent', () => {
    const result = auditEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      projectId: null,
      assessmentId: null,
      resourceId: null,
      ip: null,
      userAgent: null,
    });
    expect(result.success).toBe(true);
  });

  test('before / after are optional and accept arbitrary JSON', () => {
    const result = auditEventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      before: { foo: 1, bar: [1, 2, { baz: null }] },
      after: { foo: 2 },
    });
    expect(result.success).toBe(true);
  });
});
