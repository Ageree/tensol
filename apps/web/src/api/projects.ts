import { api } from './client.ts';

export interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export const listProjects = async (): Promise<{ projects: Project[]; total: number }> => {
  const envelope = await api.get<{ data: Project[]; nextCursor: string | null }>('/api/v1/projects');
  return { projects: envelope.data, total: envelope.data.length };
};

export const getProject = async (id: string): Promise<{ project: Project }> => {
  const project = await api.get<Project>(`/api/v1/projects/${id}`);
  return { project };
};

export const createProject = async (data: { name: string; description: string }): Promise<{ project: Project }> => {
  const project = await api.post<Project>('/api/v1/projects', data);
  return { project };
};
