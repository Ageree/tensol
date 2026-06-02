// T118 — Sthrip Blackbox MVP Settings.
//
// MVP scope (US3): show only what the user has actual control over today.
//   1. Account info — email from GET /v1/auth/me (cookie session).
//   2. Free-quota status — derived from scanOrders.list() via the same
//      helper the Dashboard uses (`deriveFreeQuotaStatus`). FR-015.
//   3. Placeholder copy — explicit "no other settings in MVP" so the
//      user knows tenant/notifications/tokens are intentionally absent.
//
// Replaces the v2 design-bundle screen (profile/tenant/notifications tabs)
// which was scaffolded against TENSOL_DATA mock and assumed multi-tenant
// SaaS shape. Backend exposes none of that surface yet.

import { useEffect, useState, type ReactElement } from 'react';
import { AppShell } from '../components/AppShell';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Card, Eyebrow, Mono, StatusChip } from '../components/primitives';
import { useTensol } from '../context.tsx';
import {
  ApiError,
  agentTokens,
  auth,
  scanOrders,
  type AgentTokenMeta,
  type AuthMe,
  type ScanOrder,
} from '../lib/api-client.ts';
import {
  deriveFreeQuotaStatus,
  type FreeQuotaStatus,
} from './dashboard-helpers.ts';

interface SettingsState {
  readonly me: AuthMe | null;
  readonly quota: FreeQuotaStatus | null;
  readonly tokens: AgentTokenMeta[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly tokenError: string | null;
}

const INITIAL_STATE: SettingsState = {
  me: null,
  quota: null,
  tokens: [],
  loading: true,
  error: null,
  tokenError: null,
};

export default function Settings(): ReactElement {
  const { lang, t } = useTensol();
  const [state, setState] = useState<SettingsState>(INITIAL_STATE);
  const [tokenName, setTokenName] = useState<string>('Codex MCP');
  const [creatingToken, setCreatingToken] = useState<boolean>(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Fire both in parallel — both are cookie-auth, both cheap.
        const [me, orders, tokensResult] = await Promise.all([
          auth.me(),
          scanOrders.list().catch((e: unknown) => {
            // List can 401 for anon — fall back to empty so we still
            // render account info. Re-throw on non-auth errors.
            if (e instanceof ApiError && e.status === 401)
              return [] as readonly ScanOrder[];
            throw e;
          }),
          agentTokens
            .list()
            .then((result) => ({ tokens: result.tokens, error: null as string | null }))
            .catch((e: unknown) => {
              if (e instanceof ApiError && e.status === 401) {
                return { tokens: [] as AgentTokenMeta[], error: null };
              }
              return {
                tokens: [] as AgentTokenMeta[],
                error: t.settingsMvp.agentTokensLoadError,
              };
            }),
        ]);
        if (cancelled) return;
        const quota = deriveFreeQuotaStatus(orders, Date.now());
        setState({
          me,
          quota,
          tokens: tokensResult.tokens,
          loading: false,
          error: null,
          tokenError: tokensResult.error,
        });
      } catch (e: unknown) {
        if (cancelled) return;
        const code = e instanceof ApiError ? e.code : 'network_error';
        setState({
          me: null,
          quota: null,
          tokens: [],
          loading: false,
          error: code,
          tokenError: null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      language={lang}
      showLanguageSwitcher={false}
      surface="white-mono"
    >
      <RouteHead title="Settings — Sthrip" />
      <div data-screen-label="T118 — settings (mvp)">
        <div style={{ marginBottom: 32 }}>
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
            {t.sTitle}
          </h1>
        </div>

        {state.loading && (
          <Card>
            <div style={{ padding: '32px 28px' }} data-testid="settings-loading">
              <Mono size={12} color="var(--fg-3)">
                {t.settingsMvp.loading}
              </Mono>
            </div>
          </Card>
        )}

        {!state.loading && state.error && (
          <Card>
            <div style={{ padding: '32px 28px' }} data-testid="settings-error">
              <Mono size={12} color="var(--red)">
                {t.settingsMvp.loadError}: {state.error}
              </Mono>
            </div>
          </Card>
        )}

        {!state.loading && !state.error && (
          <Card>
            {/* ── Account ─────────────────────────────────────────── */}
            <section
              data-testid="settings-account"
              style={{
                padding: '24px 28px',
                borderBottom: '1px solid var(--line-soft)',
              }}
            >
              <Eyebrow style={{ marginBottom: 12 }} color="var(--fg)">
                {t.settingsMvp.accountTitle}
              </Eyebrow>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 1fr',
                  gap: '12px 24px',
                  alignItems: 'baseline',
                }}
              >
                <Mono size={11} color="var(--fg-3)">
                  {t.settingsMvp.accountEmail}
                </Mono>
                <Mono size={13} color="var(--fg)" data-testid="settings-email">
                  {state.me?.email ?? t.settingsMvp.notSignedIn}
                </Mono>
                <Mono size={11} color="var(--fg-3)">
                  {t.settingsMvp.accountUserId}
                </Mono>
                <Mono size={11} color="var(--fg-2)">
                  {state.me?.id ?? '—'}
                </Mono>
              </div>
            </section>

            {/* ── Free quota ──────────────────────────────────────── */}
            <section
              data-testid="settings-quota"
              style={{
                padding: '24px 28px',
                borderBottom: '1px solid var(--line-soft)',
              }}
            >
              <Eyebrow style={{ marginBottom: 12 }} color="var(--fg)">
                {t.settingsMvp.quotaTitle}
              </Eyebrow>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {state.quota?.state === 'available' ? (
                  <StatusChip
                    status={t.settingsMvp.quotaAvailable}
                    tone="ok"
                    size="md"
                  />
                ) : (
                  <StatusChip
                    status={t.settingsMvp.quotaUsed.replace(
                      '{days}',
                      String(state.quota?.daysUntilReset ?? 0),
                    )}
                    tone="warn"
                    size="md"
                  />
                )}
              </div>
              <Mono
                size={11}
                color="var(--fg-3)"
                style={{ marginTop: 10, display: 'block' }}
              >
                {t.settingsMvp.quotaHelp}
              </Mono>
            </section>

            {/* ── Agent API tokens ───────────────────────────────── */}
            <section
              data-testid="settings-agent-tokens"
              style={{
                padding: '24px 28px',
                borderBottom: '1px solid var(--line-soft)',
              }}
            >
              <Eyebrow style={{ marginBottom: 12 }} color="var(--fg)">
                {t.settingsMvp.agentTokensTitle}
              </Eyebrow>
              <Mono
                size={11}
                color="var(--fg-3)"
                style={{ display: 'block', maxWidth: '70ch', marginBottom: 16 }}
              >
                {t.settingsMvp.agentTokensHelp}
              </Mono>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 10,
                  alignItems: 'center',
                  maxWidth: 520,
                  marginBottom: 16,
                }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Mono size={10.5} color="var(--fg-3)">
                    {t.settingsMvp.agentTokensName}
                  </Mono>
                  <input
                    value={tokenName}
                    onChange={(e) => setTokenName(e.currentTarget.value)}
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
                </label>
                <Btn
                  kind="secondary"
                  size="sm"
                  onClick={() => void createToken()}
                  disabled={creatingToken || tokenName.trim().length === 0}
                >
                  {creatingToken
                    ? t.settingsMvp.agentTokensCreating
                    : t.settingsMvp.agentTokensCreate}
                </Btn>
              </div>

              {newToken && (
                <div
                  style={{
                    padding: 14,
                    background: 'var(--bg-2)',
                    border: '1px solid var(--line-soft)',
                    marginBottom: 16,
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
                  <Mono size={10.5} color="var(--fg-3)" style={{ display: 'block', marginTop: 8 }}>
                    {t.settingsMvp.agentTokensPlaintextHelp}
                  </Mono>
                </div>
              )}

              {state.tokenError && (
                <Mono size={11} color="var(--red)" style={{ display: 'block', marginBottom: 12 }}>
                  {state.tokenError}
                </Mono>
              )}

              {state.tokens.length === 0 ? (
                <Mono size={11} color="var(--fg-3)">
                  {t.settingsMvp.agentTokensEmpty}
                </Mono>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
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

            {/* ── MVP placeholder ─────────────────────────────────── */}
            <section
              data-testid="settings-placeholder"
              style={{ padding: '24px 28px' }}
            >
              <Eyebrow style={{ marginBottom: 10 }} color="var(--fg-3)">
                {t.settingsMvp.mvpTitle}
              </Eyebrow>
              <Mono
                size={12}
                color="var(--fg-2)"
                style={{ display: 'block', maxWidth: '64ch' }}
              >
                {t.settingsMvp.mvpBody}
              </Mono>
              <div style={{ marginTop: 14 }}>
                <a
                  href="mailto:hello@sthrip.dev"
                  style={{ textDecoration: 'none' }}
                >
                  <Btn kind="dim" size="sm">
                    {t.settingsMvp.contactCta} →
                  </Btn>
                </a>
              </div>
            </section>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
