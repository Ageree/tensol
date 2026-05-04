import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { listScanFindings } from '../api/findings-scan.ts';
import type { Finding } from '../api/findings.ts';

interface Props {
  scanId: string;
  onBack: () => void;
}

export const ScanFindingsPage = ({ scanId, onBack }: Props) => {
  const [severity, setSeverity] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['scan-findings', scanId, severity, kind, page],
    queryFn: () => {
      const params: { severity?: string; kind?: string; page?: number; limit?: number } = {
        page,
        limit: 20,
      };
      if (severity) params.severity = severity;
      if (kind) params.kind = kind;
      return listScanFindings(scanId, params);
    },
  });

  const findings = data?.findings ?? [];
  const total = data?.total ?? 0;
  const totalPages = data ? Math.ceil(total / (data.limit ?? 20)) : 1;

  return (
    <div data-testid="scan-findings-page">
      <button type="button" onClick={onBack} data-testid="scan-findings-back">
        Back
      </button>
      <h1>Findings</h1>

      <div data-testid="findings-filters">
        <label>
          Severity:
          <select
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value);
              setPage(1);
            }}
            data-testid="severity-filter"
          >
            <option value="">All</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label>
          Kind:
          <input
            type="text"
            placeholder="e.g. xss"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setPage(1);
            }}
            data-testid="kind-filter"
          />
        </label>
      </div>

      {isLoading && <p data-testid="findings-loading">Loading...</p>}
      {isError && <p data-testid="findings-error">Failed to load findings.</p>}

      {!isLoading && !isError && (
        <>
          <p data-testid="findings-total">Total: {total}</p>
          {findings.length === 0 ? (
            <p data-testid="no-findings">No findings.</p>
          ) : (
            <table data-testid="findings-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Type</th>
                  <th>URL</th>
                  <th>Status</th>
                  <th>Found</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => (
                  <tr
                    key={f.id}
                    data-testid={`finding-row-${f.id}`}
                    onClick={() => setSelectedFinding(f)}
                    onKeyDown={(e) => e.key === 'Enter' && setSelectedFinding(f)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td data-testid={`finding-severity-${f.id}`}>{f.severity}</td>
                    <td data-testid={`finding-type-${f.id}`}>{f.type}</td>
                    <td>{f.affectedUrl}</td>
                    <td>{f.status}</td>
                    <td>{new Date(f.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {totalPages > 1 && (
            <div data-testid="findings-pagination">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                data-testid="prev-page"
              >
                Prev
              </button>
              <span data-testid="page-indicator">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                data-testid="next-page"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {selectedFinding && (
        <div data-testid="finding-drawer">
          <h2>Finding Detail</h2>
          <button type="button" onClick={() => setSelectedFinding(null)} data-testid="close-drawer">
            Close
          </button>
          <p data-testid="drawer-severity">Severity: {selectedFinding.severity}</p>
          <p data-testid="drawer-type">Type: {selectedFinding.type}</p>
          <p data-testid="drawer-url">URL: {selectedFinding.affectedUrl}</p>
          <p data-testid="drawer-status">Status: {selectedFinding.status}</p>
          <p data-testid="drawer-confidence">Confidence: {selectedFinding.confidence}</p>
        </div>
      )}
    </div>
  );
};
