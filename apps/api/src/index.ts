// apps/api public surface.
// Sprint 1 invariant A18: `name` MUST equal the workspace key.

export const name = 'apps/api' as const;

export { type AuthApiConfig, loadAuthApiConfig } from './config.ts';
export {
  type CookieAttributes,
  buildClearCookieHeader,
  buildSetCookieHeader,
  mintSessionTokenPlaintext,
  readSessionCookie,
} from './cookies.ts';
export { type AppOptions, type CreatedApp, createApp } from './factory.ts';
export {
  type PreAuthEntry,
  type PreAuthIssued,
  type PreAuthStore,
  PRE_AUTH_TOKEN_BYTES,
  PRE_AUTH_TOKEN_TTL_MS,
  createPreAuthStore,
} from './pre-auth-tokens.ts';
export { SessionRepo, type SessionLookup } from './session-repo.ts';
export {
  type EmitAuditArgs,
  type AuditAction,
  type AuditOutcome,
  emitAudit,
} from './middleware/audit.ts';
export { assertOwnership, type ResourceTenancy } from './middleware/assert-ownership.ts';
export {
  DEFAULT_LOGIN_RATE_LIMIT,
  type RateLimitConfig,
  type RateLimiter,
  createRateLimiter,
} from './middleware/rate-limit.ts';
export { sessionMiddleware, type SessionEnv } from './middleware/session.ts';
export { tenantGuard } from './middleware/tenant-guard.ts';
export { selfRegisterLimiter } from './routes/auth/self-register.ts';
export {
  PLATFORM_TENANT_SLUG,
  ensurePlatformTenantId,
  resetPlatformTenantCache,
} from './routes/shared.ts';
export type { TxtDnsResolver } from './routes/domains/domain-verify.ts';
