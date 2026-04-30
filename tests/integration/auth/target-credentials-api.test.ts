// Sprint 16 B19 — POST /api/v1/assessments/:id/target-credentials IT.
//
// 4 cases:
//   A-16-CredentialCreate        — 201 + audit (security_lead → allowed)
//   A-16-CredentialCreate403     — auditor → 403 (RBAC deny)
//   A-16-CredentialCreateCrossTenant — T2 actor posting to T1 assessment → 403/404
//   A-16-CredentialCreateBadBody — missing fields → 400
//
// P27: resetAuthState ×2 (beforeAll + beforeEach).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  seedAssessment,
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';
import {
  type AuthFixture,
  buildAuthApp,
  hasDatabaseUrl,
  resetAuthState,
  seedLoggedInUser,
} from './helpers/auth-fixture.ts';

const VALID_KEK = 'a'.repeat(64); // 64-char hex = 32 bytes for AES-256-GCM

describe.skipIf(!hasDatabaseUrl())(
  'integration :: target-credentials API (A-16-CredentialCreate*)',
  () => {
    let fx: DbFixture;
    let auth: AuthFixture;

    beforeAll(async () => {
      fx = await createFixture();
      await dropAllTables(fx);
      await applyAllMigrations(fx);
      auth = buildAuthApp(fx.db);
      // P27: resetAuthState in beforeAll.
      await resetAuthState(fx.db);
    });

    afterAll(async () => {
      await dropAllTables(fx);
      await fx.db.destroy();
    });

    beforeEach(async () => {
      // P27: resetAuthState in beforeEach.
      await resetAuthState(fx.db);
    });

    test('A-16-CredentialCreate — security_lead creates credential → 201 + audit', async () => {
      const oldKek = process.env.CREDENTIAL_KEK;
      process.env.CREDENTIAL_KEK = VALID_KEK;
      try {
        const t1 = await seedLoggedInUser(auth, {
          tenantSlug: 't1-cred-ok',
          email: 't1@credok.example',
          role: 'security_lead',
        });

        const projectId = await seedProject(fx, { tenantId: t1.tenantId, name: 'P-cred' });
        const targetId = await seedTarget(fx, {
          tenantId: t1.tenantId,
          projectId,
          kind: 'url',
          value: 'https://target.example',
          ownershipStatus: 'verified',
        });
        const assessmentId = await seedAssessment(fx, {
          tenantId: t1.tenantId,
          projectId,
          createdBy: t1.userId,
          state: 'running',
          targetIds: [targetId],
        });

        const body = {
          targetId,
          recipeId: crypto.randomUUID(),
          username: 'admin',
          password: 'secret',
        };

        const res = await auth.app.request(
          `/api/v1/assessments/${assessmentId}/target-credentials`,
          {
            method: 'POST',
            headers: { cookie: t1.cookieHeader, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        expect(res.status).toBe(201);
        const json = (await res.json()) as { id: string };
        expect(typeof json.id).toBe('string');

        // Audit event emitted.
        const audits = await fx.db
          .selectFrom('audit_events')
          .select(['action', 'resource_type', 'resource_id'])
          .where('tenant_id', '=', t1.tenantId)
          .where('action', '=', 'auth.credential.encrypted')
          .execute();
        expect(audits.length).toBe(1);
        expect(audits[0]?.resource_type).toBe('target_credential');
        expect(audits[0]?.resource_id).toBe(json.id);
      } finally {
        if (oldKek !== undefined) process.env.CREDENTIAL_KEK = oldKek;
        else Reflect.deleteProperty(process.env, 'CREDENTIAL_KEK');
      }
    });

    test('A-16-CredentialCreate403 — auditor role → 403', async () => {
      const oldKek = process.env.CREDENTIAL_KEK;
      process.env.CREDENTIAL_KEK = VALID_KEK;
      try {
        const t1 = await seedLoggedInUser(auth, {
          tenantSlug: 't1-cred-403',
          email: 'auditor@cred403.example',
          role: 'auditor',
        });

        const projectId = await seedProject(fx, { tenantId: t1.tenantId, name: 'P-cred-403' });
        const targetId = await seedTarget(fx, {
          tenantId: t1.tenantId,
          projectId,
          kind: 'url',
          value: 'https://target403.example',
          ownershipStatus: 'verified',
        });
        const assessmentId = await seedAssessment(fx, {
          tenantId: t1.tenantId,
          projectId,
          createdBy: t1.userId,
          state: 'running',
          targetIds: [targetId],
        });

        const body = {
          targetId,
          recipeId: crypto.randomUUID(),
          username: 'admin',
          password: 'secret',
        };

        const res = await auth.app.request(
          `/api/v1/assessments/${assessmentId}/target-credentials`,
          {
            method: 'POST',
            headers: { cookie: t1.cookieHeader, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        expect(res.status).toBe(403);
      } finally {
        if (oldKek !== undefined) process.env.CREDENTIAL_KEK = oldKek;
        else Reflect.deleteProperty(process.env, 'CREDENTIAL_KEK');
      }
    });

    test('A-16-CredentialCreateCrossTenant — T2 actor posting to T1 assessment → 403/404', async () => {
      const oldKek = process.env.CREDENTIAL_KEK;
      process.env.CREDENTIAL_KEK = VALID_KEK;
      try {
        const t1 = await seedLoggedInUser(auth, {
          tenantSlug: 't1-cred-xtenant',
          email: 't1@credxtenant.example',
          role: 'security_lead',
        });
        const t2 = await seedLoggedInUser(auth, {
          tenantSlug: 't2-cred-xtenant',
          email: 't2@credxtenant.example',
          role: 'security_lead',
        });

        const projectId = await seedProject(fx, { tenantId: t1.tenantId, name: 'P-xtenant' });
        const targetId = await seedTarget(fx, {
          tenantId: t1.tenantId,
          projectId,
          kind: 'url',
          value: 'https://xtenant.example',
          ownershipStatus: 'verified',
        });
        const assessmentId = await seedAssessment(fx, {
          tenantId: t1.tenantId,
          projectId,
          createdBy: t1.userId,
          state: 'running',
          targetIds: [targetId],
        });

        const body = {
          targetId,
          recipeId: crypto.randomUUID(),
          username: 'admin',
          password: 'secret',
        };

        // T2 cookie posting to T1's assessment — must be rejected.
        const res = await auth.app.request(
          `/api/v1/assessments/${assessmentId}/target-credentials`,
          {
            method: 'POST',
            headers: { cookie: t2.cookieHeader, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        expect([403, 404]).toContain(res.status);
      } finally {
        if (oldKek !== undefined) process.env.CREDENTIAL_KEK = oldKek;
        else Reflect.deleteProperty(process.env, 'CREDENTIAL_KEK');
      }
    });

    test('A-16-CredentialCreateBadBody — missing fields → 400', async () => {
      const oldKek = process.env.CREDENTIAL_KEK;
      process.env.CREDENTIAL_KEK = VALID_KEK;
      try {
        const t1 = await seedLoggedInUser(auth, {
          tenantSlug: 't1-cred-bad',
          email: 't1@credbad.example',
          role: 'security_lead',
        });

        const projectId = await seedProject(fx, { tenantId: t1.tenantId, name: 'P-bad' });
        const targetId = await seedTarget(fx, {
          tenantId: t1.tenantId,
          projectId,
          kind: 'url',
          value: 'https://targetbad.example',
          ownershipStatus: 'verified',
        });
        const assessmentId = await seedAssessment(fx, {
          tenantId: t1.tenantId,
          projectId,
          createdBy: t1.userId,
          state: 'running',
          targetIds: [targetId],
        });

        // Missing username + password.
        const res = await auth.app.request(
          `/api/v1/assessments/${assessmentId}/target-credentials`,
          {
            method: 'POST',
            headers: { cookie: t1.cookieHeader, 'content-type': 'application/json' },
            body: JSON.stringify({ targetId, recipeId: crypto.randomUUID() }),
          },
        );
        expect(res.status).toBe(400);
      } finally {
        if (oldKek !== undefined) process.env.CREDENTIAL_KEK = oldKek;
        else Reflect.deleteProperty(process.env, 'CREDENTIAL_KEK');
      }
    });
  },
);
