// Sprint 10 — services/validator-worker public surface.

export const name = 'services/validator-worker' as const;

export {
  handleValidateFinding,
  handleSsrfReplay,
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
  validateSsrfReplayPayloadSchema,
  type ValidateSsrfReplayPayload,
} from './payload-schema.ts';
