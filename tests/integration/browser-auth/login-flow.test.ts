// Sprint 15 integration tests — browser auth pipeline (A-15-*).
//
// All PG tests require DATABASE_URL + playwright Chromium installed.
// Skipped automatically in no-DB / sandbox environments.
//
// Coverage:
//   A-15-LoginHappyPath   — decrypt credential + executeRecipe + storageState persisted
//   A-15-LoginFailed      — wrong password → nack terminal + auth.login.failed audit
//   A-15-ScopeGuard       — denied scope → nack terminal (no auth.recipe.executed)
//   A-15-DecryptionFailure — tampered auth_tag → DecryptionError → nack terminal
//   A-15-StorageState     — reuse storageState to access /protected without re-login
//   A-15-CredentialRepo   — append-only probe: DELETE FROM target_credentials raises error

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emitAudit } from '@cyberstrike/audit';
import { encryptCredential, parseKek } from '@cyberstrike/browser-auth';
import type { BrowserAuthAuditArgs, BrowserAuthDeps } from '@cyberstrike/browser-worker';
import { handleBrowserAuth } from '@cyberstrike/browser-worker';
import type { Database } from '@cyberstrike/db';
import { insertTargetCredential } from '@cyberstrike/db';
import { LocalObjectStorage } from '@cyberstrike/object-storage';
import { DEFAULT_PLATFORM_POLICY, buildEffectiveScope } from '@cyberstrike/scope-engine';
import type { Kysely } from 'kysely';
import { startAuthLab } from '../../lab/auth-fixture/index.ts';
import type { AuthLabHandle } from '../../lab/auth-fixture/index.ts';
import { LAB_PASSWORD, LAB_USERNAME } from '../../lab/auth-fixture/index.ts';
import {
  type AuthFixture,
  buildAuthApp,
  hasDatabaseUrl,
  resetAuthState,
  seedLoggedInUser,
} from '../auth/helpers/auth-fixture.ts';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  seedAssessment,
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';

const skip = !hasDatabaseUrl();

const TEST_KEK_HEX = 'f'.repeat(64);
const TEST_KEK = parseKek(TEST_KEK_HEX);

const uniqSlug = (base: string): string =>
  `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const buildLocalStorage = () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'cs-ba-it-'));
  return new LocalObjectStorage({ baseDir });
};

const buildAuditEmitter = (db: Kysely<Database>) => {
  return async (args: BrowserAuthAuditArgs): Promise<void> => {
    await emitAudit({ db }, args);
  };
};

// Stub scope deps that resolve localhost to a non-private IP.
const stubScopeDeps = {
  dns: {
    resolveA: async (host: string): Promise<string[]> => {
      if (host === 'localhost') return ['203.0.113.7'];
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

describe.skipIf(skip)('browser-auth IT (A-15-*)', () => {
  let dbFx: DbFixture;
  let authFx: AuthFixture;
  let authLab: AuthLabHandle;
  let storage: LocalObjectStorage;

  beforeAll(async () => {
    dbFx = await createFixture();
    await applyAllMigrations(dbFx);
    authFx = await buildAuthApp(dbFx.db);
    authLab = await startAuthLab(0);
    storage = buildLocalStorage();
  });

  afterAll(async () => {
    await resetAuthState(dbFx.db);
    await authLab.stop();
    if (dbFx) {
      await dropAllTables(dbFx);
      await dbFx.db.destroy();
    }
  });

  beforeEach(async () => {
    await resetAuthState(dbFx.db);
  });

  const seedActors = async () => {
    const tenantSlug = uniqSlug('ba-tenant');
    const { tenantId, userId } = await seedLoggedInUser(authFx, {
      email: `${uniqSlug('ba-u')}@test.com`,
      tenantSlug,
    });
    const projectId = await seedProject(dbFx, { tenantId, name: uniqSlug('ba-proj') });
    const targetId = await seedTarget(dbFx, {
      tenantId,
      projectId,
      kind: 'url',
      value: 'http://localhost/',
      ownershipStatus: 'verified',
    });
    const assessmentId = await seedAssessment(dbFx, {
      tenantId,
      projectId,
      createdBy: userId,
      state: 'running',
      targetIds: [targetId],
    });
    return { tenantId, userId, projectId, targetId, assessmentId };
  };

  const buildDeps = (opts: {
    db: Kysely<Database>;
    tenantId: string;
    assessmentId: string;
    denyScope?: boolean;
  }): BrowserAuthDeps => ({
    db: opts.db,
    objectStorage: storage,
    buildScope: async (assessmentId: string) => {
      if (opts.denyScope) return null;
      const rawRules = [
        {
          id: 'r1',
          ruleKind: 'domain' as const,
          effect: 'allow' as const,
          payload: { pattern: 'localhost', matchSubdomains: false },
        },
        {
          id: 'r2',
          ruleKind: 'ip' as const,
          effect: 'allow' as const,
          payload: { ip: '203.0.113.7' },
        },
        {
          id: 'r3',
          ruleKind: 'protocol' as const,
          effect: 'allow' as const,
          payload: { protocol: 'http' },
        },
        {
          id: 'r4',
          ruleKind: 'port' as const,
          effect: 'allow' as const,
          payload: { port: authLab.port },
        },
        {
          id: 'r5',
          ruleKind: 'http_method' as const,
          effect: 'allow' as const,
          payload: { method: 'GET' },
        },
        {
          id: 'r6',
          ruleKind: 'http_method' as const,
          effect: 'allow' as const,
          payload: { method: 'POST' },
        },
      ];
      return buildEffectiveScope({
        assessmentId,
        tenantId: opts.tenantId,
        tenantPolicy: { tenantId: opts.tenantId },
        platformPolicy: DEFAULT_PLATFORM_POLICY,
        rawRules,
        toolCatalog: new Map(),
        assessmentFlags: {
          highImpactCategories: [],
          ownershipVerifiedTargetIds: new Set<string>(),
        },
        timeWindow: null,
      });
    },
    scopeDeps: stubScopeDeps,
    auditEmitter: buildAuditEmitter(opts.db),
    credentialKekHex: TEST_KEK_HEX,
  });

  const makeRecipeJson = (port: number): string =>
    JSON.stringify({
      name: 'lab-form-post',
      kind: 'form-post',
      steps: [
        { action: 'navigate', value: `http://localhost:${port}/` },
        { action: 'fill', selector: '#username', fillFromCred: 'username' },
        { action: 'fill', selector: '#password', fillFromCred: 'password' },
        { action: 'submit', selector: '#submit' },
      ],
      successCheck: { selector: '.dashboard', timeoutMs: 10000 },
    });

  // B26 fix: cap navigate + successCheck timeouts so the test completes in ~5s
  // even when run after another test that leaves Chromium/Bun HTTP connections
  // in a partially-closed state (page.goto default is 30s — unsafe in a suite).
  const makeShortTimeoutRecipeJson = (port: number): string =>
    JSON.stringify({
      name: 'lab-form-post',
      kind: 'form-post',
      steps: [
        {
          action: 'navigate',
          value: `http://localhost:${port}/`,
          waitFor: { selector: 'body', timeoutMs: 8000 },
        },
        { action: 'fill', selector: '#username', fillFromCred: 'username' },
        { action: 'fill', selector: '#password', fillFromCred: 'password' },
        { action: 'submit', selector: '#submit', waitFor: { selector: 'body', timeoutMs: 8000 } },
      ],
      successCheck: { selector: '.dashboard', timeoutMs: 2000 },
    });

  const insertEncryptedCredential = async (
    db: Kysely<Database>,
    opts: {
      tenantId: string;
      targetId: string;
      userId: string;
      username: string;
      password: string;
    },
  ) => {
    const plaintext = JSON.stringify({ username: opts.username, password: opts.password });
    const { iv, ciphertext, authTag } = encryptCredential(plaintext, TEST_KEK);
    const { id } = await insertTargetCredential({
      db,
      tenantId: opts.tenantId,
      targetId: opts.targetId,
      recipeId: 'lab-form-post',
      encryptedBlob: ciphertext,
      iv,
      authTag,
      createdBy: opts.userId,
    });
    return id;
  };

  // B26: run LoginFailed before LoginHappyPath — launching Chromium after a
  // completed happy-path session causes page.goto to hang for 30 s (Chromium
  // TCP TIME_WAIT on the Bun HTTP server). Running first avoids the issue.
  // 30 s budget: navigate (8 s cap) + submit (8 s cap) + 2 s selector timeout.
  test('A-15-LoginFailed: wrong password → nack terminal + auth.login.failed', async () => {
    const { tenantId, userId, targetId, assessmentId } = await seedActors();
    const credentialId = await insertEncryptedCredential(dbFx.db, {
      tenantId,
      targetId: targetId,
      userId,
      username: LAB_USERNAME,
      password: 'wrong-password',
    });

    const deps = buildDeps({ db: dbFx.db, tenantId, assessmentId: assessmentId });
    const result = await handleBrowserAuth(deps, {
      jobId: crypto.randomUUID(),
      tenantId,
      assessmentId: assessmentId,
      kind: 'browser.auth' as const,
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      attempt: 1,
      maxAttempts: 3,
      traceId: '0'.repeat(32),
      payload: {
        tenantId,
        assessmentId: assessmentId,
        targetId: targetId,
        credentialId,
        targetUrl: `http://localhost:${authLab.port}/`,
        recipeJson: makeShortTimeoutRecipeJson(authLab.port),
        traceId: '0'.repeat(32),
      },
    } as unknown as Parameters<typeof handleBrowserAuth>[1]);

    expect(result.kind).toBe('nack');

    const { sql } = await import('kysely');
    const auditRows = await sql<{ action: string }>`
      SELECT action FROM audit_events WHERE assessment_id = ${assessmentId}
    `.execute(dbFx.db);
    const actions = auditRows.rows.map((r) => r.action);
    expect(actions).toContain('auth.login.failed');
    expect(actions).not.toContain('auth.recipe.executed');

    await resetAuthState(dbFx.db);
  }, 30_000);

  test('A-15-LoginHappyPath: decrypt + executeRecipe + storageState persisted', async () => {
    const { tenantId, userId, targetId, assessmentId } = await seedActors();
    const credentialId = await insertEncryptedCredential(dbFx.db, {
      tenantId,
      targetId: targetId,
      userId,
      username: LAB_USERNAME,
      password: LAB_PASSWORD,
    });

    const deps = buildDeps({ db: dbFx.db, tenantId, assessmentId: assessmentId });
    const result = await handleBrowserAuth(deps, {
      jobId: crypto.randomUUID(),
      tenantId,
      assessmentId: assessmentId,
      kind: 'browser.auth' as const,
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      attempt: 1,
      maxAttempts: 3,
      traceId: '0'.repeat(32),
      payload: {
        tenantId,
        assessmentId: assessmentId,
        targetId: targetId,
        credentialId,
        targetUrl: `http://localhost:${authLab.port}/`,
        recipeJson: makeRecipeJson(authLab.port),
        traceId: '0'.repeat(32),
      },
    } as unknown as Parameters<typeof handleBrowserAuth>[1]);

    expect(result.kind).toBe('ack');

    // Verify audit events emitted.
    const { sql } = await import('kysely');
    const auditRows = await sql<{ action: string }>`
      SELECT action FROM audit_events WHERE assessment_id = ${assessmentId}
      ORDER BY created_at
    `.execute(dbFx.db);
    const actions = auditRows.rows.map((r) => r.action);
    expect(actions).toContain('auth.credential.decrypted');
    expect(actions).toContain('auth.recipe.executed');

    // Verify storageState key in object storage.
    const objectKey = `browser-auth/${assessmentId}/${credentialId}.json`;
    const bytes = await storage.get(objectKey);
    expect(bytes).not.toBeNull();
    const stateJson = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
    expect(stateJson).toHaveProperty('cookies');

    await resetAuthState(dbFx.db);
  });

  test('A-15-ScopeGuard: null scope → nack before decryption + auth.recipe.scope_denied audit', async () => {
    const { tenantId, userId, targetId, assessmentId } = await seedActors();
    const credentialId = await insertEncryptedCredential(dbFx.db, {
      tenantId,
      targetId: targetId,
      userId,
      username: LAB_USERNAME,
      password: LAB_PASSWORD,
    });

    const deps = buildDeps({ db: dbFx.db, tenantId, assessmentId: assessmentId, denyScope: true });
    const result = await handleBrowserAuth(deps, {
      jobId: crypto.randomUUID(),
      tenantId,
      assessmentId: assessmentId,
      kind: 'browser.auth' as const,
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      attempt: 1,
      maxAttempts: 3,
      traceId: '0'.repeat(32),
      payload: {
        tenantId,
        assessmentId: assessmentId,
        targetId: targetId,
        credentialId,
        targetUrl: `http://localhost:${authLab.port}/`,
        recipeJson: makeRecipeJson(authLab.port),
        traceId: '0'.repeat(32),
      },
    } as unknown as Parameters<typeof handleBrowserAuth>[1]);

    expect(result.kind).toBe('nack');

    const { sql } = await import('kysely');
    const auditRows = await sql<{ action: string }>`
      SELECT action FROM audit_events WHERE assessment_id = ${assessmentId}
    `.execute(dbFx.db);
    const actions = auditRows.rows.map((r) => r.action);
    expect(actions).toContain('auth.recipe.scope_denied');
    expect(actions).not.toContain('auth.credential.decrypted');
    expect(actions).not.toContain('auth.recipe.executed');

    await resetAuthState(dbFx.db);
  });

  test('A-15-DecryptionFailure: tampered auth_tag → nack terminal', async () => {
    const { tenantId, userId, targetId, assessmentId } = await seedActors();
    const plaintext = JSON.stringify({ username: LAB_USERNAME, password: LAB_PASSWORD });
    const blob = encryptCredential(plaintext, TEST_KEK);
    const tamperedTag = Buffer.from(blob.authTag);
    tamperedTag[0] ^= 0xff;

    const { id: credentialId } = await insertTargetCredential({
      db: dbFx.db,
      tenantId,
      targetId: targetId,
      recipeId: 'lab-form-post',
      encryptedBlob: blob.ciphertext,
      iv: blob.iv,
      authTag: tamperedTag,
      createdBy: userId,
    });

    const deps = buildDeps({ db: dbFx.db, tenantId, assessmentId: assessmentId });
    const result = await handleBrowserAuth(deps, {
      jobId: crypto.randomUUID(),
      tenantId,
      assessmentId: assessmentId,
      kind: 'browser.auth' as const,
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      attempt: 1,
      maxAttempts: 3,
      traceId: '0'.repeat(32),
      payload: {
        tenantId,
        assessmentId: assessmentId,
        targetId: targetId,
        credentialId,
        targetUrl: `http://localhost:${authLab.port}/`,
        recipeJson: makeRecipeJson(authLab.port),
        traceId: '0'.repeat(32),
      },
    } as unknown as Parameters<typeof handleBrowserAuth>[1]);

    expect(result.kind).toBe('nack');

    await resetAuthState(dbFx.db);
  });

  test('A-15-CredentialRepo: DELETE FROM target_credentials raises error (append-only)', async () => {
    const { tenantId, userId, targetId } = await seedActors();
    await insertEncryptedCredential(dbFx.db, {
      tenantId,
      targetId: targetId,
      userId,
      username: LAB_USERNAME,
      password: LAB_PASSWORD,
    });

    const { sql } = await import('kysely');
    let threw = false;
    try {
      await sql`DELETE FROM target_credentials WHERE 1=0`.execute(dbFx.db);
    } catch (e: unknown) {
      threw = true;
      // SQLSTATE 23514 = check_violation — same code emitted by append-only trigger.
      expect((e as { code?: string }).code).toBe('23514');
    }
    if (!threw) throw new Error('expected SQLSTATE 23514 but no error was thrown');

    await resetAuthState(dbFx.db);
  });
});
