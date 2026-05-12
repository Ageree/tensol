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
  test('AUDIT_ACTIONS is the exhaustive set (S27: 96 post-S26 + 5 auth_proof.* = 101)', () => {
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
      // Sprint 5 — assessments success (8) + EE-1 completion transition (1).
      'assessment.created',
      'assessment.updated',
      'assessment.submitted',
      'assessment.approved',
      'assessment.started',
      'assessment.paused',
      'assessment.resumed',
      'assessment.cancelled',
      // EE-1 (2026-05-12) — success-path terminal transition.
      'assessment.completed',
      // EE-3.B (2026-05-12) — MVP cost cap: action-count quota exceeded → scan halt.
      'assessment.action_cap_exceeded',
      // Sprint 5 — assessment deny (R8 testing-window gate).
      'assessment.start.denied',
      // Sprint 6 — scope engine deny event (A-SE-Audit-1).
      'scope.validate.denied',
      // Sprint 7 — coordinator scope-deny terminal failure (A-Q-Audit-1, OQ-3).
      'assessment.failed',
      // Sprint 8 — fake decepticon adapter session lifecycle + candidate observation.
      'decepticon.session.started',
      'decepticon.session.completed',
      'decepticon.session.failed',
      'decepticon.candidate.observed',
      // Sprint 9 — browser-worker scope-guarded crawl lifecycle.
      'recon.browser.job.started',
      'recon.browser.job.completed',
      'recon.browser.job.failed',
      'recon.browser.navigation.denied',
      'recon.browser.observation.persisted',
      // Sprint 10 — XSS validator + finding creation lifecycle.
      'validation.started',
      'validation.confirmed',
      'validation.rejected',
      'validation.inconclusive',
      'validation.out_of_scope',
      'finding.created',
      // Sprint 11 — finding status workflow.
      'finding.status_changed',
      // Sprint 13 codex P1-A — per-candidate scope gate deny event.
      'decepticon.candidate.denied',
      // Sprint 14 — report builder lifecycle (6).
      'report.build.requested',
      'report.build.started',
      'report.build.completed',
      'report.build.failed',
      'report.finding.excluded_oos',
      'report.downloaded',
      // Sprint 15 — browser auth: login recipe + encrypted credential lifecycle.
      'auth.recipe.executed',
      'auth.credential.encrypted',
      'auth.credential.decrypted',
      'auth.login.failed',
      // Sprint 15 codex adversarial — credential bound to wrong target.
      'auth.credential.target_mismatch',
      // Sprint 15 codex adversarial — scope unavailable or target URL denied.
      'auth.recipe.scope_denied',
      // Sprint 16 — SPA route discovery lifecycle.
      'browser.spa.route.discovered',
      'browser.spa.route.skipped_oos',
      // Sprint 17 — credential read audit.
      'auth.credential.read.viewed',
      // Sprint 18 — SSRF validator (3).
      'validator.ssrf.replay_denied',
      'validator.ssrf.confirmed',
      'validator.ssrf.timeout',
      // Sprint 19 — LFI validator (3) + codex fetch_failed (2).
      'validator.lfi.replay_denied',
      'validator.lfi.confirmed',
      'validator.lfi.unmatched',
      'validator.lfi.fetch_failed',
      'validator.ssrf.fetch_failed',
      // Sprint 20 — RCE validator (4).
      'validator.rce.replay_denied',
      'validator.rce.confirmed',
      'validator.rce.unmatched',
      'validator.rce.fetch_failed',
      // SQLi validator (4) — confirms Decepticon-found SQL injection via HTTP body replay.
      'validator.sqli.replay_denied',
      'validator.sqli.confirmed',
      'validator.sqli.unmatched',
      'validator.sqli.fetch_failed',
      // Sprint 21 — recon-runner PD-stack (10).
      'recon.subfinder.run',
      'recon.subfinder.denied',
      'recon.subfinder.error',
      'recon.httpx.run',
      'recon.httpx.denied',
      'recon.httpx.error',
      'recon.nuclei.run',
      'recon.nuclei.denied',
      'recon.nuclei.error',
      'recon.nuclei.template_match',
      // S23 consolidated actions — tool/kind in metadata field.
      'recon.run.started',
      'recon.run.completed',
      'validator.run.started',
      'validator.run.completed',
      // S24 SaaS self-registration.
      'auth.self_register',
      // S25 domain ownership verification via DNS-TXT.
      'domain.verify.requested',
      'domain.verify.checked',
      'domain.verify.confirmed',
      'domain.verify.failed',
      'domain.verify.expired',
      // S26 scan launch + billing.
      'scan.launched',
      'billing.checkout.completed',
      'billing.subscription.cancelled',
      // S27 target authorization proof.
      'auth_proof.start',
      'auth_proof.verify.success',
      'auth_proof.verify.failure',
      'auth_proof.email.sent',
      'auth_proof.email_link.replay',
    ];
    expect([...AUDIT_ACTIONS]).toEqual(expected);
    // EE-3.B: 102 post-EE-1 + 1 (assessment.action_cap_exceeded) = 103.
    // SQLi validator adds 4 actions (replay_denied/confirmed/unmatched/fetch_failed) → 107.
    expect(AUDIT_ACTIONS.length).toBe(107);
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
  test('SERVICE_ACTOR_IDS contains exactly the 5 reserved IDs', () => {
    const expected: ServiceActorId[] = [
      'coordinator',
      'browser-worker',
      'validator-worker',
      'report-builder',
      // Sprint 21 — recon-runner PD-stack service.
      'recon-runner',
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
