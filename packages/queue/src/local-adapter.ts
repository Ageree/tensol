// Sprint 7 §5.3 A-Q-Local-1..6, A-Q-Concurrent-1 — file+DB-backed local queue.
//
// Architecture (per OQ-1):
//   - DB is canonical: status, claim, ack, nack, retry are all SQL state-machine.
//   - File is metadata: each publish appends a JSONL line for debug visibility.
//   - PG `FOR UPDATE SKIP LOCKED` substitutes the file-lock primitive — multiple
//     subscribers on the same DB safely share work without dupes.
//   - Crash recovery: file half-written / unparseable lines do NOT crash the
//     subscribe loop; the DB row is the source of truth.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Database } from '@cyberstrike/db';
import { type Kysely, sql } from 'kysely';
import { parseEnvelope } from './envelope.ts';
import { decideRetry } from './retry-classifier.ts';
import {
  type EnvelopeKind,
  EnvelopeValidationError,
  type Handler,
  type JobEnvelope,
  type PublishResult,
  type QueueAdapter,
  type SubscribeOptions,
  type Subscription,
} from './types.ts';

export interface LocalQueueAdapterDeps {
  readonly db: Kysely<Database>;
  /** Default `./.queue-local/`. */
  readonly baseDir?: string;
  /** Test seam — defaults to `() => new Date()`. */
  readonly clock?: { readonly now: () => Date };
  /** Test seam — used by truncated-file test to inject a write that throws. */
  readonly writeFile?: (filepath: string, contents: string) => Promise<void>;
  /** Test seam — captures parse-failure logs (default: silent / dev-null). */
  readonly logger?: {
    readonly warn: (msg: string, meta?: Record<string, unknown>) => void;
    readonly info: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const DEFAULT_BASE_DIR = './.queue-local';

const silentLogger = {
  warn: () => {
    /* noop */
  },
  info: () => {
    /* noop */
  },
};

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  (err as { code: unknown }).code === PG_UNIQUE_VIOLATION;

const queueFilePath = (baseDir: string, kind: EnvelopeKind): string =>
  path.join(baseDir, `${kind}.queue`);

const atomicAppendJsonl = async (
  filepath: string,
  line: string,
  override?: (filepath: string, contents: string) => Promise<void>,
): Promise<void> => {
  // Read-modify-write under tmp + rename. The file is best-effort metadata; if
  // write throws, the DB row still represents canonical state — the subscribe
  // loop reads the DB, not the file.
  const writer = override ?? ((p: string, c: string): Promise<void> => fs.writeFile(p, c));
  let prior = '';
  try {
    prior = await fs.readFile(filepath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const next = `${prior}${line}\n`;
  const tmp = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  await writer(tmp, next);
  await fs.rename(tmp, filepath);
};

interface JobRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  assessment_id: string | null;
  kind: string;
  status: string;
  attempt: number;
  max_attempts: number;
  idempotency_key: string;
  not_before: Date | null;
  trace_id: string;
  payload: unknown;
  last_error: string | null;
}

export class LocalQueueAdapter implements QueueAdapter {
  private readonly db: Kysely<Database>;
  private readonly baseDir: string;
  private readonly clock: { readonly now: () => Date };
  private readonly writeFile: ((filepath: string, contents: string) => Promise<void>) | undefined;
  private readonly logger: {
    readonly warn: (msg: string, meta?: Record<string, unknown>) => void;
    readonly info: (msg: string, meta?: Record<string, unknown>) => void;
  };

  constructor(deps: LocalQueueAdapterDeps) {
    this.db = deps.db;
    this.baseDir = deps.baseDir ?? DEFAULT_BASE_DIR;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.writeFile = deps.writeFile;
    this.logger = deps.logger ?? silentLogger;
  }

  /** A-Q-Local-2 — publish: validate → DB insert (canonical) → file append (metadata). */
  async publish(envelope: JobEnvelope): Promise<PublishResult> {
    const parsed = parseEnvelope(envelope);
    if (!parsed.ok) {
      throw new EnvelopeValidationError(parsed.reason);
    }
    const env = parsed.envelope;

    let jobId: string;
    const deduped = false;
    try {
      const inserted = await this.db
        .insertInto('jobs')
        .values({
          tenant_id: env.tenantId,
          project_id: env.projectId ?? null,
          assessment_id: env.assessmentId,
          kind: env.kind,
          status: 'pending',
          attempt: 0,
          max_attempts: env.maxAttempts,
          idempotency_key: env.idempotencyKey,
          not_before: env.notBefore ? new Date(env.notBefore) : null,
          trace_id: env.traceId,
          // CF-3 — JSONB write MUST be JSON.stringify-wrapped (Sprint 5 F5 pitfall).
          // biome-ignore lint/suspicious/noExplicitAny: pg expects text for jsonb.
          payload: JSON.stringify(env) as any,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      jobId = inserted.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A-Q-Idem-1 — second publish of same (tenant, idem_key) → dedupe.
        const existing = await this.db
          .selectFrom('jobs')
          .select(['id'])
          .where('tenant_id', '=', env.tenantId)
          .where('idempotency_key', '=', env.idempotencyKey)
          .executeTakeFirstOrThrow();
        return { deduped: true, jobId: existing.id };
      }
      throw err;
    }

    // Best-effort file append. Failure here doesn't compromise correctness —
    // subscribe reads from DB only.
    await fs.mkdir(this.baseDir, { recursive: true });
    const filepath = queueFilePath(this.baseDir, env.kind);
    try {
      await atomicAppendJsonl(filepath, JSON.stringify(env), this.writeFile);
    } catch (err) {
      this.logger.warn('queue.file_append_failed', {
        filepath,
        error: err instanceof Error ? err.message : String(err),
        jobId,
      });
    }
    return { deduped, jobId };
  }

  /** A-Q-Local-3 — subscribe loop. */
  subscribe(queueName: EnvelopeKind, handler: Handler, opts?: SubscribeOptions): Subscription {
    const tenantId = opts?.tenantId ?? null;
    const pollIntervalMs = opts?.pollIntervalMs ?? 100;
    const batchSize = opts?.batchSize ?? 10;

    let stopped = false;
    let inFlight = 0;
    let stopResolver: (() => void) | null = null;

    const pollOnce = async (): Promise<void> => {
      const claimed = await this.claimBatch(queueName, tenantId, batchSize);
      for (const row of claimed) {
        inFlight += 1;
        // Don't await — let handlers run concurrently up to `batchSize`.
        // (Each invocation owns its DB row via FOR UPDATE SKIP LOCKED.)
        this.runHandler(row, handler).finally(() => {
          inFlight -= 1;
          if (stopped && inFlight === 0 && stopResolver) {
            stopResolver();
            stopResolver = null;
          }
        });
      }
    };

    // Polling loop — fires off pollOnce repeatedly until stopped.
    const loop = async (): Promise<void> => {
      while (!stopped) {
        try {
          await pollOnce();
        } catch (err) {
          // Per A-Q-Local-6 — loop must NOT crash on transient DB errors.
          this.logger.warn('queue.poll_failed', {
            queueName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (stopped) break;
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    };

    void loop();

    return {
      stop: async (stopOpts?: { timeoutMs?: number }): Promise<void> => {
        const timeoutMs = stopOpts?.timeoutMs ?? 5000;
        stopped = true;
        if (inFlight === 0) return;
        await new Promise<void>((resolve) => {
          stopResolver = resolve;
          setTimeout(() => {
            stopResolver = null;
            resolve();
          }, timeoutMs);
        });
      },
    };
  }

  /** Direct ack (A-Q-Local-4). */
  async ack(jobId: string): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({ status: 'succeeded', updated_at: sql`now()` })
      .where('id', '=', jobId)
      .execute();
  }

  /** Direct nack — applies retry-classifier (A-Q-Local-4). */
  async nack(jobId: string, error: Error): Promise<void> {
    const row = await this.db
      .selectFrom('jobs')
      .select(['attempt', 'max_attempts'])
      .where('id', '=', jobId)
      .executeTakeFirst();
    if (!row) return;
    const decision = decideRetry({
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      error,
    });
    await this.applyDecision(jobId, decision, error);
  }

  // ============== private ==============

  private async claimBatch(
    queueName: EnvelopeKind,
    tenantId: string | null,
    batchSize: number,
  ): Promise<JobRow[]> {
    // A-Q-Local-3, A-Q-Local-5, A-Q-Concurrent-1 — single CTE atomically:
    //   1. SELECT pending rows due now, FOR UPDATE SKIP LOCKED (caps races).
    //   2. UPDATE them to running, return * for handler dispatch.
    // The tenant filter is enforced in SQL — A-Q-Tenant-1 cannot leak.
    const tenantFilter = tenantId === null ? sql`true` : sql`tenant_id = ${tenantId}`;
    const rows = await sql<JobRow>`
      WITH claimed AS (
        SELECT id FROM jobs
        WHERE kind = ${queueName}
          AND status = 'pending'
          AND (not_before IS NULL OR not_before <= now())
          AND ${tenantFilter}
        ORDER BY created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs SET
        status = 'running',
        attempt = attempt + 1,
        updated_at = now()
      WHERE id IN (SELECT id FROM claimed)
      RETURNING
        id, tenant_id, project_id, assessment_id, kind, status,
        attempt, max_attempts, idempotency_key, not_before, trace_id,
        payload, last_error
    `.execute(this.db);
    return rows.rows;
  }

  private async runHandler(row: JobRow, handler: Handler): Promise<void> {
    const parsed = parseEnvelope(
      typeof row.payload === 'string' ? safeJsonParse(row.payload) : row.payload,
    );
    if (!parsed.ok) {
      // The row's payload itself is malformed — terminal failure.
      await this.applyDecision(
        row.id,
        { action: 'failed_terminal', reason: 'classified_terminal' },
        new EnvelopeValidationError(parsed.reason),
      );
      return;
    }
    let outcome: import('./types.ts').HandlerOutcome;
    try {
      outcome = await handler(parsed.envelope);
    } catch (err) {
      outcome = {
        kind: 'nack' as const,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    if (outcome.kind === 'ack') {
      await this.ack(row.id);
      return;
    }
    const decision = decideRetry({
      attempt: row.attempt, // already +1 from claim
      maxAttempts: row.max_attempts,
      error: outcome.error,
    });
    await this.applyDecision(row.id, decision, outcome.error);
  }

  private async applyDecision(
    jobId: string,
    decision: ReturnType<typeof decideRetry>,
    error: Error,
  ): Promise<void> {
    if (decision.action === 'retry') {
      const dueAt = new Date(this.clock.now().getTime() + decision.delayMs);
      await this.db
        .updateTable('jobs')
        .set({
          status: 'pending',
          not_before: dueAt,
          last_error: truncateForColumn(error.message, 1000),
          updated_at: sql`now()`,
        })
        .where('id', '=', jobId)
        .execute();
      return;
    }
    // failed_terminal — either classified_terminal or attempts_exhausted.
    const finalStatus =
      decision.reason === 'attempts_exhausted' ? 'failed_transient' : 'failed_terminal';
    await this.db
      .updateTable('jobs')
      .set({
        status: finalStatus,
        last_error: truncateForColumn(error.message, 1000),
        updated_at: sql`now()`,
      })
      .where('id', '=', jobId)
      .execute();
  }
}

const truncateForColumn = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max);

const safeJsonParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
