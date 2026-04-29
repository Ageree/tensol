// Sprint 10 — finding_evidence repo (append-only). Single insert path.
//
// JSONB pitfall (P1) — `metadata` is wrapped via JSON.stringify before
// the Kysely insert.

import type { Kysely } from 'kysely';
import type { Database } from '../schema.ts';

export interface InsertFindingEvidenceInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly findingId: string;
  readonly kind: 'screenshot' | 'har' | 'trace' | 'json' | 'log';
  readonly objectStorageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly metadata: Record<string, unknown>;
}

export interface InsertFindingEvidenceResult {
  readonly id: string;
}

export const insertFindingEvidence = async (
  input: InsertFindingEvidenceInput,
): Promise<InsertFindingEvidenceResult> => {
  // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary requires string.
  const metadataJson = JSON.stringify(input.metadata) as any;
  const row = await input.db
    .insertInto('finding_evidence')
    .values({
      tenant_id: input.tenantId,
      finding_id: input.findingId,
      kind: input.kind,
      object_storage_key: input.objectStorageKey,
      sha256: input.sha256,
      size_bytes: String(input.sizeBytes),
      metadata: metadataJson,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: String(row.id) };
};

export interface GetFindingEvidenceInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly evidenceId: string;
}

export interface FindingEvidenceRow {
  readonly id: string;
  readonly findingId: string;
  readonly kind: string;
  readonly objectStorageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export const getFindingEvidence = async (
  input: GetFindingEvidenceInput,
): Promise<FindingEvidenceRow | null> => {
  const row = await input.db
    .selectFrom('finding_evidence')
    .select(['id', 'finding_id', 'kind', 'object_storage_key', 'sha256', 'size_bytes'])
    .where('id', '=', input.evidenceId)
    .where('tenant_id', '=', input.tenantId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: String(row.id),
    findingId: String(row.finding_id),
    kind: String(row.kind),
    objectStorageKey: String(row.object_storage_key),
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
  };
};

export interface ListFindingEvidenceInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly findingId: string;
}

export const listFindingEvidence = async (
  input: ListFindingEvidenceInput,
): Promise<
  ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly objectStorageKey: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }>
> => {
  const rows = await input.db
    .selectFrom('finding_evidence')
    .select(['id', 'kind', 'object_storage_key', 'sha256', 'size_bytes'])
    .where('tenant_id', '=', input.tenantId)
    .where('finding_id', '=', input.findingId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    objectStorageKey: String(r.object_storage_key),
    sha256: String(r.sha256),
    sizeBytes: Number(r.size_bytes),
  }));
};
