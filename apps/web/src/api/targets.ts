import { api } from './client.ts';

export interface Target {
  id: string;
  projectId: string;
  kind: string;
  value: string;
  ownershipStatus: string;
}

export const listTargets = async (
  projectId: string,
): Promise<{ targets: Target[]; total: number }> => {
  const envelope = await api.get<{ data: Target[]; nextCursor: string | null }>(
    `/api/v1/projects/${projectId}/targets`,
  );
  return { targets: envelope.data, total: envelope.data.length };
};

export const createTarget = async (
  projectId: string,
  data: { kind: string; value: string },
): Promise<Target> => api.post<Target>(`/api/v1/projects/${projectId}/targets`, data);
