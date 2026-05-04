import { api } from './client.ts';

export interface MeActor {
  id: string;
  email: string;
  role: string;
  tenantId: string;
}

export interface MeTenant {
  id: string;
  slug: string;
}

// Matches actual /auth/me backend response shape (apps/api/src/routes/auth/me.ts).
export interface MeResponse {
  actor: MeActor;
  tenant: MeTenant | null;
}

export const getMe = () => api.get<MeResponse>('/auth/me');

export const login = (email: string, password: string) =>
  api.post<{ status: 'ok' | 'mfa_required'; preAuthToken?: string }>('/auth/login', {
    email,
    password,
  });

export const loginMfa = (preAuthToken: string, code: string) =>
  api.post<{ status: 'ok' }>('/auth/login/mfa', { preAuthToken, code });

export const logout = () => api.post<{ status: 'ok' }>('/auth/logout');

export interface SelfRegisterBody {
  email: string;
  password: string;
  displayName: string;
}

export const selfRegister = (body: SelfRegisterBody) =>
  api.post<{ ok: boolean; userId: string; tenantId: string }>('/auth/self-register', body);
