// Sprint 10 — services/validator-worker public surface.

export const name = 'services/validator-worker' as const;

export {
  handleValidateFinding,
  handleSsrfReplay,
  handleLfiReplay,
  handleRceReplay,
  handleSqliReplay,
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
  validateLfiReplayPayloadSchema,
  type ValidateLfiReplayPayload,
  validateRceReplayPayloadSchema,
  type ValidateRceReplayPayload,
  validateSqliReplayPayloadSchema,
  type ValidateSqliReplayPayload,
} from './payload-schema.ts';

export {
  validateSqliCandidate,
  type HttpReplayRequest,
  type HttpReplayResponse,
  type SqliHttpMethod,
  type SqliValidatorInput,
  type SqliValidatorDeps,
  type SqliValidationResult,
  type SqliValidationStatus,
  type SqliEvidence,
} from './sqli-validator.ts';
