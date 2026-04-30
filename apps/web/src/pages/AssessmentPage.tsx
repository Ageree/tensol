import { useQuery } from '@tanstack/react-query';
import { getAssessment, getAssessmentFindings, getAssessmentTimeline } from '../api/assessments.ts';
import type { Finding } from '../api/findings.ts';

interface Props {
  assessmentId: string;
  onFindingClick: (id: string) => void;
}

export const AssessmentPage = ({ assessmentId, onFindingClick }: Props) => {
  const { data: assessmentData, isLoading: loadingAssessment } = useQuery({
    queryKey: ['assessment', assessmentId],
    queryFn: () => getAssessment(assessmentId),
  });

  const { data: findingsData, isLoading: loadingFindings } = useQuery({
    queryKey: ['assessment-findings', assessmentId],
    queryFn: () => getAssessmentFindings(assessmentId),
  });

  const { data: timelineData } = useQuery({
    queryKey: ['assessment-timeline', assessmentId],
    queryFn: () => getAssessmentTimeline(assessmentId),
  });

  if (loadingAssessment || loadingFindings) {
    return <p data-testid="assessment-loading">Loading...</p>;
  }

  const assessment = assessmentData?.assessment;
  const findings: Finding[] = (findingsData?.findings ?? []) as Finding[];
  const events = timelineData?.rows ?? [];

  return (
    <div data-testid="assessment-page">
      <h1>Assessment</h1>
      <dl>
        <dt>State</dt>
        <dd data-testid="assessment-state">{assessment?.state}</dd>
        <dt>Confirmed findings</dt>
        <dd data-testid="confirmed-count">{findings.length}</dd>
      </dl>

      <h2>Confirmed Findings</h2>
      {findings.length === 0 ? (
        <p data-testid="no-findings">No confirmed findings</p>
      ) : (
        <ul data-testid="findings-list">
          {findings.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onFindingClick(f.id)}
                data-testid={`finding-item-${f.id}`}
              >
                {f.type} — {f.severity} — {f.status}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2>Timeline</h2>
      <ul data-testid="timeline-list">
        {events.map((e) => (
          <li key={e.id} data-testid={`timeline-event-${e.id}`}>
            {e.occurredAt} — {e.action} — {e.outcome}
          </li>
        ))}
      </ul>
    </div>
  );
};
