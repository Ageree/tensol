import { api } from './client.ts';
import type { Finding } from './findings.ts';

export type { Finding };

export interface Assessment {
  id: string;
  projectId: string;
  state: string;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  testingWindow: { start: string; end: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEvent {
  id: string;
  action: string;
  outcome: string;
  occurredAt: string;
  actorId: string;
  metadata: Record<string, unknown>;
}

export const listAssessments = (projectId: string) =>
  api.get<{ assessments: Assessment[]; total: number }>(
    `/api/v1/projects/${projectId}/assessments`,
  );

export const getAssessment = (id: string) =>
  api.get<{ assessment: Assessment }>(`/api/v1/assessments/${id}`);

export const getAssessmentTimeline = (id: string) =>
  api.get<{ rows: TimelineEvent[]; nextCursor: string | null }>(
    `/api/v1/assessments/${id}/timeline`,
  );

export const getAssessmentFindings = (id: string) =>
  api.get<{ findings: Finding[] }>(`/api/v1/assessments/${id}/findings`);
