// Sprint 13 — factory that wraps a DecepticonAdapter + runner deps into the
// DecepticonRunner function type expected by handleAssessmentStart / createCoordinator.
//
// Lives in apps/api/src/scope-engine/ so services/coordinator does NOT need
// to import @cyberstrike/decepticon-adapter (kept adapter-agnostic per S8 design).
//
// Usage (API startup):
//   const adapter = selectAdapter({ fixturesDir, env: process.env });
//   const runner = createDecepticonRunner(adapter, { db, objectStorage, queueAdapter });
//   createCoordinator({ ..., decepticonRunner: runner });

import type { Database } from '@cyberstrike/db';
import type { DecepticonAdapter } from '@cyberstrike/decepticon-adapter';
import type { ObjectStorage } from '@cyberstrike/object-storage';
import type { QueueAdapter } from '@cyberstrike/queue';
import type { Kysely } from 'kysely';
import type { StartDecepticonInput } from './start-decepticon-session.ts';
import { startDecepticonSession } from './start-decepticon-session.ts';

export interface DecepticonRunnerDeps {
  readonly db: Kysely<Database>;
  readonly objectStorage: ObjectStorage;
  readonly queueAdapter: QueueAdapter;
  readonly randomUUID?: () => string;
  readonly clockIso?: () => string;
}

/** Matches the DecepticonRunner type in @cyberstrike/coordinator without importing it. */
export type BoundDecepticonRunner = (
  input: StartDecepticonInput,
) => Promise<{ status: 'completed' | 'failed'; failureReason?: string }>;

export const createDecepticonRunner = (
  adapter: DecepticonAdapter,
  deps: DecepticonRunnerDeps,
): BoundDecepticonRunner => {
  return (input) =>
    startDecepticonSession(
      {
        db: deps.db,
        adapter,
        objectStorage: deps.objectStorage,
        queueAdapter: deps.queueAdapter,
        ...(deps.randomUUID ? { randomUUID: deps.randomUUID } : {}),
        ...(deps.clockIso ? { clockIso: deps.clockIso } : {}),
      },
      input,
    );
};
