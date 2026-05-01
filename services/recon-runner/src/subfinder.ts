// Sprint 21 — subfinder subprocess wrapper.
//
// Scope gate BEFORE subprocess (S13/P14):
//   1. Null scope → recon.subfinder.denied reason:no_scope. Zero subprocess calls.
//   2. Missing binary → recon.subfinder.error reason:config_error. Zero subprocess calls.
//   3. decide(scope, {kind:'http_request', url:'https://<domain>/', method:'GET'}, scopeDeps).
//      Denied → recon.subfinder.denied. Zero subprocess calls.
//   4. Allowed → spawn subfinder -d <domain> -json -silent, bounded timeout.
//   5. Parse JSON-lines stdout → string[] of discovered hosts.
//   6. Error/timeout → recon.subfinder.error. Returns [].

import type { AuditAction } from '@cyberstrike/contracts';
import { type EffectiveScope, decide } from '@cyberstrike/scope-engine';
import type { ValidatorScopeDeps } from '@cyberstrike/validators';
import type { AuditEmitter, AuditEmitterArgs } from './worker.ts';

const RECON_ACTOR_ID = 'recon-runner' as const;

export interface SubfinderDeps {
  readonly subfinderBin: string | undefined;
  readonly spawnFn?: SpawnFn;
  readonly auditEmitter: AuditEmitter;
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly traceId: string;
  readonly scopeDeps: ValidatorScopeDeps;
  readonly scope: EffectiveScope | null;
  readonly timeoutMs?: number;
}

export type SpawnFn = (
  cmd: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; exitCode: number }>;

const emitAudit = async (
  auditEmitter: AuditEmitter,
  deps: Pick<SubfinderDeps, 'tenantId' | 'assessmentId' | 'projectId' | 'traceId'>,
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

export const runSubfinder = async (domain: string, deps: SubfinderDeps): Promise<string[]> => {
  const timeoutMs = deps.timeoutMs ?? Number(process.env.SUBFINDER_TIMEOUT_MS ?? 60_000);

  if (deps.scope === null) {
    await emitAudit(deps.auditEmitter, deps, 'recon.subfinder.denied', 'denied', {
      reason: 'no_scope',
      domain,
    });
    return [];
  }

  if (!deps.subfinderBin) {
    await emitAudit(deps.auditEmitter, deps, 'recon.subfinder.error', 'failure', {
      reason: 'config_error',
      domain,
    });
    return [];
  }

  const decision = await decide(
    deps.scope,
    { kind: 'http_request', url: `https://${domain}/`, method: 'GET' },
    deps.scopeDeps,
  );

  if (!decision.allowed) {
    await emitAudit(deps.auditEmitter, deps, 'recon.subfinder.denied', 'denied', {
      reason: decision.reason,
      domain,
    });
    return [];
  }

  const spawn = deps.spawnFn ?? defaultSpawnFn;

  let stdout: string;
  let exitCode: number;
  try {
    ({ stdout, exitCode } = await spawn([deps.subfinderBin, '-d', domain, '-json', '-silent'], {
      timeout: timeoutMs,
    }));
  } catch (err) {
    await emitAudit(deps.auditEmitter, deps, 'recon.subfinder.error', 'failure', {
      domain,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (exitCode !== 0) {
    await emitAudit(deps.auditEmitter, deps, 'recon.subfinder.error', 'failure', {
      domain,
      exitCode,
    });
    return [];
  }

  const hosts: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'host' in parsed &&
        typeof (parsed as { host: unknown }).host === 'string'
      ) {
        hosts.push((parsed as { host: string }).host);
      }
    } catch {
      // malformed line — skip defensively
    }
  }

  await emitAudit(deps.auditEmitter, deps, 'recon.subfinder.run', 'success', {
    domain,
    discoveredHosts: hosts,
    count: hosts.length,
  });
  return hosts;
};
