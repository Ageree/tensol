// Sprint 7 §5.2 A-Q-Retry-1..3 — retry classifier unit tests.

import { describe, expect, it } from 'bun:test';
import { classifyError, decideRetry, nextDelayMs } from './retry-classifier.ts';
import { EnvelopeValidationError, ScopeDenyError } from './types.ts';

describe('classifyError (A-Q-Retry-1)', () => {
  it('classifies NetworkError as transient', () => {
    const err = new Error('boom');
    err.name = 'NetworkError';
    expect(classifyError(err)).toBe('transient');
  });

  it('classifies TimeoutError as transient', () => {
    const err = new Error('boom');
    err.name = 'TimeoutError';
    expect(classifyError(err)).toBe('transient');
  });

  // Sprint 9 codex iter-2 P1 — browser-worker transient sentinels.
  it('classifies BrowserTimeoutError as transient', () => {
    const err = new Error('browser timeout');
    err.name = 'BrowserTimeoutError';
    expect(classifyError(err)).toBe('transient');
  });

  it('classifies StorageWriteError as transient', () => {
    const err = new Error('disk full');
    err.name = 'StorageWriteError';
    expect(classifyError(err)).toBe('transient');
  });

  it('classifies DbTransientError as transient', () => {
    const err = new Error('connection lost');
    err.name = 'DbTransientError';
    expect(classifyError(err)).toBe('transient');
  });

  it('classifies ECONNREFUSED message as transient', () => {
    expect(classifyError(new Error('ECONNREFUSED 127.0.0.1:5432'))).toBe('transient');
  });

  it('classifies ETIMEDOUT message as transient', () => {
    expect(classifyError(new Error('connect ETIMEDOUT'))).toBe('transient');
  });

  it('classifies EAI_AGAIN message as transient', () => {
    expect(classifyError(new Error('getaddrinfo EAI_AGAIN'))).toBe('transient');
  });

  it('classifies HTTP 503-shaped message as transient', () => {
    expect(classifyError(new Error('upstream returned 503 Service Unavailable'))).toBe('transient');
  });

  it('classifies HTTP 4xx as terminal (default)', () => {
    expect(classifyError(new Error('400 Bad Request'))).toBe('terminal');
  });

  it('classifies plain Error as terminal (fail-closed default)', () => {
    expect(classifyError(new Error('unknown failure'))).toBe('terminal');
  });

  it('classifies ScopeDenyError as terminal', () => {
    expect(classifyError(new ScopeDenyError('denied_by_rule', ['rule-1']))).toBe('terminal');
  });

  it('classifies EnvelopeValidationError as terminal', () => {
    expect(classifyError(new EnvelopeValidationError('bad envelope'))).toBe('terminal');
  });

  it('honours __terminal flag on plain objects', () => {
    expect(classifyError({ message: 'x', __terminal: true })).toBe('terminal');
  });

  it('treats undefined / null / non-error as terminal', () => {
    expect(classifyError(undefined)).toBe('terminal');
    expect(classifyError(null)).toBe('terminal');
    expect(classifyError('string error')).toBe('terminal');
    expect(classifyError(42)).toBe('terminal');
  });
});

describe('nextDelayMs (A-Q-Retry-2)', () => {
  it('returns ~baseMs at attempt 0 with zero-jitter random', () => {
    const delay = nextDelayMs({ attempt: 0, baseMs: 200, random: () => 0.5 });
    expect(delay).toBe(200);
  });

  it('doubles per attempt', () => {
    const noJitter = () => 0.5;
    expect(nextDelayMs({ attempt: 0, baseMs: 200, random: noJitter })).toBe(200);
    expect(nextDelayMs({ attempt: 1, baseMs: 200, random: noJitter })).toBe(400);
    expect(nextDelayMs({ attempt: 2, baseMs: 200, random: noJitter })).toBe(800);
    expect(nextDelayMs({ attempt: 3, baseMs: 200, random: noJitter })).toBe(1600);
  });

  it('caps at capMs (default 30s)', () => {
    const noJitter = () => 0.5;
    expect(nextDelayMs({ attempt: 20, baseMs: 200, random: noJitter })).toBe(30_000);
  });

  it('caps at custom capMs', () => {
    const noJitter = () => 0.5;
    expect(nextDelayMs({ attempt: 10, baseMs: 200, capMs: 5000, random: noJitter })).toBe(5000);
  });

  it('applies +25% jitter when random()=1', () => {
    const delay = nextDelayMs({ attempt: 2, baseMs: 200, random: () => 1 });
    // base = 800; jitter = +25% = +200; total = 1000
    expect(delay).toBe(1000);
  });

  it('applies -25% jitter when random()=0', () => {
    const delay = nextDelayMs({ attempt: 2, baseMs: 200, random: () => 0 });
    // base = 800; jitter = -25% = -200; total = 600
    expect(delay).toBe(600);
  });

  it('never returns negative', () => {
    const delay = nextDelayMs({ attempt: 0, baseMs: 1, random: () => 0 });
    expect(delay).toBeGreaterThanOrEqual(0);
  });
});

describe('decideRetry (A-Q-Retry-3)', () => {
  const transientErr = (() => {
    const err = new Error('ECONNREFUSED');
    err.name = 'NetworkError';
    return err;
  })();
  const terminalErr = new ScopeDenyError('denied', ['r1']);

  it('terminal error → failed_terminal even with attempts remaining', () => {
    const decision = decideRetry({ attempt: 1, maxAttempts: 5, error: terminalErr });
    expect(decision.action).toBe('failed_terminal');
    if (decision.action === 'failed_terminal') {
      expect(decision.reason).toBe('classified_terminal');
    }
  });

  it('transient + attempts remaining → retry with delay', () => {
    const decision = decideRetry({ attempt: 1, maxAttempts: 3, error: transientErr });
    expect(decision.action).toBe('retry');
    if (decision.action === 'retry') {
      expect(decision.delayMs).toBeGreaterThan(0);
    }
  });

  it('transient + attempts exhausted → failed_terminal', () => {
    const decision = decideRetry({ attempt: 3, maxAttempts: 3, error: transientErr });
    expect(decision.action).toBe('failed_terminal');
    if (decision.action === 'failed_terminal') {
      expect(decision.reason).toBe('attempts_exhausted');
    }
  });

  it('transient + attempt > maxAttempts → failed_terminal', () => {
    const decision = decideRetry({ attempt: 4, maxAttempts: 3, error: transientErr });
    expect(decision.action).toBe('failed_terminal');
  });
});
