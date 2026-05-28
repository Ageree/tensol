// T084 — Live scan progress page (Blackbox MVP).
//
// Polls /v1/scans/:id summary + /v1/scans/:id/events with a `since` cursor.
// Constitution V (NON-NEGOTIABLE): polling, NOT SSE/WebSockets.
//
// Renders:
//   - 5-phase progress (dns_pending → dns_verified → vm_provisioning →
//     running → completed). `failed` / `cancelled` short-circuit the bar.
//   - Live events feed (newest at bottom) accumulated across polls.
//   - When status='completed': links to /scan/:id/findings + /scan/:id/report.
//
// URL: /scan/:id  (T083 route).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Mono, Scroll, StatusChip } from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';
import {
  ApiError,
  scans,
  type ScanEvent,
  type ScanEventType,
  type ScanStatus,
  type ScanSummary,
} from '../lib/api-client.ts';
import { usePolling } from '../lib/poll.ts';

// ─── Phase model ───────────────────────────────────────────────────────────
// We mirror the scan_order lifecycle bridged into the scan via webhook events.
// The five steps visible to the operator:

// 5 phases mirror the scan_order lifecycle:
//   0=dns_pending, 1=dns_verified, 2=vm_provisioning, 3=running, 4=completed
// (Exported for tests; the slug order is documented above.)

/**
 * Derive the active phase index (0..4) from scan summary status + events.
 * - completed/failed/cancelled → 4 (terminal)
 * - running → 3
 * - vm_ready emitted but not yet agent_started → 2 (still provisioning slot)
 * - vm_provisioning emitted → 2
 * - queued → 1 (DNS already verified by the time the scan record exists)
 * - default → 1
 */
export function derivePhaseIndex(
  status: ScanStatus | undefined,
  events: readonly ScanEvent[],
): number {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    return 4;
  }
  if (status === 'running') return 3;
  const types = new Set<ScanEventType>(events.map((e) => e.event_type));
  if (types.has('agent_started') || types.has('vm_ready')) return 3;
  if (types.has('vm_provisioning')) return 2;
  // Newly queued scan — DNS already verified upstream by /launch.
  return 1;
}

// ─── Phase progress bar ────────────────────────────────────────────────────

interface PhaseBarProps {
  readonly active: number;
  readonly failed: boolean;
  readonly labels: readonly string[];
}

function PhaseBar({ active, failed, labels }: PhaseBarProps): ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${labels.length}, 1fr)`,
        gap: 12,
        marginBottom: 24,
      }}
    >
      {labels.map((label, idx) => {
        const isActive = idx === active && !failed;
        const isDone = idx < active;
        const color = isActive
          ? 'var(--fg)'
          : isDone
            ? 'var(--fg-2)'
            : 'var(--fg-3)';
        const borderColor = failed && idx === active
          ? 'var(--red)'
          : isActive
            ? 'var(--red)'
            : isDone
              ? 'var(--fg-2)'
              : 'var(--line-soft)';
        return (
          <div
            key={label}
            style={{ paddingTop: 8, borderTop: `2px solid ${borderColor}` }}
          >
            <Mono
              size={10.5}
              color={color}
              style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}
            >
              {`0${idx + 1}`}
            </Mono>
            <div
              style={{
                marginTop: 4,
                fontFamily: "'Inter', sans-serif",
                fontSize: 13,
                color,
              }}
            >
              {label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Event row ─────────────────────────────────────────────────────────────

const EVENT_TAG: Record<ScanEventType, string> = {
  vm_provisioning: '[vm  ]',
  vm_ready: '[vm  ]',
  vm_teardown: '[vm  ]',
  agent_started: '[run ]',
  agent_phase_changed: '[run ]',
  finding_detected: '[find]',
  scan_completed: '[sum ]',
  scan_failed: '[fail]',
};

const EVENT_TONE: Record<ScanEventType, string> = {
  vm_provisioning: 'var(--fg-3)',
  vm_ready: 'var(--fg-2)',
  vm_teardown: 'var(--fg-3)',
  agent_started: 'var(--fg-2)',
  agent_phase_changed: 'var(--fg-2)',
  finding_detected: 'var(--fg)',
  scan_completed: 'var(--fg)',
  scan_failed: 'var(--red)',
};

function formatEventTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function summarizeEvent(e: ScanEvent): string {
  if (!e.payload || typeof e.payload !== 'object') return e.event_type;
  const p = e.payload as Record<string, unknown>;
  if (e.event_type === 'finding_detected') {
    const sev = typeof p.severity === 'string' ? p.severity : '';
    const title = typeof p.title === 'string' ? p.title : 'finding';
    return sev ? `${sev} · ${title}` : title;
  }
  if (e.event_type === 'agent_phase_changed') {
    const phase = typeof p.phase === 'string' ? p.phase : 'phase';
    return phase;
  }
  if (e.event_type === 'scan_failed') {
    const reason = typeof p.reason === 'string' ? p.reason : 'unknown';
    return reason;
  }
  return e.event_type;
}

// ─── Page ──────────────────────────────────────────────────────────────────

const SCAN_POLL_MS = 3000;
const EVENTS_POLL_MS = 3000;

function isTerminalStatus(s: ScanStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'cancelled';
}

export default function Live(): ReactElement {
  const { t } = useTensol();
  const { id } = useParams<{ id: string }>();

  // Accumulated events across polls + monotonically advancing cursor.
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const sinceRef = useRef<number>(0);
  const [networkErr, setNetworkErr] = useState<string | null>(null);

  // Stable predicates so usePolling doesn't recreate its poller every render.
  const scanStopWhen = useCallback(
    (s: ScanSummary) => isTerminalStatus(s.status),
    [],
  );
  const onErr = useCallback((e: unknown) => {
    if (e instanceof ApiError) {
      setNetworkErr(e.code);
    } else {
      setNetworkErr('network_error');
    }
  }, []);

  // Poll scan summary. Stops itself on terminal state.
  const scanFetcher = useCallback((): Promise<ScanSummary> => {
    if (!id) return Promise.reject(new Error('no_id'));
    return scans.get(id);
  }, [id]);
  const { data: scan, loading: scanLoading } = usePolling<ScanSummary>(
    scanFetcher,
    {
      intervalMs: SCAN_POLL_MS,
      stopWhen: scanStopWhen,
      onError: onErr,
    },
  );

  // Poll events with `since` cursor. We append + advance the cursor on each
  // successful poll. We DO NOT stop event polling on terminal state until we
  // have one final tick (so trailing finding_detected + scan_completed land).
  const [eventsEnabled, setEventsEnabled] = useState<boolean>(true);
  const eventsFetcher = useCallback((): Promise<ScanEvent[]> => {
    if (!id) return Promise.reject(new Error('no_id'));
    return scans.getEvents(id, sinceRef.current || undefined);
  }, [id]);
  const { data: latestBatch } = usePolling<ScanEvent[]>(eventsFetcher, {
    intervalMs: EVENTS_POLL_MS,
    enabled: eventsEnabled,
    onError: onErr,
  });

  // Append new events + advance the cursor on every batch.
  useEffect(() => {
    if (!latestBatch || latestBatch.length === 0) return;
    setEvents((prev) => [...prev, ...latestBatch]);
    const maxTs = latestBatch.reduce(
      (acc, e) => (e.created_at > acc ? e.created_at : acc),
      sinceRef.current,
    );
    sinceRef.current = maxTs;
    setNetworkErr(null);
  }, [latestBatch]);

  // Once scan reaches terminal, stop the events poller after one trailing tick.
  useEffect(() => {
    if (!scan) return;
    if (!isTerminalStatus(scan.status)) return;
    const timer = window.setTimeout(() => setEventsEnabled(false), EVENTS_POLL_MS + 500);
    return () => window.clearTimeout(timer);
  }, [scan]);

  const phaseLabels: readonly string[] = useMemo(
    () => [
      t.live.phaseDns,
      t.live.phaseDnsOk,
      t.live.phaseVm,
      t.live.phaseRunning,
      t.live.phaseDone,
    ],
    [t.live],
  );
  const phaseIdx = derivePhaseIndex(scan?.status, events);
  const failed = scan?.status === 'failed' || scan?.status === 'cancelled';
  const terminal = scan ? isTerminalStatus(scan.status) : false;

  return (
    <AppShell breadcrumb={[t.navAssessments, id ?? '—']} density="comfortable">
      <RouteHead title={`Tensol · ${t.live.title}`} />
      <div data-screen-label="C6 Live (T084)">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 24,
          }}
        >
          <div>
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
              {t.live.title}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <StatusChip
                status={scan ? scan.status : t.live.loading}
                tone={
                  failed
                    ? 'warn'
                    : scan?.status === 'completed'
                      ? 'ok'
                      : 'ok'
                }
              />
              <Mono size={11} color="var(--fg-3)">
                {id ?? '—'}
              </Mono>
            </div>
          </div>
          {terminal && id ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Link
                to={`/scan/${id}/findings`}
                style={{ textDecoration: 'none' }}
              >
                <Btn kind="primary" size="md">
                  {t.live.navFindings}
                </Btn>
              </Link>
              <Link to={`/scan/${id}/report`} style={{ textDecoration: 'none' }}>
                <Btn kind="secondary" size="md">
                  {t.live.navReport}
                </Btn>
              </Link>
            </div>
          ) : null}
        </div>

        <PhaseBar active={phaseIdx} failed={failed} labels={phaseLabels} />

        {networkErr ? (
          <div style={{ marginBottom: 16 }}>
            <Mono size={11} color="var(--red)">
              {`${t.live.errPolling}: ${networkErr}`}
            </Mono>
          </div>
        ) : null}

        <section>
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
            <Mono
              size={11}
              color="var(--fg)"
              style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
            >
              {t.live.eventsLabel}
            </Mono>
            <Mono size={11} color="var(--fg-3)">
              {eventsEnabled ? t.live.polling : t.live.pollingStopped}
            </Mono>
          </div>

          <Scroll maxHeight={520}>
            <div style={{ padding: '8px 0' }}>
              {events.length === 0 ? (
                <div style={{ padding: '12px 0' }}>
                  <Mono size={11} color="var(--fg-3)">
                    {scanLoading ? t.live.loading : t.live.eventsEmpty}
                  </Mono>
                </div>
              ) : (
                events.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      padding: '5px 0',
                      display: 'grid',
                      gridTemplateColumns: '80px 56px 1fr',
                      gap: 10,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11.5,
                    }}
                  >
                    <span style={{ color: 'var(--fg-3)' }}>
                      {formatEventTime(e.created_at)}
                    </span>
                    <span
                      style={{
                        color: EVENT_TONE[e.event_type],
                        fontWeight: 500,
                      }}
                    >
                      {EVENT_TAG[e.event_type]}
                    </span>
                    <span style={{ color: 'var(--fg-2)' }}>
                      {summarizeEvent(e)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Scroll>
        </section>
      </div>
    </AppShell>
  );
}
