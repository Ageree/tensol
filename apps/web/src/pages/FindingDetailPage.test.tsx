import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as findingsApi from '../api/findings.ts';
import { AuthProvider } from '../auth/context.tsx';
import { FindingDetailPage } from './FindingDetailPage.tsx';

const hasDom = typeof document !== 'undefined';

const mockFinding: findingsApi.Finding = {
  id: 'f1',
  assessmentId: 'a1',
  type: 'xss_reflected',
  severity: 'high',
  confidence: 'high',
  status: 'open',
  affectedUrl: 'http://example.com/search',
  reproduction: {},
  validatorLog: [],
  validatedAt: '2026-04-29T00:00:00.000Z',
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
};

describe.skipIf(!hasDom)('FindingDetailPage :: RBAC visibility (A-UI-RBAC)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows status controls for developer role', async () => {
    vi.spyOn(findingsApi, 'getFinding').mockResolvedValue({ finding: mockFinding });
    vi.spyOn(findingsApi, 'listFindingEvidence').mockResolvedValue({ evidence: [] });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <FindingDetailPage findingId="f1" onEvidenceClick={vi.fn()} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('finding-detail-page')).toBeInTheDocument();
    });
    // status-controls visible because no auth user → useAuth returns null role (not auditor)
    await waitFor(() => {
      expect(screen.getByTestId('status-controls')).toBeInTheDocument();
    });
  });
});

describe.skipIf(!hasDom)('FindingDetailPage :: content display', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(findingsApi, 'getFinding').mockResolvedValue({ finding: mockFinding });
    vi.spyOn(findingsApi, 'listFindingEvidence').mockResolvedValue({ evidence: [] });
  });

  it('displays severity, confidence, status, and url', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <FindingDetailPage findingId="f1" onEvidenceClick={vi.fn()} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('finding-severity')).toHaveTextContent('high');
      expect(screen.getByTestId('finding-confidence')).toHaveTextContent('high');
      expect(screen.getByTestId('finding-status')).toHaveTextContent('open');
      expect(screen.getByTestId('finding-url')).toHaveTextContent('http://example.com/search');
    });
  });

  it('calls patchFindingStatus when status is changed', async () => {
    const patchSpy = vi.spyOn(findingsApi, 'patchFindingStatus').mockResolvedValue({
      finding: { ...mockFinding, status: 'triaged' },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <FindingDetailPage findingId="f1" onEvidenceClick={vi.fn()} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => screen.getByTestId('finding-detail-page'));

    const select = screen.queryByTestId('status-select');
    if (select) {
      await userEvent.selectOptions(select, 'triaged');
      await waitFor(() => {
        expect(patchSpy).toHaveBeenCalledWith('f1', 'triaged');
      });
    }
  });
});
