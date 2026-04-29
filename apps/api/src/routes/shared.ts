// Shared route plumbing — Sprint 3 §C22, C29.
//
// `RouteDeps` is the dependency bundle every auth route receives. It mirrors
// the AppOptions surface (factory.ts) plus the projects repo (used by the
// /_test/resource/:id IDOR fixture). Routes never import the factory directly
// to avoid a cycle.
//
// `canonical401` is the C22 single-shape failure body. EVERY auth-failure exit
// — bad credentials, unknown email, expired pre-auth token, replayed code —
// returns this exact body with status 401, so the client cannot distinguish
// failure modes (no oracle).

import type { PasswordHasher, TotpVerifier } from '@cyberstrike/authz';
import type { Database, Repositories } from '@cyberstrike/db';
import type { ObjectStorage } from '@cyberstrike/object-storage';
import type { Context } from 'hono';
import type { Kysely } from 'kysely';
import type { AuthApiConfig } from '../config.ts';
import type { EmitAuditArgs } from '../middleware/audit.ts';
import { emitAudit } from '../middleware/audit.ts';
import type { RateLimiter } from '../middleware/rate-limit.ts';
import type { SessionEnv } from '../middleware/session.ts';
import type { PreAuthStore } from '../pre-auth-tokens.ts';
import type { SessionRepo } from '../session-repo.ts';

export interface RouteDeps {
  readonly config: AuthApiConfig;
  readonly db: Kysely<Database>;
  readonly repos: Repositories;
  readonly hasher: PasswordHasher;
  readonly totp: TotpVerifier;
  readonly preAuthStore: PreAuthStore;
  readonly rateLimiter: RateLimiter;
  readonly sessionRepo: SessionRepo;
  readonly nowMs?: () => number;
  readonly objectStorage?: ObjectStorage;
}

/** Canonical 401 body — Sprint 3 C22. */
export const canonical401Body = (): { error: 'invalid_credentials' } =>
  ({ error: 'invalid_credentials' }) as const;

/** Trace ID for audit rows. Routes that don't have access to a span generate one. */
export const newTraceId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Best-effort source IP extraction (reverse-proxy aware in non-local). */
export const sourceIp = (c: Context<SessionEnv>): string => {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return c.req.header('x-real-ip') ?? 'unknown';
};

export const userAgent = (c: Context<SessionEnv>): string | null =>
  c.req.header('user-agent') ?? null;

/** Audit-emission wrapper: every state-changing route calls this exactly once. */
export const audit = async (deps: Pick<RouteDeps, 'db'>, args: EmitAuditArgs): Promise<void> => {
  await emitAudit({ db: deps.db }, args);
};

/**
 * Look up (or lazily seed) the system tenant used as the FK target for
 * unattributed platform-level audit rows (failed logins for unknown email,
 * pre-auth-token rejections, register-410-Gone). The system tenant is a
 * sentinel — it owns no users, projects, or assessments. C29 delta=1 audits
 * against this row land cleanly without violating the audit_events FK.
 *
 * Slug `__platform__` is reserved.
 */
export const PLATFORM_TENANT_SLUG = '__platform__' as const;

let platformTenantIdCache: string | null = null;

export const ensurePlatformTenantId = async (deps: Pick<RouteDeps, 'db'>): Promise<string> => {
  if (platformTenantIdCache) return platformTenantIdCache;
  const existing = await deps.db
    .selectFrom('tenants')
    .select(['id'])
    .where('slug', '=', PLATFORM_TENANT_SLUG)
    .executeTakeFirst();
  if (existing) {
    platformTenantIdCache = existing.id;
    return existing.id;
  }
  const created = await deps.db
    .insertInto('tenants')
    .values({
      name: 'Platform System',
      slug: PLATFORM_TENANT_SLUG,
      status: 'active',
    })
    .onConflict((oc) => oc.column('slug').doNothing())
    .returning(['id'])
    .executeTakeFirst();
  if (created) {
    platformTenantIdCache = created.id;
    return created.id;
  }
  // Race lost; re-read.
  const after = await deps.db
    .selectFrom('tenants')
    .select(['id'])
    .where('slug', '=', PLATFORM_TENANT_SLUG)
    .executeTakeFirstOrThrow();
  platformTenantIdCache = after.id;
  return after.id;
};

/** Reset the in-memory cache — only used by tests across DB resets. */
export const resetPlatformTenantCache = (): void => {
  platformTenantIdCache = null;
};
