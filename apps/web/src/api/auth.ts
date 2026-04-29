import { api } from './client.ts';

export interface MeResponse {
  id: string;
  email: string;
  role: string;
  tenantId: string;
  displayName: string;
}

export const getMe = () => api.get<{ user: MeResponse }>('/auth/me');

export const login = (email: string, password: string) =>
  api.post<{ status: 'ok' | 'mfa_required'; preAuthToken?: string }>('/auth/login', {
    email,
    password,
  });

export const loginMfa = (preAuthToken: string, code: string) =>
  api.post<{ status: 'ok' }>('/auth/login/mfa', { preAuthToken, code });

export const logout = () => api.post<{ status: 'ok' }>('/auth/logout');
