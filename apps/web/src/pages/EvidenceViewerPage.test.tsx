import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as findingsApi from '../api/findings.ts';
import { EvidenceViewerPage } from './EvidenceViewerPage.tsx';

const hasDom = typeof document !== 'undefined';

const mockEvidence: findingsApi.Evidence = {
  id: 'ev1',
  findingId: 'f1',
  kind: 'screenshot',
  sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
  sizeBytes: 1024,
  downloadUrl: '/api/v1/evidence/ev1?download=1',
};

describe.skipIf(!hasDom)('EvidenceViewerPage :: display (A-UI-Sha256)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('displays sha256 from server', async () => {
    vi.spyOn(findingsApi, 'getEvidence').mockResolvedValue({ evidence: mockEvidence });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <EvidenceViewerPage evidenceId="ev1" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('evidence-sha256')).toHaveTextContent(mockEvidence.sha256);
    });
  });

  it('displays evidence kind', async () => {
    vi.spyOn(findingsApi, 'getEvidence').mockResolvedValue({ evidence: mockEvidence });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <EvidenceViewerPage evidenceId="ev1" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('evidence-kind')).toHaveTextContent('screenshot');
    });
  });

  it('shows screenshot viewer for screenshot kind', async () => {
    vi.spyOn(findingsApi, 'getEvidence').mockResolvedValue({ evidence: mockEvidence });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <EvidenceViewerPage evidenceId="ev1" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('screenshot-viewer')).toBeInTheDocument();
    });
  });

  it('shows trace download link for trace kind', async () => {
    const traceEvidence = { ...mockEvidence, kind: 'trace' };
    vi.spyOn(findingsApi, 'getEvidence').mockResolvedValue({ evidence: traceEvidence });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <EvidenceViewerPage evidenceId="ev1" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('trace-viewer')).toBeInTheDocument();
      expect(screen.getByTestId('trace-download')).toBeInTheDocument();
    });
  });

  it('shows error state on fetch failure', async () => {
    vi.spyOn(findingsApi, 'getEvidence').mockRejectedValue(new Error('forbidden'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <EvidenceViewerPage evidenceId="ev1" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('evidence-error')).toBeInTheDocument();
    });
  });
});
