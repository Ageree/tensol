import { useEffect, useRef, useState } from 'react';
import { type ScanDetail, type ScanProgress, getScan, getScanProgress } from '../api/scans.ts';

interface Props {
  scanId: string;
  onBack: () => void;
  onFindingsClick?: (scanId: string) => void;
  onReportClick?: (scanId: string) => void;
}

export const ScanProgressPage = ({ scanId, onBack, onFindingsClick, onReportClick }: Props) => {
  const [scan, setScan] = useState<ScanDetail | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [scanData, progressData] = await Promise.all([
          getScan(scanId),
          getScanProgress(scanId),
        ]);
        setScan(scanData);
        setProgress(progressData);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to load scan';
        setError(msg);
      }
    };

    fetchData();
    intervalRef.current = setInterval(fetchData, 2000);
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, [scanId]);

  return (
    <div data-testid="scan-progress-page">
      <button type="button" onClick={onBack} data-testid="scan-progress-back">
        Back
      </button>
      {onFindingsClick && (
        <button
          type="button"
          onClick={() => onFindingsClick(scanId)}
          data-testid="view-findings-btn"
        >
          View Findings
        </button>
      )}
      {onReportClick && (
        <button type="button" onClick={() => onReportClick(scanId)} data-testid="view-report-btn">
          View Report
        </button>
      )}
      <h1>Scan Progress</h1>

      {error && (
        <p data-testid="scan-progress-error" style={{ color: 'red' }}>
          {error}
        </p>
      )}

      {scan && (
        <section data-testid="scan-detail">
          <p data-testid="scan-state">
            State: <strong>{scan.state}</strong>
          </p>
          <p data-testid="scan-tier">Tier: {scan.tier ?? 'unknown'}</p>
        </section>
      )}

      {progress && (
        <section data-testid="scan-progress-data">
          <p data-testid="findings-count">Findings: {progress.findings_count}</p>
          <h2>Recent Events</h2>
          <ul data-testid="audit-events-list">
            {progress.recent_audit_events.map((ev) => (
              <li key={ev.id} data-testid={`audit-event-${ev.id}`}>
                {ev.action} ({new Date(ev.occurred_at).toLocaleTimeString()})
              </li>
            ))}
          </ul>
        </section>
      )}

      {!scan && !error && <p data-testid="scan-progress-loading">Loading...</p>}
    </div>
  );
};
