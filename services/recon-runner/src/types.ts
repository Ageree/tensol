// Sprint 21 — shared output types for recon-runner subprocess wrappers.

export interface HttpxProbeResult {
  readonly url: string;
  readonly statusCode: number;
  readonly title: string;
  readonly tech: readonly string[];
  readonly webServer?: string;
}

export interface NucleiFinding {
  readonly templateId: string;
  readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  readonly info: { readonly name: string; readonly description?: string };
  readonly matched: string;
}
