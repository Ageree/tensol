// Sprint 3 contract C18 (R6) — assertOwnership.
//
// Compares actor's tenantId against a resource's tenantId. On mismatch
// throws structured RbacDenyError with full context (actorTenantId,
// attemptedResourceType, attemptedResourceId) for audit reconstruction.
// Routes catch this and emit a generic `403 {error: 'forbidden'}` body —
// NEVER include tenant IDs (no enumeration oracle, C18c).

import { RbacDenyError } from '@cyberstrike/authz';

export interface ResourceTenancy {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly resourceTenantId: string;
}

export const assertOwnership = (actorTenantId: string, resource: ResourceTenancy): void => {
  if (actorTenantId === resource.resourceTenantId) return;
  throw new RbacDenyError({
    actorTenantId,
    attemptedResourceType: resource.resourceType,
    attemptedResourceId: resource.resourceId,
    reason: 'cross-tenant access',
  });
};
