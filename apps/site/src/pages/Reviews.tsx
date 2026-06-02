// Reviews — list page for Sthrip Review (PR Review + Whitebox Pentest).
//
// URL: /reviews
//
// Sections:
//   - "Connected repositories" — repos from review.listRepos()
//   - "Recent reviews" — table from review.list()

import { useEffect, useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Checkbox, Eyebrow, Mono, StatusChip } from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';
import {
  ApiError,
  type FeatureFlags,
  type ReviewKind,
  type ReviewListItemWire,
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

function kindLabel(
  kind: ReviewKind | undefined,
  labels: { readonly kindPr: string; readonly kindWhitebox: string },
): string {
  if (kind === 'pr') return labels.kindPr;
  if (kind === 'whitebox') return labels.kindWhitebox;
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

// ─── Repo row (per-repo whitebox launch — Task B) ──────────────────────────────

interface RepoRowProps {
  repo: ReviewRepoWire;
  /** F1 — only render the "Deep research" toggle when the server flag is on. */
  researchEnabled: boolean;
}

function RepoRow({ repo, researchEnabled }: RepoRowProps): ReactElement {
  const { t } = useTensol();
  const tr = t.reviews;
  const navigate = useNavigate();

  const [deep, setDeep] = useState<boolean>(false);
  const [launching, setLaunching] = useState<boolean>(false);
  const [launchErr, setLaunchErr] = useState<string | null>(null);

  // Only allow launching against a healthy connection.
  const canLaunch = repo.status === 'active' && !launching;

  const onRun = async (): Promise<void> => {
    if (launching) return;
    setLaunching(true);
    setLaunchErr(null);
    try {
      const { review_id } = await apiClient.review.launchWhitebox({
        repo_id: repo.id,
        mode: deep && researchEnabled ? 'deep' : 'fast',
      });
      navigate(`/reviews/${encodeURIComponent(review_id)}`);
    } catch (err) {
      if (err instanceof ApiError) {
        // 422 feature_disabled → friendly inline copy; everything else → generic.
        setLaunchErr(
          err.code === 'feature_disabled' ? tr.featureDisabled : tr.runScanError,
        );
      } else {
        setLaunchErr(tr.runScanError);
      }
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 16px',
        background: 'var(--bg)',
        border: '1px solid var(--line-soft)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Mono size={12} color="var(--fg)" style={{ fontWeight: 500, flex: 1, minWidth: 160 }}>
          {repo.owner}/{repo.name}
        </Mono>
        <Mono
          size={10.5}
          color="var(--fg-3)"
          style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}
        >
          {repo.scm}
        </Mono>
        <StatusChip status={repo.status} tone={repoStatusTone(repo.status)} size="sm" />
        {researchEnabled && (
          <Checkbox checked={deep} onChange={setDeep} label={tr.deepResearch} />
        )}
        <Btn kind="secondary" size="sm" onClick={() => void onRun()} disabled={!canLaunch}>
          {launching ? tr.runningScan : tr.runScan}
        </Btn>
      </div>

      {launchErr && (
        <Mono size={11} color="var(--red)">
          {launchErr}
        </Mono>
      )}
    </div>
  );
}

// ─── Repos section ────────────────────────────────────────────────────────────

interface ReposSectionProps {
  repos: ReviewRepoWire[];
  loading: boolean;
  error: string | null;
  /** F1 — passed through to each row to gate the "Deep research" toggle. */
  researchEnabled: boolean;
}

function ReposSection({
  repos,
  loading,
  error,
  researchEnabled,
}: ReposSectionProps): ReactElement {
  const { t } = useTensol();
  const tr = t.reviews;
  return (
    <section style={{ marginBottom: 40 }}>
      <Eyebrow style={{ marginBottom: 14 }}>{tr.sectionRepos}</Eyebrow>

      {loading && (
        <Mono size={12} color="var(--fg-3)">
          {tr.loadingRepos}
        </Mono>
      )}

      {!loading && error && (
        <Mono size={12} color="var(--red)">
          {tr.errorRepos}: {error}
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
            {tr.emptyRepos}
          </Mono>
        </div>
      )}

      {!loading && !error && repos.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {repos.map((repo) => (
            <RepoRow key={repo.id} repo={repo} researchEnabled={researchEnabled} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Reviews table ────────────────────────────────────────────────────────────

interface ReviewsTableProps {
  reviews: ReviewListItemWire[];
  loading: boolean;
  error: string | null;
}

function ReviewsTable({ reviews, loading, error }: ReviewsTableProps): ReactElement {
  const { t } = useTensol();
  const tr = t.reviews;
  const columns = [
    tr.colKind,
    tr.colMode,
    tr.colRepo,
    tr.colScore,
    tr.colStatus,
    tr.colFindings,
    tr.colCreated,
    '',
  ] as const;

  return (
    <section>
      <Eyebrow style={{ marginBottom: 14 }}>{tr.sectionRecent}</Eyebrow>

      {loading && (
        <Mono size={12} color="var(--fg-3)">
          {tr.loadingReviews}
        </Mono>
      )}

      {!loading && error && (
        <Mono size={12} color="var(--red)">
          {tr.errorReviews}: {error}
        </Mono>
      )}

      {!loading && !error && reviews.length === 0 && (
        <Mono size={12} color="var(--fg-3)">
          {tr.emptyReviews}
        </Mono>
      )}

      {!loading && !error && reviews.length > 0 && (
        <div style={{ overflowX: 'auto', width: '100%' }}>
          <table
            style={{
              width: '100%',
              minWidth: 760,
              borderCollapse: 'collapse',
              background: 'transparent',
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line-soft)' }}>
                {columns.map((col, i) => (
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
                ))}
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
                        status={kindLabel(r.kind, tr)}
                        tone={kindTone(r.kind)}
                        size="sm"
                      />
                    </td>
                    <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                      {r.mode == null ? (
                        <Mono size={11} color="var(--fg-3)">—</Mono>
                      ) : (
                        <StatusChip
                          status={r.mode === 'deep' ? tr.modeDeep : tr.modeFast}
                          tone={r.mode === 'deep' ? 'warn' : 'muted'}
                          size="sm"
                        />
                      )}
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
                        {r.findings_count}
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
                        {tr.detailLink}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function Reviews(): ReactElement {
  const { lang, t } = useTensol();
  const tr = t.reviews;
  const [reviews, setReviews] = useState<ReviewListItemWire[] | null>(null);
  const [reviewsErr, setReviewsErr] = useState<string | null>(null);
  const [reviewsLoading, setReviewsLoading] = useState<boolean>(true);

  const [repos, setRepos] = useState<ReviewRepoWire[] | null>(null);
  const [reposErr, setReposErr] = useState<string | null>(null);
  const [reposLoading, setReposLoading] = useState<boolean>(true);

  // F1 — feature flags gate the per-repo "Deep research" toggle. Default the
  // flags to "off" until they load (and if the request fails) so the toggle
  // never appears unless the server explicitly enables it.
  const [flags, setFlags] = useState<FeatureFlags | null>(null);

  useEffect(() => {
    let cancelled = false;

    apiClient.config
      .getFeatureFlags()
      .then((data) => {
        if (cancelled) return;
        setFlags(data);
      })
      .catch(() => {
        // Fail closed: leave flags null → deep-research toggle stays hidden.
        if (cancelled) return;
        setFlags(null);
      });

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
      breadcrumb={[tr.title]}
      role="security_lead"
      density="comfortable"
      brand="sthrip"
      language={lang}
      showLanguageSwitcher={false}
      surface="white-mono"
    >
      <RouteHead title={tr.pageTitle} />
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
            {tr.title}
          </h1>
        </div>
        <Mono
          size={13}
          color="var(--fg-3)"
          style={{ display: 'block', marginBottom: 36 }}
        >
          {tr.subtitle}
        </Mono>

        <ReposSection
          repos={repos ?? []}
          loading={reposLoading}
          error={reposErr}
          researchEnabled={flags?.research_enabled === true}
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
