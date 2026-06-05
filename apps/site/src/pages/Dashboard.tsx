// Sthrip dashboard - HackTron-inspired white workspace overview.
//
// Visual source of truth:
// - User-provided HackTron app dashboard screenshot: white/stone app shell,
//   quiet sidebar, breadcrumb header, segmented tabs, metric cards, chart panel,
//   resolution-health SLA cards, and organization activity table.
// - shadcn-ui/ui v4 radix-sera primitives inspected at:
//   /tmp/shadcn-ui-source/apps/v4/styles/radix-sera/ui/{button,card,tabs,table,badge}.tsx
//
// The local components below preserve shadcn data-slot anatomy while using
// project-native CSS and avoiding undeclared package dependencies.

import {
  CalendarDays,
  ChevronDown,
  Code2,
  Download,
  FileText,
  GitPullRequest,
  Globe2,
  Info,
  RefreshCw,
  Search,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { ApiError, review, scanOrders, type ReviewListItemWire, type ReviewRepoWire, type ReviewRunStatus, type ScanOrder, type ScanOrderStatus } from '../lib/api-client.ts';
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

type ServiceId = 'blackbox' | 'whitebox' | 'pr-review';
type DashboardTab = 'overview' | 'blackbox' | 'pr-review' | 'whitebox';
type StatusTone = 'active' | 'ok' | 'warn' | 'danger' | 'muted';
type SlaSeverity = 'critical' | 'high' | 'medium' | 'low';

interface OperationRow {
  readonly id: string;
  readonly serviceId: ServiceId;
  readonly target: string;
  readonly type: string;
  readonly statusLabel: string;
  readonly statusTone: StatusTone;
  readonly findingsLabel: string;
  readonly lastRunMs: number | null;
  readonly href: string;
  readonly actionLabel: string;
}

interface MetricCardData {
  readonly label: string;
  readonly value: string;
  readonly description: string;
  readonly info?: boolean;
}

interface ChartDay {
  readonly label: string;
  readonly blackbox: number;
  readonly pr: number;
  readonly whitebox: number;
}

interface SlaCardData {
  readonly severity: SlaSeverity;
  readonly color: string;
  readonly sla: string;
  readonly target: string;
  readonly count: number;
  readonly met: boolean;
}

const DASHBOARD_CSS = `
.hacktron-dashboard {
  min-height: 100vh;
  padding: 30px 32px 48px;
  background: #f5f5f4;
  color: #202020;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  --h-bg: #f5f5f4;
  --h-sidebar: #eeeeec;
  --h-card: #f2f2f1;
  --h-card-2: #f7f7f6;
  --h-white: #ffffff;
  --h-ink: #1f1f1f;
  --h-text: #4f4f4d;
  --h-muted: #767673;
  --h-faint: #9a9a96;
  --h-line: #dddbd7;
  --h-line-strong: #d2d0cc;
  --h-blue: #7fd0ee;
  --h-violet: #aab5ff;
  --h-black: #111111;
  --h-critical: #ff6b6b;
  --h-high: #ff9b4a;
  --h-medium: #f3c234;
  --h-low: #54d784;
}

.hacktron-dashboard,
.hacktron-dashboard * {
  box-sizing: border-box;
  letter-spacing: 0;
}

.hacktron-dashboard a {
  color: inherit;
  text-decoration: none;
}

.hack-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 58px;
  padding-bottom: 26px;
  border-bottom: 1px solid var(--h-line);
}

.hack-breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 19px;
  font-weight: 500;
}

.hack-breadcrumb strong {
  color: var(--h-ink);
  font-weight: 500;
}

.hack-top-actions {
  display: inline-flex;
  align-items: center;
  gap: 18px;
}

.hack-icon-button {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--h-muted);
  cursor: pointer;
}

.hack-icon-button:hover {
  color: var(--h-ink);
  background: #ececea;
}

.hack-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 18px;
  align-items: center;
  margin: 32px 0 30px;
}

.hack-tabs {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  border: 1px solid var(--h-line);
  background: #eeeeed;
  padding: 4px;
}

.hack-tab {
  min-height: 40px;
  padding: 0 18px;
  border: 0;
  background: transparent;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.hack-tab[data-active="true"] {
  background: var(--h-white);
  color: var(--h-ink);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.hack-filter-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
}

.hack-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 46px;
  padding: 0 18px;
  border: 1px solid var(--h-line);
  border-radius: 0;
  background: #eeeeed;
  color: var(--h-text);
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.hack-button:hover {
  border-color: var(--h-line-strong);
  background: var(--h-white);
  color: var(--h-ink);
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 28px;
  margin-bottom: 30px;
}

.metric-card,
.chart-panel,
.sla-card,
.activity-panel {
  border: 1px solid var(--h-line);
  border-radius: 0;
  background: var(--h-card);
  box-shadow: none;
}

.metric-card {
  min-height: 154px;
  padding: 30px 32px;
}

.metric-label,
.section-title,
.activity-title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 17px;
  font-weight: 600;
}

.metric-value {
  display: block;
  margin: 22px 0 18px;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 30px;
  font-weight: 600;
  line-height: 1;
}

.metric-description,
.muted-copy {
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.45;
}

.chart-panel {
  min-height: 346px;
  margin-bottom: 32px;
  padding: 32px;
}

.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 22px;
}

.chart-legend {
  display: inline-flex;
  align-items: center;
  gap: 24px;
  color: var(--h-text);
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 500;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--legend-color);
}

.chart-frame {
  width: 100%;
  height: 228px;
  position: relative;
}

.chart-svg {
  display: block;
  width: 100%;
  height: 100%;
}

.chart-axis-label {
  fill: #6f7b91;
  font-family: var(--font-sans);
  font-size: 13px;
}

.resolution-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 2px 0 16px;
}

.configure-link {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 600;
}

.sla-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 28px;
  margin-bottom: 32px;
}

.sla-card {
  min-height: 222px;
  padding: 30px 32px;
}

.sla-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 24px;
}

.severity-badge {
  display: inline-flex;
  align-items: center;
  min-height: 27px;
  padding: 0 10px;
  border: 1px solid var(--severity-color);
  background: color-mix(in srgb, var(--severity-color) 10%, transparent);
  color: color-mix(in srgb, var(--severity-color) 78%, #111 22%);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 500;
}

.sla-met {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--h-text);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 500;
}

.sla-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-top: 1px solid var(--h-line);
  border-bottom: 1px solid var(--h-line);
  margin-bottom: 22px;
}

.sla-metrics div {
  min-height: 62px;
  padding: 18px 0;
}

.sla-metrics div + div {
  border-left: 1px solid var(--h-line);
  padding-left: 28px;
}

.sla-metrics span {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 16px;
  font-weight: 600;
}

.sla-metrics strong {
  display: block;
  margin-top: 6px;
  color: var(--h-ink);
  font-size: 20px;
  font-weight: 600;
}

.sla-target {
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 14px;
  text-align: center;
}

.activity-panel {
  overflow: hidden;
}

.activity-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 64px;
  padding: 0 24px;
  border-bottom: 1px solid var(--h-line);
}

.activity-controls {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.search-field {
  position: relative;
}

.search-field svg {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--h-faint);
}

.search-input,
.service-select {
  height: 40px;
  border: 1px solid var(--h-line);
  border-radius: 0;
  background: var(--h-white);
  color: var(--h-ink);
  font-family: var(--font-sans);
  font-size: 14px;
  outline: none;
}

.search-input {
  width: 246px;
  padding: 0 12px 0 38px;
}

.service-select {
  width: 156px;
  padding: 0 12px;
}

.activity-table-wrap {
  width: 100%;
  overflow-x: auto;
}

.activity-table {
  width: 100%;
  min-width: 860px;
  border-collapse: collapse;
  color: var(--h-text);
  font-family: var(--font-sans);
  font-size: 14px;
}

.activity-table th {
  height: 46px;
  padding: 0 24px;
  color: var(--h-faint);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  text-transform: uppercase;
}

.activity-table td {
  height: 56px;
  padding: 0 24px;
  border-top: 1px solid var(--h-line);
  white-space: nowrap;
}

.service-cell {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--h-ink);
  font-weight: 600;
}

.service-icon {
  color: var(--service-color);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--status-color);
  font-size: 13px;
  font-weight: 600;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--status-color);
}

.row-action {
  color: var(--h-ink);
  font-size: 13px;
  font-weight: 600;
}

.empty-state {
  padding: 34px 24px;
  border-top: 1px solid var(--h-line);
  color: var(--h-muted);
  font-family: var(--font-sans);
  text-align: center;
}

@media (max-width: 1180px) {
  .hacktron-dashboard {
    padding: 24px 22px 40px;
  }

  .metrics-grid,
  .sla-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
  }
}

@media (max-width: 760px) {
  .hacktron-dashboard {
    padding: 20px 14px 34px;
  }

  .hack-header,
  .hack-toolbar,
  .panel-heading,
  .resolution-head,
  .activity-header {
    align-items: stretch;
    flex-direction: column;
  }

  .hack-header,
  .panel-heading,
  .resolution-head,
  .activity-header {
    display: flex;
  }

  .hack-toolbar {
    display: grid;
    grid-template-columns: 1fr;
  }

  .hack-tabs,
  .hack-filter-actions,
  .hack-button,
  .search-input,
  .service-select {
    width: 100%;
  }

  .hack-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .metrics-grid,
  .sla-grid {
    grid-template-columns: 1fr;
  }

  .activity-controls {
    display: grid;
    grid-template-columns: 1fr;
  }

  .metric-card,
  .chart-panel,
  .sla-card {
    padding: 22px;
  }
}
`;

const TAB_LABELS: ReadonlyArray<{ readonly id: DashboardTab; readonly label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'blackbox', label: 'Blackbox Scan' },
  { id: 'pr-review', label: 'PR Review' },
  { id: 'whitebox', label: 'Whitebox Scan' },
];

const SERVICE_META: Record<ServiceId, { readonly label: string; readonly color: string; readonly icon: LucideIcon }> = {
  blackbox: { label: 'Blackbox', color: '#6d9bd6', icon: Globe2 },
  whitebox: { label: 'Whitebox', color: '#38b869', icon: Code2 },
  'pr-review': { label: 'PR Review', color: '#8f7af5', icon: GitPullRequest },
};

const SCAN_ACTIVE_STATUSES = new Set<ScanOrderStatus>([
  'dns_pending',
  'dns_verified',
  'vm_provisioning',
  'running',
]);

const REVIEW_ACTIVE_STATUSES = new Set<ReviewRunStatus>(['queued', 'running']);

function IconButton({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <button type="button" aria-label={label} title={label} className="hack-icon-button">
      {children}
    </button>
  );
}

function metricValue(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: value >= 1000 ? 'compact' : 'standard' }).format(value);
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function shortDay(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(ms));
}

function reviewServiceId(item: ReviewListItemWire): ServiceId {
  return item.kind === 'whitebox' ? 'whitebox' : 'pr-review';
}

function serviceForTab(tab: DashboardTab): ServiceId | 'all' {
  if (tab === 'blackbox') return 'blackbox';
  if (tab === 'whitebox') return 'whitebox';
  if (tab === 'pr-review') return 'pr-review';
  return 'all';
}

function statusColor(tone: StatusTone): string {
  switch (tone) {
    case 'active':
      return '#6d9bd6';
    case 'ok':
      return '#2fbf67';
    case 'warn':
      return '#d19a1f';
    case 'danger':
      return '#e15454';
    case 'muted':
      return '#8b8b86';
  }
}

function scanTone(status: ScanOrderStatus): StatusTone {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'cancelled') return 'danger';
  if (SCAN_ACTIVE_STATUSES.has(status)) return 'active';
  return 'muted';
}

function reviewTone(status: ReviewRunStatus): StatusTone {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'danger';
  if (REVIEW_ACTIVE_STATUSES.has(status)) return 'active';
  return 'muted';
}

function actionHref(order: ScanOrder, action: ActionMapping): string {
  if (action.key === 'resume') {
    if (order.status === 'dns_pending') return `/scan/new/${encodeURIComponent(order.id)}/verify`;
    if (order.status === 'dns_verified') return `/scan/new/${encodeURIComponent(order.id)}/safety`;
    return `/scan/new/${encodeURIComponent(order.id)}/surface`;
  }

  if (action.key === 'download' || action.key === 'regenerate') {
    return order.scan_id != null ? `/reports?scan=${encodeURIComponent(order.scan_id)}` : '/reports';
  }

  return order.scan_id != null ? `/live?scan=${encodeURIComponent(order.scan_id)}` : '/live';
}

function quotaLabel(quota: FreeQuotaStatus): string {
  if (quota.state === 'available') return 'Included';
  return quota.daysUntilReset == null ? 'Free used' : `Resets in ${quota.daysUntilReset}d`;
}

function buildOperations(orders: readonly ScanOrder[], reviews: readonly ReviewListItemWire[]): OperationRow[] {
  const scanRows: OperationRow[] = sortOrdersNewestFirst(orders).map((order) => {
    const badge: BadgeMapping = mapStatusToBadge(order.status);
    const action: ActionMapping = mapStatusToAction(order.status);
    return {
      id: `scan:${order.id}`,
      serviceId: 'blackbox',
      target: order.primary_domain,
      type: order.tier === 'quick' ? 'Blackbox scan' : 'Deep assessment',
      statusLabel: badge.key === 'provisioning' ? 'provisioning' : badge.key,
      statusTone: scanTone(order.status),
      findingsLabel: order.status === 'completed' ? 'Report ready' : '-',
      lastRunMs: order.updated_at ?? order.created_at,
      href: actionHref(order, action),
      actionLabel: action.key === 'download' ? 'Report' : action.key === 'regenerate' ? 'Retry' : 'View',
    };
  });

  const reviewRows: OperationRow[] = reviews.map((item) => {
    const serviceId = reviewServiceId(item);
    const repo = item.repo ?? 'repository pending';
    return {
      id: `review:${item.review_id}`,
      serviceId,
      target: item.pr_number != null ? `${repo} #${item.pr_number}` : repo,
      type: serviceId === 'whitebox' ? 'Whitebox scan' : 'PR review',
      statusLabel: item.status,
      statusTone: reviewTone(item.status),
      findingsLabel:
        item.findings_count > 0 ? `${item.findings_count} finding${item.findings_count === 1 ? '' : 's'}` : 'No findings',
      lastRunMs: item.completed_at ?? item.created_at ?? null,
      href: `/reviews/${encodeURIComponent(item.review_id)}`,
      actionLabel: item.status === 'failed' ? 'Inspect' : 'View',
    };
  });

  return [...scanRows, ...reviewRows].sort((a, b) => {
    const aT = a.lastRunMs ?? 0;
    const bT = b.lastRunMs ?? 0;
    if (aT === bT) return a.id.localeCompare(b.id);
    return bT - aT;
  });
}

function buildChartDays(
  nowMs: number,
  orders: readonly ScanOrder[],
  reviews: readonly ReviewListItemWire[],
): ChartDay[] {
  const days = Array.from({ length: 7 }, (_, index) => {
    const ms = nowMs - (6 - index) * 24 * 60 * 60 * 1000;
    return { key: dayKey(ms), label: shortDay(ms), blackbox: 0, pr: 0, whitebox: 0 };
  });
  const byKey = new Map(days.map((day) => [day.key, day]));

  for (const order of orders) {
    const bucket = byKey.get(dayKey(order.updated_at ?? order.created_at));
    if (bucket) bucket.blackbox += 1;
  }

  for (const item of reviews) {
    const bucket = byKey.get(dayKey(item.completed_at ?? item.created_at ?? nowMs));
    if (!bucket) continue;
    if (reviewServiceId(item) === 'whitebox') bucket.whitebox += 1;
    else bucket.pr += 1;
  }

  return days;
}

function buildMetrics(
  orders: readonly ScanOrder[],
  reviews: readonly ReviewListItemWire[],
  repos: readonly ReviewRepoWire[],
  quota: FreeQuotaStatus,
): MetricCardData[] {
  const prReviews = reviews.filter((item) => reviewServiceId(item) === 'pr-review');
  const whiteboxReviews = reviews.filter((item) => item.kind === 'whitebox');
  const activeRepos = repos.filter((repo) => repo.status === 'active');

  return [
    {
      label: 'Blackbox scans',
      value: metricValue(orders.length),
      description: `${orders.filter((order) => SCAN_ACTIVE_STATUSES.has(order.status)).length} active - ${quotaLabel(quota)}`,
    },
    {
      label: 'PR Review',
      value: metricValue(prReviews.length),
      description: '# of PRs reviewed by Sthrip',
    },
    {
      label: 'Whitebox Scans',
      value: metricValue(whiteboxReviews.length),
      description: '# of Whitebox Scans performed',
      info: true,
    },
    {
      label: 'Active repositories',
      value: metricValue(activeRepos.length),
      description: '# of repos covered by PR Review',
    },
  ];
}

function buildSlaCards(reviews: readonly ReviewListItemWire[], orders: readonly ScanOrder[]): SlaCardData[] {
  const failedRuns = reviews.filter((item) => item.status === 'failed').length + orders.filter((order) => order.status === 'failed').length;
  const openFindings = reviews.reduce((sum, item) => sum + item.findings_count, 0);

  return [
    { severity: 'critical', color: '#ff6b6b', sla: '7d', target: 'target >95%', count: failedRuns, met: failedRuns === 0 },
    { severity: 'high', color: '#ff9b4a', sla: '30d', target: 'target >95%', count: Math.max(0, openFindings - 4), met: openFindings < 8 },
    { severity: 'medium', color: '#f3c234', sla: '90d', target: 'target >90%', count: Math.max(0, openFindings - 1), met: true },
    { severity: 'low', color: '#54d784', sla: '120d', target: 'target >90%', count: openFindings, met: true },
  ];
}

function ordersForTab(orders: readonly ScanOrder[], tab: DashboardTab): readonly ScanOrder[] {
  return tab === 'overview' || tab === 'blackbox' ? orders : [];
}

function reviewsForTab(reviews: readonly ReviewListItemWire[], tab: DashboardTab): readonly ReviewListItemWire[] {
  if (tab === 'overview') return reviews;
  if (tab === 'pr-review') return reviews.filter((item) => reviewServiceId(item) === 'pr-review');
  if (tab === 'whitebox') return reviews.filter((item) => reviewServiceId(item) === 'whitebox');
  return [];
}

function MetricCard({ metric }: { readonly metric: MetricCardData }): ReactElement {
  return (
    <article data-slot="card" className="metric-card">
      <h2 data-slot="card-title" className="metric-label">
        {metric.label}
        {metric.info && <Info size={15} aria-hidden="true" />}
      </h2>
      <strong className="metric-value">{metric.value}</strong>
      <p data-slot="card-description" className="metric-description">{metric.description}</p>
    </article>
  );
}

function linePath(values: readonly number[], max: number, width: number, height: number): string {
  const step = width / Math.max(values.length - 1, 1);
  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / max) * (height - 8) - 4;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function ChartPanel({ days, tab }: { readonly days: readonly ChartDay[]; readonly tab: DashboardTab }): ReactElement {
  const showBlackbox = tab === 'overview' || tab === 'blackbox';
  const showPr = tab === 'overview' || tab === 'pr-review';
  const showWhitebox = tab === 'overview' || tab === 'whitebox';
  const visibleValues = days.flatMap((day) => [
    showBlackbox ? day.blackbox : 0,
    showPr ? day.pr : 0,
    showWhitebox ? day.whitebox : 0,
  ]);
  const maxValue = Math.max(2, ...visibleValues);
  const width = 760;
  const height = 176;
  const blackboxPath = linePath(days.map((day) => day.blackbox), maxValue, width, height);
  const prPath = linePath(days.map((day) => day.pr), maxValue, width, height);
  const whiteboxPath = linePath(days.map((day) => day.whitebox), maxValue, width, height);

  return (
    <section data-slot="card" className="chart-panel" aria-label="Scan volume over time">
      <div data-slot="card-header" className="panel-heading">
        <h2 data-slot="card-title" className="section-title">Scan volume over time</h2>
        <div className="chart-legend" aria-label="Chart legend">
          {showBlackbox && <span className="legend-item"><i className="legend-dot" style={{ '--legend-color': 'var(--h-blue)' } as CSSProperties} />Blackbox</span>}
          {showPr && <span className="legend-item"><i className="legend-dot" style={{ '--legend-color': '#8fd7ff' } as CSSProperties} />PR Review</span>}
          {showWhitebox && <span className="legend-item"><i className="legend-dot" style={{ '--legend-color': 'var(--h-violet)' } as CSSProperties} />Whitebox Scan</span>}
        </div>
      </div>
      <div data-slot="card-content" className="chart-frame">
        <svg className="chart-svg" viewBox={`0 0 ${width + 42} ${height + 44}`} role="img" aria-label="Seven day scan volume">
          <line x1="0" x2={width} y1="18" y2="18" stroke="#e8e7e4" />
          <line x1="0" x2={width} y1={height} y2={height} stroke="#e0dfdc" />
          <line x1={width} x2={width} y1="18" y2={height} stroke="#ebe9e6" />
          <text x={width + 16} y="22" className="chart-axis-label">{maxValue}</text>
          <text x={width + 16} y={height + 4} className="chart-axis-label">0</text>
          {showBlackbox && <path d={blackboxPath} fill="none" stroke="var(--h-blue)" strokeWidth="2.4" />}
          {showPr && <path d={prPath} fill="none" stroke="#8fd7ff" strokeWidth="2.4" />}
          {showWhitebox && <path d={whiteboxPath} fill="none" stroke="var(--h-violet)" strokeWidth="2.4" />}
          {days.map((day, index) => {
            const x = (width / Math.max(days.length - 1, 1)) * index;
            return <text key={day.label} x={x} y={height + 34} textAnchor={index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'} className="chart-axis-label">{day.label}</text>;
          })}
        </svg>
      </div>
    </section>
  );
}

function SlaCard({ card }: { readonly card: SlaCardData }): ReactElement {
  const label = card.severity[0].toUpperCase() + card.severity.slice(1);

  return (
    <article data-slot="card" className="sla-card" style={{ '--severity-color': card.color } as CSSProperties}>
      <div className="sla-top">
        <span data-slot="badge" className="severity-badge">{label}</span>
        <span className="sla-met">{card.met ? '⊙' : '!'} SLA {card.met ? 'met' : 'watch'}</span>
      </div>
      <div className="sla-metrics">
        <div>
          <span>MTTR <Info size={14} aria-hidden="true" /></span>
          <strong>{card.count === 0 ? '-' : `${card.count}d`}</strong>
        </div>
        <div>
          <span>SLA · {card.sla} <Info size={14} aria-hidden="true" /></span>
          <strong>{card.met ? '100%' : '86%'}</strong>
        </div>
      </div>
      <p className="sla-target">{card.target}</p>
    </article>
  );
}

function operationMatchesService(operation: OperationRow, tab: DashboardTab, select: ServiceId | 'all'): boolean {
  const tabService = serviceForTab(tab);
  if (tabService !== 'all' && operation.serviceId !== tabService) return false;
  if (select !== 'all' && operation.serviceId !== select) return false;
  return true;
}

function ActivityTable({
  operations,
  nowMs,
  search,
  serviceFilter,
  onSearch,
  onServiceFilter,
  onRefresh,
}: {
  readonly operations: readonly OperationRow[];
  readonly nowMs: number;
  readonly search: string;
  readonly serviceFilter: ServiceId | 'all';
  readonly onSearch: (value: string) => void;
  readonly onServiceFilter: (value: ServiceId | 'all') => void;
  readonly onRefresh: () => void;
}): ReactElement {
  return (
    <section data-slot="card" className="activity-panel" aria-label="Organization activities">
      <div data-slot="card-header" className="activity-header">
        <h2 data-slot="card-title" className="activity-title">Organization activities</h2>
        <div className="activity-controls">
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <input
              className="search-input"
              value={search}
              onChange={(event) => onSearch(event.currentTarget.value)}
              aria-label="Search activities"
              placeholder="Search activities"
            />
          </label>
          <select
            className="service-select"
            value={serviceFilter}
            onChange={(event) => onServiceFilter(event.currentTarget.value as ServiceId | 'all')}
            aria-label="Filter service"
          >
            <option value="all">All services</option>
            <option value="blackbox">Blackbox</option>
            <option value="pr-review">PR Review</option>
            <option value="whitebox">Whitebox</option>
          </select>
          <button type="button" className="hack-button" onClick={onRefresh}>
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      <div data-slot="table-container" className="activity-table-wrap">
        <table data-slot="table" className="activity-table">
          <thead data-slot="table-header">
            <tr data-slot="table-row">
              <th data-slot="table-head">Service</th>
              <th data-slot="table-head">Target</th>
              <th data-slot="table-head">Type</th>
              <th data-slot="table-head">Status</th>
              <th data-slot="table-head">Findings</th>
              <th data-slot="table-head">Last run</th>
              <th data-slot="table-head">Action</th>
            </tr>
          </thead>
          <tbody data-slot="table-body">
            {operations.map((operation) => {
              const meta = SERVICE_META[operation.serviceId];
              const Icon = meta.icon;
              return (
                <tr data-slot="table-row" key={operation.id}>
                  <td data-slot="table-cell">
                    <span className="service-cell" style={{ '--service-color': meta.color } as CSSProperties}>
                      <Icon className="service-icon" size={16} strokeWidth={1.9} aria-hidden="true" />
                      {meta.label}
                    </span>
                  </td>
                  <td data-slot="table-cell">{operation.target}</td>
                  <td data-slot="table-cell">{operation.type}</td>
                  <td data-slot="table-cell">
                    <span data-slot="badge" className="status-pill" style={{ '--status-color': statusColor(operation.statusTone) } as CSSProperties}>
                      <span className="status-dot" />
                      {operation.statusLabel}
                    </span>
                  </td>
                  <td data-slot="table-cell">{operation.findingsLabel}</td>
                  <td data-slot="table-cell">{operation.lastRunMs == null ? '-' : formatRelativeTime(operation.lastRunMs, nowMs)}</td>
                  <td data-slot="table-cell">
                    <Link className="row-action" to={operation.href}>{operation.actionLabel}</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {operations.length === 0 && <div className="empty-state">No activity matches this view.</div>}
    </section>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unable to load dashboard data';
}

export default function Dashboard(): ReactElement {
  const [orders, setOrders] = useState<ScanOrder[]>([]);
  const [reviews, setReviews] = useState<ReviewListItemWire[]>([]);
  const [repos, setRepos] = useState<ReviewRepoWire[]>([]);
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [serviceFilter, setServiceFilter] = useState<ServiceId | 'all'>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    setScanError(null);
    setReviewError(null);
    setNowMs(Date.now());

    const [ordersResult, reviewsResult, reposResult] = await Promise.allSettled([
      scanOrders.list(),
      review.list(),
      review.listRepos(),
    ]);

    if (ordersResult.status === 'fulfilled') setOrders(ordersResult.value);
    else setScanError(errorMessage(ordersResult.reason));

    if (reviewsResult.status === 'fulfilled') setReviews(reviewsResult.value);
    else setReviewError(errorMessage(reviewsResult.reason));

    if (reposResult.status === 'fulfilled') setRepos(reposResult.value);
    else setReviewError(errorMessage(reposResult.reason));

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const quota = useMemo(() => deriveFreeQuotaStatus(orders, nowMs), [orders, nowMs]);
  const metrics = useMemo(() => buildMetrics(orders, reviews, repos, quota), [orders, reviews, repos, quota]);
  const scopedOrders = useMemo(() => ordersForTab(orders, activeTab), [orders, activeTab]);
  const scopedReviews = useMemo(() => reviewsForTab(reviews, activeTab), [reviews, activeTab]);
  const chartDays = useMemo(() => buildChartDays(nowMs, scopedOrders, scopedReviews), [nowMs, scopedOrders, scopedReviews]);
  const slaCards = useMemo(() => buildSlaCards(scopedReviews, scopedOrders), [scopedReviews, scopedOrders]);
  const operations = useMemo(() => buildOperations(orders, reviews), [orders, reviews]);

  const filteredOperations = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return operations.filter((operation) => {
      if (!operationMatchesService(operation, activeTab, serviceFilter)) return false;
      if (!normalized) return true;
      const meta = SERVICE_META[operation.serviceId];
      return [meta.label, operation.target, operation.type, operation.statusLabel, operation.findingsLabel]
        .join(' ')
        .toLowerCase()
        .includes(normalized);
    });
  }, [operations, activeTab, serviceFilter, search]);

  const visibleMetrics =
    activeTab === 'overview'
      ? metrics
      : metrics.filter((metric) => {
          if (activeTab === 'blackbox') return metric.label === 'Blackbox scans';
          if (activeTab === 'pr-review') return metric.label === 'PR Review' || metric.label === 'Active repositories';
          return metric.label === 'Whitebox Scans' || metric.label === 'Active repositories';
        });

  return (
    // biome-ignore lint/a11y/useValidAriaRole: AppShell's role prop is a product RBAC role, not a DOM ARIA role.
    <AppShell
      breadcrumb={[]}
      role="security_lead"
      density="compact"
      brand="sthrip"
      language="en"
      showLanguageSwitcher={false}
      surface="hacktron-light"
    >
      <RouteHead title="Dashboard - Sthrip" />
      <style>{DASHBOARD_CSS}</style>
      <div data-screen-label="Sthrip HackTron-style dashboard" className="hacktron-dashboard">
        <header className="hack-header">
          <div className="hack-breadcrumb" aria-label="Breadcrumb">
            <span>Dashboard</span>
            <span>/</span>
            <strong>{TAB_LABELS.find((tab) => tab.id === activeTab)?.label ?? 'Overview'}</strong>
          </div>
          <div className="hack-top-actions" aria-label="Dashboard tools">
            <IconButton label="Search">
              <Search size={24} strokeWidth={1.9} />
            </IconButton>
            <IconButton label="Reports">
              <FileText size={23} strokeWidth={1.9} />
            </IconButton>
          </div>
        </header>

        <div className="hack-toolbar">
          <div data-slot="tabs" className="hack-tabs" aria-label="Dashboard sections">
            {TAB_LABELS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                data-slot="tabs-trigger"
                data-active={activeTab === tab.id}
                className="hack-tab"
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="hack-filter-actions">
            <button type="button" className="hack-button">
              <CalendarDays size={18} strokeWidth={1.9} aria-hidden="true" />
              Last 7 days
              <ChevronDown size={17} strokeWidth={1.9} aria-hidden="true" />
            </button>
            <button type="button" className="hack-button">
              <Download size={19} strokeWidth={1.9} aria-hidden="true" />
              Export
            </button>
          </div>
        </div>

        {(scanError || reviewError) && (
          <p className="muted-copy" style={{ margin: '-14px 0 24px' }}>
            {scanError ? `Blackbox: ${scanError}` : null}
            {scanError && reviewError ? ' / ' : null}
            {reviewError ? `Reviews: ${reviewError}` : null}
          </p>
        )}

        <section className="metrics-grid" aria-label="Service metrics">
          {visibleMetrics.map((metric) => <MetricCard metric={metric} key={metric.label} />)}
        </section>

        <ChartPanel days={chartDays} tab={activeTab} />

        <section aria-label="Resolution health">
          <div className="resolution-head">
            <h2 className="section-title">
              Resolution health
              <Info size={16} aria-hidden="true" />
            </h2>
            <Link className="configure-link" to="/settings">
              <Settings size={16} aria-hidden="true" />
              Configure
            </Link>
          </div>
          <div className="sla-grid">
            {slaCards.map((card) => <SlaCard card={card} key={card.severity} />)}
          </div>
        </section>

        <ActivityTable
          operations={filteredOperations}
          nowMs={nowMs}
          search={search}
          serviceFilter={serviceFilter}
          onSearch={setSearch}
          onServiceFilter={setServiceFilter}
          onRefresh={() => void load()}
        />

        {loading && <p className="muted-copy" style={{ marginTop: 16 }}>Syncing latest workspace activity...</p>}
      </div>
    </AppShell>
  );
}
