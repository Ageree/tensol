import { api } from './client.ts';

export interface Target {
  id: string;
  projectId: string;
  kind: string;
  value: string;
  ownershipStatus: string;
}

export const listTargets = (projectId: string) =>
  api.get<{ targets: Target[]; total: number }>(`/api/v1/projects/${projectId}/targets`);
