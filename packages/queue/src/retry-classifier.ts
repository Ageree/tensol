// Sprint 7 §5.2 A-Q-Retry-1..3 — error classification + exponential backoff.
//
// Default to terminal (fail-closed) for unknown errors — forward-compat
// security: a new error type never silently retries forever.

export type RetryClass = 'transient' | 'terminal';

const TRANSIENT_NAMES = new Set(['NetworkError', 'TimeoutError']);
const TRANSIENT_PATTERN = /ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|\b5\d\d\b/;

interface MaybeTerminal {
  readonly __terminal?: unknown;
}

const hasTerminalFlag = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as MaybeTerminal).__terminal === true;

/**
 * A-Q-Retry-1 — classify an error into transient (retry) or terminal (no retry).
 *
 * Transient: network/timeout shapes, 5xx-shaped strings.
 * Terminal: anything tagged `__terminal: true` (envelope validation, scope deny),
 *           anything matching `name === 'ScopeDenyError'`, default fall-through.
 */
export const classifyError = (err: unknown): RetryClass => {
  if (hasTerminalFlag(err)) return 'terminal';
  if (err instanceof Error) {
    if (err.name === 'ScopeDenyError') return 'terminal';
    if (TRANSIENT_NAMES.has(err.name)) return 'transient';
    if (TRANSIENT_PATTERN.test(err.message)) return 'transient';
  }
  return 'terminal';
};

export interface NextDelayInputs {
  readonly attempt: number;
  readonly baseMs?: number;
  readonly capMs?: number;
  /** 0..1 — deterministic test seam. Defaults to Math.random(). */
  readonly random?: () => number;
}

/**
 * A-Q-Retry-2 — exponential backoff with ±25% jitter.
 *
 * `baseMs * 2^attempt`, capped at `capMs`. Jitter: ±25% of the computed delay.
 */
export const nextDelayMs = (inputs: NextDelayInputs): number => {
  const baseMs = inputs.baseMs ?? 200;
  const capMs = inputs.capMs ?? 30_000;
  const random = inputs.random ?? Math.random;
  const raw = baseMs * 2 ** Math.max(0, inputs.attempt);
  const capped = Math.min(raw, capMs);
  const jitter = (random() * 2 - 1) * 0.25 * capped;
  return Math.max(0, Math.round(capped + jitter));
};

export interface RetryDecisionInputs {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly error: unknown;
}

export type RetryDecision =
  | { readonly action: 'retry'; readonly delayMs: number }
  | {
      readonly action: 'failed_terminal';
      readonly reason: 'classified_terminal' | 'attempts_exhausted';
    };

/**
 * A-Q-Retry-3 — terminal envelopes are NEVER retried, even if attempts remain.
 *
 * Caller passes the post-incremented `attempt` (i.e. the count of completed
 * attempts including this failure). Retry happens only when:
 *   classify === 'transient' AND attempt < maxAttempts.
 */
export const decideRetry = (inputs: RetryDecisionInputs): RetryDecision => {
  const cls = classifyError(inputs.error);
  if (cls === 'terminal') {
    return { action: 'failed_terminal', reason: 'classified_terminal' };
  }
  if (inputs.attempt >= inputs.maxAttempts) {
    return { action: 'failed_terminal', reason: 'attempts_exhausted' };
  }
  return {
    action: 'retry',
    delayMs: nextDelayMs({ attempt: inputs.attempt }),
  };
};
