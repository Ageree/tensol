export const name = 'packages/contracts' as const;

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
} from './audit.ts';

// Sprint 5 — assessment state machine + DTOs.
export {
  ASSESSMENT_COMMANDS,
  ASSESSMENT_STATES,
  type AssessmentCommand,
  type AssessmentState,
  InvalidStateTransitionError,
  type StateError,
  type StateResult,
  TERMINAL_STATES,
  TerminalStateError,
  transition,
  transitionsAvailable,
} from './assessment-state.ts';

export {
  HIGH_IMPACT_CATEGORIES,
  type HighImpactCategory,
  type AssessmentCreate,
  type AssessmentPatch,
  type TestingWindow,
  assessmentCreateSchema,
  assessmentListQuerySchema,
  assessmentPatchSchema,
} from './assessments.ts';

export {
  PROJECT_STATUSES,
  type ProjectCreate,
  type ProjectPatch,
  type ProjectStatus,
  projectCreateSchema,
  projectListQuerySchema,
  projectPatchSchema,
} from './projects.ts';

export {
  OWNERSHIP_PROOF_METHODS,
  TARGET_KINDS,
  TARGET_OWNERSHIP_STATUSES,
  type OwnershipProof,
  type OwnershipProofMethod,
  type TargetCreate,
  type TargetKind,
  type TargetOwnershipStatus,
  type TargetPatch,
  ownershipProofSchema,
  targetCreateSchema,
  targetPatchSchema,
} from './targets.ts';

export {
  SCOPE_EFFECTS,
  type ScopeEffect,
  type ScopeRule,
  scopeRuleSchema,
} from './scope-rules.ts';
