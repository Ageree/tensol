// Sprint 7 — shared helpers for queue IT.

import type { DbFixture } from '../db/helpers/db-fixture.ts';
import { seedAssessment, seedProject } from '../db/helpers/db-fixture.ts';

export interface SeededAssessmentContext {
  readonly tenantId: string;
  readonly projectId: string;
  readonly assessmentId: string;
  readonly userId: string;
}

const uniqId = (): string => crypto.randomUUID();

/**
 * Seed the minimal tenant + user + project + assessment graph needed for a
 * jobs row to satisfy its FKs (tenant_id, assessment_id, optional project_id).
 */
export const seedMinimalAssessmentContext = async (
  fx: DbFixture,
): Promise<SeededAssessmentContext> => {
  const tenantId = uniqId();
  await fx.db
    .insertInto('tenants')
    .values({ id: tenantId, slug: `t-${tenantId.slice(0, 8)}`, name: 't' })
    .execute();
  const userId = uniqId();
  await fx.db
    .insertInto('users')
    .values({
      id: userId,
      tenant_id: tenantId,
      email: `u-${userId.slice(0, 8)}@example.com`,
      display_name: `u-${userId.slice(0, 8)}`,
      status: 'active',
      role: 'security_lead',
      password_hash: 'x',
    })
    .execute();
  const projectId = await seedProject(fx, { tenantId, name: `P-${userId.slice(0, 6)}` });
  const assessmentId = await seedAssessment(fx, {
    tenantId,
    projectId,
    createdBy: userId,
    state: 'running',
  });
  return { tenantId, projectId, assessmentId, userId };
};
