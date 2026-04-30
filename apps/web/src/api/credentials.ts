import { api } from './client.ts';

export interface CredentialListItem {
  id: string;
  targetId: string;
  recipeId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  fingerprintHex: string;
}

export interface CredentialListResponse {
  credentials: CredentialListItem[];
  total: number;
}

export const listTargetCredentials = (targetId: string): Promise<CredentialListResponse> =>
  api.get<CredentialListResponse>(`/api/v1/targets/${targetId}/credentials`);
