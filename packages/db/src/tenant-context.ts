// Tenant context plumbing.
// Combines two surfaces:
//   1. AsyncLocalStorage-backed ambient context, set via runInTenant(...).
//   2. Explicit `tenantId` argument passed at the repository call site.
//
// Precedence rule (Sprint 2 contract B17 / R1):
//   - explicit arg always wins.
//   - if explicit and ambient both present and DIFFER, throw TenantContextMismatchError.
//   - if neither, throw MissingTenantContextError.
//
// Repository code calls resolveTenantId({explicit, ambient: getTenantId(), context}).

import { AsyncLocalStorage } from 'node:async_hooks';
import { MissingTenantContextError, TenantContextMismatchError } from './errors.ts';

export interface TenantStore {
  readonly tenantId: string;
}

const storage = new AsyncLocalStorage<TenantStore>();

export const runInTenant = <T>(tenantId: string, fn: () => T): T => {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new MissingTenantContextError('runInTenant: tenantId must be a non-empty string');
  }
  return storage.run(Object.freeze({ tenantId }), fn);
};

export const getAmbientTenantId = (): string | undefined => storage.getStore()?.tenantId;

export interface ResolveTenantArgs {
  readonly explicit?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly operation?: string | undefined;
}

export const resolveTenantId = (args: ResolveTenantArgs = {}): string => {
  const ambient = getAmbientTenantId();
  // Treat empty / whitespace explicit as absent — the contract says "explicit
  // arg wins when truthy". Falling through to ambient avoids a footgun where
  // a caller forgets to set tenantId on a partial DTO and accidentally
  // bypasses the ambient guard.
  const explicit =
    typeof args.explicit === 'string' && args.explicit.trim() !== '' ? args.explicit : undefined;

  if (explicit && ambient && explicit !== ambient) {
    throw new TenantContextMismatchError({
      explicit,
      ambient,
      resourceType: args.resourceType,
      operation: args.operation,
    });
  }

  const resolved = explicit ?? ambient;
  if (!resolved) {
    throw new MissingTenantContextError(undefined, {
      resourceType: args.resourceType,
      operation: args.operation,
    });
  }

  return resolved;
};
