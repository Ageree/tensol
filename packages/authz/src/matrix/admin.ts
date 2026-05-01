// S23 cleanup: all roles → all-allow admin permissions.
// The fine-grained per-role matrix files (auditor, developer, operator,
// platform_admin, security_lead, tenant_admin, viewer) are deleted; every
// role now gets unconditional allow on every resource×action cell.
// Role names are preserved for backward-compat with DB seeds and fixtures.

import type { Decision } from '../decision.ts';
import { buildKey } from '../decision.ts';
import { ACTIONS } from '../actions.ts';
import { RESOURCES } from '../resources.ts';
import { ROLES } from '../roles.ts';

const buildAllowMatrix = (): Map<string, Decision> => {
  const m = new Map<string, Decision>();
  for (const role of ROLES) {
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        const key = buildKey(role, resource, action);
        m.set(
          key,
          Object.freeze({
            allowed: true,
            reason: 'admin: all-allow (S23 cleanup)',
            matchedRuleKey: key,
          }),
        );
      }
    }
  }
  return m;
};

export const adminMatrix: ReadonlyMap<string, Decision> = buildAllowMatrix();
