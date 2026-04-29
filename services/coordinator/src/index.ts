// Sprint 7 §5.4 A-Q-Coord-1 — coordinator factory + lifecycle.
//
// Importable module (OQ-2). Tests run in-process; prod can run as a
// standalone Bun script at services/coordinator/src/main.ts (added later).

export const name = 'services/coordinator' as const;

import type { Database } from '@cyberstrike/db';
import type { QueueAdapter, Subscription } from '@cyberstrike/queue';
import type { EffectiveScope } from '@cyberstrike/scope-engine';
import type { Kysely } from 'kysely';
import { reconPlaceholderHandler } from './placeholder-consumer.ts';
import {
  type CoordinatorScopeDeps,
  type DecepticonRunner,
  handleAssessmentStart,
} from './start-handler.ts';

export type { CoordinatorScopeDeps, DecepticonRunner };
export {
  assessmentStartPayloadSchema,
  decepticonFindingsPayloadSchema,
  reconPlaceholderPayloadSchema,
} from './payloads.ts';
export type {
  AssessmentStartPayload,
  DecepticonFindingsPayload,
  ReconPlaceholderPayload,
} from './payloads.ts';
export { handleAssessmentStart } from './start-handler.ts';
export { publishReconChildJobs } from './child-job.ts';
export { reconPlaceholderHandler } from './placeholder-consumer.ts';

export interface CoordinatorDeps {
  readonly db: Kysely<Database>;
  readonly adapter: QueueAdapter;
  readonly scopeDeps: CoordinatorScopeDeps;
  readonly buildScope: (assessmentId: string) => Promise<EffectiveScope | null>;
  /** Sprint 8 — optional fake-decepticon orchestration runner. */
  readonly decepticonRunner?: DecepticonRunner;
  /** Test seam — passed through to handlers. */
  readonly randomUUID?: () => string;
  readonly clockIso?: () => string;
  /** Test seam — subscribe poll interval. Default 100ms. */
  readonly pollIntervalMs?: number;
  /** Test seam — only-tenant filter. Default null (all tenants). */
  readonly tenantFilter?: string | null;
}

export interface CoordinatorHandle {
  start(): void;
  stop(opts?: { timeoutMs?: number }): Promise<void>;
}

export const createCoordinator = (deps: CoordinatorDeps): CoordinatorHandle => {
  let assessmentStartSub: Subscription | null = null;
  let placeholderSub: Subscription | null = null;
  return {
    start: (): void => {
      const startDeps = {
        db: deps.db,
        adapter: deps.adapter,
        scopeDeps: deps.scopeDeps,
        buildScope: deps.buildScope,
        ...(deps.decepticonRunner ? { decepticonRunner: deps.decepticonRunner } : {}),
        ...(deps.randomUUID ? { randomUUID: deps.randomUUID } : {}),
        ...(deps.clockIso ? { clockIso: deps.clockIso } : {}),
      };
      const subOpts = {
        ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
        ...(deps.tenantFilter !== undefined ? { tenantId: deps.tenantFilter } : {}),
      };
      assessmentStartSub = deps.adapter.subscribe(
        'assessment.start',
        (env) => handleAssessmentStart(startDeps, env),
        subOpts,
      );
      placeholderSub = deps.adapter.subscribe(
        'recon.browser.placeholder',
        reconPlaceholderHandler,
        subOpts,
      );
    },
    stop: async (opts?: { timeoutMs?: number }): Promise<void> => {
      const stopOpts = opts ?? {};
      await Promise.all([
        assessmentStartSub?.stop(stopOpts) ?? Promise.resolve(),
        placeholderSub?.stop(stopOpts) ?? Promise.resolve(),
      ]);
      assessmentStartSub = null;
      placeholderSub = null;
    },
  };
};
