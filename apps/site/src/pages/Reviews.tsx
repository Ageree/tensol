// Reviews — list page for Sthrip Review (PR Review + Whitebox Pentest).
//
// URL: /reviews
//
// Sections:
//   - "Connected repositories" — repos from review.listRepos()
//   - "Recent reviews" — table from review.list()

import { useEffect, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Eyebrow, Mono, StatusChip } from '../components/primitives.tsx';
import {
  ApiError,
  type ReviewKind,
  type ReviewResultWire,
  type ReviewRepoWire,
  type ReviewRunStatus,
} from '../lib/api-client.ts';
import { apiClient } from '../lib/api-client.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTimestamp(ms?: number | null): string {
  if (ms == null) return '—';
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return '—';
  }
}

function scoreColor(score: number): string {
  if (score >= 5) return '#0E5E2A';
  if (score >= 3) return '#7A5A05';
  return 'var(--red)';
}

function scoreBg(score: number): string {
  if (score >= 5) return '#E5F4EB';
  if (score >= 3) return '#FBF1D9';
  return '#FEE2E2';
}

function scoreBorder(score: number): string {
  if (score >= 5) return '#1F7A3A';
  if (score >= 3) return '#B8860B';
  return 'var(--red)';
}

interface ScoreBadgeProps {
  score: number | null | undefined;
}

function ScoreBadge({ score }: ScoreBadgeProps): ReactElement {
  if (score == null) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          padding: '2px 8px',
          background: 'var(--bg)',
          color: 'var(--fg-3)',
          border: '1px solid var(--line-soft)',
          lineHeight: 1.3,
        }}
      >
        —/5
      </span>
    );
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        fontWeight: 500,
        padding: '2px 8px',
        background: scoreBg(score),
        color: scoreColor(score),
        border: `1px solid ${scoreBorder(score)}`,
        lineHeight: 1.3,
      }}
    >
      {score}/5
    </span>
  );
}

type KindTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'muted' | 'inverse';

function kindTone(kind: ReviewKind | undefined): KindTone {
  if (kind === 'pr') return 'neutral';
  if (kind === 'whitebox') return 'inverse';
  return 'muted';
}

function kindLabel(kind: ReviewKind | undefined): string {
  if (kind === 'pr') return 'PR';
  if (kind === 'whitebox') return 'Whitebox';
  return '—';
}

function statusTone(status: ReviewRunStatus): KindTone {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'muted';
  return 'warn';
}

function repoStatusTone(status: ReviewRepoWire['status']): KindTone {
  if (status === 'active') return 'ok';
  if (status === 'revoked') return 'danger';
  return 'warn';
}

// ─── Repos section ────────────────────────────────────────────────────────────

interface ReposSectionProps {
  repos: ReviewRepoWire[];
  loading: boolean;
  error: string | null;
}

function ReposSection({ repos, loading, error }: ReposSectionProps): ReactElement {
  return (
    <section style={{ marginBottom: 40 }}>
      <Eyebrow style={{ marginBottom: 14 }}>Connected repositories</Eyebrow>

      {loading && (
        <Mono size={12} color="var(--fg-3)">
          Loading repositories…
        </Mono>
      )}

      {!loading && error && (
        <Mono size={12} color="var(--red)">
          Failed to load repositories: {error}
        </Mono>
      )}

      {!loading && !error && repos.length === 0 && (
        <div
          style={{
            padding: '20px 24px',
            border: '1px solid var(--line-soft)',
            background: 'var(--bg-2)',
          }}
        >
          <Mono size={12} color="var(--fg-3)">
            No repositories connected yet. Install the GitHub App to start reviewing pull requests.
          </Mono>
        </div>
      )}

      {!loading && !error && repos.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {repos.map((repo) => (
            <div
              key={repo.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '12px 16px',
                background: 'var(--bg)',
                border: '1px solid var(--line-soft)',
              }}
            >
              <Mono size={12} color="var(--fg)" style={{ fontWeight: 500, flex: 1 }}>
                {repo.owner}/{repo.name}
              </Mono>
              <Mono size={10.5} color="var(--fg-3)" style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                {repo.scm}
              </Mono>
              <StatusChip status={repo.status} tone={repoStatusTone(repo.status)} size="sm" />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Reviews table ────────────────────────────────────────────────────────────

interface ReviewsTableProps {
  reviews: ReviewResultWire[];
  loading: boolean;
  error: string | null;
}

function ReviewsTable({ reviews, loading, error }: ReviewsTableProps): ReactElement {
  return (
    <section>
      <Eyebrow style={{ marginBottom: 14 }}>Recent reviews</Eyebrow>

      {loading && (
        <Mono size={12} color="var(--fg-3)">
          Loading reviews…
        </Mono>
      )}

      {!loading && error && (
        <Mono size={12} color="var(--red)">
          Failed to load reviews: {error}
        </Mono>
      )}

      {!loading && !error && reviews.length === 0 && (
        <Mono size={12} color="var(--fg-3)">
          No reviews yet. Push a pull request or trigger a whitebox scan to see results here.
        </Mono>
      )}

      {!loading && !error && reviews.length > 0 && (
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            background: 'transparent',
          }}
        >
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line-soft)' }}>
              {(['Kind', 'Repository', 'Score', 'Status', 'Findings', 'Created', ''] as const).map(
                (col, i) => (
                  <th
                    key={`${i}-${col}`}
                    style={{
                      textAlign: 'left',
                      padding: '10px 4px',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      fontWeight: 500,
                      color: 'var(--fg-3)',
                    }}
                  >
                    {col}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {reviews.map((r) => {
              const repoLabel = r.repo
                ? r.pr_number != null
                  ? `${r.repo} #${r.pr_number}`
                  : r.repo
                : '—';
              return (
                <tr key={r.review_id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                  <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                    <StatusChip
                      status={kindLabel(r.kind)}
                      tone={kindTone(r.kind)}
                      size="sm"
                    />
                  </td>
                  <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                    <Mono size={12} color="var(--fg)">
                      {repoLabel}
                    </Mono>
                  </td>
                  <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                    <ScoreBadge score={r.score_0_5} />
                  </td>
                  <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                    <StatusChip status={r.status} tone={statusTone(r.status)} size="sm" />
                  </td>
                  <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                    <Mono size={11} color="var(--fg)">
                      {r.findings.length}
                    </Mono>
                  </td>
                  <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                    <Mono size={10.5} color="var(--fg-3)">
                      {fmtTimestamp(r.created_at)}
                    </Mono>
                  </td>
                  <td style={{ padding: '14px 4px', textAlign: 'right', verticalAlign: 'top' }}>
                    <Link
                      to={`/reviews/${encodeURIComponent(r.review_id)}`}
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                        color: 'var(--fg)',
                        textDecoration: 'underline',
                      }}
                    >
                      Detail →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function Reviews(): ReactElement {
  const [reviews, setReviews] = useState<ReviewResultWire[] | null>(null);
  const [reviewsErr, setReviewsErr] = useState<string | null>(null);
  const [reviewsLoading, setReviewsLoading] = useState<boolean>(true);

  const [repos, setRepos] = useState<ReviewRepoWire[] | null>(null);
  const [reposErr, setReposErr] = useState<string | null>(null);
  const [reposLoading, setReposLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;

    apiClient.review
      .list()
      .then((data) => {
        if (cancelled) return;
        setReviews(data);
        setReviewsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setReviewsErr(e instanceof ApiError ? e.code : 'network_error');
        setReviewsLoading(false);
      });

    apiClient.review
      .listRepos()
      .then((data) => {
        if (cancelled) return;
        setRepos(data);
        setReposLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setReposErr(e instanceof ApiError ? e.code : 'network_error');
        setReposLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell
      breadcrumb={['Reviews']}
      role="security_lead"
      density="comfortable"
    >
      <RouteHead title="Sthrip · Security Reviews" />
      <div data-screen-label="Reviews">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 8,
          }}
        >
          <h1
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 500,
              fontSize: 44,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              margin: 0,
            }}
          >
            Security Reviews
          </h1>
        </div>
        <Mono
          size={13}
          color="var(--fg-3)"
          style={{ display: 'block', marginBottom: 36 }}
        >
          AI-assisted PR review and full-repository whitebox assessment coverage.
        </Mono>

        <ReposSection
          repos={repos ?? []}
          loading={reposLoading}
          error={reposErr}
        />

        <ReviewsTable
          reviews={reviews ?? []}
          loading={reviewsLoading}
          error={reviewsErr}
        />
      </div>
    </AppShell>
  );
}
