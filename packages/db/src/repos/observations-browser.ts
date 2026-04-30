// Sprint 9 — observations_browser repo (minimal).
//
// Single insert path so the JSONB pitfall (P1) lives in exactly one place:
// `console_messages` is wrapped via JSON.stringify(arr) before the Kysely
// insert. Without the wrap, Kysely silently writes `{}` for arrays.
//
// Read path: listByAssessment for IT timeline + observation lookups.

import type { Kysely, Selectable } from 'kysely';
import type { Database, ObservationsBrowserTable } from '../schema.ts';

export interface ConsoleMessageInput {
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  readonly text: string;
  readonly tsIso: string;
}

export interface InsertObservationBrowserInput {
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly url: string;
  readonly httpStatus: number | null;
  readonly screenshotObjectKey: string;
  readonly screenshotSha256: string;
  readonly screenshotSizeBytes: number;
  readonly harObjectKey: string;
  readonly harSha256: string;
  readonly harSizeBytes: number;
  readonly traceObjectKey: string;
  readonly traceSha256: string;
  readonly traceSizeBytes: number;
  readonly consoleMessages: ReadonlyArray<ConsoleMessageInput>;
  // Sprint 16 SPA route discovery fields (migration 019). Defaults apply when absent.
  readonly sourceUrl?: string | null;
  readonly depth?: number;
  readonly discoveryMethod?: string;
}

export interface InsertObservationBrowserResult {
  readonly id: string;
}

export const insertObservationBrowser = async (
  db: Kysely<Database>,
  input: InsertObservationBrowserInput,
): Promise<InsertObservationBrowserResult> => {
  // P1 JSONB pitfall: array writes to jsonb columns MUST go through
  // JSON.stringify, otherwise Kysely persists `{}` silently. Cast to
  // `unknown` then to the column type so the boundary is explicit.
  // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary requires string.
  const consoleMessagesJson = JSON.stringify([...input.consoleMessages]) as any;
  const row = await db
    .insertInto('observations_browser')
    .values({
      tenant_id: input.tenantId,
      assessment_id: input.assessmentId,
      url: input.url,
      http_status: input.httpStatus,
      screenshot_object_key: input.screenshotObjectKey,
      screenshot_sha256: input.screenshotSha256,
      screenshot_size_bytes: String(input.screenshotSizeBytes),
      har_object_key: input.harObjectKey,
      har_sha256: input.harSha256,
      har_size_bytes: String(input.harSizeBytes),
      trace_object_key: input.traceObjectKey,
      trace_sha256: input.traceSha256,
      trace_size_bytes: String(input.traceSizeBytes),
      console_messages: consoleMessagesJson,
      source_url: input.sourceUrl ?? null,
      depth: input.depth ?? 0,
      discovery_method: input.discoveryMethod ?? 'initial_navigation',
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: String(row.id) };
};

export interface ListObservationsByAssessmentInput {
  readonly tenantId: string;
  readonly assessmentId: string;
}

export const listObservationsBrowserByAssessment = async (
  db: Kysely<Database>,
  input: ListObservationsByAssessmentInput,
): Promise<ReadonlyArray<Selectable<ObservationsBrowserTable>>> => {
  return db
    .selectFrom('observations_browser')
    .selectAll()
    .where('tenant_id', '=', input.tenantId)
    .where('assessment_id', '=', input.assessmentId)
    .orderBy('observed_at', 'asc')
    .execute();
};
