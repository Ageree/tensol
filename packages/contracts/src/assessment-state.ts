// Sprint 5 A-State-1..5 — assessment state machine pure function.
//
// Single source of truth for the assessment lifecycle. Routes invoke
// `transition(...)`; they do not encode the state graph independently. The
// Sprint 7 coordinator imports the same function — no parallel graph
// (ADR 0005 §Decision rule #1).
//
// 8-state enum reused as-is from migration 004's CHECK constraint
// (ADR 0005 §Decision rule #2). `starting`/`resuming`/`cancelling` deferred
// to Sprint 7 with the queue-dispatch work.
//
// Pure: no I/O, no clock, no random. The route layer evaluates temporal
// gates (R8 testingWindow) AFTER calling `transition('approved','start')`
// and BEFORE the DB write commits — see ADR 0005 §Decision rule #4.

export const ASSESSMENT_STATES = [
  'draft',
  'submitted',
  'approved',
  'running',
  'paused',
  'cancelled',
  'completed',
  'failed',
] as const;

export type AssessmentState = (typeof ASSESSMENT_STATES)[number];

export const ASSESSMENT_COMMANDS = [
  'submit',
  'approve',
  'start',
  'pause',
  'resume',
  'cancel',
  'markCompleted',
  'markFailed',
] as const;

export type AssessmentCommand = (typeof ASSESSMENT_COMMANDS)[number];

/**
 * Terminal states: no further commands accepted. Returning a typed
 * `TerminalStateError` lets the route layer respond with 409 + a deterministic
 * error code.
 */
export const TERMINAL_STATES: ReadonlyArray<AssessmentState> = Object.freeze([
  'cancelled',
  'completed',
  'failed',
]);

const isTerminal = (s: AssessmentState): boolean =>
  (TERMINAL_STATES as ReadonlyArray<string>).includes(s);

/**
 * Transition table — every allowed (command, from-states) → to-state.
 * Anything not listed here is a typed rejection.
 */
interface TransitionRule {
  readonly from: ReadonlyArray<AssessmentState>;
  readonly to: AssessmentState;
}

const TRANSITIONS: Readonly<Record<AssessmentCommand, TransitionRule>> = Object.freeze({
  submit: { from: ['draft'] as const, to: 'submitted' },
  approve: { from: ['submitted'] as const, to: 'approved' },
  start: { from: ['approved'] as const, to: 'running' },
  pause: { from: ['running'] as const, to: 'paused' },
  resume: { from: ['paused'] as const, to: 'running' },
  cancel: {
    from: ['draft', 'submitted', 'approved', 'running', 'paused'] as const,
    to: 'cancelled',
  },
  markCompleted: { from: ['running', 'paused'] as const, to: 'completed' },
  markFailed: { from: ['submitted', 'approved', 'running', 'paused'] as const, to: 'failed' },
});

// =============================================================================
// Errors (typed)
// =============================================================================

export class InvalidStateTransitionError extends Error {
  public readonly from: AssessmentState;
  public readonly command: AssessmentCommand;
  public readonly allowedFromStates: ReadonlyArray<AssessmentState>;
  constructor(
    from: AssessmentState,
    command: AssessmentCommand,
    allowedFromStates: ReadonlyArray<AssessmentState>,
  ) {
    super(`invalid transition: ${command} from ${from}`);
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.command = command;
    this.allowedFromStates = allowedFromStates;
  }
}

export class TerminalStateError extends Error {
  public readonly state: AssessmentState;
  constructor(state: AssessmentState) {
    super(`assessment is in terminal state: ${state}`);
    this.name = 'TerminalStateError';
    this.state = state;
  }
}

export type StateError = InvalidStateTransitionError | TerminalStateError;

// =============================================================================
// Result type — Ok | Err
// =============================================================================

export type StateResult =
  | { readonly ok: true; readonly to: AssessmentState }
  | { readonly ok: false; readonly error: StateError };

// =============================================================================
// transition() — the single source of truth
// =============================================================================

export const transition = (current: AssessmentState, command: AssessmentCommand): StateResult => {
  if (isTerminal(current)) {
    return { ok: false, error: new TerminalStateError(current) };
  }
  const rule = TRANSITIONS[command];
  if ((rule.from as ReadonlyArray<string>).includes(current)) {
    return { ok: true, to: rule.to };
  }
  return {
    ok: false,
    error: new InvalidStateTransitionError(current, command, rule.from),
  };
};

/**
 * Returns the list of commands that are valid from the given state. Used by
 * `GET /assessments/:id/status` to populate `transitionsAvailable` (A-Asm-10).
 * Pure derivation from the same `TRANSITIONS` table — single source of truth.
 */
export const transitionsAvailable = (
  current: AssessmentState,
): ReadonlyArray<AssessmentCommand> => {
  if (isTerminal(current)) return Object.freeze([]);
  const out: AssessmentCommand[] = [];
  for (const command of ASSESSMENT_COMMANDS) {
    const rule = TRANSITIONS[command];
    if ((rule.from as ReadonlyArray<string>).includes(current)) {
      out.push(command);
    }
  }
  return Object.freeze(out);
};
