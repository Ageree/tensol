// Sprint 10 — services/validator-worker public surface.

export const name = 'services/validator-worker' as const;

export {
  handleValidateFinding,
  type AssessmentLoader,
  type AssessmentRow,
  type AuditEmitter,
  type AuditEmitterArgs,
  type CandidateLoader,
  type CandidateRow,
  type FindingEvidenceWriter,
  type FindingEvidenceWriterInput,
  type FindingsWriter,
  type FindingsWriterInput,
  type ValidatorWorkerDeps,
} from './worker.ts';

export {
  validateFindingPayloadSchema,
  type ValidateFindingPayload,
} from './payload-schema.ts';
