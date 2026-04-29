import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type FindingStatus,
  getFinding,
  listFindingEvidence,
  patchFindingStatus,
} from '../api/findings.ts';
import { useAuth } from '../auth/context.tsx';

const FINDING_STATUSES: FindingStatus[] = [
  'open',
  'triaged',
  'accepted_risk',
  'false_positive',
  'fixed',
  'retested',
  'closed',
];

interface Props {
  findingId: string;
  onEvidenceClick: (id: string) => void;
}

export const FindingDetailPage = ({ findingId, onEvidenceClick }: Props) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isAuditor = user?.role === 'auditor';

  const { data: findingData, isLoading } = useQuery({
    queryKey: ['finding', findingId],
    queryFn: () => getFinding(findingId),
  });

  const { data: evidenceData } = useQuery({
    queryKey: ['finding-evidence', findingId],
    queryFn: () => listFindingEvidence(findingId),
  });

  const statusMutation = useMutation({
    mutationFn: (status: FindingStatus) => patchFindingStatus(findingId, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['finding', findingId] });
    },
  });

  if (isLoading) return <p data-testid="finding-loading">Loading...</p>;

  const finding = findingData?.finding;
  const evidence = evidenceData?.evidence ?? [];

  if (!finding) return <p data-testid="finding-not-found">Finding not found</p>;

  return (
    <div data-testid="finding-detail-page">
      <h1>Finding: {finding.type}</h1>

      <dl>
        <dt>Severity</dt>
        <dd data-testid="finding-severity">{finding.severity}</dd>
        <dt>Confidence</dt>
        <dd data-testid="finding-confidence">{finding.confidence}</dd>
        <dt>Status</dt>
        <dd data-testid="finding-status">{finding.status}</dd>
        <dt>Affected URL</dt>
        <dd data-testid="finding-url">{finding.affectedUrl}</dd>
        <dt>Validated at</dt>
        <dd>{finding.validatedAt}</dd>
      </dl>

      {!isAuditor && (
        <div data-testid="status-controls">
          <label htmlFor="status-select">Change status</label>
          <select
            id="status-select"
            data-testid="status-select"
            defaultValue={finding.status}
            onChange={(e) => statusMutation.mutate(e.target.value as FindingStatus)}
            disabled={statusMutation.isPending}
          >
            {FINDING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {statusMutation.isError && <p data-testid="status-error">Failed to update status</p>}
        </div>
      )}

      <h2>Evidence</h2>
      {evidence.length === 0 ? (
        <p data-testid="no-evidence">No evidence attached</p>
      ) : (
        <ul data-testid="evidence-list">
          {evidence.map((ev) => (
            <li key={ev.id}>
              <button
                type="button"
                onClick={() => onEvidenceClick(ev.id)}
                data-testid={`evidence-item-${ev.id}`}
              >
                {ev.kind} — sha256: {ev.sha256.slice(0, 16)}…
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
