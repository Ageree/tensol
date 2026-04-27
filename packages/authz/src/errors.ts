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
 * Sprint 3 contract C18 (R6): structured fields for audit reconstruction.
 * Middleware MUST translate to generic `403 {error: 'forbidden'}` — never
 * leak the field values into the response body (C18c).
 */
export class RbacDenyError extends Error {
  public readonly actorTenantId: string;
  public readonly attemptedResourceType: string;
  public readonly attemptedResourceId: string | undefined;
  public readonly reason: string;

  constructor(args: {
    actorTenantId: string;
    attemptedResourceType: string;
    attemptedResourceId?: string;
    reason: string;
  }) {
    super(`forbidden: ${args.reason}`);
    this.name = 'RbacDenyError';
    this.actorTenantId = args.actorTenantId;
    this.attemptedResourceType = args.attemptedResourceType;
    this.attemptedResourceId = args.attemptedResourceId;
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
