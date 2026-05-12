// Manual one-shot ingest: read /workspace/findings/*.md from decepticon-sandbox,
// parse via extractWorkspaceFindings, INSERT into candidate_findings under the
// given scan_id. Used to backfill findings for scan #8 (which completed BEFORE
// the auto-extractor was wired into the running coord process).
//
// Usage:
//   DATABASE_URL=postgres://... bun scripts/ingest-workspace-findings.ts <scan_id> <tenant_id>

import { sql } from 'kysely';
import { emitSignedAudit } from '@cyberstrike/audit';
import { createDatabase } from '@cyberstrike/db';
import { extractWorkspaceFindings } from '../apps/api/src/scope-engine/decepticon-workspace.ts';

const argScanId = process.argv[2];
const argTenantId = process.argv[3];
if (!argScanId || !argTenantId) {
  console.error('Usage: bun scripts/ingest-workspace-findings.ts <scan_id> <tenant_id>');
  process.exit(1);
}

const main = async (): Promise<void> => {
  const db = createDatabase({
    url: process.env['DATABASE_URL'] ?? 'postgres://cs:cs@localhost:5433/cyberstrike',
  });
  console.warn('extracting findings from /workspace/findings/...');
  const findings = await extractWorkspaceFindings({});
  console.warn(`found ${findings.length} parsed findings`);

  const sessionRow = await db
    .selectFrom('decepticon_sessions')
    .select(['id'])
    .where('tenant_id', '=', argTenantId)
    .where('assessment_id', '=', argScanId)
    .executeTakeFirst();
  const sessionId = sessionRow?.id;
  console.warn(`session id: ${sessionId ?? '(none)'}`);

  const projectRow = await db
    .selectFrom('assessments')
    .select(['project_id'])
    .where('tenant_id', '=', argTenantId)
    .where('id', '=', argScanId)
    .executeTakeFirst();
  const projectId = projectRow?.project_id;
  console.warn(`project id: ${projectId ?? '(none)'}`);

  let inserted = 0;
  for (const f of findings) {
    const candidateFindingId = crypto.randomUUID();
    await db
      .insertInto('candidate_findings')
      .values({
        id: candidateFindingId,
        tenant_id: argTenantId,
        assessment_id: argScanId,
        type: f.type,
        severity: f.severity,
        affected_url: f.affectedUrl ?? '',
        source: 'decepticon',
        // biome-ignore lint/suspicious/noExplicitAny: Json boundary
        payload: JSON.stringify({
          decepticonFindingId: f.id,
          agent: f.agent,
          ts: f.ts,
          description: f.description ?? '',
          backfilled: true,
        }) as any,
      })
      .execute();
    await emitSignedAudit(db, {
      tenantId: argTenantId,
      action: 'decepticon.candidate.observed',
      outcome: 'success',
      actorType: 'service',
      actorId: 'coordinator',
      actorName: 'coordinator',
      resourceType: 'candidate_finding',
      resourceId: candidateFindingId,
      ...(projectId ? { projectId } : {}),
      assessmentId: argScanId,
      ip: 'coordinator',
      userAgent: null,
      traceId: '00000000000000000000000000000000',
      metadata: {
        ...(sessionId ? { sessionId } : {}),
        type: f.type,
        severity: f.severity,
        source: 'workspace_extractor_backfill',
        decepticonFindingId: f.id,
      },
    });
    inserted += 1;
    console.warn(
      `  inserted ${f.id} (${f.severity} ${f.type}) — ${f.affectedUrl ?? 'no-url'} — ${f.description?.slice(0, 60) ?? ''}`,
    );
  }

  // Bump candidateCount in the existing assessment.completed audit metadata
  // is impossible (append-only), so just emit a backfill summary audit.
  // Actually we can't add new audit actions easily; just log.
  console.warn(`backfilled ${inserted} candidate_findings for scan ${argScanId}`);
  void sql; // keep import for potential future use
  await db.destroy();
};

await main();
