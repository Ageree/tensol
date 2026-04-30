// Sprint 15 — handleBrowserAuth: the browser.auth envelope handler.
//
// Flow:
//   1. Parse payload (defence in depth).
//   2. Load TargetCredentialRow from DB (tenant-scoped).
//   3. Decrypt credential using AES-256-GCM + CREDENTIAL_KEK env var.
//   4. Parse decrypted JSON → Credential.
//   5. Parse LoginRecipe from payload (recipe JSON passed inline).
//   6. Scope-guard: validate target URL before any browser action.
//   7. Launch RealBrowserDriver context + executeRecipe.
//   8. Emit auth.credential.decrypted + auth.recipe.executed audit events.
//   9. Compute sha256 of storageState; PUT to object storage.
//  10. Emit auth.login.failed on LoginFailedError (terminal nack via __terminal marker).
//  11. Zero-out credential reference.
//
// Security invariants:
//   - Decryption ONLY here, never in apps/api.
//   - KEK never logged.
//   - storageState never included in audit event payloads.

import { createHash } from 'node:crypto';
import {
  type Credential,
  CredentialSchema,
  LoginFailedError,
  LoginRecipeSchema,
  type LoginResult,
  decryptCredential,
  executeRecipe,
  parseKek,
} from '@cyberstrike/browser-auth';
import type { AuditAction, AuditOutcome, ServiceActorId } from '@cyberstrike/contracts';
import type { Database } from '@cyberstrike/db';
import { getTargetCredential } from '@cyberstrike/db';
import type { ObjectStorage } from '@cyberstrike/object-storage';
import { type HandlerOutcome, type JobEnvelope, ScopeDenyError } from '@cyberstrike/queue';
import type { EffectiveScope } from '@cyberstrike/scope-engine';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { RealBrowserDriver } from './real-driver.ts';
import { type ScopeGuardDeps, checkNavigation } from './scope-guard.ts';

const AUTH_WORKER_ACTOR_ID: ServiceActorId = 'browser-worker';

export const browserAuthPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  assessmentId: z.string().uuid(),
  targetId: z.string().uuid(),
  credentialId: z.string().uuid(),
  targetUrl: z.string().url(),
  recipeJson: z.string().min(1),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
});

export type BrowserAuthPayload = z.infer<typeof browserAuthPayloadSchema>;

export interface BrowserAuthAuditArgs {
  readonly tenantId: string;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly actorType: 'service';
  readonly actorId: ServiceActorId;
  readonly actorName: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly assessmentId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly traceId: string;
  readonly metadata: Record<string, unknown>;
}

export type BrowserAuthAuditEmitter = (args: BrowserAuthAuditArgs) => Promise<void>;

export interface BrowserAuthDeps {
  readonly db: Kysely<Database>;
  readonly objectStorage: ObjectStorage;
  readonly buildScope: (assessmentId: string) => Promise<EffectiveScope | null>;
  readonly scopeDeps: ScopeGuardDeps;
  readonly auditEmitter: BrowserAuthAuditEmitter;
  /** Test seam — defaults to process.env.CREDENTIAL_KEK. */
  readonly credentialKekHex?: string;
}

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

const nack = (err: unknown): HandlerOutcome => ({
  kind: 'nack',
  error: err instanceof Error ? err : new Error(String(err)),
});

export const handleBrowserAuth = async (
  deps: BrowserAuthDeps,
  envelope: JobEnvelope,
): Promise<HandlerOutcome> => {
  let payload: BrowserAuthPayload;
  try {
    payload = browserAuthPayloadSchema.parse(envelope.payload);
  } catch (err) {
    return nack(err);
  }

  const { tenantId, assessmentId, credentialId, targetUrl, recipeJson, traceId } = payload;

  const auditBase = {
    tenantId,
    actorType: 'service' as const,
    actorId: AUTH_WORKER_ACTOR_ID,
    actorName: 'browser-worker',
    assessmentId,
    ip: null,
    userAgent: null,
    traceId,
  };

  // Load credential row (tenant-scoped).
  const credRow = await getTargetCredential(deps.db, credentialId, tenantId);
  if (!credRow) {
    return nack(new Error(`credential_not_found:${credentialId}`));
  }

  // Verify credential belongs to the requested target — prevents cross-target replay.
  if (credRow.targetId !== payload.targetId) {
    await deps.auditEmitter({
      ...auditBase,
      action: 'auth.credential.target_mismatch',
      outcome: 'denied',
      resourceType: 'target_credential',
      resourceId: credentialId,
      metadata: { requestedTargetId: payload.targetId, credentialTargetId: credRow.targetId },
    });
    return nack(new Error(`credential_target_mismatch:${credentialId}`));
  }

  // Scope-guard before any browser action — fail closed on null scope.
  const scope = await deps.buildScope(assessmentId);
  if (!scope) {
    await deps.auditEmitter({
      ...auditBase,
      action: 'auth.recipe.executed',
      outcome: 'failure',
      resourceType: 'target_credential',
      resourceId: credentialId,
      metadata: { reason: 'scope_unavailable' },
    });
    return nack(new Error('scope_unavailable'));
  }

  const decision = await checkNavigation(scope, targetUrl, deps.scopeDeps);
  if (!decision.allowed) {
    return nack(new ScopeDenyError(targetUrl, decision.matchedDenyRuleIds));
  }

  // Decrypt credential — KEK never logged.
  const { CREDENTIAL_KEK } = process.env;
  let kek: Buffer;
  try {
    kek = parseKek(deps.credentialKekHex ?? CREDENTIAL_KEK);
  } catch (err) {
    return nack(err);
  }

  let credential: Credential;
  try {
    const plaintext = decryptCredential(
      { iv: credRow.iv, ciphertext: credRow.encryptedBlob, authTag: credRow.authTag },
      kek,
    );
    credential = CredentialSchema.parse(JSON.parse(plaintext));
  } catch (err) {
    return nack(err);
  }

  await deps.auditEmitter({
    ...auditBase,
    action: 'auth.credential.decrypted',
    outcome: 'success',
    resourceType: 'target_credential',
    resourceId: credentialId,
    metadata: { targetId: credRow.targetId, recipeId: credRow.recipeId },
  });

  // Parse recipe.
  let recipe: ReturnType<typeof LoginRecipeSchema.parse>;
  try {
    recipe = LoginRecipeSchema.parse(JSON.parse(recipeJson));
  } catch (err) {
    return nack(err);
  }

  const recipeScopeCheck = async (url: string): Promise<void> => {
    const d = await checkNavigation(scope, url, deps.scopeDeps);
    if (!d.allowed) throw new ScopeDenyError(url, d.matchedDenyRuleIds);
  };

  // Launch browser + execute recipe.
  const driver = new RealBrowserDriver({
    scopeCheck: recipeScopeCheck,
  });

  let loginResult: LoginResult;
  try {
    const session = await driver.launch({
      tenantId,
      assessmentId,
      traceId,
    });

    // Access the underlying Playwright context for storageState capture.
    // biome-ignore lint/suspicious/noExplicitAny: internal session map access for storageState.
    const internalSession = (driver as any).sessions?.get(session.sessionId);
    const page = internalSession?.page;
    const context = internalSession?.context;

    if (!page || !context) {
      throw new Error('browser_session_missing_page_or_context');
    }

    try {
      loginResult = await executeRecipe(page, context, recipe, credential, recipeScopeCheck);
    } finally {
      // Zero-out credential reference (best-effort GC hint).
      credential = { username: '', password: '' };
      await driver.close(session.sessionId);
    }
  } catch (err) {
    if (err instanceof LoginFailedError) {
      await deps.auditEmitter({
        ...auditBase,
        action: 'auth.login.failed',
        outcome: 'failure',
        resourceType: 'target_credential',
        resourceId: credentialId,
        metadata: { recipeId: credRow.recipeId, error: err.message },
      });
      return nack(err);
    }
    return nack(err);
  }

  // Persist storageState to object storage.
  const storageStateSha256 = sha256Hex(loginResult.storageState);
  const objectKey = `browser-auth/${assessmentId}/${credentialId}.json`;
  await deps.objectStorage.put({
    key: objectKey,
    body: Buffer.from(loginResult.storageState, 'utf8'),
    contentType: 'application/json',
  });

  await deps.auditEmitter({
    ...auditBase,
    action: 'auth.recipe.executed',
    outcome: 'success',
    resourceType: 'target_credential',
    resourceId: credentialId,
    metadata: {
      recipeId: credRow.recipeId,
      lastUrl: loginResult.lastUrl,
      cookieCount: loginResult.cookies.length,
      storageStateSha256,
      objectKey,
    },
  });

  return { kind: 'ack' };
};
