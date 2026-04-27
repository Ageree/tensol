export interface ConfigIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

export class ConfigValidationError extends Error {
  public readonly issues: ReadonlyArray<ConfigIssue>;

  constructor(issues: ReadonlyArray<ConfigIssue>) {
    const summary = issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    super(`Config validation failed: ${summary}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}
