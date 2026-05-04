import { useQuery } from '@tanstack/react-query';
import { listScans } from '../api/scans.ts';

interface Props {
  onScanClick?: (scanId: string) => void;
}

export const HistoryPage = ({ onScanClick }: Props) => {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['scans'],
    queryFn: listScans,
  });

  const scans = data?.items ?? [];

  return (
    <div data-testid="history-page">
      <h1>Scan History</h1>

      {isLoading && <p data-testid="history-loading">Loading...</p>}
      {isError && <p data-testid="history-error">Failed to load history.</p>}

      {!isLoading &&
        !isError &&
        (scans.length === 0 ? (
          <p data-testid="no-scans">No scans yet.</p>
        ) : (
          <table data-testid="history-table">
            <thead>
              <tr>
                <th>Scan ID</th>
                <th>Tier</th>
                <th>State</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {scans.map((s) => (
                <tr
                  key={s.scan_id}
                  data-testid={`scan-row-${s.scan_id}`}
                  onClick={() => onScanClick?.(s.scan_id)}
                  onKeyDown={(e) => e.key === 'Enter' && onScanClick?.(s.scan_id)}
                  style={{ cursor: onScanClick ? 'pointer' : undefined }}
                >
                  <td data-testid={`scan-id-${s.scan_id}`}>{s.scan_id.slice(0, 8)}…</td>
                  <td>{s.tier ?? '—'}</td>
                  <td data-testid={`scan-state-${s.scan_id}`}>{s.state}</td>
                  <td>{new Date(s.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
};
