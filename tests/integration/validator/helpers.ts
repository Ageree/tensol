// Sprint 10 — shared helpers for tests/integration/validator/.
//
// Wires the in-process validator-worker handler with the real emitAudit
// + findings/finding_evidence repos + LocalObjectStorage + a Fake XSS
// replay driver. Lab fixture lifecycle helpers reuse Sprint 9's lab.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emitAudit } from '@cyberstrike/audit';
import {
  type Database,
  findFindingByCandidateId,
  insertConfirmedFinding,
  insertFindingEvidence,
  listFindingEvidence,
} from '@cyberstrike/db';
import { LocalObjectStorage } from '@cyberstrike/object-storage';
import {
  type AssessmentLoader,
  type AuditEmitter,
  type AuditEmitterArgs,
  type CandidateLoader,
  type CandidateRow,
  type EvidenceCounter,
  type FindingByCandidateLoader,
  type FindingCreatedAuditChecker,
  type FindingEvidenceWriter,
  type FindingsWriter,
  type ValidatorWorkerDeps,
  validateFindingPayloadSchema,
} from '@cyberstrike/validator-worker';
import { FakeXssReplayDriver, type FakeXssReplayDriverDeps } from '@cyberstrike/validators';
import type { Kysely } from 'kysely';
import { type XssLabHandle, startXssLab } from '../../lab/xss-fixture/index.ts';

export const stubValidatorScopeDeps = {
  dns: {
    resolveA: async (host: string): Promise<string[]> => {
      if (host === 'localhost') return ['203.0.113.7'];
      if (host === 'evil.example') return ['198.51.100.7'];
      return [];
    },
    resolveAAAA: async (): Promise<string[]> => [],
  },
  clock: { now: (): Date => new Date() },
  rateLimit: {
    consume: async (): Promise<{ ok: true; retryAfterMs: number }> => ({
      ok: true,
      retryAfterMs: 0,
    }),
  },
};

export const buildLocalStorage = (): {
  storage: LocalObjectStorage;
  baseDir: string;
} => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'cs-vw-it-'));
  return { storage: new LocalObjectStorage({ baseDir }), baseDir };
};

export const buildAuditEmitter = (db: Kysely<Database>): AuditEmitter => {
  return async (args: AuditEmitterArgs): Promise<void> => {
    await emitAudit({ db }, args);
  };
};

export const buildCandidateLoader = (db: Kysely<Database>): CandidateLoader => {
  return async ({ tenantId, candidateFindingId }) => {
    const row = await db
      .selectFrom('candidate_findings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', candidateFindingId)
      .executeTakeFirst();
    if (!row) return null;
    const candidate: CandidateRow = {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      assessmentId: String(row.assessment_id),
      type: String(row.type),
      severity: row.severity as 'info' | 'low' | 'medium' | 'high' | 'critical',
      affectedUrl: String(row.affected_url),
      source: String(row.source),
      payload: row.payload,
    };
    return candidate;
  };
};

export const buildAssessmentLoader = (db: Kysely<Database>): AssessmentLoader => {
  return async ({ tenantId, assessmentId }) => {
    const row = await db
      .selectFrom('assessments')
      .select(['id', 'tenant_id', 'project_id'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', assessmentId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      projectId: row.project_id ? String(row.project_id) : null,
    };
  };
};

export const buildFindingsWriter = (db: Kysely<Database>): FindingsWriter => {
  return async (input) => {
    return insertConfirmedFinding({ db, ...input });
  };
};

export const buildFindingEvidenceWriter = (db: Kysely<Database>): FindingEvidenceWriter => {
  return async (input) => {
    return insertFindingEvidence({ db, ...input });
  };
};

export const buildFindingByCandidateLoader = (db: Kysely<Database>): FindingByCandidateLoader => {
  return async ({ tenantId, candidateFindingId }) => {
    return findFindingByCandidateId({ db, tenantId, candidateFindingId });
  };
};

export const buildEvidenceCounter = (db: Kysely<Database>): EvidenceCounter => {
  return async ({ tenantId, findingId }) => {
    const rows = await listFindingEvidence({ db, tenantId, findingId });
    return rows.length;
  };
};

export const buildFindingCreatedAuditChecker = (
  db: Kysely<Database>,
): FindingCreatedAuditChecker => {
  return async ({ tenantId, findingId }) => {
    const row = await db
      .selectFrom('audit_events')
      .select(['id'])
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'finding.created')
      .where('resource_id', '=', findingId)
      .executeTakeFirst();
    return Boolean(row);
  };
};

export interface BuildValidatorHandlerInput {
  readonly db: Kysely<Database>;
  readonly storage: LocalObjectStorage;
  readonly buildScope: (assessmentId: string) => Promise<unknown>;
  readonly driverDeps?: FakeXssReplayDriverDeps;
}

export const buildValidatorHandlerDeps = (input: BuildValidatorHandlerInput): ValidatorWorkerDeps =>
  ({
    driver: new FakeXssReplayDriver(input.driverDeps ?? {}),
    objectStorage: input.storage,
    // biome-ignore lint/suspicious/noExplicitAny: scope shape varies; runtime checked.
    buildScope: input.buildScope as any,
    scopeDeps: stubValidatorScopeDeps,
    auditEmitter: buildAuditEmitter(input.db),
    candidateLoader: buildCandidateLoader(input.db),
    assessmentLoader: buildAssessmentLoader(input.db),
    findingsWriter: buildFindingsWriter(input.db),
    findingEvidenceWriter: buildFindingEvidenceWriter(input.db),
    findingByCandidateLoader: buildFindingByCandidateLoader(input.db),
    evidenceCounter: buildEvidenceCounter(input.db),
    findingCreatedAuditChecker: buildFindingCreatedAuditChecker(input.db),
    payloadSchema: validateFindingPayloadSchema,
  }) as ValidatorWorkerDeps;

export interface LabHarness {
  readonly handle: XssLabHandle;
  readonly origin: string;
  readonly port: number;
}

export const withLab = async <T>(fn: (lab: LabHarness) => Promise<T>): Promise<T> => {
  const handle = await startXssLab(0);
  try {
    return await fn({ handle, origin: handle.origin, port: handle.port });
  } finally {
    await handle.stop();
  }
};

export const uniqUuid = (): string => crypto.randomUUID();

export const allowLocalhostLabScopeRules = (port: number): unknown[] => [
  {
    ruleKind: 'domain',
    effect: 'allow' as const,
    payload: { pattern: 'localhost', matchSubdomains: false },
  },
  {
    ruleKind: 'ip',
    effect: 'allow' as const,
    payload: { ip: '203.0.113.7' },
  },
  {
    ruleKind: 'protocol',
    effect: 'allow' as const,
    payload: { protocol: 'http' },
  },
  {
    ruleKind: 'port',
    effect: 'allow' as const,
    payload: { port },
  },
  {
    ruleKind: 'http_method',
    effect: 'allow' as const,
    payload: { method: 'GET' },
  },
  {
    ruleKind: 'path_pattern',
    effect: 'allow' as const,
    payload: { glob: '/**' },
  },
];

/**
 * Seed a candidate_finding row pointing at the lab fixture's vulnerable
 * search endpoint. Returns the candidateFindingId so ITs can dispatch
 * `validate.finding` envelopes against it.
 */
export const seedCandidateFinding = async (
  db: Kysely<Database>,
  args: {
    tenantId: string;
    assessmentId: string;
    affectedUrl: string;
    type?: string;
    severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  },
): Promise<string> => {
  const id = uniqUuid();
  // biome-ignore lint/suspicious/noExplicitAny: jsonb boundary requires string.
  const payloadJson = JSON.stringify({ sample: 1 }) as any;
  await db
    .insertInto('candidate_findings')
    .values({
      id,
      tenant_id: args.tenantId,
      assessment_id: args.assessmentId,
      type: args.type ?? 'xss_reflected',
      severity: args.severity ?? 'medium',
      affected_url: args.affectedUrl,
      source: 'fake-decepticon',
      payload: payloadJson,
    })
    .execute();
  return id;
};
