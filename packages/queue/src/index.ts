// Sprint 7 — public surface for @cyberstrike/queue.

export const name = 'packages/queue' as const;

export {
  ENVELOPE_KINDS,
  EnvelopeValidationError,
  JOB_STATUSES,
  ScopeDenyError,
} from './types.ts';
export type {
  EnvelopeKind,
  Handler,
  HandlerOutcome,
  JobEnvelope,
  JobStatus,
  PublishResult,
  QueueAdapter,
  Subscription,
  SubscribeOptions,
} from './types.ts';
export { jobEnvelopeSchema, parseEnvelope } from './envelope.ts';
export type { EnvelopeParseResult, JobEnvelopeShape } from './envelope.ts';
export { classifyError, decideRetry, nextDelayMs } from './retry-classifier.ts';
export type { RetryClass, RetryDecision } from './retry-classifier.ts';
export { LocalQueueAdapter } from './local-adapter.ts';
export type { LocalQueueAdapterDeps } from './local-adapter.ts';
