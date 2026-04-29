// Sprint 3 contract C6 — actions covered by the matrix. Later sprints may
// add more (e.g. observation streaming controls); for the slice these 14
// cover every gating decision the API needs.

import { z } from 'zod';

export const ACTIONS = [
  'read',
  'list',
  'create',
  'update',
  'delete',
  'submit',
  'approve',
  'start',
  'pause',
  'resume',
  'cancel',
  'change_status',
  'change_scope',
  'change_tool_policy',
  // Sprint 6 A-SE-RBAC-1 — scope-engine validate endpoint.
  'scope_validate',
] as const;

export type Action = (typeof ACTIONS)[number];

export const actionSchema = z.enum(ACTIONS);
