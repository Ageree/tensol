// Codex follow-up tests — P1 nav wiring + P2 403 surface.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as assessmentsApi from '../api/assessments.ts';
import { ApiError } from '../api/client.ts';
import * as credentialsApi from '../api/credentials.ts';
import * as projectsApi from '../api/projects.ts';
import * as targetsApi from '../api/targets.ts';
import { AuthProvider } from '../auth/context.tsx';
import { AssessmentPage } from './AssessmentPage.tsx';
import { ProjectDetailPage } from './ProjectDetailPage.tsx';
import { TargetCredentialsPage } from './TargetCredentialsPage.tsx';

const hasDom = typeof document !== 'undefined';

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
};

describe.skipIf(!hasDom)('P1 — timeline navigation wiring', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(assessmentsApi, 'getAssessment').mockResolvedValue({
      assessment: {
        id: 'a1',
        projectId: 'p1',
        state: 'running',
        createdBy: 'u1',
        approvedBy: null,
        approvedAt: null,
        testingWindow: null,
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    });
    vi.spyOn(assessmentsApi, 'getAssessmentFindings').mockResolvedValue({ findings: [] });
    vi.spyOn(assessmentsApi, 'getAssessmentTimeline').mockResolvedValue({
      rows: [],
      nextCursor: null,
    });
  });

  it('calls onTimelineClick with assessmentId when View Timeline button is clicked', async () => {
    const onTimelineClick = vi.fn();
    wrap(
      <AssessmentPage
        assessmentId="a1"
        onFindingClick={vi.fn()}
        onTimelineClick={onTimelineClick}
      />,
    );

    await waitFor(() => screen.getByTestId('view-timeline-btn'));
    await userEvent.click(screen.getByTestId('view-timeline-btn'));
    expect(onTimelineClick).toHaveBeenCalledWith('a1');
  });

  it('does not render View Timeline button when onTimelineClick is not provided', async () => {
    wrap(<AssessmentPage assessmentId="a1" onFindingClick={vi.fn()} />);
    await waitFor(() => screen.getByTestId('assessment-page'));
    expect(screen.queryByTestId('view-timeline-btn')).toBeNull();
  });
});

describe.skipIf(!hasDom)('P1 — credentials navigation wiring', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(projectsApi, 'getProject').mockResolvedValue({
      project: {
        id: 'p1',
        name: 'Proj',
        description: '',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    });
    vi.spyOn(assessmentsApi, 'listAssessments').mockResolvedValue({ assessments: [], total: 0 });
    vi.spyOn(targetsApi, 'listTargets').mockResolvedValue({
      targets: [
        {
          id: 't1',
          projectId: 'p1',
          kind: 'url',
          value: 'http://x.com',
          ownershipStatus: 'verified',
        },
      ],
      total: 1,
    });
  });

  it('calls onCredentialsClick with targetId when Credentials button is clicked', async () => {
    const onCredentialsClick = vi.fn();
    wrap(
      <ProjectDetailPage
        projectId="p1"
        onAssessmentClick={vi.fn()}
        onCredentialsClick={onCredentialsClick}
      />,
    );

    await waitFor(() => screen.getByTestId('credentials-btn-t1'));
    await userEvent.click(screen.getByTestId('credentials-btn-t1'));
    expect(onCredentialsClick).toHaveBeenCalledWith('t1');
  });
});

describe.skipIf(!hasDom)('P2 — TargetCredentialsPage 403 surface', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders credentials-forbidden when API throws 403', async () => {
    vi.spyOn(credentialsApi, 'listTargetCredentials').mockRejectedValue(
      new ApiError(403, { error: 'forbidden' }),
    );
    wrap(<TargetCredentialsPage targetId="t1" />);
    await waitFor(() => {
      expect(screen.getByTestId('credentials-forbidden')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('no-credentials')).toBeNull();
  });

  it('renders credentials-error for non-403 errors', async () => {
    vi.spyOn(credentialsApi, 'listTargetCredentials').mockRejectedValue(
      new ApiError(500, { error: 'internal' }),
    );
    wrap(<TargetCredentialsPage targetId="t1" />);
    await waitFor(() => {
      expect(screen.getByTestId('credentials-error')).toBeInTheDocument();
    });
  });

  it('renders credentials list on success', async () => {
    vi.spyOn(credentialsApi, 'listTargetCredentials').mockResolvedValue({
      credentials: [
        {
          id: 'c1',
          targetId: 't1',
          recipeId: 'r1',
          name: 'admin',
          createdBy: 'u1',
          createdAt: '2026-01-01T00:00:00Z',
          fingerprintHex: 'abcd1234',
        },
      ],
      total: 1,
    });
    wrap(<TargetCredentialsPage targetId="t1" />);
    await waitFor(() => {
      expect(screen.getByTestId('credential-item-c1')).toBeInTheDocument();
    });
  });
});
