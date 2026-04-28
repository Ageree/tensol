// Sprint 5 — target DTOs (A-Tgt-1..7).

import { z } from 'zod';

export const TARGET_KINDS = [
  'url',
  'domain',
  'ip',
  'cidr',
  'cloud_account',
  'k8s_namespace',
  'repo',
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const TARGET_OWNERSHIP_STATUSES = ['unverified', 'pending', 'verified'] as const;
export type TargetOwnershipStatus = (typeof TARGET_OWNERSHIP_STATUSES)[number];

export const OWNERSHIP_PROOF_METHODS = ['dns_txt', 'http_meta', 'manual_attestation'] as const;
export type OwnershipProofMethod = (typeof OWNERSHIP_PROOF_METHODS)[number];

/**
 * A-Tgt-2 — strict zod rejects any client-provided `ownership_status`. The
 * server always inserts `'unverified'` on create. Status transitions go
 * through `POST /targets/:id/ownership-proof`.
 */
export const targetCreateSchema = z
  .object({
    kind: z.enum(TARGET_KINDS),
    value: z.string().min(1).max(2048),
  })
  .strict();
export type TargetCreate = z.infer<typeof targetCreateSchema>;

/** A-Tgt-4 — only `value` is patchable. `kind` is immutable post-create. */
export const targetPatchSchema = z
  .object({
    value: z.string().min(1).max(2048),
  })
  .strict();
export type TargetPatch = z.infer<typeof targetPatchSchema>;

/**
 * A-Tgt-5 — ownership-proof body. R1: 8KB cap on evidence (DNS TXT, HTTP
 * meta, manual attestation all fit). Per-method structured validation
 * deferred to Sprint 6 with the scope-engine work.
 */
export const ownershipProofSchema = z
  .object({
    method: z.enum(OWNERSHIP_PROOF_METHODS),
    evidence: z.string().min(1).max(8192),
  })
  .strict();
export type OwnershipProof = z.infer<typeof ownershipProofSchema>;
