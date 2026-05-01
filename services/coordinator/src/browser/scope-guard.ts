// Sprint 9 — scope-guard wraps `scope-engine.decide` for HTTP navigation.
//
// Pure function. Given a URL + EffectiveScope + DNS/clock/rateLimit deps,
// returns the decide() result for the canonical http_request action. Used
// by the worker BEFORE any fetch is issued and BEFORE following any
// redirect (closes the Sprint 6 round-2 P1 redirect-target bypass).

import type { ScopeActionInput } from '@cyberstrike/contracts';
import {
  type Clock,
  type Decision,
  type DnsResolver,
  type EffectiveScope,
  type RateLimitCounter,
  decide,
} from '@cyberstrike/scope-engine';

export interface ScopeGuardDeps {
  readonly dns: DnsResolver;
  readonly clock: Clock;
  readonly rateLimit: RateLimitCounter;
}

export const checkNavigation = async (
  scope: EffectiveScope,
  url: string,
  deps: ScopeGuardDeps,
): Promise<Decision> => {
  const action: ScopeActionInput = {
    kind: 'http_request',
    url,
    method: 'GET',
  };
  return decide(scope, action, deps);
};
