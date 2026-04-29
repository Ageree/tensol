import { useQuery } from '@tanstack/react-query';
import { getEvidence } from '../api/findings.ts';

interface Props {
  evidenceId: string;
}

export const EvidenceViewerPage = ({ evidenceId }: Props) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['evidence', evidenceId],
    queryFn: () => getEvidence(evidenceId),
  });

  if (isLoading) return <p data-testid="evidence-loading">Loading...</p>;
  if (error) return <p data-testid="evidence-error">Failed to load evidence</p>;

  const ev = data?.evidence;
  if (!ev) return <p data-testid="evidence-not-found">Evidence not found</p>;

  return (
    <div data-testid="evidence-viewer-page">
      <h1>Evidence</h1>
      <dl>
        <dt>Kind</dt>
        <dd data-testid="evidence-kind">{ev.kind}</dd>
        <dt>SHA-256</dt>
        <dd data-testid="evidence-sha256">{ev.sha256}</dd>
        <dt>Size</dt>
        <dd data-testid="evidence-size">{ev.sizeBytes} bytes</dd>
      </dl>

      {ev.kind === 'screenshot' && (
        <div data-testid="screenshot-viewer">
          <img
            src={ev.downloadUrl}
            alt="Screenshot evidence"
            style={{ maxWidth: '100%', border: '1px solid #ccc' }}
          />
        </div>
      )}

      {ev.kind === 'har' && (
        <div data-testid="har-viewer">
          <p>
            HAR file —{' '}
            <a href={ev.downloadUrl} download>
              Download
            </a>
          </p>
        </div>
      )}

      {ev.kind === 'trace' && (
        <div data-testid="trace-viewer">
          <p>
            Trace file —{' '}
            <a href={`${ev.downloadUrl}`} download data-testid="trace-download">
              Download trace
            </a>
          </p>
        </div>
      )}
    </div>
  );
};
