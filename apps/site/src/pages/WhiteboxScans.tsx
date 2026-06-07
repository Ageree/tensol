import { useEffect, useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { DashboardPage } from '../components/dashboard-ui.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Checkbox, Eyebrow, Mono, StatusChip } from '../components/primitives.tsx';
import {
  ApiError,
  apiClient,
  type FeatureFlags,
  type InstallationRepo,
  type ReviewListItemWire,
  type ReviewMode,
} from '../lib/api-client.ts';

const INSTALLATION_REPOS_PAGE_LIMIT = 200;
const INSTALLATION_REPOS_FETCH_CONCURRENCY = 3;

interface WhiteboxRepo {
  readonly key: string;
  readonly repo_id?: string | null;
  readonly owner: string;
  readonly name: string;
  readonly default_branch: string;
  readonly enabled: boolean;
  readonly account_login: string;
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async (_, workerIndex) => {
      for (let index = workerIndex; index < items.length; index += workerCount) {
        const item = items[index];
        if (item !== undefined) await worker(item);
      }
    }),
  );
}

function repoFromInstallationRepo(
  installationId: string,
  accountLogin: string,
  repo: InstallationRepo,
): WhiteboxRepo {
  return {
    key: repo.repo_id ?? `${installationId}:${repo.owner}/${repo.name}`,
    repo_id: repo.repo_id ?? null,
    owner: repo.owner,
    name: repo.name,
    default_branch: repo.default_branch ?? 'main',
    enabled: repo.enabled,
    account_login: accountLogin,
  };
}

function statusTone(enabled: boolean): 'ok' | 'warn' {
  return enabled ? 'ok' : 'warn';
}

function reviewStatusTone(
  status: ReviewListItemWire['status'],
): 'ok' | 'warn' | 'danger' | 'muted' {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'muted';
  return 'warn';
}

function fmtTimestamp(ms?: number | null): string {
  if (ms == null) return '-';
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return '-';
  }
}

interface RepoCardProps {
  readonly repo: WhiteboxRepo;
  readonly researchEnabled: boolean;
}

function RepoCard({ repo, researchEnabled }: RepoCardProps): ReactElement {
  const navigate = useNavigate();
  const [mode, setMode] = useState<ReviewMode>('fast');
  const [ref, setRef] = useState<string>(repo.default_branch);
  const [launching, setLaunching] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const canLaunch = !launching;

  const launch = async (): Promise<void> => {
    if (!canLaunch) return;
    setLaunching(true);
    setError(null);
    try {
      const { review_id } = await apiClient.review.launchWhitebox({
        ...(repo.repo_id
          ? { repo_id: repo.repo_id }
          : { repo: `${repo.owner}/${repo.name}` }),
        ref: ref.trim() || repo.default_branch,
        mode: mode === 'deep' && researchEnabled ? 'deep' : 'fast',
      });
      navigate(`/reviews/${encodeURIComponent(review_id)}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'feature_disabled') {
        setError('Deep research is not enabled for this workspace.');
      } else if (err instanceof ApiError) {
        setError(err.code);
      } else {
        setError('network_error');
      }
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(180px, 260px) auto',
        gap: 16,
        alignItems: 'center',
        padding: '14px 0',
        borderBottom: '1px solid var(--line-soft)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Mono size={13} color="var(--fg)" style={{ display: 'block', fontWeight: 600 }}>
          {repo.owner}/{repo.name}
        </Mono>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <StatusChip
            status={repo.enabled ? 'enabled' : 'disabled'}
            tone={statusTone(repo.enabled)}
            size="sm"
          />
          <Mono size={10.5} color="var(--fg-3)">
            {repo.account_login} / {repo.default_branch}
          </Mono>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <input
          value={ref}
          onChange={(e) => setRef(e.currentTarget.value)}
          aria-label={`${repo.owner}/${repo.name} ref`}
          style={{
            height: 34,
            border: '1px solid var(--line)',
            background: 'var(--bg)',
            color: 'var(--fg)',
            padding: '0 10px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
          }}
        />
        {researchEnabled && (
          <Checkbox
            checked={mode === 'deep'}
            onChange={(checked) => setMode(checked ? 'deep' : 'fast')}
            label="Deep research"
          />
        )}
      </div>

      <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
        <Btn kind="secondary" size="sm" onClick={() => void launch()} disabled={!canLaunch}>
          {launching ? 'Starting...' : 'Start scan'}
        </Btn>
        {error && (
          <Mono size={10.5} color="var(--red)">
            {error}
          </Mono>
        )}
      </div>
    </div>
  );
}

export default function WhiteboxScans(): ReactElement {
  const [repos, setRepos] = useState<WhiteboxRepo[]>([]);
  const [reviews, setReviews] = useState<ReviewListItemWire[]>([]);
  const [flags, setFlags] = useState<FeatureFlags | null>(null);
  const [reposLoading, setReposLoading] = useState<boolean>(true);
  const [reviewsLoading, setReviewsLoading] = useState<boolean>(true);
  const [reposError, setReposError] = useState<string | null>(null);
  const [reviewsError, setReviewsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    apiClient.config
      .getFeatureFlags()
      .then((data) => {
        if (!cancelled) setFlags(data);
      })
      .catch(() => {
        if (!cancelled) setFlags(null);
      });

    void (async () => {
      try {
        const { installations } = await apiClient.github.installations();
        const activeInstallations = installations.filter(
          (installation) => installation.status !== 'deleted',
        );
        const collected: WhiteboxRepo[] = [];
        await forEachWithConcurrency(
          activeInstallations,
          INSTALLATION_REPOS_FETCH_CONCURRENCY,
          async (installation) => {
            const installationRepos = await apiClient.github.installationRepos(
              installation.id,
              { limit: INSTALLATION_REPOS_PAGE_LIMIT },
            );
            collected.push(
              ...installationRepos.map((repo) =>
                repoFromInstallationRepo(
                  installation.id,
                  installation.account_login,
                  repo,
                ),
              ),
            );
          },
        );
        if (cancelled) return;
        collected.sort((a, b) =>
          `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`),
        );
        setRepos(collected);
        setReposError(null);
      } catch (e: unknown) {
        if (cancelled) return;
        setReposError(e instanceof ApiError ? e.code : 'network_error');
      } finally {
        if (!cancelled) setReposLoading(false);
      }
    })();

    apiClient.review
      .list({ limit: 50, kind: 'whitebox' })
      .then((data) => {
        if (cancelled) return;
        setReviews(data);
        setReviewsError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setReviewsError(e instanceof ApiError ? e.code : 'network_error');
      })
      .finally(() => {
        if (!cancelled) setReviewsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell
      breadcrumb={['Whitebox Scans']}
      role="security_lead"
      density="comfortable"
      brand="sthrip"
      language="en"
      showLanguageSwitcher={false}
      surface="hacktron-light"
    >
      <RouteHead title="Whitebox Scans - Sthrip" />
      <DashboardPage
        title="Whitebox Scans"
        section="Whitebox Scans"
        description="Launch repository-backed source analysis against connected GitHub repositories."
        data-screen-label="Whitebox Scans"
      >
        <div style={{ display: 'grid', gap: 22 }}>
          <section>
            <Eyebrow style={{ marginBottom: 14 }} color="var(--fg-3)">
              Repositories
            </Eyebrow>
            <div
              style={{
                border: '1px solid var(--fg)',
                background: 'var(--bg)',
                padding: '18px 24px',
              }}
            >
              {reposLoading && (
                <Mono size={12} color="var(--fg-3)">
                  Loading repositories...
                </Mono>
              )}
              {!reposLoading && reposError && (
                <Mono size={12} color="var(--red)">
                  Failed to load repositories: {reposError}
                </Mono>
              )}
              {!reposLoading && !reposError && repos.length === 0 && (
                <div style={{ display: 'grid', gap: 12 }}>
                  <Mono size={12} color="var(--fg-3)">
                    No connected repositories yet.
                  </Mono>
                  <Link to="/repositories" style={{ textDecoration: 'none' }}>
                    <Btn kind="secondary" size="sm">
                      Connect repositories
                    </Btn>
                  </Link>
                </div>
              )}
              {!reposLoading && !reposError && repos.length > 0 && (
                <div>
                  {repos.map((repo) => (
                    <RepoCard
                      key={repo.key}
                      repo={repo}
                      researchEnabled={flags?.research_enabled === true}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>

          <section>
            <Eyebrow style={{ marginBottom: 14 }} color="var(--fg-3)">
              Recent whitebox runs
            </Eyebrow>
            <div
              style={{
                border: '1px solid var(--fg)',
                background: 'var(--bg)',
                padding: '18px 24px',
                overflowX: 'auto',
              }}
            >
              {reviewsLoading && (
                <Mono size={12} color="var(--fg-3)">
                  Loading scans...
                </Mono>
              )}
              {!reviewsLoading && reviewsError && (
                <Mono size={12} color="var(--red)">
                  Failed to load scans: {reviewsError}
                </Mono>
              )}
              {!reviewsLoading && !reviewsError && reviews.length === 0 && (
                <Mono size={12} color="var(--fg-3)">
                  No whitebox scans have been launched yet.
                </Mono>
              )}
              {!reviewsLoading && !reviewsError && reviews.length > 0 && (
                <table style={{ width: '100%', minWidth: 700, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--line-soft)' }}>
                      {['Repository', 'Mode', 'Status', 'Findings', 'Created', ''].map((column) => (
                        <th
                          key={column}
                          style={{
                            textAlign: 'left',
                            padding: '10px 4px',
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 10,
                            textTransform: 'uppercase',
                            fontWeight: 500,
                            color: 'var(--fg-3)',
                          }}
                        >
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reviews.map((review) => (
                      <tr key={review.review_id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                        <td style={{ padding: '14px 4px' }}>
                          <Mono size={12} color="var(--fg)">
                            {review.repo ?? '-'}
                          </Mono>
                        </td>
                        <td style={{ padding: '14px 4px' }}>
                          <StatusChip
                            status={review.mode === 'deep' ? 'deep' : 'fast'}
                            tone={review.mode === 'deep' ? 'warn' : 'muted'}
                            size="sm"
                          />
                        </td>
                        <td style={{ padding: '14px 4px' }}>
                          <StatusChip status={review.status} tone={reviewStatusTone(review.status)} size="sm" />
                        </td>
                        <td style={{ padding: '14px 4px' }}>
                          <Mono size={11} color="var(--fg)">
                            {review.findings_count}
                          </Mono>
                        </td>
                        <td style={{ padding: '14px 4px' }}>
                          <Mono size={10.5} color="var(--fg-3)">
                            {fmtTimestamp(review.created_at)}
                          </Mono>
                        </td>
                        <td style={{ padding: '14px 4px', textAlign: 'right' }}>
                          <Link
                            to={`/reviews/${encodeURIComponent(review.review_id)}`}
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 11,
                              color: 'var(--fg)',
                              textDecoration: 'underline',
                            }}
                          >
                            Open
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </DashboardPage>
    </AppShell>
  );
}
