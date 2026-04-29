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
  CLOUD_PROVIDERS,
  type CloudProvider,
  HTTP_METHODS,
  type HttpMethod,
  PROTOCOLS,
  type Protocol,
  RULE_KINDS,
  type RuleKind,
  SCOPE_EFFECTS,
  type ScopeEffect,
  type ScopeRule,
  type StrictScopeRule,
  TOOL_CATEGORIES,
  type ToolCategory,
  VCS_PROVIDERS,
  type VcsProvider,
  type LegacyScopeRule,
  scopeRuleSchema,
  strictScopeRuleSchema,
  legacyScopeRulePayload,
} from './scope-rules.ts';

// Sprint 6 — scope-engine action input + decision DTO.
export {
  SCOPE_ACTION_KINDS,
  type ScopeActionInput,
  type ScopeActionKind,
  scopeActionInputSchema,
} from './scope-action.ts';

export {
  DECISION_REASONS,
  type Decision,
  type DecisionReason,
  type ScopeValidateRequest,
  type ScopeValidateResponse,
  decisionReasonSchema,
  decisionSchema,
  scopeValidateRequestSchema,
  scopeValidateResponseSchema,
} from './scope-validate.ts';
