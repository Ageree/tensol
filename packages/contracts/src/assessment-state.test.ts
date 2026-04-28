// A-State-4 — table-driven 64-case unit test (8 states × 8 commands).
//
// The expected matrix is generated FROM the same fields that drive the
// runtime behaviour (TRANSITIONS table embedded in assessment-state.ts).
// We mirror those expected outcomes here as data, not as imperative code,
// so that drift between contract A-State-3 and the runtime would fail the
// test.

import { describe, expect, test } from 'bun:test';
import {
  ASSESSMENT_COMMANDS,
  ASSESSMENT_STATES,
  type AssessmentCommand,
  type AssessmentState,
  InvalidStateTransitionError,
  TERMINAL_STATES,
  TerminalStateError,
  transition,
  transitionsAvailable,
} from './assessment-state.ts';

// Expected outcomes per A-State-3. `null` means rejection (the kind of
// rejection — InvalidStateTransitionError vs TerminalStateError — depends on
// whether `from` is terminal).
const EXPECTED: Readonly<Record<AssessmentCommand, ReadonlySet<AssessmentState>>> = {
  submit: new Set<AssessmentState>(['draft']),
  approve: new Set<AssessmentState>(['submitted']),
  start: new Set<AssessmentState>(['approved']),
  pause: new Set<AssessmentState>(['running']),
  resume: new Set<AssessmentState>(['paused']),
  cancel: new Set<AssessmentState>(['draft', 'submitted', 'approved', 'running', 'paused']),
  markCompleted: new Set<AssessmentState>(['running', 'paused']),
  markFailed: new Set<AssessmentState>(['submitted', 'approved', 'running', 'paused']),
};

const TO_STATE: Readonly<Record<AssessmentCommand, AssessmentState>> = {
  submit: 'submitted',
  approve: 'approved',
  start: 'running',
  pause: 'paused',
  resume: 'running',
  cancel: 'cancelled',
  markCompleted: 'completed',
  markFailed: 'failed',
};

describe('packages/contracts :: assessment-state — 64-case matrix (A-State-4)', () => {
  test('cardinality is 8 states × 8 commands = 64', () => {
    expect(ASSESSMENT_STATES).toHaveLength(8);
    expect(ASSESSMENT_COMMANDS).toHaveLength(8);
    expect(ASSESSMENT_STATES.length * ASSESSMENT_COMMANDS.length).toBe(64);
  });

  for (const from of ASSESSMENT_STATES) {
    for (const command of ASSESSMENT_COMMANDS) {
      const isAllowed = EXPECTED[command].has(from);
      const isTerminal = (TERMINAL_STATES as ReadonlyArray<string>).includes(from);
      const label = `${from} + ${command} → ${
        isTerminal
          ? 'TerminalStateError'
          : isAllowed
            ? `ok(${TO_STATE[command]})`
            : 'InvalidStateTransitionError'
      }`;
      test(label, () => {
        const result = transition(from, command);
        if (isTerminal) {
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(TerminalStateError);
            expect((result.error as TerminalStateError).state).toBe(from);
          }
          return;
        }
        if (isAllowed) {
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.to).toBe(TO_STATE[command]);
          return;
        }
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidStateTransitionError);
          const e = result.error as InvalidStateTransitionError;
          expect(e.from).toBe(from);
          expect(e.command).toBe(command);
          expect([...e.allowedFromStates].sort()).toEqual([...EXPECTED[command]].sort());
        }
      });
    }
  }
});

describe('packages/contracts :: terminal states (A-State-3)', () => {
  test('TERMINAL_STATES = [cancelled, completed, failed]', () => {
    expect([...TERMINAL_STATES]).toEqual(['cancelled', 'completed', 'failed']);
  });

  test('every command on every terminal state → TerminalStateError', () => {
    for (const from of TERMINAL_STATES) {
      for (const command of ASSESSMENT_COMMANDS) {
        const result = transition(from, command);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(TerminalStateError);
        }
      }
    }
  });
});

describe('packages/contracts :: transitionsAvailable() — derived from same table (A-Asm-10)', () => {
  test('terminal state → empty array', () => {
    for (const s of TERMINAL_STATES) {
      expect(transitionsAvailable(s)).toEqual([]);
    }
  });

  test('draft → [submit, cancel]', () => {
    expect([...transitionsAvailable('draft')].sort()).toEqual(['cancel', 'submit']);
  });

  test('submitted → [approve, cancel, markFailed]', () => {
    expect([...transitionsAvailable('submitted')].sort()).toEqual([
      'approve',
      'cancel',
      'markFailed',
    ]);
  });

  test('approved → [start, cancel, markFailed]', () => {
    expect([...transitionsAvailable('approved')].sort()).toEqual(['cancel', 'markFailed', 'start']);
  });

  test('running → [pause, cancel, markCompleted, markFailed]', () => {
    expect([...transitionsAvailable('running')].sort()).toEqual([
      'cancel',
      'markCompleted',
      'markFailed',
      'pause',
    ]);
  });

  test('paused → [resume, cancel, markCompleted, markFailed]', () => {
    expect([...transitionsAvailable('paused')].sort()).toEqual([
      'cancel',
      'markCompleted',
      'markFailed',
      'resume',
    ]);
  });
});

describe('packages/contracts :: purity (A-State-1)', () => {
  test('transition() returns same StateResult for same inputs across many calls', () => {
    const r1 = transition('draft', 'submit');
    const r2 = transition('draft', 'submit');
    const r3 = transition('draft', 'submit');
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  test('rejection results carry stable, comparable error properties', () => {
    const r = transition('draft', 'approve');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(InvalidStateTransitionError);
      const e = r.error as InvalidStateTransitionError;
      expect(e.from).toBe('draft');
      expect(e.command).toBe('approve');
      expect([...e.allowedFromStates]).toEqual(['submitted']);
    }
  });
});
