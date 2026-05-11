// Public surface for packages/audit. Sprint 1 invariant A18: name === workspace key.

export const name = 'packages/audit' as const;

// Envelope schema + types — re-exported from @cyberstrike/contracts.
export {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  SERVICE_ACTOR_IDS,
  type AuditAction,
  type AuditActor,
  type AuditEventEnvelope,
  type AuditOutcome,
  type ServiceActorId,
  auditActionSchema,
  auditActorSchema,
  auditEventEnvelopeSchema,
  auditOutcomeSchema,
  serviceActorIdSchema,
} from './envelope.ts';

// Writer (A6) + EE-2 HMAC signing surface.
export {
  type AuditDeps,
  type AuditSigner,
  type EmitAuditArgs,
  type TelemetryEmit,
  buildCanonicalAuditMessage,
  emitAudit,
  hmacSign,
  verifyAuditSignature,
} from './writer.ts';
export { createDbAuditSigner, emitSignedAudit } from './signer.ts';

// Deny (A7).
export { type DenyAction, type DenyAuditArgs, type DenyOutcome, denyAudit } from './deny.ts';

// Service actors (A5/A20).
export {
  SERVICE_ACTORS,
  UnknownServiceActorError,
  requireRegisteredServiceActorId,
  serviceActor,
} from './service-actors.ts';

// Redact (A16).
export {
  CIRCULAR,
  DEFAULT_SECRET_KEYS,
  REDACTED,
  type RedactionConfig,
  redact,
} from './redact.ts';

// Test helpers (A18) — also exported under the `testing` subpath.
export {
  AuditCardinalityError,
  type AuditPredicate,
  assertExactlyOneAuditRow,
  countAuditRows,
} from './testing.ts';
