// T118 — Tensol Blackbox MVP Settings.
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
import { TENSOL_I18N } from '../i18n.ts';
import {
  ApiError,
  auth,
  scanOrders,
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
  readonly loading: boolean;
  readonly error: string | null;
}

const INITIAL_STATE: SettingsState = {
  me: null,
  quota: null,
  loading: true,
  error: null,
};

export default function Settings(): ReactElement {
  const t = TENSOL_I18N.en;
  const [state, setState] = useState<SettingsState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Fire both in parallel — both are cookie-auth, both cheap.
        const [me, orders] = await Promise.all([
          auth.me(),
          scanOrders.list().catch((e: unknown) => {
            // List can 401 for anon — fall back to empty so we still
            // render account info. Re-throw on non-auth errors.
            if (e instanceof ApiError && e.status === 401)
              return [] as readonly ScanOrder[];
            throw e;
          }),
        ]);
        if (cancelled) return;
        const quota = deriveFreeQuotaStatus(orders, Date.now());
        setState({ me, quota, loading: false, error: null });
      } catch (e: unknown) {
        if (cancelled) return;
        const code = e instanceof ApiError ? e.code : 'network_error';
        setState({ me: null, quota: null, loading: false, error: code });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell
      breadcrumb={[t.navSettings]}
      role="security_lead"
      density="comfortable"
      brand="sthrip"
      language="en"
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
                  href="mailto:hi@tensol.ai"
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
