// Sprint 10 — packages/validators public surface.

export const name = 'packages/validators' as const;

export {
  VALIDATION_CONFIDENCES,
  VALIDATION_PROOF_TYPES,
  VALIDATION_STATUSES,
  type Validator,
  type ValidationConfidence,
  type ValidationInput,
  type ValidationProofType,
  type ValidationResult,
  type ValidationStatus,
  validationInputSchema,
  validationResultSchema,
} from './contract.ts';

export {
  NONCE_REGEX,
  buildXssPayload,
  generateNonce,
  nonceMatchesEcho,
  taggedConsoleMessage,
} from './nonce.ts';

export {
  BrowserReplayTimeoutError,
  FakeXssReplayDriver,
  NotImplementedError,
  RealXssReplayDriver,
  selectXssReplayDriver,
  type FakeXssReplayDriverDeps,
  type SelectXssReplayDriverOptions,
  type XssReplayDriver,
  type XssReplayDriverChoice,
  type XssReplayInput,
  type XssReplayResult,
} from './xss-replay-driver.ts';

export {
  validateXssReflected,
  type ValidatorScopeDeps,
  type XssDriverRunSnapshot,
  type XssValidatorDeps,
} from './xss.ts';

export {
  collectEvidence,
  evidenceObjectKey,
  type EvidenceBlob,
  type EvidenceKind,
} from './evidence-collector.ts';
