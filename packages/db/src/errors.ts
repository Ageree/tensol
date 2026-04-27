// Error types for packages/db. Used by tenant-context, repository bases, and
// the migrator. Every error carries enough structured context for audit
// reconstruction (plan §2.6).

export class MissingTenantContextError extends Error {
  public readonly resourceType?: string | undefined;
  public readonly operation?: string | undefined;

  constructor(
    message = 'tenant context required: pass tenantId explicitly or wrap call in runInTenant(tenantId, ...)',
    context?: { resourceType?: string | undefined; operation?: string | undefined },
  ) {
    super(message);
    this.name = 'MissingTenantContextError';
    this.resourceType = context?.resourceType;
    this.operation = context?.operation;
  }
}

export class TenantContextMismatchError extends Error {
  public readonly explicit: string;
  public readonly ambient: string;
  public readonly resourceType?: string | undefined;
  public readonly operation?: string | undefined;

  constructor(args: {
    explicit: string;
    ambient: string;
    resourceType?: string | undefined;
    operation?: string | undefined;
  }) {
    super(
      `tenant context mismatch: explicit=${args.explicit} ambient=${args.ambient}${
        args.resourceType ? ` resource=${args.resourceType}` : ''
      }${args.operation ? ` op=${args.operation}` : ''}`,
    );
    this.name = 'TenantContextMismatchError';
    this.explicit = args.explicit;
    this.ambient = args.ambient;
    this.resourceType = args.resourceType;
    this.operation = args.operation;
  }
}

export class OptimisticLockError extends Error {
  public readonly resourceType: string;
  public readonly resourceId: string;
  public readonly expectedVersion: number;

  constructor(args: { resourceType: string; resourceId: string; expectedVersion: number }) {
    super(
      `optimistic lock failed for ${args.resourceType} ${args.resourceId}: expected version ${args.expectedVersion}`,
    );
    this.name = 'OptimisticLockError';
    this.resourceType = args.resourceType;
    this.resourceId = args.resourceId;
    this.expectedVersion = args.expectedVersion;
  }
}

export class AppendOnlyViolationError extends Error {
  public readonly resourceType: string;
  public readonly operation: string;

  constructor(args: { resourceType: string; operation: string }) {
    super(`append-only violation: ${args.operation} on ${args.resourceType} is not permitted`);
    this.name = 'AppendOnlyViolationError';
    this.resourceType = args.resourceType;
    this.operation = args.operation;
  }
}
