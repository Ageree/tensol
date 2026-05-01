// Sprint 21 — nuclei subprocess wrapper.
//
// Scope gate BEFORE subprocess (S13/P14):
//   1. Null scope → recon.nuclei.denied per url reason:no_scope. Zero subprocess calls.
//   2. Missing binary → recon.nuclei.error reason:config_error. Zero subprocess calls.
//   3. Per-url decide() gate: denied urls get recon.nuclei.denied (NOT silent drop).
//   4. Allowed → spawn nuclei -l tmpfile -json -silent -severity <severities>, bounded timeout.
//   5. Parse JSON-lines stdout → NucleiFinding[].
//   6. Per-finding try/catch (B4 Model X): on findingsWriter throw → recon.nuclei.error
//      reason:finding_write_failed + continue loop. Never short-circuit.
//   7. template_match audit per confirmed finding.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditAction } from '@cyberstrike/contracts';
import { type EffectiveScope, decide } from '@cyberstrike/scope-engine';
import type { ValidatorScopeDeps } from '@cyberstrike/validators';
import type { SpawnFn } from './subfinder.ts';
import type { NucleiFinding } from './types.ts';
import type { AuditEmitter, AuditEmitterArgs } from './worker.ts';

const RECON_ACTOR_ID = 'recon-runner' as const;

export interface NucleiDeps {
  readonly nucleiBin: string | undefined;
  readonly spawnFn?: SpawnFn;
  readonly auditEmitter: AuditEmitter;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly traceId: string;
  readonly scopeDeps: ValidatorScopeDeps;
  readonly scope: EffectiveScope | null;
  readonly timeoutMs?: number;
  readonly findingsWriter?: (finding: NucleiFinding, targetUrl: string) => Promise<void>;
}

const emitAudit = async (
  auditEmitter: AuditEmitter,
  deps: Pick<NucleiDeps, 'tenantId' | 'assessmentId' | 'projectId' | 'traceId'>,
  action: AuditAction,
  outcome: 'success' | 'denied' | 'failure',
  metadata: Record<string, unknown>,
): Promise<void> => {
  const args: AuditEmitterArgs = {
    tenantId: deps.tenantId,
    action,
    outcome,
    actorType: 'service',
    actorId: RECON_ACTOR_ID,
    actorName: 'recon-runner',
    resourceType: 'assessment',
    resourceId: deps.assessmentId,
    projectId: deps.projectId,
    assessmentId: deps.assessmentId,
    ip: null,
    userAgent: null,
    traceId: deps.traceId,
    metadata,
  };
  await auditEmitter(args);
};

const defaultSpawnFn: SpawnFn = async (cmd, { timeout }) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  } finally {
    clearTimeout(timer);
  }
};

export const runNuclei = async (
  urls: readonly string[],
  deps: NucleiDeps,
): Promise<NucleiFinding[]> => {
  const timeoutMs = deps.timeoutMs ?? Number(process.env.NUCLEI_TIMEOUT_MS ?? 120_000);

  if (deps.scope === null) {
    for (const url of urls) {
      await emitAudit(deps.auditEmitter, deps, 'recon.nuclei.denied', 'denied', {
        reason: 'no_scope',
        url,
      });
    }
    return [];
  }

  if (!deps.nucleiBin) {
    await emitAudit(deps.auditEmitter, deps, 'recon.nuclei.error', 'failure', {
      reason: 'config_error',
    });
    return [];
  }

  // Per-url scope gate (B3 — untrusted httpx yields invariant).
  const approvedUrls: string[] = [];
  for (const url of urls) {
    const decision = await decide(
      deps.scope,
      { kind: 'http_request', url, method: 'GET' },
      deps.scopeDeps,
    );
    if (!decision.allowed) {
      await emitAudit(deps.auditEmitter, deps, 'recon.nuclei.denied', 'denied', {
        reason: decision.reason,
        url,
      });
    } else {
      approvedUrls.push(url);
    }
  }

  if (approvedUrls.length === 0) {
    return [];
  }

  const spawn = deps.spawnFn ?? defaultSpawnFn;
  const stdinInput = approvedUrls.join('\n');

  let stdout: string;
  let exitCode: number;
  const tmpDir = mkdtempSync(join(tmpdir(), 'cs-nuclei-'));
  const tmpFile = join(tmpDir, `${randomUUID()}.txt`);
  try {
    await Bun.write(tmpFile, stdinInput);
    ({ stdout, exitCode } = await spawn(
      [
        deps.nucleiBin,
        '-l',
        tmpFile,
        '-json',
        '-silent',
        '-severity',
        'info,low,medium,high,critical',
      ],
      { timeout: timeoutMs },
    ));
  } catch (err) {
    await emitAudit(deps.auditEmitter, deps, 'recon.nuclei.error', 'failure', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ok */
    }
    try {
      rmdirSync(tmpDir);
    } catch {
      /* ok */
    }
  }

  if (exitCode !== 0) {
    await emitAudit(deps.auditEmitter, deps, 'recon.nuclei.error', 'failure', { exitCode });
    return [];
  }

  const findings: NucleiFinding[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const templateId = typeof parsed['template-id'] === 'string' ? parsed['template-id'] : '';
    const matched = typeof parsed.matched === 'string' ? parsed.matched : '';
    const infoRaw =
      parsed.info !== null && typeof parsed.info === 'object'
        ? (parsed.info as Record<string, unknown>)
        : {};
    const severityRaw = typeof infoRaw.severity === 'string' ? infoRaw.severity : 'info';
    const severity = (['info', 'low', 'medium', 'high', 'critical'] as const).includes(
      severityRaw as 'info' | 'low' | 'medium' | 'high' | 'critical',
    )
      ? (severityRaw as NucleiFinding['severity'])
      : 'info';

    if (!templateId || !matched) continue;

    const finding: NucleiFinding = {
      templateId,
      severity,
      info: {
        name: typeof infoRaw.name === 'string' ? infoRaw.name : templateId,
        ...(typeof infoRaw.description === 'string' ? { description: infoRaw.description } : {}),
      },
      matched,
    };

    findings.push(finding);

    // Per-finding audit (template_match).
    await emitAudit(deps.auditEmitter, deps, 'recon.nuclei.template_match', 'success', {
      templateId,
      severity,
      matched,
    });

    // B4 — per-finding try/catch Model X: write failure → error audit + continue.
    if (deps.findingsWriter) {
      try {
        await deps.findingsWriter(finding, matched);
      } catch (err) {
        await emitAudit(deps.auditEmitter, deps, 'recon.nuclei.error', 'failure', {
          reason: 'finding_write_failed',
          templateId,
          error: err instanceof Error ? err.message : String(err),
        });
        // continue loop — never short-circuit
      }
    }
  }

  await emitAudit(deps.auditEmitter, deps, 'recon.nuclei.run', 'success', {
    inputCount: approvedUrls.length,
    findingCount: findings.length,
  });
  return findings;
};
