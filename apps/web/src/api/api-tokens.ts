import { api } from './client.ts';

export interface ApiToken {
  id: string;
  name: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface CreateApiTokenResult {
  token: string;
  id: string;
  name: string;
  created_at: string;
}

export const createApiToken = (name: string): Promise<CreateApiTokenResult> =>
  api.post('/api/v1/auth/api-tokens', { name });

export const listApiTokens = (): Promise<{ tokens: ApiToken[] }> =>
  api.get('/api/v1/auth/api-tokens');

export const deleteApiToken = (id: string): Promise<{ id: string }> =>
  api.delete(`/api/v1/auth/api-tokens/${id}`);
