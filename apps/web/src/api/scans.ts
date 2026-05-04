import { api } from './client.ts';

export interface ScanSummary {
  scan_id: string;
  state: string;
  tier: string | null;
  project_id: string;
  created_at: string;
}

export interface ScanDetail extends ScanSummary {
  updated_at: string;
}

export interface ScanProgress {
  state: string;
  findings_count: number;
  recent_audit_events: Array<{
    id: string;
    action: string;
    occurred_at: string;
  }>;
}

export const launchScan = async (data: {
  project_id: string;
  tier: 'light' | 'medium' | 'aggressive';
  target_ids: string[];
}): Promise<{ scan_id: string; state: string }> => {
  return api.post('/api/v1/scans', data);
};

export const listScans = async (): Promise<{ items: ScanSummary[]; total: number }> => {
  return api.get('/api/v1/scans');
};

export const getScan = async (id: string): Promise<ScanDetail> => {
  return api.get(`/api/v1/scans/${id}`);
};

export const getScanProgress = async (id: string): Promise<ScanProgress> => {
  return api.get(`/api/v1/scans/${id}/progress`);
};

export const buildScanReport = async (
  assessmentId: string,
): Promise<{ reportId: string; status: string }> => {
  const idempotencyKey = `report.build:${assessmentId}:${Date.now()}`;
  const res = await fetch(`/api/v1/assessments/${assessmentId}/reports`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({}))) as { reportId: string; status: string };
  if (!res.ok) throw new Error(`build report failed: ${res.status}`);
  return body;
};
