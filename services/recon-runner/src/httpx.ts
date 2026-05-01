// Sprint 21 — httpx subprocess wrapper.
//
// Per-url scope gate (B3 — untrusted subfinder yields):
//   Every input url is treated as untrusted until decide() rules on it.
//   Denied urls produce recon.httpx.denied audit (NOT silent drop — telemetry surface).
//   dns_resolution_failed from normalizeAction → denied reason:dns_resolution_failed.
//   Only scope-approved urls are passed to the subprocess.
//
// Scope gate BEFORE subprocess (S13/P14):
//   Null scope → recon.httpx.denied per url reason:no_scope. Zero subprocess calls.
//   Missing binary → recon.httpx.error reason:config_error. Zero subprocess calls.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditAction } from '@cyberstrike/contracts';
import { type EffectiveScope, decide } from '@cyberstrike/scope-engine';
import type { ValidatorScopeDeps } from '@cyberstrike/validators';
import type { SpawnFn } from './subfinder.ts';
import type { HttpxProbeResult } from './types.ts';
import type { AuditEmitter, AuditEmitterArgs } from './worker.ts';

const RECON_ACTOR_ID = 'recon-runner' as const;

export interface HttpxDeps {
  readonly httpxBin: string | undefined;
  readonly spawnFn?: SpawnFn;
  readonly mkdtempFn?: (prefix: string) => string;
  readonly auditEmitter: AuditEmitter;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly traceId: string;
  readonly scopeDeps: ValidatorScopeDeps;
  readonly scope: EffectiveScope | null;
  readonly timeoutMs?: number;
}

const emitAudit = async (
  auditEmitter: AuditEmitter,
  deps: Pick<HttpxDeps, 'tenantId' | 'assessmentId' | 'projectId' | 'traceId'>,
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

export const probeHttpx = async (
  urls: readonly string[],
  deps: HttpxDeps,
): Promise<HttpxProbeResult[]> => {
  const timeoutMs = deps.timeoutMs ?? Number(process.env.HTTPX_TIMEOUT_MS ?? 30_000);

  if (deps.scope === null) {
    for (const url of urls) {
      await emitAudit(deps.auditEmitter, deps, 'recon.httpx.denied', 'denied', {
        reason: 'no_scope',
        url,
      });
    }
    return [];
  }

  if (!deps.httpxBin) {
    await emitAudit(deps.auditEmitter, deps, 'recon.httpx.error', 'failure', {
      reason: 'config_error',
    });
    return [];
  }

  // Per-url scope gate (B3 — untrusted subfinder yields invariant).
  const approvedUrls: string[] = [];
  for (const url of urls) {
    const decision = await decide(
      deps.scope,
      { kind: 'http_request', url, method: 'GET' },
      deps.scopeDeps,
    );
    if (!decision.allowed) {
      await emitAudit(deps.auditEmitter, deps, 'recon.httpx.denied', 'denied', {
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
  const mkdtemp = deps.mkdtempFn ?? ((prefix: string) => mkdtempSync(prefix));
  let tmpDir: string | null = null;
  let tmpFile: string | null = null;
  try {
    tmpDir = mkdtemp(join(tmpdir(), 'cs-httpx-'));
    tmpFile = join(tmpDir, `${randomUUID()}.txt`);
    await Bun.write(tmpFile, stdinInput);
    ({ stdout, exitCode } = await spawn([deps.httpxBin, '-l', tmpFile, '-json', '-silent'], {
      timeout: timeoutMs,
    }));
  } catch (err) {
    await emitAudit(deps.auditEmitter, deps, 'recon.httpx.error', 'failure', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    if (tmpFile) {
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ok */
      }
    }
    if (tmpDir) {
      try {
        rmdirSync(tmpDir);
      } catch {
        /* ok */
      }
    }
  }

  if (exitCode !== 0) {
    await emitAudit(deps.auditEmitter, deps, 'recon.httpx.error', 'failure', { exitCode });
    return [];
  }

  const results: HttpxProbeResult[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.url === 'string') {
        results.push({
          url: parsed.url,
          statusCode: typeof parsed.status_code === 'number' ? parsed.status_code : 0,
          title: typeof parsed.title === 'string' ? parsed.title : '',
          tech: Array.isArray(parsed.tech)
            ? (parsed.tech as string[]).filter((t) => typeof t === 'string')
            : [],
          webServer: typeof parsed.webserver === 'string' ? parsed.webserver : undefined,
        });
      }
    } catch {
      // malformed line — skip
    }
  }

  await emitAudit(deps.auditEmitter, deps, 'recon.httpx.run', 'success', {
    inputCount: approvedUrls.length,
    aliveCount: results.length,
  });
  return results;
};
