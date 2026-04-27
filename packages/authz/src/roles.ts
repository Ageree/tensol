// Sprint 3 contract C5 — exactly these 7 roles, no more, no less.

import { z } from 'zod';

export const ROLES = [
  'platform_admin',
  'tenant_admin',
  'security_lead',
  'operator',
  'developer',
  'auditor',
  'viewer',
] as const;

export type Role = (typeof ROLES)[number];

export const roleSchema = z.enum(ROLES);

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);
