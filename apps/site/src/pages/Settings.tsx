import { useUser } from '@clerk/react';
import {
  useConvexAuth,
  useMutation,
  useQuery_experimental as useQueryState,
} from 'convex/react';
import {
  useEffect,
  useState,
  type ReactElement,
} from 'react';
import { AppShell } from '../components/AppShell';
import { DashboardPage } from '../components/dashboard-ui.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Card, Eyebrow, Mono, StatusChip } from '../components/primitives';
import { TENSOL_I18N } from '../i18n.ts';
import {
  ApiError,
  agentTokens,
  auth,
  scanOrders,
  type AgentTokenMeta,
  type AuthMe,
} from '../lib/api-client.ts';
import { isE2EAuthBypass } from '../lib/clerk.ts';
import { api } from '../lib/convex-api.ts';
import { isConvexConfigured } from '../lib/convex.ts';
import {
  deriveFreeQuotaStatus,
  type FreeQuotaStatus,
} from './dashboard-helpers.ts';

interface SlaThresholds {
  critical_days: number;
  critical_target: number;
  high_days: number;
  high_target: number;
  medium_days: number;
  medium_target: number;
  low_days: number;
  low_target: number;
}

interface OrgSettings {
  organization_name: string;
  url_slug: string;
  sla_thresholds: SlaThresholds;
  security_score_min: number;
  updated_at: number | null;
}

interface SettingsState {
  readonly restMe: AuthMe | null;
  readonly quota: FreeQuotaStatus | null;
  readonly tokens: AgentTokenMeta[];
  readonly loading: boolean;
  readonly accountError: string | null;
  readonly quotaError: string | null;
  readonly tokenError: string | null;
}

interface Profile {
  readonly id: string;
  readonly email: string;
}

interface SettingsContentProps {
  readonly convexMe: AuthMe | null | undefined;
  readonly convexMeLoading: boolean;
  readonly orgSettings: OrgSettings | null | undefined;
  readonly orgSettingsLoading: boolean;
  readonly updateGeneral?: (args: {
    organization_name: string;
    url_slug: string;
  }) => Promise<unknown>;
  readonly updateSlaThresholds?: (args: {
    sla_thresholds: SlaThresholds;
  }) => Promise<unknown>;
  readonly updateSecurityScore?: (args: {
    security_score_min: number;
  }) => Promise<unknown>;
  readonly settingsPersistenceMessage?: string | null;
  readonly clerkProfile: Profile | null;
  readonly clerkLoaded: boolean;
}

const DEFAULT_SLA_THRESHOLDS: SlaThresholds = {
  critical_days: 7,
  critical_target: 95,
  high_days: 30,
  high_target: 95,
  medium_days: 90,
  medium_target: 90,
  low_days: 120,
  low_target: 90,
};

const ACCOUNT_LOAD_TIMEOUT_MS = 6000;
const DAY_MS = 24 * 60 * 60 * 1000;

const INITIAL_STATE: SettingsState = {
  restMe: null,
  quota: null,
  tokens: [],
  loading: true,
  accountError: null,
  quotaError: null,
  tokenError: null,
};

const inputStyle = {
  height: 38,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  padding: '0 10px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
} as const;

function slugFrom(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug.length >= 3 ? slug : 'sthrip';
}

function normalizeNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function profileFromClerk(user: ReturnType<typeof useUser>['user']): Profile | null {
  if (!user) return null;
  const email =
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses[0]?.emailAddress ??
    '';
  return { id: user.id, email };
}

function profileFromAuthMe(me: AuthMe | null | undefined): Profile | null {
  if (!me) return null;
  return { id: me.id, email: me.email };
}

function quotaFromAuthMe(
  me: AuthMe | null | undefined,
  nowMs: number,
  requireInitialized = false,
): FreeQuotaStatus | null {
  if (!me || me.free_quick_available === undefined) return null;
  if (requireInitialized && me.convex_user_initialized !== true) return null;
  if (me.free_quick_available) {
    return { state: 'available', resetsAtMs: null, daysUntilReset: null };
  }
  const resetsAtMs = me.free_quick_resets_at ?? null;
  return {
    state: 'consumed',
    resetsAtMs,
    daysUntilReset:
      resetsAtMs == null
        ? null
        : Math.ceil(Math.max(0, resetsAtMs - nowMs) / DAY_MS),
  };
}

function SettingsWithConvex(): ReactElement {
  const { user, isLoaded } = useUser();
  const convexAuth = useConvexAuth();
  const canUseConvexSettings = convexAuth.isAuthenticated;
  const convexMeState = useQueryState({
    query: api.auth.me,
    args: canUseConvexSettings ? {} : 'skip',
  });
  const orgSettingsState = useQueryState({
    query: api.settings.get,
    args: canUseConvexSettings ? {} : 'skip',
  });
  const updateGeneral = useMutation(api.settings.updateGeneral);
  const updateSlaThresholds = useMutation(api.settings.updateSlaThresholds);
  const updateSecurityScore = useMutation(api.settings.updateSecurityScore);
  const convexQueryError =
    convexMeState.status === 'error' || orgSettingsState.status === 'error';
  const convexSettingsReady = canUseConvexSettings && !convexQueryError;
  const convexMe =
    convexMeState.status === 'success' ? convexMeState.data : undefined;
  const orgSettings =
    orgSettingsState.status === 'success'
      ? (orgSettingsState.data as OrgSettings | null)
      : null;
  const settingsPersistenceMessage =
    convexAuth.isLoading
      ? 'Loading profile settings...'
      : convexQueryError
        ? 'Profile settings are temporarily unavailable.'
        : !canUseConvexSettings
          ? 'Profile settings are waiting for Convex authentication.'
          : null;

  return (
    <SettingsContent
      convexMe={convexMe}
      convexMeLoading={canUseConvexSettings && convexMeState.status === 'pending'}
      orgSettings={orgSettings}
      orgSettingsLoading={
        convexAuth.isLoading ||
        (canUseConvexSettings && orgSettingsState.status === 'pending')
      }
      updateGeneral={convexSettingsReady ? updateGeneral : undefined}
      updateSlaThresholds={
        convexSettingsReady ? updateSlaThresholds : undefined
      }
      updateSecurityScore={
        convexSettingsReady ? updateSecurityScore : undefined
      }
      settingsPersistenceMessage={settingsPersistenceMessage}
      clerkProfile={profileFromClerk(user)}
      clerkLoaded={isLoaded}
    />
  );
}

function SettingsWithClerk(): ReactElement {
  const { user, isLoaded } = useUser();
  return (
    <SettingsContent
      convexMe={undefined}
      convexMeLoading={false}
      orgSettings={null}
      orgSettingsLoading={false}
      settingsPersistenceMessage="Profile settings persistence requires Convex configuration."
      clerkProfile={profileFromClerk(user)}
      clerkLoaded={isLoaded}
    />
  );
}

export default function Settings(): ReactElement {
  if (isE2EAuthBypass) {
    return (
      <SettingsContent
        convexMe={undefined}
        convexMeLoading={false}
        orgSettings={null}
        orgSettingsLoading={false}
        clerkProfile={{ id: 'e2e-user', email: 'e2e@sthrip.dev' }}
        clerkLoaded
      />
    );
  }
  if (isConvexConfigured) {
    return <SettingsWithConvex />;
  }
  return <SettingsWithClerk />;
}

function SettingsContent({
  convexMe,
  convexMeLoading,
  orgSettings,
  orgSettingsLoading,
  updateGeneral,
  updateSlaThresholds,
  updateSecurityScore,
  settingsPersistenceMessage,
  clerkProfile,
  clerkLoaded,
}: SettingsContentProps): ReactElement {
  const t = TENSOL_I18N.en;
  const [state, setState] = useState<SettingsState>(INITIAL_STATE);
  const [tokenName, setTokenName] = useState<string>('Codex MCP');
  const [creatingToken, setCreatingToken] = useState<boolean>(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  const [organizationName, setOrganizationName] = useState<string>('sthrip');
  const [urlSlug, setUrlSlug] = useState<string>('sthrip');
  const [slaThresholds, setSlaThresholds] =
    useState<SlaThresholds>(DEFAULT_SLA_THRESHOLDS);
  const [securityScoreMin, setSecurityScoreMin] = useState<number>(70);
  const [savingGeneral, setSavingGeneral] = useState<boolean>(false);
  const [savingSla, setSavingSla] = useState<boolean>(false);
  const [savingScore, setSavingScore] = useState<boolean>(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState<string | null>(null);
  const [accountLoadTimedOut, setAccountLoadTimedOut] = useState<boolean>(false);

  useEffect(() => {
    if (!orgSettings) return;
    setOrganizationName(orgSettings.organization_name);
    setUrlSlug(orgSettings.url_slug);
    setSlaThresholds(orgSettings.sla_thresholds);
    setSecurityScoreMin(orgSettings.security_score_min);
  }, [orgSettings]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [meResult, ordersResult, tokensResult] = await Promise.all([
        auth.me().then(
          (me) => ({ ok: true as const, me }),
          (e: unknown) => ({
            ok: false as const,
            error: e instanceof ApiError ? e.code : 'network_error',
          }),
        ),
        scanOrders.list().then(
          (orders) => ({ ok: true as const, orders }),
          (e: unknown) => ({
            ok: false as const,
            error: e instanceof ApiError ? e.code : 'network_error',
          }),
        ),
        agentTokens.list().then(
          (result) => ({
            ok: true as const,
            tokens: result.tokens,
            error: null as string | null,
          }),
          (e: unknown) => ({
            ok: false as const,
            tokens: [] as AgentTokenMeta[],
            error:
              e instanceof ApiError && e.status === 401
                ? null
                : t.settingsMvp.agentTokensLoadError,
          }),
        ),
      ]);
      if (cancelled) return;
      const quota =
        ordersResult.ok ? deriveFreeQuotaStatus(ordersResult.orders, Date.now()) : null;
      setState({
        restMe: meResult.ok ? meResult.me : null,
        quota,
        tokens: tokensResult.tokens,
        loading: false,
        accountError: meResult.ok ? null : meResult.error,
        quotaError: ordersResult.ok ? null : ordersResult.error,
        tokenError: tokensResult.error,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [t.settingsMvp.agentTokensLoadError]);

  const resolvedProfile =
    profileFromAuthMe(convexMe) ?? profileFromAuthMe(state.restMe) ?? clerkProfile;
  const resolvedQuota =
    quotaFromAuthMe(convexMe, Date.now(), true) ??
    state.quota ??
    quotaFromAuthMe(state.restMe, Date.now());

  useEffect(() => {
    if (resolvedProfile) {
      setAccountLoadTimedOut(false);
      return;
    }
    const timer = window.setTimeout(
      () => setAccountLoadTimedOut(true),
      ACCOUNT_LOAD_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [resolvedProfile]);

  const profile =
    resolvedProfile ??
    (accountLoadTimedOut
      ? { id: 'authenticated-session', email: 'Signed in' }
      : null);
  const identityLoading =
    !accountLoadTimedOut && (convexMeLoading || !clerkLoaded);
  const accountStillLoading =
    !profile && !accountLoadTimedOut && (state.loading || identityLoading);
  const accountError =
    !accountStillLoading && !profile
      ? state.accountError ?? 'unauthorized'
      : null;

  const saveGeneral = async (): Promise<void> => {
    if (!updateGeneral || savingGeneral) return;
    setSavingGeneral(true);
    setSettingsError(null);
    setSettingsSaved(null);
    try {
      await updateGeneral({
        organization_name: organizationName.trim(),
        url_slug: urlSlug.trim().toLowerCase(),
      });
      setSettingsSaved('General settings saved.');
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : 'Failed to save settings.');
    } finally {
      setSavingGeneral(false);
    }
  };

  const saveSla = async (): Promise<void> => {
    if (!updateSlaThresholds || savingSla) return;
    setSavingSla(true);
    setSettingsError(null);
    setSettingsSaved(null);
    try {
      await updateSlaThresholds({ sla_thresholds: slaThresholds });
      setSettingsSaved('SLA thresholds saved.');
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : 'Failed to save thresholds.');
    } finally {
      setSavingSla(false);
    }
  };

  const saveScore = async (): Promise<void> => {
    if (!updateSecurityScore || savingScore) return;
    setSavingScore(true);
    setSettingsError(null);
    setSettingsSaved(null);
    try {
      await updateSecurityScore({ security_score_min: securityScoreMin });
      setSettingsSaved('Security score threshold saved.');
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : 'Failed to save threshold.');
    } finally {
      setSavingScore(false);
    }
  };

  const createToken = async (): Promise<void> => {
    const name = tokenName.trim();
    if (!name || creatingToken) return;
    setCreatingToken(true);
    setNewToken(null);
    setState((s) => ({ ...s, tokenError: null }));
    try {
      const created = await agentTokens.create({ name });
      setNewToken(created.token);
      setState((s) => ({
        ...s,
        tokens: [created.token_meta, ...s.tokens],
        tokenError: null,
      }));
    } catch {
      setState((s) => ({ ...s, tokenError: t.settingsMvp.agentTokensCreateError }));
    } finally {
      setCreatingToken(false);
    }
  };

  const revokeToken = async (id: string): Promise<void> => {
    setState((s) => ({ ...s, tokenError: null }));
    try {
      const result = await agentTokens.revoke(id);
      if (!result.revoked) throw new Error('not revoked');
      setState((s) => ({
        ...s,
        tokens: s.tokens.map((token) =>
          token.id === id
            ? { ...token, revoked_at: Date.now(), last_used_at: token.last_used_at ?? null }
            : token,
        ),
      }));
    } catch {
      setState((s) => ({ ...s, tokenError: t.settingsMvp.agentTokensRevokeError }));
    }
  };

  return (
    <AppShell
      breadcrumb={[t.navSettings]}
      role="security_lead"
      density="comfortable"
      brand="sthrip"
      language="en"
      showLanguageSwitcher={false}
      surface="hacktron-light"
    >
      <RouteHead title="Settings - Sthrip" />
      <DashboardPage
        title="Profile Settings"
        section="Settings"
        description="Manage account access, repository policy, included usage, and local agent tokens."
        data-screen-label="settings"
      >
        {accountStillLoading && (
          <Card>
            <div style={{ padding: '32px 28px' }} data-testid="settings-loading">
              <Mono size={12} color="var(--fg-3)">
                {t.settingsMvp.loading}
              </Mono>
            </div>
          </Card>
        )}

        {accountError && (
          <Card>
            <div style={{ padding: '32px 28px' }} data-testid="settings-error">
              <Mono size={12} color="var(--red)">
                {t.settingsMvp.loadError}: {accountError}
              </Mono>
            </div>
          </Card>
        )}

        {!accountStillLoading && !accountError && (
          <div style={{ display: 'grid', gap: 18 }}>
            {(settingsError || settingsSaved) && (
              <Card>
                <div style={{ padding: '14px 18px' }}>
                  <Mono
                    size={12}
                    color={settingsError ? 'var(--red)' : 'var(--fg)'}
                  >
                    {settingsError ?? settingsSaved}
                  </Mono>
                </div>
              </Card>
            )}

            {settingsPersistenceMessage && (
              <Card>
                <div style={{ padding: '14px 18px' }}>
                  <Mono size={12} color="var(--fg-3)">
                    {settingsPersistenceMessage}
                  </Mono>
                </div>
              </Card>
            )}

            <Card>
              <section style={{ padding: '24px 28px' }} data-testid="settings-account">
                <Eyebrow style={{ marginBottom: 16 }} color="var(--fg)">
                  Account
                </Eyebrow>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '160px minmax(0, 1fr)',
                    gap: '12px 24px',
                    alignItems: 'baseline',
                  }}
                >
                  <Mono size={11} color="var(--fg-3)">
                    {t.settingsMvp.accountEmail}
                  </Mono>
                  <Mono size={13} color="var(--fg)" data-testid="settings-email">
                    {profile?.email || t.settingsMvp.notSignedIn}
                  </Mono>
                  <Mono size={11} color="var(--fg-3)">
                    {t.settingsMvp.accountUserId}
                  </Mono>
                  <Mono size={11} color="var(--fg-2)" style={{ overflowWrap: 'anywhere' }}>
                    {profile?.id ?? '-'}
                  </Mono>
                </div>
              </section>
            </Card>

            <Card>
              <section style={{ padding: '24px 28px' }}>
                <Eyebrow style={{ marginBottom: 16 }} color="var(--fg-3)">
                  General
                </Eyebrow>
                <label style={{ display: 'grid', gap: 8 }}>
                  <Mono size={13} color="var(--fg)">
                  Profile name
                  </Mono>
                  <Mono size={11} color="var(--fg-3)">
                    The display name for your Sthrip workspace
                  </Mono>
                  <input
                    value={organizationName}
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      setOrganizationName(next);
                      if (urlSlug === slugFrom(organizationName)) setUrlSlug(slugFrom(next));
                    }}
                    style={inputStyle}
                    disabled={!updateGeneral || orgSettingsLoading}
                    data-testid="settings-org-name"
                  />
                </label>
                <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
                  <Btn
                    kind="secondary"
                    size="md"
                    onClick={() => void saveGeneral()}
                    disabled={!updateGeneral || savingGeneral || orgSettingsLoading}
                  >
                    {savingGeneral ? 'Saving...' : 'Save changes'}
                  </Btn>
                </div>
              </section>
            </Card>

            <Card>
              <section style={{ padding: '24px 28px' }}>
                <Eyebrow style={{ marginBottom: 12 }} color="var(--fg-3)">
                  Profile URL
                </Eyebrow>
              <Mono
                size={12}
                color="var(--fg-3)"
                style={{ display: 'block', marginBottom: 16 }}
              >
                  Changing your URL slug will update links for your profile workspace.
                </Mono>
                <label style={{ display: 'grid', gap: 8 }}>
                  <Mono size={13} color="var(--fg)">
                    URL slug
                  </Mono>
                  <input
                    value={urlSlug}
                    onChange={(e) => setUrlSlug(e.currentTarget.value.toLowerCase())}
                    style={inputStyle}
                    disabled={!updateGeneral || orgSettingsLoading}
                    data-testid="settings-url-slug"
                  />
                  <Mono size={11} color="var(--fg-3)">
                    Lowercase letters, numbers, and hyphens (3-50 characters)
                  </Mono>
                </label>
                <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
                  <Btn
                    kind="secondary"
                    size="md"
                    onClick={() => void saveGeneral()}
                    disabled={!updateGeneral || savingGeneral || orgSettingsLoading}
                  >
                    {savingGeneral ? 'Saving...' : 'Update URL'}
                  </Btn>
                </div>
              </section>
            </Card>

            <Card>
              <section style={{ padding: '24px 28px' }}>
                <Eyebrow style={{ marginBottom: 10 }} color="var(--fg-3)">
                  SLA Thresholds
                </Eyebrow>
                <Mono size={12} color="var(--fg-3)" style={{ display: 'block', marginBottom: 18 }}>
                  Set the resolution window and minimum compliance target per severity.
                </Mono>
                <details style={{ marginBottom: 18 }}>
                  <summary
                    style={{
                      cursor: 'pointer',
                      fontWeight: 600,
                      color: 'var(--fg)',
                      fontSize: 13,
                    }}
                  >
                    How is this calculated?
                  </summary>
                  <Mono
                    size={11}
                    color="var(--fg-3)"
                    style={{ display: 'block', marginTop: 10 }}
                  >
                    Resolution health compares closed findings against these per-severity windows.
                  </Mono>
                </details>
                <div style={{ display: 'grid', gap: 12 }}>
                  {[
                    ['Critical', 'critical_days', 'critical_target'],
                    ['High', 'high_days', 'high_target'],
                    ['Medium', 'medium_days', 'medium_target'],
                    ['Low', 'low_days', 'low_target'],
                  ].map(([label, daysKey, targetKey]) => (
                    <div
                      key={label}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(110px, 1fr) 120px 120px',
                        gap: 14,
                        alignItems: 'center',
                      }}
                    >
                      <Mono size={13} color="var(--fg)">
                        {label}
                      </Mono>
                      <input
                        type="number"
                        min={1}
                        max={3650}
                        value={slaThresholds[daysKey as keyof SlaThresholds]}
                        onChange={(e) =>
                          setSlaThresholds((current) => ({
                            ...current,
                            [daysKey]: normalizeNumber(
                              e.currentTarget.value,
                              current[daysKey as keyof SlaThresholds],
                            ),
                          }))
                        }
                        style={inputStyle}
                        aria-label={`${label} SLA days`}
                        disabled={!updateSlaThresholds || orgSettingsLoading}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={slaThresholds[targetKey as keyof SlaThresholds]}
                          onChange={(e) =>
                            setSlaThresholds((current) => ({
                              ...current,
                              [targetKey]: normalizeNumber(
                                e.currentTarget.value,
                                current[targetKey as keyof SlaThresholds],
                              ),
                            }))
                          }
                          style={inputStyle}
                          aria-label={`${label} SLA target`}
                          disabled={!updateSlaThresholds || orgSettingsLoading}
                        />
                        <Mono size={12} color="var(--fg-3)">
                          %
                        </Mono>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
                  <Btn
                    kind="secondary"
                    size="md"
                    onClick={() => void saveSla()}
                    disabled={!updateSlaThresholds || savingSla || orgSettingsLoading}
                  >
                    {savingSla ? 'Saving...' : 'Save thresholds'}
                  </Btn>
                </div>
              </section>
            </Card>

            <Card>
              <section style={{ padding: '24px 28px' }}>
                <Eyebrow style={{ marginBottom: 10 }} color="var(--fg-3)">
                  Security Score Threshold
                </Eyebrow>
                <Mono
                  size={12}
                  color="var(--fg-3)"
                  style={{ display: 'block', marginBottom: 18 }}
                >
                  Set the minimum acceptable score for PR review and whitebox dashboards.
                </Mono>
                <label
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(160px, 1fr) 140px',
                    gap: 16,
                    alignItems: 'center',
                  }}
                >
                  <Mono size={13} color="var(--fg)">
                    Minimum score
                  </Mono>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={securityScoreMin}
                      onChange={(e) =>
                        setSecurityScoreMin(normalizeNumber(e.currentTarget.value, 70))
                      }
                      style={inputStyle}
                      data-testid="settings-security-score"
                      disabled={!updateSecurityScore || orgSettingsLoading}
                    />
                    <Mono size={12} color="var(--fg-3)">
                      /100
                    </Mono>
                  </div>
                </label>
                <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
                  <Btn
                    kind="secondary"
                    size="md"
                    onClick={() => void saveScore()}
                    disabled={!updateSecurityScore || savingScore || orgSettingsLoading}
                  >
                    {savingScore ? 'Saving...' : 'Save threshold'}
                  </Btn>
                </div>
              </section>
            </Card>

            <Card>
              <section style={{ padding: '24px 28px' }} data-testid="settings-quota">
                <Eyebrow style={{ marginBottom: 12 }} color="var(--fg)">
                  {t.settingsMvp.quotaTitle}
                </Eyebrow>
                {resolvedQuota ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {resolvedQuota.state === 'available' ? (
                      <StatusChip status={t.settingsMvp.quotaAvailable} tone="ok" size="md" />
                    ) : (
                      <StatusChip
                        status={t.settingsMvp.quotaUsed.replace(
                          '{days}',
                          String(resolvedQuota.daysUntilReset ?? 0),
                        )}
                        tone="warn"
                        size="md"
                      />
                    )}
                  </div>
                ) : (
                  <Mono size={12} color="var(--fg-3)">
                    {state.loading ? t.settingsMvp.loading : 'Usage data unavailable.'}
                  </Mono>
                )}
                {!resolvedQuota && state.quotaError && (
                  <Mono size={11} color="var(--red)" style={{ display: 'block', marginTop: 10 }}>
                    Usage: {state.quotaError}
                  </Mono>
                )}
                <Mono size={11} color="var(--fg-3)" style={{ marginTop: 10, display: 'block' }}>
                  {t.settingsMvp.quotaHelp}
                </Mono>
              </section>
            </Card>

            <Card>
              <section style={{ padding: '24px 28px' }} data-testid="settings-agent-tokens">
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ flex: 1 }}>
                    <Eyebrow style={{ marginBottom: 12 }} color="var(--fg-3)">
                      API Keys
                    </Eyebrow>
                    <Mono
                      size={12}
                      color="var(--fg-3)"
                      style={{ display: 'block', maxWidth: '70ch' }}
                    >
                      Manage API keys for programmatic access to the Sthrip API.
                    </Mono>
                  </div>
                  <Btn
                    kind="secondary"
                    size="sm"
                    onClick={() => void createToken()}
                    disabled={creatingToken || tokenName.trim().length === 0}
                  >
                    {creatingToken ? t.settingsMvp.agentTokensCreating : '+ Create key'}
                  </Btn>
                </div>

                <label
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(180px, 360px)',
                    gap: 6,
                    marginTop: 16,
                  }}
                >
                  <Mono size={10.5} color="var(--fg-3)">
                    {t.settingsMvp.agentTokensName}
                  </Mono>
                  <input
                    value={tokenName}
                    onChange={(e) => setTokenName(e.currentTarget.value)}
                    style={inputStyle}
                  />
                </label>

                {newToken && (
                  <div
                    style={{
                      padding: 14,
                      background: 'var(--bg-2)',
                      border: '1px solid var(--line-soft)',
                      marginTop: 16,
                    }}
                  >
                    <Mono size={10.5} color="var(--fg-3)" style={{ display: 'block' }}>
                      {t.settingsMvp.agentTokensPlaintextLabel}
                    </Mono>
                    <Mono
                      size={12}
                      color="var(--fg)"
                      style={{
                        display: 'block',
                        marginTop: 8,
                        overflowWrap: 'anywhere',
                        userSelect: 'all',
                      }}
                      data-testid="settings-new-agent-token"
                    >
                      {newToken}
                    </Mono>
                    <Mono
                      size={10.5}
                      color="var(--fg-3)"
                      style={{ display: 'block', marginTop: 8 }}
                    >
                      {t.settingsMvp.agentTokensPlaintextHelp}
                    </Mono>
                  </div>
                )}

                {state.tokenError && (
                  <Mono size={11} color="var(--red)" style={{ display: 'block', marginTop: 12 }}>
                    {state.tokenError}
                  </Mono>
                )}

                {state.tokens.length === 0 ? (
                  <Mono
                    size={12}
                    color="var(--fg-3)"
                    style={{ display: 'block', marginTop: 32, textAlign: 'center' }}
                  >
                    {t.settingsMvp.agentTokensEmpty}
                  </Mono>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 18 }}>
                    {state.tokens.map((token) => (
                      <div
                        key={token.id}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) auto auto',
                          gap: 12,
                          alignItems: 'center',
                          padding: '10px 0',
                          borderTop: '1px solid var(--line-soft)',
                        }}
                      >
                        <div>
                          <Mono size={12} color="var(--fg)" style={{ display: 'block' }}>
                            {token.name}
                          </Mono>
                          <Mono size={10.5} color="var(--fg-3)">
                            {token.token_prefix}
                          </Mono>
                        </div>
                        <StatusChip
                          status={token.revoked_at ? 'revoked' : 'active'}
                          tone={token.revoked_at ? 'muted' : 'ok'}
                          size="sm"
                        />
                        <Btn
                          kind="dim"
                          size="sm"
                          onClick={() => void revokeToken(token.id)}
                          disabled={token.revoked_at != null}
                        >
                          {t.settingsMvp.agentTokensRevoke}
                        </Btn>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </Card>
          </div>
        )}
      </DashboardPage>
    </AppShell>
  );
}
