// Sprint 9 — handleReconBrowser: the recon.browser envelope handler.
//
// Flow:
//   1. Parse payload (defence in depth).
//   2. Build EffectiveScope via injected buildScope().
//   3. Scope-check the startUrl. Deny → emit
//      `recon.browser.navigation.denied` audit, return nack(ScopeDenyError).
//   4. Emit `recon.browser.job.started` audit.
//   5. driver.launch(); driver.navigate(startUrl).
//   6. For each redirect destination — independent scope check (R5).
//      Deny → emit denied audit, abort the URL, session marked closed.
//   7. Redact HAR cookies, write 3 artefacts to object storage.
//   8. Insert observations_browser row (JSONB pitfall handled in repo).
//   9. Emit `recon.browser.observation.persisted` audit.
//   10. Emit `recon.browser.job.completed` audit; ack.
//
// Errors:
//   - BrowserTimeoutError → nack with NON-terminal error (transient).
//   - object-storage put throws → nack with NON-terminal error (transient).
//   - ScopeDenyError on startUrl → nack with terminal classification.
//
// Audit + observation persistence are injected as deps (not imported as
// side-effecting modules) so unit tests can record without spinning up a
// real Postgres. The IT helpers wire the real `emitAudit` +
// `insertObservationBrowser` from packages.

import type { AuditAction, AuditOutcome, ServiceActorId } from '@cyberstrike/contracts';
import type { ObjectStorage } from '@cyberstrike/object-storage';
import { type HandlerOutcome, type JobEnvelope, ScopeDenyError } from '@cyberstrike/queue';
import type { EffectiveScope } from '@cyberstrike/scope-engine';
import { z } from 'zod';

/**
 * Defence-in-depth payload schema for `recon.browser` envelopes. Mirrors
 * the canonical schema in `services/coordinator/src/payloads.ts`. Kept
 * here so packages/services importing the handler don't take a
 * coordinator dep.
 */
export const reconBrowserPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  assessmentId: z.string().uuid(),
  targetId: z.string().uuid(),
  startUrl: z.string().url(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
});
import { writeArtifacts } from './artifact-writer.ts';
import { type Har, redactCookies } from './har-redactor.ts';
import { type ScopeGuardDeps, checkNavigation } from './scope-guard.ts';
import {
  type BrowserDriver,
  BrowserTimeoutError,
  type ConsoleMessage,
  DbTransientError,
  StorageWriteError,
} from './types.ts';

const BROWSER_WORKER_ACTOR_ID: ServiceActorId = 'browser-worker';

export type ReconBrowserPayload = z.infer<typeof reconBrowserPayloadSchema>;

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

export interface ObservationWriterInput {
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
  readonly consoleMessages: ReadonlyArray<ConsoleMessage>;
}

export type ObservationWriter = (input: ObservationWriterInput) => Promise<{ readonly id: string }>;

export interface BrowserWorkerDeps {
  readonly driver: BrowserDriver;
  readonly objectStorage: ObjectStorage;
  readonly buildScope: (assessmentId: string) => Promise<EffectiveScope | null>;
  readonly scopeDeps: ScopeGuardDeps;
  readonly auditEmitter: AuditEmitter;
  readonly observationWriter: ObservationWriter;
  /** Defence-in-depth payload schema. */
  readonly payloadSchema: z.ZodType<ReconBrowserPayload>;
}

const emitDeniedAudit = async (
  deps: BrowserWorkerDeps,
  envelope: JobEnvelope,
  payload: ReconBrowserPayload,
  url: string,
  matchedDenyRuleIds: readonly string[],
): Promise<void> => {
  await deps.auditEmitter({
    tenantId: payload.tenantId,
    action: 'recon.browser.navigation.denied',
    outcome: 'denied',
    actorType: 'service',
    actorId: BROWSER_WORKER_ACTOR_ID,
    actorName: 'browser-worker',
    resourceType: 'assessment',
    resourceId: payload.assessmentId,
    ...(payload.projectId ? { projectId: payload.projectId } : {}),
    assessmentId: payload.assessmentId,
    ip: 'browser-worker',
    userAgent: null,
    traceId: payload.traceId,
    metadata: {
      deniedUrl: url,
      matchedDenyRuleIds: [...matchedDenyRuleIds],
      jobId: envelope.jobId,
    },
  });
};

const emitJobLifecycle = async (
  deps: BrowserWorkerDeps,
  envelope: JobEnvelope,
  payload: ReconBrowserPayload,
  action:
    | 'recon.browser.job.started'
    | 'recon.browser.job.completed'
    | 'recon.browser.job.failed'
    | 'recon.browser.observation.persisted',
  outcome: 'success' | 'failure',
  metadata: Record<string, unknown>,
): Promise<void> => {
  await deps.auditEmitter({
    tenantId: payload.tenantId,
    action,
    outcome,
    actorType: 'service',
    actorId: BROWSER_WORKER_ACTOR_ID,
    actorName: 'browser-worker',
    resourceType: 'assessment',
    resourceId: payload.assessmentId,
    ...(payload.projectId ? { projectId: payload.projectId } : {}),
    assessmentId: payload.assessmentId,
    ip: 'browser-worker',
    userAgent: null,
    traceId: payload.traceId,
    metadata: { ...metadata, jobId: envelope.jobId },
  });
};

export const handleReconBrowser = async (
  deps: BrowserWorkerDeps,
  envelope: JobEnvelope,
): Promise<HandlerOutcome> => {
  // 1. Parse payload.
  const parseResult = deps.payloadSchema.safeParse(envelope.payload);
  if (!parseResult.success) {
    return {
      kind: 'nack',
      error: new ScopeDenyError('invalid_recon_browser_payload', [
        'recon_browser_payload_schema_mismatch',
      ]),
    };
  }
  const payload = parseResult.data;

  // 2. Build scope.
  const scope = await deps.buildScope(payload.assessmentId);
  if (!scope) {
    return {
      kind: 'nack',
      error: new ScopeDenyError('assessment_not_found', ['assessment_not_found']),
    };
  }

  // 3. Scope-check the startUrl BEFORE any fetch (A-BR-NavBeforeFetch).
  const startDecision = await checkNavigation(scope, payload.startUrl, deps.scopeDeps);
  if (!startDecision.allowed) {
    await emitDeniedAudit(
      deps,
      envelope,
      payload,
      payload.startUrl,
      startDecision.matchedDenyRuleIds,
    );
    return {
      kind: 'nack',
      error: new ScopeDenyError(startDecision.reason, [...startDecision.matchedDenyRuleIds]),
    };
  }

  // 4. Job started audit.
  await emitJobLifecycle(deps, envelope, payload, 'recon.browser.job.started', 'success', {
    startUrl: payload.startUrl,
    targetId: payload.targetId,
  });

  // 5. Launch + navigate. Catch transient/terminal errors.
  try {
    const session = await deps.driver.launch({
      tenantId: payload.tenantId,
      assessmentId: payload.assessmentId,
      traceId: payload.traceId,
    });
    let outcome: Awaited<ReturnType<BrowserDriver['navigate']>>;
    try {
      outcome = await deps.driver.navigate(session.sessionId, {
        url: payload.startUrl,
        method: 'GET',
      });
    } finally {
      await deps.driver.close(session.sessionId).catch(() => undefined);
    }

    // 6. Each redirect destination must independently pass scope-engine
    // (R5 — closes Sprint 6 round-2 P1 redirect-target bypass).
    for (let i = 1; i < outcome.redirectChain.length; i++) {
      const redirectUrl = outcome.redirectChain[i];
      if (!redirectUrl) continue;
      const redirectDecision = await checkNavigation(scope, redirectUrl, deps.scopeDeps);
      if (!redirectDecision.allowed) {
        await emitDeniedAudit(
          deps,
          envelope,
          payload,
          redirectUrl,
          redirectDecision.matchedDenyRuleIds,
        );
        await emitJobLifecycle(deps, envelope, payload, 'recon.browser.job.failed', 'failure', {
          reason: 'redirect_denied',
          deniedUrl: redirectUrl,
        });
        return {
          kind: 'nack',
          error: new ScopeDenyError(redirectDecision.reason, [
            ...redirectDecision.matchedDenyRuleIds,
          ]),
        };
      }
    }

    // 7. Redact HAR cookies before writing.
    const harJson = JSON.parse(new TextDecoder().decode(outcome.artifacts.har)) as Har;
    const redacted = redactCookies(harJson);
    const redactedBytes = new TextEncoder().encode(JSON.stringify(redacted));

    // codex iter-2 P1 — wrap storage failures as StorageWriteError so the
    // queue retry-classifier names the failure 'transient' and retries
    // up to maxAttempts (instead of defaulting to terminal).
    let written: Awaited<ReturnType<typeof writeArtifacts>>;
    try {
      written = await writeArtifacts(deps.objectStorage, {
        tenantId: payload.tenantId,
        assessmentId: payload.assessmentId,
        sessionId: session.sessionId,
        screenshot: outcome.artifacts.screenshot,
        har: redactedBytes,
        trace: outcome.artifacts.trace,
      });
    } catch (err) {
      throw new StorageWriteError(
        `object_storage_put_failed:${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    // 8. Insert observations_browser row (JSONB pitfall handled in repo).
    // codex iter-2 P1 — wrap DB throws as DbTransientError for the queue
    // classifier. Permanent failures (constraint violations) should NOT
    // be wrapped here; they surface as plain Error → terminal.
    let observation: Awaited<ReturnType<typeof deps.observationWriter>>;
    try {
      observation = await deps.observationWriter({
        tenantId: payload.tenantId,
        assessmentId: payload.assessmentId,
        url: outcome.finalUrl,
        httpStatus: outcome.artifacts.httpStatus,
        screenshotObjectKey: written.screenshot.key,
        screenshotSha256: written.screenshot.sha256,
        screenshotSizeBytes: written.screenshot.sizeBytes,
        harObjectKey: written.har.key,
        harSha256: written.har.sha256,
        harSizeBytes: written.har.sizeBytes,
        traceObjectKey: written.trace.key,
        traceSha256: written.trace.sha256,
        traceSizeBytes: written.trace.sizeBytes,
        consoleMessages: outcome.artifacts.consoleMessages,
      });
    } catch (err) {
      throw new DbTransientError(
        `observation_insert_failed:${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    // 9. Observation persisted audit.
    await emitJobLifecycle(
      deps,
      envelope,
      payload,
      'recon.browser.observation.persisted',
      'success',
      {
        observationId: observation.id,
        finalUrl: outcome.finalUrl,
        screenshotSha256: written.screenshot.sha256,
        harSha256: written.har.sha256,
        traceSha256: written.trace.sha256,
      },
    );

    // 10. Job completed audit.
    await emitJobLifecycle(deps, envelope, payload, 'recon.browser.job.completed', 'success', {
      observationId: observation.id,
    });

    return { kind: 'ack' };
  } catch (err) {
    // Transient classifications: BrowserTimeoutError + storage/IO failures
    // throw plain Error → both are NOT __terminal:true, so the queue
    // retry-classifier (Sprint 7) retries up to maxAttempts.
    const reason =
      err instanceof BrowserTimeoutError
        ? 'browser_timeout'
        : err instanceof Error
          ? `transient:${err.name}`
          : 'transient_unknown';
    await emitJobLifecycle(deps, envelope, payload, 'recon.browser.job.failed', 'failure', {
      reason,
    });
    if (err instanceof Error) {
      return { kind: 'nack', error: err };
    }
    return { kind: 'nack', error: new Error('browser_worker_unknown_error') };
  }
};
