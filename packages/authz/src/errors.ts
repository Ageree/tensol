// Error types for packages/authz. Sprint 3 contract C18/C18c — every error
// carries enough structured context for audit reconstruction; HTTP middleware
// translates them to generic body shapes (no tenant ID leakage).

export class AuthError extends Error {
  public readonly code: string;
  constructor(message: string, code = 'auth_error') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export class MfaError extends Error {
  public readonly code: string;
  constructor(message: string, code = 'mfa_error') {
    super(message);
    this.name = 'MfaError';
    this.code = code;
  }
}

/**
 * Sprint 3 contract C18 (R6) + Sprint 4 A8 (R3+R7): structured fields for
 * audit reconstruction. Middleware MUST translate to generic
 * `403 {error: 'forbidden'}` — never leak the field values into the response
 * body (C18c).
 *
 * Sprint 4 attribution rule: cross-tenant deny audit rows are attributed to
 * the **actor's** tenant (`actorTenantId`), not the targeted tenant. The
 * targeted tenant lands in `targetedTenantId` and ends up as
 * `metadata.attemptedResourceTenantId` on the audit row.
 */
export class RbacDenyError extends Error {
  public readonly actorTenantId: string;
  public readonly attemptedResourceType: string;
  public readonly attemptedResourceId: string | undefined;
  public readonly targetedTenantId: string | undefined;
  public readonly reason: string;

  constructor(args: {
    actorTenantId: string;
    attemptedResourceType: string;
    attemptedResourceId?: string;
    targetedTenantId?: string;
    reason: string;
  }) {
    super(`forbidden: ${args.reason}`);
    this.name = 'RbacDenyError';
    this.actorTenantId = args.actorTenantId;
    this.attemptedResourceType = args.attemptedResourceType;
    this.attemptedResourceId = args.attemptedResourceId;
    this.targetedTenantId = args.targetedTenantId;
    this.reason = args.reason;
  }
}

export class RateLimitError extends Error {
  public readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('too_many_requests');
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
