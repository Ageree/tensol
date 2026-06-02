// T018 — ConnectGitHub page.
//
// URL: /connect-github (wired via App.tsx by T021)
//
// Sections:
//   1. Page header with title + subtitle.
//   2. Connection status panel — reads GET /v1/github/installations on mount.
//      - Not connected: shows "Install Sthrip GitHub App" CTA.
//      - Connected: lists accounts with type + repo-selection + status chip.
//   3. "Install Sthrip GitHub App" button calls GET /v1/github/connect
//      then redirects window.location to install_url.
//   4. "Remove" button per installation calls POST /v1/github/disconnect.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AppShell } from '../components/AppShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Card, Eyebrow, Mono, StatusChip } from '../components/primitives.tsx';
import { TENSOL_I18N } from '../i18n.ts';
import {
  ApiError,
  github,
  type Installation,
  type InstallationsResponse,
} from '../lib/api-client.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PageState {
  readonly installations: InstallationsResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
}

type ConnectingState = 'idle' | 'connecting' | 'error';

const INITIAL_STATE: PageState = {
  installations: null,
  loading: true,
  error: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function installationStatusTone(
  status: Installation['status'],
): 'ok' | 'warn' | 'muted' {
  if (status === 'active') return 'ok';
  if (status === 'suspended') return 'warn';
  return 'muted';
}

// ─── InstallationRow ──────────────────────────────────────────────────────────

interface InstallationRowProps {
  installation: Installation;
  t: typeof TENSOL_I18N.en.connect;
  onDisconnect: (id: string) => void;
  disconnectingId: string | null;
  disconnectError: string | null;
}

function InstallationRow({
  installation,
  t,
  onDisconnect,
  disconnectingId,
  disconnectError,
}: InstallationRowProps): ReactElement {
  const isDisconnecting = disconnectingId === installation.id;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto auto auto',
        alignItems: 'center',
        gap: 16,
        padding: '14px 16px',
        background: 'var(--bg)',
        border: '1px solid var(--line-soft)',
      }}
      data-testid={`installation-row-${installation.id}`}
    >
      {/* Account login + type */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Mono size={13} color="var(--fg)" style={{ fontWeight: 500 }}>
          {installation.account_login}
        </Mono>
        <Mono size={10.5} color="var(--fg-3)" style={{ letterSpacing: '0.06em' }}>
          {t.accountType}: {installation.account_type.toLowerCase()}
          {' · '}
          {t.accountRepoSelection}:{' '}
          {installation.repository_selection === 'all'
            ? t.repoSelectionAll
            : t.repoSelectionSelected}
        </Mono>
        {isDisconnecting && disconnectError && (
          <Mono size={11} color="var(--red)" style={{ marginTop: 2 }}>
            {t.disconnectError}
          </Mono>
        )}
      </div>

      {/* Status chip */}
      <StatusChip
        status={
          installation.status === 'active'
            ? t.statusConnected
            : installation.status === 'suspended'
              ? t.statusSuspended
              : t.statusDeleted
        }
        tone={installationStatusTone(installation.status)}
        size="sm"
      />

      {/* Disconnect button */}
      <Btn
        kind="dim"
        size="sm"
        disabled={isDisconnecting || installation.status === 'deleted'}
        onClick={() => {
          if (window.confirm(t.disconnectConfirm)) {
            onDisconnect(installation.id);
          }
        }}
      >
        {isDisconnecting ? t.disconnecting : t.disconnectBtn}
      </Btn>
    </div>
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function ConnectGitHub(): ReactElement {
  const t = TENSOL_I18N.en.connect;

  const [state, setState] = useState<PageState>(INITIAL_STATE);
  const [connectingState, setConnectingState] = useState<ConnectingState>('idle');
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  // Load installations on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await github.installations();
        if (cancelled) return;
        setState({ installations: data, loading: false, error: null });
      } catch (e: unknown) {
        if (cancelled) return;
        const code = e instanceof ApiError ? e.code : 'network_error';
        setState({ installations: null, loading: false, error: code });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Connect: call GET /v1/github/connect → redirect to install_url.
  const handleConnect = useCallback((): void => {
    setConnectingState('connecting');
    void (async () => {
      try {
        const result = await github.connect();
        // Hard-redirect the browser to the GitHub App installation URL.
        window.location.href = result.install_url;
      } catch {
        setConnectingState('error');
      }
    })();
  }, []);

  // Disconnect: call POST /v1/github/disconnect for the given installation.
  const handleDisconnect = useCallback(
    (installationId: string): void => {
      setDisconnectingId(installationId);
      setDisconnectError(null);
      void (async () => {
        try {
          await github.disconnect(installationId);
          // Refresh installations after disconnect.
          const data = await github.installations();
          setState({ installations: data, loading: false, error: null });
        } catch {
          setDisconnectError(installationId);
        } finally {
          setDisconnectingId(null);
        }
      })();
    },
    [],
  );

  const installations = state.installations?.installations ?? [];
  const isConnected = state.installations?.connected === true;

  return (
    <AppShell
      breadcrumb={['Connect GitHub']}
      role="security_lead"
      density="comfortable"
      brand="sthrip"
      language="en"
      showLanguageSwitcher={false}
      surface="white-mono"
    >
      <RouteHead title={t.pageTitle} />
      <div data-screen-label="T018 — connect-github">
        {/* ── Page header ─────────────────────────────────────────────── */}
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
        <Mono
          size={13}
          color="var(--fg-3)"
          style={{ display: 'block', marginBottom: 36 }}
        >
          {t.subtitle}
        </Mono>

        {/* ── Connection status card ───────────────────────────────────── */}
        <Card>
          {/* Status section */}
          <section
            data-testid="connect-status-section"
            style={{
              padding: '24px 28px',
              borderBottom: '1px solid var(--line-soft)',
            }}
          >
            <Eyebrow style={{ marginBottom: 14 }} color="var(--fg)">
              {t.statusTitle}
            </Eyebrow>

            {state.loading && (
              <Mono size={12} color="var(--fg-3)" data-testid="connect-loading">
                {t.statusLoading}
              </Mono>
            )}

            {!state.loading && state.error && (
              <Mono size={12} color="var(--red)" data-testid="connect-load-error">
                {t.statusLoadError}: {state.error}
              </Mono>
            )}

            {!state.loading && !state.error && (
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 16 }}
                data-testid="connect-status"
              >
                <StatusChip
                  status={isConnected ? t.statusConnected : t.statusNotConnected}
                  tone={isConnected ? 'ok' : 'muted'}
                  size="md"
                />

                {!isConnected && (
                  <div style={{ marginTop: 0 }}>
                    <Btn
                      kind="primary"
                      size="md"
                      disabled={connectingState === 'connecting'}
                      onClick={handleConnect}
                      data-testid="connect-btn"
                    >
                      {connectingState === 'connecting' ? t.connecting : t.connectBtn}
                    </Btn>
                    {connectingState === 'error' && (
                      <Mono
                        size={11}
                        color="var(--red)"
                        style={{ marginTop: 8, display: 'block' }}
                        data-testid="connect-error"
                      >
                        {t.connectError}
                      </Mono>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Accounts section */}
          {!state.loading && !state.error && (
            <section
              data-testid="connect-accounts-section"
              style={{ padding: '24px 28px' }}
            >
              <Eyebrow style={{ marginBottom: 14 }} color="var(--fg)">
                {t.accountsTitle}
              </Eyebrow>

              {installations.length === 0 ? (
                <div
                  style={{
                    padding: '20px 24px',
                    border: '1px solid var(--line-soft)',
                    background: 'var(--bg-2)',
                  }}
                  data-testid="connect-no-accounts"
                >
                  <Mono size={12} color="var(--fg-3)">
                    {t.noAccounts}
                  </Mono>
                </div>
              ) : (
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 1 }}
                  data-testid="connect-accounts-list"
                >
                  {installations.map((installation) => (
                    <InstallationRow
                      key={installation.id}
                      installation={installation}
                      t={t}
                      onDisconnect={handleDisconnect}
                      disconnectingId={disconnectingId}
                      disconnectError={disconnectError}
                    />
                  ))}
                </div>
              )}

              {/* CTA to add another installation when already connected */}
              {isConnected && (
                <div style={{ marginTop: 20 }}>
                  <Btn
                    kind="secondary"
                    size="sm"
                    disabled={connectingState === 'connecting'}
                    onClick={handleConnect}
                  >
                    {connectingState === 'connecting' ? t.connecting : t.connectBtn}
                  </Btn>
                </div>
              )}
            </section>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
