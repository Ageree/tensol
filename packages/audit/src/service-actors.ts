// Sprint 4 A5/CF-6 — service-actor closed enum.
//
// The 4 service IDs reserved for Sprints 7+ (coordinator + 3 workers) get
// human-readable names here. The set is closed: adding a 5th entry without
// updating service-actors.test.ts must fail CI. The IDs themselves live in
// `@cyberstrike/contracts` so the schema package stays pure.

import { type AuditActor, SERVICE_ACTOR_IDS, type ServiceActorId } from '@cyberstrike/contracts';

export class UnknownServiceActorError extends Error {
  public readonly attemptedId: string;
  constructor(attemptedId: string) {
    super(`Unknown service actor id: ${attemptedId}`);
    this.name = 'UnknownServiceActorError';
    this.attemptedId = attemptedId;
  }
}

const SERVICE_ACTOR_NAMES: Readonly<Record<ServiceActorId, string>> = Object.freeze({
  coordinator: 'Coordinator Service',
  'browser-worker': 'Browser Worker',
  'validator-worker': 'Validator Worker',
  'report-builder': 'Report Builder',
});

export const SERVICE_ACTORS: ReadonlyArray<{
  readonly id: ServiceActorId;
  readonly name: string;
}> = Object.freeze(
  SERVICE_ACTOR_IDS.map((id) => Object.freeze({ id, name: SERVICE_ACTOR_NAMES[id] })),
);

export const serviceActor = (id: ServiceActorId): AuditActor =>
  Object.freeze({
    type: 'service',
    id,
    name: SERVICE_ACTOR_NAMES[id],
  });

/**
 * Runtime guard for ill-typed callers (e.g. plain JS) that bypass the union.
 * Pure TS callers will be caught at compile time by the union.
 */
export const requireRegisteredServiceActorId = (id: string): ServiceActorId => {
  if ((SERVICE_ACTOR_IDS as ReadonlyArray<string>).includes(id)) {
    return id as ServiceActorId;
  }
  throw new UnknownServiceActorError(id);
};

export { SERVICE_ACTOR_IDS, type ServiceActorId };
