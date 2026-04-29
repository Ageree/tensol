// Sprint 9 §8 — publish `recon.browser` envelopes per declared startUrl.
//
// Sibling of `publishReconChildJobs` (Sprint 7 placeholder). Coordinator
// runs both publishers on the allow path while Sprint 7 ITs still assert
// on the placeholder envelope. Sprint 10+ will retire the placeholder
// once those tests migrate to subscribing on `recon.browser`.
//
// Idempotency key shape: `${parent.idempotencyKey}:browser:${targetId}` —
// distinct from the placeholder key so the two publishers don't collide.

import type { JobEnvelope, PublishResult, QueueAdapter } from '@cyberstrike/queue';

export interface BrowserChildTargetSpec {
  readonly targetId: string;
  readonly startUrl: string;
}

export interface PublishBrowserChildJobsInputs {
  readonly adapter: QueueAdapter;
  readonly parent: JobEnvelope;
  readonly targets: readonly BrowserChildTargetSpec[];
  readonly randomUUID?: () => string;
  readonly clockIso?: () => string;
}

export const publishReconBrowserChildJobs = async (
  inputs: PublishBrowserChildJobsInputs,
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
      kind: 'recon.browser',
      idempotencyKey: `${inputs.parent.idempotencyKey}:browser:${target.targetId}`,
      createdAt: clockIso(),
      attempt: 0,
      maxAttempts: 3,
      traceId: inputs.parent.traceId,
      payload: {
        tenantId: inputs.parent.tenantId,
        projectId: inputs.parent.projectId ?? null,
        assessmentId: inputs.parent.assessmentId,
        targetId: target.targetId,
        startUrl: target.startUrl,
        traceId: inputs.parent.traceId,
      },
    };
    results.push(await inputs.adapter.publish(childEnv));
  }
  return results;
};
