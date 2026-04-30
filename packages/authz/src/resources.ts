// Sprint 3 contract C7 — resources covered by the matrix.

import { z } from 'zod';

export const RESOURCES = [
  'tenant',
  'user',
  'project',
  'target',
  'assessment',
  'scope_rule',
  'tool_policy',
  'finding',
  'evidence',
  'report',
  'audit_log',
  'skill',
  'tool_catalog',
  // Sprint 16 — encrypted login credentials per target (B19).
  'target_credential',
] as const;

export type Resource = (typeof RESOURCES)[number];

export const resourceSchema = z.enum(RESOURCES);
