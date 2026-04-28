// Sprint 5 — project DTOs (A-Proj-1..6).

import { z } from 'zod';

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const projectCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
  })
  .strict();
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const projectPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
  })
  .strict();
export type ProjectPatch = z.infer<typeof projectPatchSchema>;

export const projectListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9+/=]+$/)
      .optional(),
  })
  .strict();
