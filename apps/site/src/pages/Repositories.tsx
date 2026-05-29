// T019 — Repositories page (feature 004: Sthrip PR Review).
//
// URL: /repositories
//
// Shows all repositories accessible through the user's GitHub installation(s).
// Per-repo controls:
//   - Enable / disable review coverage
//   - Edit covered branches
//   - Toggle status-check (Sthrip N/5)
//   - Toggle merge-block on critical
//   - Per-repo last-review status
//
// Changes persist via github.updateRepoSettings (PATCH /v1/review/repos/{id}/settings).
// All user-facing strings use t('repos.*') i18n keys.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';
import { AppShell } from '../components/AppShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Eyebrow, Mono, StatusChip } from '../components/primitives.tsx';
import { TENSOL_I18N } from '../i18n.ts';
import {
  ApiError,
  type Installation,
  type InstallationRepo,
} from '../lib/api-client.ts';
import { apiClient } from '../lib/api-client.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTimestamp(ms?: number | null): string {
  if (ms == null) return '';
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return '';
  }
}

function parseBranches(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type SaveStatus = 'idle' | 'saving' | 'error';

// ─── BranchEditor — inline edit for covered_branches ─────────────────────────

interface BranchEditorProps {
  repoId: string | null | undefined;
  branches: string[];
  disabled: boolean;
  onSave: (repoId: string, branches: string[]) => Promise<void>;
  t: ReturnType<typeof useLang>['t'];
}

function BranchEditor({
  repoId,
  branches,
  disabled,
  onSave,
  t,
}: BranchEditorProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(branches.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit(): void {
    setDraft(branches.join(', '));
    setEditing(true);
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  async function commitEdit(): Promise<void> {
    if (!repoId) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(repoId, parseBranches(draft));
      setEditing(false);
    } catch {
      setError(t.saveError);
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit(): void {
    setEditing(false);
    setError(null);
  }

  if (!editing) {
    return (
      <button
        onClick={disabled ? undefined : startEdit}
        disabled={disabled}
        style={{
          all: 'unset',
          cursor: disabled ? 'default' : 'pointer',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: branches.length > 0 ? 'var(--fg)' : 'var(--fg-3)',
          borderBottom: disabled ? 'none' : '1px dashed var(--line-soft)',
          lineHeight: 1.4,
          display: 'inline-block',
          maxWidth: 180,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={branches.length > 0 ? branches.join(', ') : t.branchesPlaceholder}
        aria-label="edit covered branches"
      >
        {branches.length > 0 ? branches.join(', ') : <span style={{ opacity: 0.4 }}>—</span>}
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
      <input
        ref={inputRef}
        value={draft}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
        placeholder={t.branchesPlaceholder}
        disabled={saving}
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          border: '1px solid var(--fg)',
          background: 'var(--bg)',
          color: 'var(--fg)',
          padding: '4px 6px',
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            void commitEdit();
          } else if (e.key === 'Escape') {
            cancelEdit();
          }
        }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <Btn kind="primary" size="sm" onClick={() => void commitEdit()} disabled={saving}>
          {saving ? t.saving : t.branchesSave}
        </Btn>
        <Btn kind="secondary" size="sm" onClick={cancelEdit} disabled={saving}>
          {t.branchesCancel}
        </Btn>
      </div>
      {error && (
        <Mono size={10} color="var(--red)">
          {error}
        </Mono>
      )}
    </div>
  );
}

// ─── ToggleSwitch — simple on/off toggle ──────────────────────────────────────

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  labelOn: string;
  labelOff: string;
}

function ToggleSwitch({
  checked,
  onChange,
  disabled,
  labelOn,
  labelOff,
}: ToggleSwitchProps): ReactElement {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={disabled ? undefined : () => onChange(!checked)}
      disabled={disabled}
      style={{
        all: 'unset',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <span
        style={{
          width: 28,
          height: 16,
          background: checked ? 'var(--fg)' : 'var(--line-soft)',
          borderRadius: 0,
          position: 'relative',
          display: 'inline-block',
          transition: 'background 120ms',
          border: '1px solid var(--fg)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 13 : 2,
            width: 9,
            height: 9,
            background: checked ? 'var(--bg)' : 'var(--fg)',
            transition: 'left 120ms',
          }}
        />
      </span>
      <Mono size={11} color={checked ? 'var(--fg)' : 'var(--fg-3)'}>
        {checked ? labelOn : labelOff}
      </Mono>
    </button>
  );
}

// ─── LastReviewCell ────────────────────────────────────────────────────────────

interface LastReviewCellProps {
  lastReview: InstallationRepo['last_review'];
  noReviewLabel: string;
}

type ReviewStatusTone = 'ok' | 'warn' | 'danger' | 'muted' | 'neutral';

function reviewStatusTone(
  status: NonNullable<InstallationRepo['last_review']>['status'],
): ReviewStatusTone {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'muted';
  if (status === 'running') return 'warn';
  return 'neutral';
}

function LastReviewCell({ lastReview, noReviewLabel }: LastReviewCellProps): ReactElement {
  if (!lastReview) {
    return (
      <Mono size={10.5} color="var(--fg-3)">
        {noReviewLabel}
      </Mono>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <StatusChip
        status={lastReview.status}
        tone={reviewStatusTone(lastReview.status)}
        size="sm"
      />
      {lastReview.score_0_5 != null && (
        <Mono size={10} color="var(--fg-3)">
          {lastReview.score_0_5}/5
        </Mono>
      )}
      <Mono size={10} color="var(--fg-3)">
        {fmtTimestamp(lastReview.updated_at)}
      </Mono>
    </div>
  );
}

// ─── RepoRow — one repo in the table ──────────────────────────────────────────

interface RepoRowProps {
  repo: InstallationRepo;
  onToggleEnabled: (repoId: string, enabled: boolean) => Promise<void>;
  onBranchesSave: (repoId: string, branches: string[]) => Promise<void>;
  onToggleStatusCheck: (repoId: string, v: boolean) => Promise<void>;
  onToggleMergeBlock: (repoId: string, v: boolean) => Promise<void>;
  t: ReturnType<typeof useLang>['t'];
}

function RepoRow({
  repo,
  onToggleEnabled,
  onBranchesSave,
  onToggleStatusCheck,
  onToggleMergeBlock,
  t,
}: RepoRowProps): ReactElement {
  const [enabledStatus, setEnabledStatus] = useState<SaveStatus>('idle');
  const [statusCheckStatus, setStatusCheckStatus] = useState<SaveStatus>('idle');
  const [mergeBlockStatus, setMergeBlockStatus] = useState<SaveStatus>('idle');

  const repoId = repo.repo_id ?? null;
  const disabled = repoId == null;

  async function handleToggleEnabled(v: boolean): Promise<void> {
    if (!repoId) return;
    setEnabledStatus('saving');
    try {
      await onToggleEnabled(repoId, v);
      setEnabledStatus('idle');
    } catch {
      setEnabledStatus('error');
    }
  }

  async function handleToggleStatusCheck(v: boolean): Promise<void> {
    if (!repoId) return;
    setStatusCheckStatus('saving');
    try {
      await onToggleStatusCheck(repoId, v);
      setStatusCheckStatus('idle');
    } catch {
      setStatusCheckStatus('error');
    }
  }

  async function handleToggleMergeBlock(v: boolean): Promise<void> {
    if (!repoId) return;
    setMergeBlockStatus('saving');
    try {
      await onToggleMergeBlock(repoId, v);
      setMergeBlockStatus('idle');
    } catch {
      setMergeBlockStatus('error');
    }
  }

  return (
    <tr
      style={{
        borderBottom: '1px solid var(--line-soft)',
        background: repo.enabled ? 'var(--bg)' : 'var(--bg-2)',
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {/* Repo name */}
      <td style={{ padding: '14px 8px', verticalAlign: 'top' }}>
        <Mono size={12} color="var(--fg)" style={{ fontWeight: 500 }}>
          {repo.owner}/{repo.name}
        </Mono>
        {repo.default_branch && (
          <Mono size={10} color="var(--fg-3)" style={{ marginTop: 2 }}>
            default: {repo.default_branch}
          </Mono>
        )}
      </td>

      {/* Covered branches */}
      <td style={{ padding: '14px 8px', verticalAlign: 'top', minWidth: 140 }}>
        <BranchEditor
          repoId={repoId}
          branches={repo.covered_branches ?? (repo.default_branch ? [repo.default_branch] : [])}
          disabled={disabled || !repo.enabled}
          onSave={onBranchesSave}
          t={t}
        />
      </td>

      {/* Status check */}
      <td style={{ padding: '14px 8px', verticalAlign: 'top' }}>
        <ToggleSwitch
          checked={repo.status_check_enabled ?? false}
          onChange={(v) => void handleToggleStatusCheck(v)}
          disabled={disabled || !repo.enabled || statusCheckStatus === 'saving'}
          labelOn={t.statusCheckOn}
          labelOff={t.statusCheckOff}
        />
        {statusCheckStatus === 'error' && (
          <Mono size={9} color="var(--red)" style={{ display: 'block', marginTop: 4 }}>
            {t.saveError}
          </Mono>
        )}
      </td>

      {/* Merge block */}
      <td style={{ padding: '14px 8px', verticalAlign: 'top' }}>
        <ToggleSwitch
          checked={repo.merge_block_on_critical ?? false}
          onChange={(v) => void handleToggleMergeBlock(v)}
          disabled={disabled || !repo.enabled || mergeBlockStatus === 'saving'}
          labelOn={t.mergeBlockOn}
          labelOff={t.mergeBlockOff}
        />
        {mergeBlockStatus === 'error' && (
          <Mono size={9} color="var(--red)" style={{ display: 'block', marginTop: 4 }}>
            {t.saveError}
          </Mono>
        )}
      </td>

      {/* Last review */}
      <td style={{ padding: '14px 8px', verticalAlign: 'top', minWidth: 120 }}>
        <LastReviewCell lastReview={repo.last_review} noReviewLabel={t.lastReviewNone} />
      </td>

      {/* Enabled toggle */}
      <td style={{ padding: '14px 8px', verticalAlign: 'top' }}>
        <ToggleSwitch
          checked={repo.enabled}
          onChange={(v) => void handleToggleEnabled(v)}
          disabled={disabled || enabledStatus === 'saving'}
          labelOn={t.enabledLabel}
          labelOff={t.disabledLabel}
        />
        {enabledStatus === 'error' && (
          <Mono size={9} color="var(--red)" style={{ display: 'block', marginTop: 4 }}>
            {t.saveError}
          </Mono>
        )}
      </td>
    </tr>
  );
}

// ─── InstallationSection ───────────────────────────────────────────────────────

interface InstallationSectionProps {
  installation: Installation;
  repos: InstallationRepo[];
  reposLoading: boolean;
  reposError: string | null;
  onToggleEnabled: (repoId: string, enabled: boolean) => Promise<void>;
  onBranchesSave: (repoId: string, branches: string[]) => Promise<void>;
  onToggleStatusCheck: (repoId: string, v: boolean) => Promise<void>;
  onToggleMergeBlock: (repoId: string, v: boolean) => Promise<void>;
  onDisconnect: (installationId: string) => void;
  t: ReturnType<typeof useLang>['t'];
}

type InstallationStatusTone = 'ok' | 'warn' | 'danger';

function installationStatusTone(status: Installation['status']): InstallationStatusTone {
  if (status === 'active') return 'ok';
  if (status === 'suspended') return 'warn';
  return 'danger';
}

function installationStatusLabel(
  status: Installation['status'],
  t: ReturnType<typeof useLang>['t'],
): string {
  if (status === 'active') return t.statusActive;
  if (status === 'suspended') return t.statusSuspended;
  return t.statusDeleted;
}

function InstallationSection({
  installation,
  repos,
  reposLoading,
  reposError,
  onToggleEnabled,
  onBranchesSave,
  onToggleStatusCheck,
  onToggleMergeBlock,
  onDisconnect,
  t,
}: InstallationSectionProps): ReactElement {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  function handleDisconnect(): void {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    onDisconnect(installation.id);
  }

  const colHeaders = [
    t.colRepo,
    t.colBranches,
    t.colStatusCheck,
    t.colMergeBlock,
    t.colLastReview,
    t.colEnabled,
  ] as const;

  return (
    <section style={{ marginBottom: 40 }}>
      {/* Installation header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          background: 'var(--bg-2)',
          border: '1px solid var(--line-soft)',
          marginBottom: 1,
        }}
      >
        <Mono size={12} color="var(--fg)" style={{ fontWeight: 600, flex: 1 }}>
          {installation.account_login}
        </Mono>
        <Mono size={10} color="var(--fg-3)" style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {installation.account_type}
        </Mono>
        <StatusChip
          status={installationStatusLabel(installation.status, t)}
          tone={installationStatusTone(installation.status)}
          size="sm"
        />
        <Mono size={10} color="var(--fg-3)">
          {installation.repository_selection === 'all' ? 'all repos' : 'selected repos'}
        </Mono>
        {installation.status !== 'deleted' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {confirmDisconnect && (
              <Mono size={10} color="var(--red)" style={{ maxWidth: 240 }}>
                {t.disconnectConfirm}
              </Mono>
            )}
            <Btn
              kind={confirmDisconnect ? 'red' : 'dim'}
              size="sm"
              onClick={handleDisconnect}
            >
              {t.disconnectLabel}
            </Btn>
            {confirmDisconnect && (
              <Btn
                kind="secondary"
                size="sm"
                onClick={() => setConfirmDisconnect(false)}
              >
                {t.branchesCancel}
              </Btn>
            )}
          </div>
        )}
      </div>

      {/* Repo table */}
      {reposLoading && (
        <div style={{ padding: '16px 16px', border: '1px solid var(--line-soft)', borderTop: 'none' }}>
          <Mono size={12} color="var(--fg-3)">
            {t.loading}
          </Mono>
        </div>
      )}

      {!reposLoading && reposError && (
        <div style={{ padding: '16px 16px', border: '1px solid var(--line-soft)', borderTop: 'none' }}>
          <Mono size={12} color="var(--red)">
            {t.loadError}: {reposError}
          </Mono>
        </div>
      )}

      {!reposLoading && !reposError && repos.length === 0 && (
        <div style={{ padding: '16px 16px', border: '1px solid var(--line-soft)', borderTop: 'none' }}>
          <Mono size={12} color="var(--fg-3)">
            {t.empty}
          </Mono>
        </div>
      )}

      {!reposLoading && !reposError && repos.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: 'transparent' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line-soft)', background: 'var(--bg-2)' }}>
                {colHeaders.map((col) => (
                  <th
                    key={col}
                    style={{
                      textAlign: 'left',
                      padding: '8px 8px',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      fontWeight: 500,
                      color: 'var(--fg-3)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <RepoRow
                  key={`${repo.owner}/${repo.name}`}
                  repo={repo}
                  onToggleEnabled={onToggleEnabled}
                  onBranchesSave={onBranchesSave}
                  onToggleStatusCheck={onToggleStatusCheck}
                  onToggleMergeBlock={onToggleMergeBlock}
                  t={t}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── useLang — tiny hook to read i18n ─────────────────────────────────────────

function useLang() {
  const t = TENSOL_I18N.en.repos;
  return { t };
}

// ─── Page state shape ─────────────────────────────────────────────────────────

interface InstallationState {
  readonly installation: Installation;
  readonly repos: InstallationRepo[];
  readonly reposLoading: boolean;
  readonly reposError: string | null;
}

interface PageState {
  readonly installationsLoading: boolean;
  readonly installationsError: string | null;
  readonly connected: boolean;
  readonly installations: InstallationState[];
  /** Per-installationId disconnect status */
  readonly disconnecting: ReadonlySet<string>;
  readonly disconnectError: string | null;
}

const INITIAL_STATE: PageState = {
  installationsLoading: true,
  installationsError: null,
  connected: false,
  installations: [],
  disconnecting: new Set(),
  disconnectError: null,
};

// ─── Page component ───────────────────────────────────────────────────────────

export default function Repositories(): ReactElement {
  const { t } = useLang();
  const [state, setState] = useState<PageState>(INITIAL_STATE);

  // Load installations + kick off per-installation repo fetches
  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const { connected, installations } = await apiClient.github.installations();
        if (cancelled) return;

        // Build initial per-installation state (repos loading)
        const installationStates: InstallationState[] = installations
          .filter((i) => i.status !== 'deleted')
          .map((installation) => ({
            installation,
            repos: [],
            reposLoading: true,
            reposError: null,
          }));

        setState((prev) => ({
          ...prev,
          installationsLoading: false,
          installationsError: null,
          connected,
          installations: installationStates,
        }));

        // Fetch repos for each installation concurrently
        await Promise.all(
          installationStates.map(async (inst) => {
            try {
              const repos = await apiClient.github.installationRepos(inst.installation.id);
              if (cancelled) return;
              setState((prev) => ({
                ...prev,
                installations: prev.installations.map((s) =>
                  s.installation.id === inst.installation.id
                    ? { ...s, repos, reposLoading: false }
                    : s,
                ),
              }));
            } catch (e: unknown) {
              if (cancelled) return;
              const code = e instanceof ApiError ? e.code : 'network_error';
              setState((prev) => ({
                ...prev,
                installations: prev.installations.map((s) =>
                  s.installation.id === inst.installation.id
                    ? { ...s, reposLoading: false, reposError: code }
                    : s,
                ),
              }));
            }
          }),
        );
      } catch (e: unknown) {
        if (cancelled) return;
        const code = e instanceof ApiError ? e.code : 'network_error';
        setState((prev) => ({
          ...prev,
          installationsLoading: false,
          installationsError: code,
        }));
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Update a single repo's settings in local state after a successful PATCH
  const applyRepoUpdate = useCallback((updated: InstallationRepo): void => {
    setState((prev) => ({
      ...prev,
      installations: prev.installations.map((inst) => ({
        ...inst,
        repos: inst.repos.map((r) => {
          const sameId = r.repo_id != null && r.repo_id === updated.repo_id;
          const sameName = r.owner === updated.owner && r.name === updated.name;
          return sameId || sameName ? { ...r, ...updated } : r;
        }),
      })),
    }));
  }, []);

  const handleToggleEnabled = useCallback(
    async (repoId: string, enabled: boolean): Promise<void> => {
      const updated = await apiClient.github.updateRepoSettings(repoId, { enabled });
      applyRepoUpdate(updated);
    },
    [applyRepoUpdate],
  );

  const handleBranchesSave = useCallback(
    async (repoId: string, covered_branches: string[]): Promise<void> => {
      const updated = await apiClient.github.updateRepoSettings(repoId, { covered_branches });
      applyRepoUpdate(updated);
    },
    [applyRepoUpdate],
  );

  const handleToggleStatusCheck = useCallback(
    async (repoId: string, status_check_enabled: boolean): Promise<void> => {
      const updated = await apiClient.github.updateRepoSettings(repoId, { status_check_enabled });
      applyRepoUpdate(updated);
    },
    [applyRepoUpdate],
  );

  const handleToggleMergeBlock = useCallback(
    async (repoId: string, merge_block_on_critical: boolean): Promise<void> => {
      const updated = await apiClient.github.updateRepoSettings(repoId, {
        merge_block_on_critical,
      });
      applyRepoUpdate(updated);
    },
    [applyRepoUpdate],
  );

  const handleDisconnect = useCallback((installationId: string): void => {
    setState((prev) => ({
      ...prev,
      disconnecting: new Set([...prev.disconnecting, installationId]),
      disconnectError: null,
    }));

    void apiClient.github.disconnect(installationId).then(
      () => {
        setState((prev) => {
          const disconnecting = new Set(prev.disconnecting);
          disconnecting.delete(installationId);
          return {
            ...prev,
            disconnecting,
            installations: prev.installations.filter(
              (s) => s.installation.id !== installationId,
            ),
          };
        });
      },
      (e: unknown) => {
        const code = e instanceof ApiError ? e.code : 'network_error';
        setState((prev) => {
          const disconnecting = new Set(prev.disconnecting);
          disconnecting.delete(installationId);
          return {
            ...prev,
            disconnecting,
            disconnectError: code,
          };
        });
      },
    );
  }, []);

  return (
    <AppShell
      breadcrumb={[t.title]}
      role="security_lead"
      density="comfortable"
      brand="sthrip"
      language="en"
      showLanguageSwitcher={false}
      surface="white-mono"
    >
      <RouteHead title={`Sthrip · ${t.title}`} />
      <div data-screen-label="Repositories">
        {/* Page header */}
        <div style={{ marginBottom: 8 }}>
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
            {t.title}
          </h1>
        </div>
        <Mono size={13} color="var(--fg-3)" style={{ display: 'block', marginBottom: 36 }}>
          {t.subtitle}
        </Mono>

        {/* Loading state */}
        {state.installationsLoading && (
          <Mono size={12} color="var(--fg-3)">
            {t.loading}
          </Mono>
        )}

        {/* Top-level error */}
        {!state.installationsLoading && state.installationsError && (
          <Mono size={12} color="var(--red)">
            {t.loadError}: {state.installationsError}
          </Mono>
        )}

        {/* Disconnect error */}
        {state.disconnectError && (
          <Mono size={12} color="var(--red)" style={{ display: 'block', marginBottom: 16 }}>
            {t.disconnectError}: {state.disconnectError}
          </Mono>
        )}

        {/* Not connected */}
        {!state.installationsLoading &&
          !state.installationsError &&
          !state.connected && (
            <div
              style={{
                padding: '24px',
                border: '1px solid var(--line-soft)',
                background: 'var(--bg-2)',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                maxWidth: 480,
              }}
            >
              <Mono size={12} color="var(--fg-3)">
                {t.connectHint}
              </Mono>
              <div>
                <Btn
                  kind="primary"
                  size="md"
                  onClick={() => {
                    void apiClient.github.connect().then((data) => {
                      window.location.href = data.install_url;
                    });
                  }}
                >
                  {t.connectCta}
                </Btn>
              </div>
            </div>
          )}

        {/* Connected but no installations */}
        {!state.installationsLoading &&
          !state.installationsError &&
          state.connected &&
          state.installations.length === 0 && (
            <Mono size={12} color="var(--fg-3)">
              {t.empty}
            </Mono>
          )}

        {/* Installation sections */}
        {!state.installationsLoading &&
          !state.installationsError &&
          state.installations.length > 0 && (
            <>
              <Eyebrow style={{ marginBottom: 16 }}>{t.installationSection}</Eyebrow>
              {state.installations.map((inst) => (
                <InstallationSection
                  key={inst.installation.id}
                  installation={inst.installation}
                  repos={inst.repos}
                  reposLoading={inst.reposLoading || state.disconnecting.has(inst.installation.id)}
                  reposError={inst.reposError}
                  onToggleEnabled={handleToggleEnabled}
                  onBranchesSave={handleBranchesSave}
                  onToggleStatusCheck={handleToggleStatusCheck}
                  onToggleMergeBlock={handleToggleMergeBlock}
                  onDisconnect={handleDisconnect}
                  t={t}
                />
              ))}
            </>
          )}
      </div>
    </AppShell>
  );
}
