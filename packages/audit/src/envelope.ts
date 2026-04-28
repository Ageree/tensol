// Re-export of the audit envelope schema and types from @cyberstrike/contracts
// so package-internal code (writer.ts, deny.ts, testing.ts) and downstream
// consumers can import `AuditEventEnvelope` etc. from a single namespace.

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
} from '@cyberstrike/contracts';
