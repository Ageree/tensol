// Audit envelope contracts — Sprint 4 A2/A3/A4.
//
// Single source of truth for the AuditEventEnvelope shape, AuditAction union,
// AuditOutcome union, and the closed ServiceActor enum. The runtime audit
// writer in packages/audit and every emission call site (auth routes today,
// CRUD routes in Sprint 5+, deny pipeline in Sprint 4) parse against these.

import { z } from 'zod';

// ============================================================================
// Service actors — closed set (A5/CF-6, Sprint 7+ plug-in point)
// ============================================================================

/**
 * Service actor IDs reserved for Sprints 7+. Closed set: adding a 5th value
 * without updating service-actors.test.ts must fail CI. The IDs are stable
 * lowercase-kebab-case literals; their human-readable names live in
 * `packages/audit/src/service-actors.ts` so the contract package stays
 * runtime-side-effect-free.
 */
export const SERVICE_ACTOR_IDS = [
  'coordinator',
  'browser-worker',
  'validator-worker',
  'report-builder',
  // Sprint 21 — recon-runner PD-stack service.
  'recon-runner',
] as const;

export type ServiceActorId = (typeof SERVICE_ACTOR_IDS)[number];

export const serviceActorIdSchema = z.enum(SERVICE_ACTOR_IDS);

// ============================================================================
// Audit actions — exhaustive union
// ============================================================================

export const AUDIT_ACTIONS = [
  // Sprint 3 auth surface — preserved verbatim.
  'auth.register',
  'auth.login.password',
  'auth.login.mfa',
  'auth.logout',
  'auth.mfa.enable',
  'auth.mfa.verify',
  'auth.password.reset.request',
  'auth.password.reset.confirm',
  // Sprint 4 deny pipeline — A3.
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
  // Sprint 13 codex P1-A — per-candidate scope gate: out-of-scope candidates
  // are dropped (no DB persist, no queue publish) and emit this audit event.
  'decepticon.candidate.denied',
  // Sprint 14 — report builder lifecycle.
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
  // Sprint 15 codex adversarial — scope unavailable or target URL denied before recipe executes.
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
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditActionSchema = z.enum(AUDIT_ACTIONS);

// ============================================================================
// Audit outcomes — exhaustive union
// ============================================================================

export const AUDIT_OUTCOMES = [
  // Sprint 3 outcomes — preserved verbatim.
  'success',
  'failure',
  'mfa_required',
  'gone',
  'no_session',
  'issued',
  'miss',
  'replay',
  // Sprint 4 deny outcomes — A4.
  'denied',
  'forbidden',
  'cross_tenant',
] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const auditOutcomeSchema = z.enum(AUDIT_OUTCOMES);

// ============================================================================
// Audit actor — user OR service (closed)
// ============================================================================

const userActorSchema = z
  .object({
    type: z.literal('user'),
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

const serviceActorSchema = z
  .object({
    type: z.literal('service'),
    id: serviceActorIdSchema,
    name: z.string().min(1),
  })
  .strict();

export const auditActorSchema = z.discriminatedUnion('type', [userActorSchema, serviceActorSchema]);

export type AuditActor = z.infer<typeof auditActorSchema>;

// ============================================================================
// Audit envelope — A2
// ============================================================================

const uuidSchema = z.string().uuid();
const traceIdSchema = z.string().regex(/^[0-9a-f]{32}$/, 'traceId must be 32 hex chars');

/**
 * `before` and `after` are JSON-serialisable values (object|array|primitive|null)
 * captured before and after a state-changing API action. Both are optional —
 * many actions (e.g. login attempts) don't have a before/after pair. The
 * redact() pipeline strips secrets before they land in either field.
 */
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const auditEventEnvelopeSchema = z
  .object({
    id: uuidSchema,
    actor: auditActorSchema,
    tenantId: uuidSchema,
    projectId: uuidSchema.nullable(),
    assessmentId: uuidSchema.nullable(),
    action: auditActionSchema,
    resourceType: z.string().min(1),
    resourceId: z.string().min(1).nullable(),
    before: jsonValueSchema.optional(),
    after: jsonValueSchema.optional(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    traceId: traceIdSchema,
    outcome: auditOutcomeSchema,
    occurredAt: z.string().datetime(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export type AuditEventEnvelope = z.infer<typeof auditEventEnvelopeSchema>;
