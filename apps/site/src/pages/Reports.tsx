// T087 — Per-scan report status + download (Blackbox MVP).
//
// URL: /scan/:id/report
//
// State machine (mirrors `ReportStatus` from openapi.yaml + T072):
//   pending   → polling every 5s (Constitution V: poll, not SSE)
//   rendering → polling every 5s
//   ready     → download_url + byte_size + expires_at
//   failed    → "Regenerate" button → POST /report/regenerate, then refresh

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { DashboardPage } from '../components/dashboard-ui.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Eyebrow, Mono, StatusChip } from '../components/primitives.tsx';
import { TENSOL_I18N } from '../i18n.ts';
import {
  ApiError,
  scans,
  type ReportResponse,
  type ReportStatus,
} from '../lib/api-client.ts';
import { usePolling } from '../lib/poll.ts';

// Polling cadence for in-progress report generation. Slower than the live
// scan poll (3s) because rendering takes minutes, not seconds.
const REPORT_POLL_MS = 5000;

function isTerminalStatus(s: ReportStatus): boolean {
  return s === 'ready' || s === 'failed';
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtExpiry(ms?: number | null): string {
  if (ms == null) return '—';
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return '—';
  }
}

interface StatusPanelProps {
  scanId: string;
  status: ReportStatus;
  report: ReportResponse;
  onRegenerate: () => Promise<void>;
  regenerating: boolean;
  toast: string | null;
}

function StatusPanel({
  scanId: _scanId,
  status,
  report,
  onRegenerate,
  regenerating,
  toast,
}: StatusPanelProps): ReactElement {
  const t = TENSOL_I18N.en;
  const statusLabels: Record<ReportStatus, string> = {
    pending: t.reports.statusPending,
    rendering: t.reports.statusRendering,
    ready: t.reports.statusReady,
    failed: t.reports.statusFailed,
  };
  const statusTone: Record<ReportStatus, 'neutral' | 'ok' | 'warn' | 'danger'> = {
    pending: 'warn',
    rendering: 'warn',
    ready: 'ok',
    failed: 'danger',
  };

  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        padding: '24px 28px',
        background: 'var(--bg-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Eyebrow>{t.reports.statusLabel}</Eyebrow>
        <StatusChip status={statusLabels[status]} tone={statusTone[status]} size="md" />
      </div>

      {(status === 'pending' || status === 'rendering') && (
        <div>
          <Mono size={12} color="var(--fg-2)" style={{ display: 'block', marginBottom: 6 }}>
            {t.reports.generating}
          </Mono>
          <Mono size={10.5} color="var(--fg-3)">
            {t.reports.polling.replace('{sec}', String(REPORT_POLL_MS / 1000))}
          </Mono>
        </div>
      )}

      {status === 'ready' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {report.download_url ? (
            <a
              href={report.download_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'none', alignSelf: 'flex-start' }}
            >
              <Btn kind="primary">{t.reports.download} ↓</Btn>
            </a>
          ) : (
            <Mono size={11} color="var(--fg-3)">
              {t.reports.noDownloadUrl}
            </Mono>
          )}
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            {report.byte_size != null && (
              <Mono size={11} color="var(--fg-2)">
                {t.reports.fileSize}: {fmtBytes(report.byte_size)}
              </Mono>
            )}
            {report.download_expires_at != null && (
              <Mono size={11} color="var(--fg-2)">
                {t.reports.expires}: {fmtExpiry(report.download_expires_at)}
              </Mono>
            )}
          </div>
        </div>
      )}

      {status === 'failed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Mono size={12} color="var(--red)">
            {t.reports.failedHint}
          </Mono>
          <div>
            <Btn kind="primary" onClick={onRegenerate} disabled={regenerating}>
              {regenerating ? t.reports.regenerating : t.reports.regenerate}
            </Btn>
          </div>
        </div>
      )}

      {toast && (
        <Mono size={11} color="var(--fg-2)" style={{ display: 'block' }}>
          {toast}
        </Mono>
      )}
    </div>
  );
}

export default function Reports(): ReactElement {
  const t = TENSOL_I18N.en;
  const { id: scanId } = useParams<{ id: string }>();

  const [networkErr, setNetworkErr] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);

  // Polling: stop on terminal (ready / failed).
  const stopWhen = useCallback(
    (r: ReportResponse) => isTerminalStatus(r.status),
    [],
  );
  const onErr = useCallback((e: unknown) => {
    if (e instanceof ApiError) setNetworkErr(e.code);
    else setNetworkErr('network_error');
  }, []);

  const fetcher = useCallback((): Promise<ReportResponse> => {
    if (!scanId) return Promise.reject(new Error('no_id'));
    return scans.getReport(scanId);
  }, [scanId]);

  const { data: report, loading, refetch } = usePolling<ReportResponse>(fetcher, {
    intervalMs: REPORT_POLL_MS,
    stopWhen,
    onError: onErr,
  });

  // Clear toast after a while so it doesn't linger across regenerations.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const handleRegenerate = useCallback(async (): Promise<void> => {
    if (!scanId || regenerating) return;
    setRegenerating(true);
    setToast(null);
    try {
      const result = await scans.regenerateReport(scanId);
      setToast(
        t.reports.regenerateQueued.replace('{jobId}', result.job_id),
      );
      // Kick a fresh poll so the UI flips from `failed` → `pending`
      // without waiting for the next 5s tick.
      await refetch();
    } catch (e: unknown) {
      const code = e instanceof ApiError ? e.code : 'network_error';
      setToast(`${t.reports.regenerateError}: ${code}`);
    } finally {
      setRegenerating(false);
    }
  }, [scanId, regenerating, refetch, t.reports]);

  return (
    <AppShell
      breadcrumb={[t.navReports, scanId ?? '—']}
      role="security_lead"
      density="comfortable"
      brand="sthrip"
      language="en"
      showLanguageSwitcher={false}
      surface="hacktron-light"
    >
      <RouteHead title={`Sthrip · ${t.reports.title}`} />
      <DashboardPage
        title={t.reports.title}
        section="Usage"
        description={scanId ? `Report for scan ${scanId}` : t.reports.noScanId}
        data-screen-label="Reports (T087)"
        actions={
          scanId ? (
            <Link
              to={`/scan/${encodeURIComponent(scanId)}/findings`}
              className="hack-button"
              data-slot="button"
            >
              {t.reports.backToFindings}
            </Link>
          ) : undefined
        }
      >

        {!scanId && (
          <Mono size={12} color="var(--fg-3)">
            {t.reports.noScanId}
          </Mono>
        )}

        {scanId && loading && !report && (
          <Mono size={12} color="var(--fg-3)">
            {t.reports.loading}
          </Mono>
        )}

        {scanId && networkErr && !report && (
          <Mono size={12} color="var(--red)">
            {t.reports.loadError}: {networkErr}
          </Mono>
        )}

        {scanId && report && (
          <StatusPanel
            scanId={scanId}
            status={report.status}
            report={report}
            onRegenerate={handleRegenerate}
            regenerating={regenerating}
            toast={toast}
          />
        )}
      </DashboardPage>
    </AppShell>
  );
}
