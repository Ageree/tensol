import { describe, expect, test } from 'bun:test';
import {
  ENVELOPE_KINDS,
  EnvelopeValidationError,
  JOB_STATUSES,
  LocalQueueAdapter,
  ScopeDenyError,
  classifyError,
  decideRetry,
  jobEnvelopeSchema,
  nextDelayMs,
  parseEnvelope,
} from './index.ts';

describe('packages/queue :: public surface', () => {
  test('exports envelope kinds enum (closed-set)', () => {
    expect(ENVELOPE_KINDS).toEqual([
      'assessment.start',
      'recon.browser.placeholder',
      'decepticon.findings',
    ]);
  });

  test('exports job statuses enum (matches DB CHECK constraint)', () => {
    expect(JOB_STATUSES).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed_transient',
      'failed_terminal',
    ]);
  });

  test('exports parseEnvelope as the safe-parse boundary', () => {
    expect(typeof parseEnvelope).toBe('function');
    expect(parseEnvelope(null).ok).toBe(false);
  });

  test('exports jobEnvelopeSchema for downstream consumers', () => {
    expect(jobEnvelopeSchema).toBeDefined();
  });

  test('exports retry-classifier helpers', () => {
    expect(typeof classifyError).toBe('function');
    expect(typeof nextDelayMs).toBe('function');
    expect(typeof decideRetry).toBe('function');
  });

  test('exports LocalQueueAdapter class', () => {
    expect(LocalQueueAdapter).toBeDefined();
    expect(typeof LocalQueueAdapter).toBe('function');
  });

  test('exports terminal-classified error subclasses', () => {
    expect(new EnvelopeValidationError('x').__terminal).toBe(true);
    expect(new ScopeDenyError('reason', []).__terminal).toBe(true);
  });
});
