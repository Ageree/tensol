// Sprint 14 — reports repo.
//
// Insert-only for content: report snapshots are permanent. Status transitions
// (queued → building → ready | failed) use controlled UPDATE methods here —
// the DB trigger only blocks DELETE, so UPDATE is allowed via this repo.

import type { Kysely } from 'kysely';
import type { Database } from '../schema.ts';

export interface InsertReportInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly idempotencyKey: string;
}

export interface ReportRow {
  readonly id: string;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly objectKeyHtml: string | null;
  readonly sha256Html: string | null;
  readonly sizeByteHtml: number | null;
  readonly objectKeyJson: string | null;
  readonly sha256Json: string | null;
  readonly sizeBytesJson: number | null;
  readonly objectKeyZip: string | null;
  readonly sha256Zip: string | null;
  readonly sizeBytesZip: number | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

const mapRow = (r: {
  id: unknown;
  tenant_id: unknown;
  assessment_id: unknown;
  idempotency_key: unknown;
  status: unknown;
  object_key_html: unknown;
  sha256_html: unknown;
  size_bytes_html: unknown;
  object_key_json: unknown;
  sha256_json: unknown;
  size_bytes_json: unknown;
  object_key_zip: unknown;
  sha256_zip: unknown;
  size_bytes_zip: unknown;
  failure_reason: unknown;
  created_at: unknown;
  completed_at: unknown;
}): ReportRow => ({
  id: String(r.id),
  tenantId: String(r.tenant_id),
  assessmentId: String(r.assessment_id),
  idempotencyKey: String(r.idempotency_key),
  status: String(r.status),
  objectKeyHtml: r.object_key_html != null ? String(r.object_key_html) : null,
  sha256Html: r.sha256_html != null ? String(r.sha256_html) : null,
  sizeByteHtml: r.size_bytes_html != null ? Number(r.size_bytes_html) : null,
  objectKeyJson: r.object_key_json != null ? String(r.object_key_json) : null,
  sha256Json: r.sha256_json != null ? String(r.sha256_json) : null,
  sizeBytesJson: r.size_bytes_json != null ? Number(r.size_bytes_json) : null,
  objectKeyZip: r.object_key_zip != null ? String(r.object_key_zip) : null,
  sha256Zip: r.sha256_zip != null ? String(r.sha256_zip) : null,
  sizeBytesZip: r.size_bytes_zip != null ? Number(r.size_bytes_zip) : null,
  failureReason: r.failure_reason != null ? String(r.failure_reason) : null,
  createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
  completedAt:
    r.completed_at != null
      ? r.completed_at instanceof Date
        ? r.completed_at
        : new Date(String(r.completed_at))
      : null,
});

export const insertReport = async (input: InsertReportInput): Promise<{ readonly id: string }> => {
  const row = await input.db
    .insertInto('reports')
    .values({
      tenant_id: input.tenantId,
      assessment_id: input.assessmentId,
      idempotency_key: input.idempotencyKey,
      status: 'queued',
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: String(row.id) };
};

export interface FindReportByIdInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly reportId: string;
}

export const findReportById = async (input: FindReportByIdInput): Promise<ReportRow | null> => {
  const row = await input.db
    .selectFrom('reports')
    .selectAll()
    .where('id', '=', input.reportId)
    .where('tenant_id', '=', input.tenantId)
    .executeTakeFirst();
  return row ? mapRow(row) : null;
};

export interface FindReportByIdCrossTenantInput {
  readonly db: Kysely<Database>;
  readonly reportId: string;
}

export const findReportByIdCrossTenant = async (
  input: FindReportByIdCrossTenantInput,
): Promise<ReportRow | null> => {
  const row = await input.db
    .selectFrom('reports')
    .selectAll()
    .where('id', '=', input.reportId)
    .executeTakeFirst();
  return row ? mapRow(row) : null;
};

export interface FindReportByIdempotencyKeyInput {
  readonly db: Kysely<Database>;
  readonly tenantId: string;
  readonly idempotencyKey: string;
}

export const findReportByIdempotencyKey = async (
  input: FindReportByIdempotencyKeyInput,
): Promise<ReportRow | null> => {
  const row = await input.db
    .selectFrom('reports')
    .selectAll()
    .where('tenant_id', '=', input.tenantId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  return row ? mapRow(row) : null;
};

export interface MarkReportBuildingInput {
  readonly db: Kysely<Database>;
  readonly reportId: string;
  readonly tenantId: string;
}

export const markReportBuilding = async (input: MarkReportBuildingInput): Promise<void> => {
  await input.db
    .updateTable('reports')
    .set({ status: 'building' })
    .where('id', '=', input.reportId)
    .where('tenant_id', '=', input.tenantId)
    .execute();
};

export interface MarkReportReadyInput {
  readonly db: Kysely<Database>;
  readonly reportId: string;
  readonly tenantId: string;
  readonly objectKeyHtml: string;
  readonly sha256Html: string;
  readonly sizeBytesHtml: number;
  readonly objectKeyJson: string;
  readonly sha256Json: string;
  readonly sizeBytesJson: number;
  readonly objectKeyZip: string;
  readonly sha256Zip: string;
  readonly sizeBytesZip: number;
}

export const markReportReady = async (input: MarkReportReadyInput): Promise<void> => {
  await input.db
    .updateTable('reports')
    .set({
      status: 'ready',
      object_key_html: input.objectKeyHtml,
      sha256_html: input.sha256Html,
      size_bytes_html: BigInt(input.sizeBytesHtml) as unknown as string,
      object_key_json: input.objectKeyJson,
      sha256_json: input.sha256Json,
      size_bytes_json: BigInt(input.sizeBytesJson) as unknown as string,
      object_key_zip: input.objectKeyZip,
      sha256_zip: input.sha256Zip,
      size_bytes_zip: BigInt(input.sizeBytesZip) as unknown as string,
      completed_at: new Date(),
    })
    .where('id', '=', input.reportId)
    .where('tenant_id', '=', input.tenantId)
    .execute();
};

export interface MarkReportFailedInput {
  readonly db: Kysely<Database>;
  readonly reportId: string;
  readonly tenantId: string;
  readonly reason: string;
}

export const markReportFailed = async (input: MarkReportFailedInput): Promise<void> => {
  await input.db
    .updateTable('reports')
    .set({
      status: 'failed',
      failure_reason: input.reason,
      completed_at: new Date(),
    })
    .where('id', '=', input.reportId)
    .where('tenant_id', '=', input.tenantId)
    .execute();
};
