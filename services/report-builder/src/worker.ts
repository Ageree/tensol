// Sprint 14 — handleReportBuild: the report.build envelope handler.
//
// Flow:
//   1. Parse payload (defence in depth).
//   2. If report already ready → ack (idempotent re-delivery).
//   3. Mark building + emit report.build.started.
//   4. Load assessment + confirmed findings (status='confirmed' filter).
//   5. Scope guard: for each finding, decide(scope, {kind:'http_request',url,method:'GET'}, scopeDeps).
//      Out-of-scope findings excluded + report.finding.excluded_oos emitted.
//   6. Load per-finding evidence bytes from object storage.
//   7. Render HTML + JSON + ZIP.
//   8. Compute sha256 per format.
//   9. Put artifacts to object storage.
//  10. markReady + emit report.build.completed.
//  11. On any error → markFailed + emit report.build.failed + nack.

import type { AuditAction, AuditOutcome, ServiceActorId } from '@cyberstrike/contracts';
import type { ObjectStorage } from '@cyberstrike/object-storage';
import { type HandlerOutcome, type JobEnvelope, ScopeDenyError } from '@cyberstrike/queue';
import { buildZip, computeSha256, renderHtml } from '@cyberstrike/reports';
import type { EffectiveScope, EngineDeps } from '@cyberstrike/scope-engine';
import { decide } from '@cyberstrike/scope-engine';
import type { z } from 'zod';
import type { ReportBuildPayload } from './payload-schema.ts';

const REPORT_BUILDER_ACTOR_ID: ServiceActorId = 'report-builder';

// ============================================================================
// Dependency interfaces (DI — all I/O injected, pure worker logic testable)
// ============================================================================

export interface AuditEmitterArgs {
  readonly tenantId: string;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly actorType: 'service';
  readonly actorId: ServiceActorId;
  readonly actorName: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly projectId?: string | null;
  readonly assessmentId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly traceId: string;
  readonly metadata: Record<string, unknown>;
}

export type AuditEmitter = (args: AuditEmitterArgs) => Promise<void>;

export interface FindingEvidenceRow {
  readonly id: string;
  readonly kind: string;
  readonly objectStorageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface FindingRow {
  readonly id: string;
  readonly type: string;
  readonly severity: string;
  readonly confidence: string;
  readonly affectedUrl: string;
  readonly reproduction: Record<string, unknown>;
  readonly validatedAt: Date;
  readonly evidence: ReadonlyArray<FindingEvidenceRow>;
}

export type ConfirmedFindingsLoader = (input: {
  tenantId: string;
  assessmentId: string;
}) => Promise<ReadonlyArray<FindingRow>>;

export interface ReportStatusRow {
  readonly id: string;
  readonly status: string;
}

export type ReportStatusLoader = (input: {
  tenantId: string;
  reportId: string;
}) => Promise<ReportStatusRow | null>;

export type ReportMarkBuilding = (input: {
  tenantId: string;
  reportId: string;
}) => Promise<void>;

export interface ReportReadyInput {
  readonly tenantId: string;
  readonly reportId: string;
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

export type ReportMarkReady = (input: ReportReadyInput) => Promise<void>;

export type ReportMarkFailed = (input: {
  tenantId: string;
  reportId: string;
  reason: string;
}) => Promise<void>;

export interface ReportBuilderDeps {
  readonly objectStorage: ObjectStorage;
  readonly buildScope: (assessmentId: string) => Promise<EffectiveScope | null>;
  /**
   * Injected for scope guard. REQUIRED for report-builder (fail-closed design).
   *
   * F2 [HIGH codex fix]: scopeDeps is intentionally non-optional here. This is
   * a divergence from the S13 decepticon-adapter null-guard (which was retained
   * for legacy back-compat with callers that predate createDecepticonRunner).
   * report-builder is greenfield with no legacy callers — fail-closed is correct.
   * Missing scopeDeps means misconfiguration; throw at startup rather than silently
   * degrading scope enforcement to "include everything".
   */
  readonly scopeDeps: EngineDeps;
  readonly auditEmitter: AuditEmitter;
  readonly confirmedFindingsLoader: ConfirmedFindingsLoader;
  readonly reportStatusLoader: ReportStatusLoader;
  readonly reportMarkBuilding: ReportMarkBuilding;
  readonly reportMarkReady: ReportMarkReady;
  readonly reportMarkFailed: ReportMarkFailed;
  readonly payloadSchema: z.ZodType<ReportBuildPayload>;
  readonly clock?: () => Date;
}

// ============================================================================
// Helpers
// ============================================================================

const emitAudit = async (
  deps: ReportBuilderDeps,
  envelope: JobEnvelope,
  payload: ReportBuildPayload,
  action: AuditAction,
  outcome: AuditOutcome,
  metadata: Record<string, unknown>,
): Promise<void> => {
  await deps.auditEmitter({
    tenantId: payload.tenantId,
    action,
    outcome,
    actorType: 'service',
    actorId: REPORT_BUILDER_ACTOR_ID,
    actorName: 'report-builder',
    resourceType: 'report',
    resourceId: payload.reportId,
    ...(payload.projectId ? { projectId: payload.projectId } : {}),
    assessmentId: payload.assessmentId,
    ip: 'report-builder',
    userAgent: null,
    traceId: payload.traceId,
    metadata: { ...metadata, jobId: envelope.jobId },
  });
};

const reportObjectKey = (
  tenantId: string,
  reportId: string,
  format: 'html' | 'json' | 'zip',
): string => `reports/${tenantId}/${reportId}/report.${format}`;

// ============================================================================
// Main handler
// ============================================================================

export const handleReportBuild = async (
  deps: ReportBuilderDeps,
  envelope: JobEnvelope,
): Promise<HandlerOutcome> => {
  // F2 [HIGH codex fix]: Validate scopeDeps at handler entry (startup-time check).
  // report-builder requires scopeDeps — fail-closed, not legacy-null-guard.
  // See ReportBuilderDeps.scopeDeps comment for rationale vs S13 decepticon-adapter.
  if (!deps.scopeDeps) {
    throw new Error('report-builder requires scopeDeps — configuration error');
  }

  // 1. Parse payload.
  const parsed = deps.payloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    return {
      kind: 'nack',
      error: new ScopeDenyError('invalid_report_build_payload', [
        'report_build_payload_schema_mismatch',
      ]),
    };
  }
  const payload = parsed.data;

  // 2. Idempotent re-delivery: if report already ready, ack immediately.
  const existing = await deps.reportStatusLoader({
    tenantId: payload.tenantId,
    reportId: payload.reportId,
  });
  if (existing?.status === 'ready') {
    return { kind: 'ack' };
  }

  // 3. Mark building + emit lifecycle start.
  try {
    await deps.reportMarkBuilding({ tenantId: payload.tenantId, reportId: payload.reportId });
  } catch (err) {
    return {
      kind: 'nack',
      error: err instanceof Error ? err : new Error('mark_building_failed'),
    };
  }

  try {
    await emitAudit(deps, envelope, payload, 'report.build.started', 'success', {});
  } catch {
    // Audit failure is non-fatal for the build — continue.
  }

  try {
    return await buildReport(deps, envelope, payload);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown_error';
    try {
      await deps.reportMarkFailed({
        tenantId: payload.tenantId,
        reportId: payload.reportId,
        reason,
      });
    } catch {
      // best-effort
    }
    try {
      await emitAudit(deps, envelope, payload, 'report.build.failed', 'failure', { reason });
    } catch {
      // best-effort
    }
    return {
      kind: 'nack',
      error: err instanceof Error ? err : new Error(reason),
    };
  }
};

const buildReport = async (
  deps: ReportBuilderDeps,
  envelope: JobEnvelope,
  payload: ReportBuildPayload,
): Promise<HandlerOutcome> => {
  // 4. Load confirmed findings.
  const allFindings = await deps.confirmedFindingsLoader({
    tenantId: payload.tenantId,
    assessmentId: payload.assessmentId,
  });

  // 5. Scope guard — validate each finding's affectedUrl before including.
  //
  // F2 [HIGH codex fix]: buildScope returning null is now a HARD failure.
  // report-builder is greenfield; no legacy callers exist. Silently including
  // all findings when scope is unavailable contradicts the "scope-guard at
  // publication" promise. Fail the build with failure_reason='scope_unavailable'
  // so the caller can investigate and re-queue after the scope is fixed.
  const scope = await deps.buildScope(payload.assessmentId);
  if (!scope) {
    throw new Error('scope_unavailable');
  }

  let excludedCount = 0;
  const includedFindings: FindingRow[] = [];

  for (const finding of allFindings) {
    let decision: { allowed: boolean };
    try {
      decision = await decide(
        scope,
        { kind: 'http_request', url: finding.affectedUrl, method: 'GET' },
        deps.scopeDeps,
      );
    } catch {
      // Fail-closed: exclude if scope check throws.
      decision = { allowed: false };
    }

    if (!decision.allowed) {
      excludedCount++;
      try {
        await deps.auditEmitter({
          tenantId: payload.tenantId,
          action: 'report.finding.excluded_oos',
          outcome: 'denied',
          actorType: 'service',
          actorId: REPORT_BUILDER_ACTOR_ID,
          actorName: 'report-builder',
          resourceType: 'finding',
          resourceId: finding.id,
          ...(payload.projectId ? { projectId: payload.projectId } : {}),
          assessmentId: payload.assessmentId,
          ip: 'report-builder',
          userAgent: null,
          traceId: payload.traceId,
          metadata: { affectedUrl: finding.affectedUrl, jobId: envelope.jobId },
        });
      } catch {
        // best-effort
      }
      continue;
    }
    includedFindings.push(finding);
  }

  // 6. Build snapshot + render.
  const generatedAt = (deps.clock ?? (() => new Date()))().toISOString();

  const snapshotFindings = includedFindings.map((f) => ({
    id: f.id,
    type: f.type,
    severity: f.severity,
    confidence: f.confidence,
    affectedUrl: f.affectedUrl,
    reproduction: f.reproduction,
    validatedAt: f.validatedAt.toISOString(),
    evidence: f.evidence.map((e) => ({
      id: e.id,
      kind: e.kind as 'screenshot' | 'har' | 'trace' | 'json' | 'log',
      objectStorageKey: e.objectStorageKey,
      sha256: e.sha256,
      sizeBytes: e.sizeBytes,
    })),
  }));

  const snapshot = {
    reportId: payload.reportId,
    assessmentId: payload.assessmentId,
    tenantId: payload.tenantId,
    generatedAt,
    findings: snapshotFindings,
    excludedFindingCount: excludedCount,
    methodology:
      'Automated penetration testing using CyberStrike platform. Findings validated via browser-based XSS replay.',
  };

  const htmlStr = renderHtml(snapshot);
  const htmlBuf = Buffer.from(htmlStr, 'utf8');
  const jsonBuf = Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8');

  // 7. Build ZIP entries.
  const zipEntries: Array<{ name: string; data: Buffer }> = [
    { name: 'report/report.html', data: htmlBuf },
    { name: 'report/report.json', data: jsonBuf },
  ];

  // Per-finding evidence bytes.
  //
  // F3 [MEDIUM codex fix]: Object-storage read failures for evidence are NO
  // LONGER silently swallowed. A missing or unreadable evidence object means
  // the report cannot faithfully represent the finding — marking the report
  // "ready" with silently-omitted evidence is misleading and unaudited.
  //
  // Strategy: throw on read failure. The outer try/catch in handleReportBuild
  // (step 3→buildReport path) catches, calls markFailed with
  // failure_reason='evidence_unreachable:<findingId>:<evidenceId>', emits
  // report.build.failed audit, and returns nack — allowing the queue worker's
  // retry logic (maxAttempts) to re-deliver. After exhaustion the report stays
  // in status=failed with the specific reason recorded for investigation.
  for (const finding of includedFindings) {
    for (const ev of finding.evidence) {
      let bytes: Buffer;
      try {
        bytes = await deps.objectStorage.get(ev.objectStorageKey);
      } catch {
        // Propagate as a build failure. The queue will nack+retry; after
        // maxAttempts the outer handler marks the report failed with this reason.
        throw new Error(`evidence_unreachable:${finding.id}:${ev.id}`);
      }
      const ext =
        ev.kind === 'screenshot'
          ? 'png'
          : ev.kind === 'har'
            ? 'har.json'
            : ev.kind === 'trace'
              ? 'trace.json'
              : ev.kind === 'json'
                ? 'json'
                : 'log';
      zipEntries.push({
        name: `report/findings/${finding.id}/${ev.kind}.${ext}`,
        data: bytes,
      });
    }
  }

  const zipBuf = buildZip(zipEntries);

  // 8. Compute sha256s.
  const sha256Html = computeSha256(htmlBuf);
  const sha256Json = computeSha256(jsonBuf);
  const sha256Zip = computeSha256(zipBuf);

  // 9. Put to object storage.
  const keyHtml = reportObjectKey(payload.tenantId, payload.reportId, 'html');
  const keyJson = reportObjectKey(payload.tenantId, payload.reportId, 'json');
  const keyZip = reportObjectKey(payload.tenantId, payload.reportId, 'zip');

  await deps.objectStorage.put({ key: keyHtml, body: htmlBuf, contentType: 'text/html' });
  await deps.objectStorage.put({
    key: keyJson,
    body: jsonBuf,
    contentType: 'application/json',
  });
  await deps.objectStorage.put({
    key: keyZip,
    body: zipBuf,
    contentType: 'application/zip',
  });

  // 10. Mark ready.
  await deps.reportMarkReady({
    tenantId: payload.tenantId,
    reportId: payload.reportId,
    objectKeyHtml: keyHtml,
    sha256Html,
    sizeBytesHtml: htmlBuf.length,
    objectKeyJson: keyJson,
    sha256Json,
    sizeBytesJson: jsonBuf.length,
    objectKeyZip: keyZip,
    sha256Zip,
    sizeBytesZip: zipBuf.length,
  });

  // 11. Emit completed.
  try {
    await emitAudit(deps, envelope, payload, 'report.build.completed', 'success', {
      findingCount: includedFindings.length,
      excludedCount,
      sha256Html,
      sha256Json,
      sha256Zip,
    });
  } catch {
    // best-effort
  }

  return { kind: 'ack' };
};
