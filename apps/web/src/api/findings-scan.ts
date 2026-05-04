import { api } from './client.ts';
import type { Finding } from './findings.ts';

export interface ScanFindingsResult {
  findings: Finding[];
  total: number;
  page: number;
  limit: number;
}

export const listScanFindings = (
  scanId: string,
  params?: {
    severity?: string | undefined;
    kind?: string | undefined;
    page?: number | undefined;
    limit?: number | undefined;
  },
): Promise<ScanFindingsResult> => {
  const qs = new URLSearchParams();
  if (params?.severity) qs.set('severity', params.severity);
  if (params?.kind) qs.set('kind', params.kind);
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return api.get(`/api/v1/scans/${scanId}/findings${query ? `?${query}` : ''}`);
};
