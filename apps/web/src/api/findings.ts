import { api } from './client.ts';

export type FindingStatus =
  | 'open'
  | 'triaged'
  | 'accepted_risk'
  | 'false_positive'
  | 'fixed'
  | 'retested'
  | 'closed';

export interface Finding {
  id: string;
  assessmentId: string;
  type: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  confidence: 'low' | 'medium' | 'high';
  status: FindingStatus;
  affectedUrl: string;
  reproduction: unknown;
  validatorLog: unknown;
  validatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Evidence {
  id: string;
  findingId: string;
  kind: string;
  sha256: string;
  sizeBytes: number;
  downloadUrl: string;
}

export const getFinding = (id: string) => api.get<{ finding: Finding }>(`/api/v1/findings/${id}`);

export const patchFindingStatus = (id: string, status: FindingStatus) =>
  api.patch<{ finding: Finding }>(`/api/v1/findings/${id}/status`, { status });

export const listFindingEvidence = (findingId: string) =>
  api.get<{ evidence: Evidence[] }>(`/api/v1/findings/${findingId}/evidence`);

export const getEvidence = (id: string) =>
  api.get<{ evidence: Evidence }>(`/api/v1/evidence/${id}`);
