// Sprint 7 §5.4 A-Q-Coord-2 step 5 — publish per-target child envelopes
// when scope-engine allows assessment.start.
//
// Child envelopes:
//   - kind = 'recon.browser.placeholder'
//   - inherit traceId, tenantId, projectId, assessmentId from parent
//   - idempotencyKey = `${parent.idempotencyKey}:${targetId}` (OQ-4)
//   - max_attempts capped to 3 (placeholder consumers are no-op)

import type { JobEnvelope, PublishResult, QueueAdapter } from '@cyberstrike/queue';

export interface ChildTargetSpec {
  readonly targetId: string;
  readonly targetUrl: string;
}

export interface PublishChildJobsInputs {
  readonly adapter: QueueAdapter;
  readonly parent: JobEnvelope;
  readonly targets: readonly ChildTargetSpec[];
  /** Test seam — defaults to `crypto.randomUUID()`. */
  readonly randomUUID?: () => string;
  /** Test seam — defaults to `() => new Date().toISOString()`. */
  readonly clockIso?: () => string;
}

export const publishReconChildJobs = async (
  inputs: PublishChildJobsInputs,
): Promise<PublishResult[]> => {
  const randomUUID = inputs.randomUUID ?? (() => crypto.randomUUID());
  const clockIso = inputs.clockIso ?? (() => new Date().toISOString());
  const results: PublishResult[] = [];
  for (const target of inputs.targets) {
    const childEnv: JobEnvelope = {
      jobId: randomUUID(),
      tenantId: inputs.parent.tenantId,
      projectId: inputs.parent.projectId ?? null,
      assessmentId: inputs.parent.assessmentId,
      kind: 'recon.browser.placeholder',
      idempotencyKey: `${inputs.parent.idempotencyKey}:${target.targetId}`,
      createdAt: clockIso(),
      attempt: 0,
      maxAttempts: 3,
      traceId: inputs.parent.traceId, // A-Q-Coord-4 — trace propagation
      payload: {
        targetId: target.targetId,
        targetUrl: target.targetUrl,
        parentJobId: inputs.parent.jobId,
      },
    };
    results.push(await inputs.adapter.publish(childEnv));
  }
  return results;
};
