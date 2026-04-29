// Sprint 8 — public re-exports.

export const name = 'packages/decepticon-adapter' as const;

export {
  ADAPTER_KINDS,
  ARTIFACT_KINDS,
  CANDIDATE_TYPES,
  NotImplementedError,
  SESSION_STATUSES,
  SEVERITIES,
  candidateFindingSchema,
  opplanSchema,
  statusEventSchema,
} from './types.ts';
export type {
  AdapterKind,
  Artifact,
  ArtifactKind,
  CandidateFinding,
  CandidateType,
  DecepticonAdapter,
  Opplan,
  SessionHandle,
  SessionStatus,
  Severity,
  StartSessionInput,
  StatusEvent,
} from './types.ts';
export { createFsFixtureLoader, fixtureSchema } from './fixture-loader.ts';
export type { FixtureDefinition, FixtureLoader, FsFixtureLoaderDeps } from './fixture-loader.ts';
export { FakeDecepticonAdapter } from './fake.ts';
export type { FakeAdapterDeps } from './fake.ts';
export { RealDecepticonAdapter } from './real.ts';
export { resolveAdapterKind, selectAdapter } from './select.ts';
export type { SelectAdapterDeps } from './select.ts';
