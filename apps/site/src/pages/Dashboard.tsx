// T117 — Tensol Blackbox MVP Dashboard.
//
// "Your scans" table for the Quick-flow user. Replaces the legacy fixture
// dashboard (active assessments / approvals / findings) which depended on
// TENSOL_DATA mock and pointed at deleted routes (/builder, /approval).
//
// Layout:
//   1. Header  — title + free-quota status badge (FR-015)
//   2. Deep banner card (KEPT from T110) — US2 lead-gen
//   3. Your scans table — Status | Domain | Tier | Date | Action
//   4. Floating "+ New Scan" CTA → /scan/new (T083 canonical)
//
// Polling: the dashboard does a one-shot fetch on mount + a manual "refresh"
// affordance. Live status for an individual scan lives in /scan/:id (Live.tsx)
// which polls every 3s per Constitution V. The list view is intentionally
// static to avoid hammering the server with cross-user list queries.
//
// Free-quota source (FR-015): derived purely from `scanOrders.list()` via
// `deriveFreeQuotaStatus` — see dashboard-helpers.ts. The `/v1/auth/me`
// endpoint currently returns only `{user:{id,email}}`, so we cannot rely
// on a `free_quick_consumed_at` field from there yet.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Eyebrow, Mono, StatusChip } from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';
import { ApiError, scanOrders, type ScanOrder } from '../lib/api-client.ts';
import {
  deriveFreeQuotaStatus,
  formatRelativeTime,
  mapStatusToAction,
  mapStatusToBadge,
  sortOrdersNewestFirst,
  type ActionMapping,
  type BadgeMapping,
  type FreeQuotaStatus,
} from './dashboard-helpers.ts';

// ─── Action button → final href resolver ──────────────────────────────────

function actionHref(order: ScanOrder, action: ActionMapping): string {
  switch (action.route) {
    case 'wizard-step':
      // Draft orders re-enter the wizard at Step 1 (Attack Surface).
      // Step 4 launch is the wizard's terminal step; resuming a saved
      // draft starts at surface so the user can review before continuing.
      return `/scan/new/${encodeURIComponent(order.id)}/surface`;
    case 'live':
      // If the order has a scan_id, prefer it; otherwise route by order id
      // (Live container resolves either). Pre-scan orders still get a
      // useful page even before the VM is provisioned.
      return order.scan_id
        ? `/scan/${encodeURIComponent(order.scan_id)}`
        : `/scan/${encodeURIComponent(order.id)}`;
    case 'report':
      return order.scan_id
        ? `/scan/${encodeURIComponent(order.scan_id)}/report`
        : `/scan/${encodeURIComponent(order.id)}/report`;
  }
}

// ─── Quota badge ───────────────────────────────────────────────────────────

interface QuotaBadgeProps {
  readonly quota: FreeQuotaStatus;
}

function QuotaBadge({ quota }: QuotaBadgeProps): ReactElement {
  const { t } = useTensol();
  if (quota.state === 'available') {
    return <StatusChip status={t.dashboard.quotaAvailable} tone="ok" size="md" />;
  }
  const days = quota.daysUntilReset ?? 0;
  const label = t.dashboard.quotaUsed.replace('{days}', String(days));
  return <StatusChip status={label} tone="warn" size="md" />;
}

// ─── Table row ────────────────────────────────────────────────────────────

interface ScanRowProps {
  readonly order: ScanOrder;
  readonly nowMs: number;
}

function ScanRow({ order, nowMs }: ScanRowProps): ReactElement {
  const { t } = useTensol();
  const badge: BadgeMapping = mapStatusToBadge(order.status);
  const action: ActionMapping = mapStatusToAction(order.status);
  const updatedAt = order.updated_at ?? order.created_at;
  const actionLabel = t.dashboard.actions[action.key];
  const statusLabel = t.dashboard.status[badge.key];
  const tierLabel =
    order.tier === 'quick' ? t.dashboard.tierQuick : t.dashboard.tierDeep;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '140px 1fr 80px 110px 140px',
        gap: 16,
        alignItems: 'center',
        padding: '14px 16px',
        borderBottom: '1px solid var(--line-soft)',
      }}
    >
      <StatusChip status={statusLabel} tone={badge.tone} size="sm" />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 14,
            color: 'var(--fg)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={order.primary_domain}
        >
          {order.primary_domain}
        </div>
        <Mono size={10.5} color="var(--fg-3)" style={{ marginTop: 4, display: 'block' }}>
          {order.id}
        </Mono>
      </div>
      <Mono
        size={11}
        color="var(--fg-2)"
        style={{ letterSpacing: '0.04em', textTransform: 'uppercase' }}
      >
        {tierLabel}
      </Mono>
      <Mono
        size={11}
        color="var(--fg-3)"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {formatRelativeTime(updatedAt, nowMs)}
      </Mono>
      <div style={{ justifySelf: 'end' }}>
        <Link to={actionHref(order, action)} style={{ textDecoration: 'none' }}>
          <Btn kind="dim" size="sm">
            {actionLabel} →
          </Btn>
        </Link>
      </div>
    </div>
  );
}

// ─── Empty / loading / error states ───────────────────────────────────────

function EmptyState(): ReactElement {
  const { t } = useTensol();
  return (
    <div
      style={{
        padding: '48px 16px',
        textAlign: 'center',
        border: '1px dashed var(--line-soft)',
      }}
    >
      <Mono size={12} color="var(--fg-3)">
        {t.dashboard.tableEmpty}
      </Mono>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────

const Dashboard = (): ReactElement => {
  const { t } = useTensol();

  const [orders, setOrders] = useState<readonly ScanOrder[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // `nowMs` is captured once per fetch so relative-time labels are stable
  // across re-renders triggered by hover/focus inside the table.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await scanOrders.list();
      setOrders(list);
      setNowMs(Date.now());
    } catch (e: unknown) {
      const code = e instanceof ApiError ? e.code : 'network_error';
      setError(code);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(() => sortOrdersNewestFirst(orders), [orders]);
  const quota = useMemo(() => deriveFreeQuotaStatus(orders, nowMs), [orders, nowMs]);

  return (
    <AppShell breadcrumb={[t.navDashboard]} role="security_lead" density="comfortable">
      <RouteHead title="Dashboard — Tensol" />
      <div data-screen-label="T117 — your scans dashboard" style={{ position: 'relative' }}>
        {/* ── Header ─────────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 28,
            flexWrap: 'wrap',
            gap: 16,
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
            {t.dashboard.title}
          </h1>
          <div
            data-testid="dashboard-quota"
            style={{ display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <Eyebrow color="var(--fg-3)">{t.dashboard.quotaLabel}</Eyebrow>
            <QuotaBadge quota={quota} />
          </div>
        </div>

        {/* ── Deep banner (T110, KEPT) ───────────────────────────── */}
        <div
          data-testid="dashboard-deep-banner"
          style={{
            border: '1px solid var(--fg)',
            padding: '20px 24px',
            marginBottom: 36,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 24,
            flexWrap: 'wrap',
            background: 'var(--bg)',
          }}
        >
          <div style={{ minWidth: 0, flex: '1 1 380px' }}>
            <Mono
              size={11}
              color="var(--fg-3)"
              style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
            >
              // DEEP AUDIT
            </Mono>
            <div
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 500,
                fontSize: 22,
                lineHeight: 1.15,
                letterSpacing: '-0.01em',
                margin: '8px 0 6px',
              }}
            >
              {t.dashboard.deepBanner.title}
            </div>
            <p
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: 13.5,
                lineHeight: 1.5,
                color: 'var(--fg-2)',
                margin: 0,
                maxWidth: '60ch',
              }}
            >
              {t.dashboard.deepBanner.body}
            </p>
          </div>
          <Link to="/deep-inquiry" style={{ textDecoration: 'none' }}>
            <Btn kind="secondary">{t.dashboard.deepBanner.cta} →</Btn>
          </Link>
        </div>

        {/* ── Your scans table ──────────────────────────────────── */}
        <section data-testid="dashboard-scans-table">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 12,
              paddingBottom: 8,
              borderBottom: '1px solid var(--fg)',
            }}
          >
            <Eyebrow color="var(--fg)">{t.dashboard.tableTitle}</Eyebrow>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: loading ? 'wait' : 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: 'var(--fg-3)',
                letterSpacing: '0.04em',
                padding: 0,
                textTransform: 'uppercase',
              }}
            >
              {loading ? t.dashboard.refreshing : t.dashboard.refresh} ↻
            </button>
          </div>

          {/* Column headers */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr 80px 110px 140px',
              gap: 16,
              padding: '8px 16px',
              borderBottom: '1px solid var(--line-soft)',
            }}
          >
            {(
              [
                t.dashboard.columns.status,
                t.dashboard.columns.domain,
                t.dashboard.columns.tier,
                t.dashboard.columns.date,
                t.dashboard.columns.action,
              ] as const
            ).map((label, i) => (
              <Mono
                key={label + i}
                size={10.5}
                color="var(--fg-3)"
                style={{
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  textAlign: i === 4 ? 'right' : 'left',
                }}
              >
                {label}
              </Mono>
            ))}
          </div>

          {loading && sorted.length === 0 && (
            <div style={{ padding: '32px 16px' }}>
              <Mono size={12} color="var(--fg-3)">
                {t.dashboard.loading}
              </Mono>
            </div>
          )}

          {!loading && error && (
            <div style={{ padding: '32px 16px' }}>
              <Mono size={12} color="var(--red)">
                {t.dashboard.loadError}: {error}
              </Mono>
            </div>
          )}

          {!loading && !error && sorted.length === 0 && <EmptyState />}

          {sorted.map((o) => (
            <ScanRow key={o.id} order={o} nowMs={nowMs} />
          ))}
        </section>

        {/* ── Floating "+ New Scan" CTA ─────────────────────────── */}
        <div
          style={{
            position: 'fixed',
            right: 28,
            bottom: 28,
            zIndex: 50,
          }}
          data-testid="dashboard-new-scan-cta"
        >
          <Link to="/scan/new" style={{ textDecoration: 'none' }}>
            <Btn kind="primary" size="lg">
              + {t.dashboard.newScan}
            </Btn>
          </Link>
        </div>
      </div>
    </AppShell>
  );
};

export default Dashboard;
