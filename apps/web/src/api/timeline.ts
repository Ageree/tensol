import { api } from './client.ts';

export interface TimelineItem {
  id: string;
  kind: 'audit' | 'browser';
  action: string;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
}

export interface TimelinePage {
  rows: TimelineItem[];
  items: TimelineItem[];
  nextCursor: string | null;
}

export const getTimelinePage = (
  assessmentId: string,
  kind: 'audit' | 'browser' | 'all',
  cursor?: string | null,
  limit = 50,
): Promise<TimelinePage> =>
  api.get<TimelinePage>(
    `/api/v1/assessments/${assessmentId}/timeline?kind=${kind}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
