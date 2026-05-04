import { api } from './client.ts';

export interface VerifyStartResult {
  token: string;
  instructions: string;
  expires_at: string;
}

export interface VerifyCheckResult {
  status: 'pending' | 'verified';
  verifiedAt?: string | null;
}

export const verifyStart = (targetId: string) =>
  api.post<VerifyStartResult>('/api/v1/domains/verify/start', { targetId });

export const verifyCheck = (targetId: string) =>
  api.get<VerifyCheckResult>(`/api/v1/domains/verify/check?targetId=${targetId}`);
