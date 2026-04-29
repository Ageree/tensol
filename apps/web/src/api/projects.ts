import { api } from './client.ts';

export interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export const listProjects = () =>
  api.get<{ projects: Project[]; total: number }>('/api/v1/projects');

export const getProject = (id: string) => api.get<{ project: Project }>(`/api/v1/projects/${id}`);

export const createProject = (data: { name: string; description: string }) =>
  api.post<{ project: Project }>('/api/v1/projects', data);
