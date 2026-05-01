import { describe, expect, test } from 'bun:test';
import {
  SERVICE_ACTORS,
  SERVICE_ACTOR_IDS,
  UnknownServiceActorError,
  requireRegisteredServiceActorId,
  serviceActor,
} from './service-actors.ts';

describe('packages/audit :: service-actors (A5/A20)', () => {
  test('SERVICE_ACTORS contains exactly 5 entries — closed set', () => {
    expect(SERVICE_ACTORS).toHaveLength(5);
    expect(SERVICE_ACTOR_IDS).toHaveLength(5);
  });

  test('serviceActor() builds a typed AuditActor for each registered id', () => {
    for (const id of SERVICE_ACTOR_IDS) {
      const actor = serviceActor(id);
      expect(actor.type).toBe('service');
      expect(actor.id).toBe(id);
      expect(actor.name.length).toBeGreaterThan(0);
    }
  });

  test('serviceActor() result is frozen', () => {
    const actor = serviceActor('coordinator');
    expect(Object.isFrozen(actor)).toBe(true);
  });

  test('requireRegisteredServiceActorId() accepts each registered id', () => {
    for (const id of SERVICE_ACTOR_IDS) {
      expect(requireRegisteredServiceActorId(id)).toBe(id);
    }
  });

  test('requireRegisteredServiceActorId() throws UnknownServiceActorError on unregistered id', () => {
    expect(() => requireRegisteredServiceActorId('made-up-worker')).toThrow(
      UnknownServiceActorError,
    );
  });
});
