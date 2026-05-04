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
