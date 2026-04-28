// Sprint 3 contract C8/§4.2 + C10 — auditor RBAC spec.
//
// CRITICAL INVARIANT (C10): for EVERY resource, auditor has `read` and
// `list` allowed; every other action is denied. matrix.test.ts enumerates
// all (auditor, action, resource) combinations to confirm.
//
// This file's spec is intentionally uniform: every resource gets exactly
// `['read', 'list']`. Any other shape would violate C10.

import type { Decision } from '../decision.ts';
import { RESOURCES, type Resource } from '../resources.ts';
import { type RoleSpec, expandRoleSpec } from './spec.ts';

const READ_LIST = ['read', 'list'] as const;

// Build the spec programmatically to make C10 unambiguously true and to
// make adding a new Resource later (Sprint N) trivially safe — auditor's
// invariant is "everywhere read+list, nothing else".
const buildAuditorSpec = (): RoleSpec => {
  const partial: Partial<Record<Resource, ReadonlyArray<'read' | 'list'>>> = {};
  for (const r of RESOURCES) {
    partial[r] = READ_LIST;
  }
  return partial as RoleSpec;
};
const SPEC: RoleSpec = Object.freeze(buildAuditorSpec());

export const auditorMatrix: ReadonlyMap<string, Decision> = expandRoleSpec(
  'auditor',
  SPEC,
  'auditor: read and list every resource (C10 invariant)',
  'auditor: only read|list permitted (C10 invariant)',
);
