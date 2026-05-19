// T081 — Step 3: Verify domain (FR-008 / FR-009).
//
// Drives:
//   - On mount, if no `dnsToken` yet, the container's commitStep3 already
//     requested it via POST /v1/scan-orders/:id/dns-verify/request (T077).
//   - Display the TXT record card (`_tensol.<domain>` + token value) with
//     copy-to-clipboard for both hostname and value.
//   - Poll GET /v1/scan-orders/:id/dns-verify/check every 5s via usePolling
//     (T075 primitive). Halts on verified=true OR remaining_window_seconds≤0.
//   - 30-minute countdown timer driven by `remaining_window_seconds` from
//     the most-recent poll result, decremented locally each second so the UI
//     ticks smoothly between server checks.
//   - After ~10 minutes of stall, surface the "contact support" link to
//     `t.me/kapital0` (project memory: founder direct channel).
//   - On `verified=true`, dispatches `dnsVerified` and auto-advances to
//     step 4 via navigate().
//
// Constitution V (NON-NEGOTIABLE): polling only, no SSE.
// Constitution VII: ≤ 800 LOC.
// Constitution IX: server-side Zod (DnsVerifyCheckResponseSchema) canonical.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, Mono } from '../../components/primitives.tsx';
import { useTensol } from '../../context.tsx';
import {
  scanOrders,
  type DnsVerifyCheckResult,
} from '../../lib/api-client.ts';
import { usePolling } from '../../lib/poll.ts';
import {
  DNS_VERIFY_POLL_INTERVAL_MS,
  DNS_VERIFY_WINDOW_SECONDS,
  dnsVerifyShouldStop,
  formatCountdown,
  shouldShowStallHint,
  SUPPORT_TELEGRAM_URL,
} from './dns-verify-helpers.ts';
import type { ScanWizardStateApi } from './useScanWizardState.ts';

export interface Step3DnsVerifyProps {
  readonly api: ScanWizardStateApi;
}

const PAGE_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
  padding: 24,
  maxWidth: 760,
};

const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const CARD_STYLE: CSSProperties = {
  border: '1px solid var(--line-soft)',
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  background: 'var(--bg)',
};

const ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '120px 1fr auto',
  gap: 12,
  alignItems: 'center',
};

const VALUE_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  color: 'var(--fg)',
  wordBreak: 'break-all',
};

// ─── Copy-to-clipboard helper ──────────────────────────────────────────────

function useClipboardCopy(): {
  copy: (key: string, text: string) => Promise<void>;
  copiedKey: string | null;
} {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copy = useCallback(async (key: string, text: string): Promise<void> => {
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1500);
    } catch {
      // Clipboard API rejected (insecure context, denied permission, etc.).
      // Silent — the value is still visible on-screen for manual copy.
    }
  }, []);
  return { copy, copiedKey };
}

// ─── Component ─────────────────────────────────────────────────────────────

export const Step3DnsVerify = ({
  api,
}: Step3DnsVerifyProps): ReactElement => {
  const { t } = useTensol();
  const navigate = useNavigate();
  const { state, dispatch } = api;
  const { copy, copiedKey } = useClipboardCopy();

  // Local countdown — initialized from the verification window and updated
  // each second by a 1s interval AND each successful poll (server is the
  // source of truth; the 1s tick provides smooth UX between polls).
  const [localRemaining, setLocalRemaining] = useState<number>(
    DNS_VERIFY_WINDOW_SECONDS,
  );

  // Memoized stop predicate so usePolling doesn't recreate the poller every
  // render — see poll.ts note on referential stability.
  const stopWhen = useCallback(
    (r: DnsVerifyCheckResult): boolean => dnsVerifyShouldStop(r),
    [],
  );

  // Fetcher: pull the latest check from the server. Disabled until we have
  // an orderId (defensive — the container guarantees one by step 3).
  const orderId = state.orderId;
  const fetcher = useCallback(async (): Promise<DnsVerifyCheckResult> => {
    if (!orderId) {
      throw new Error('missing_order_id');
    }
    return scanOrders.checkDnsVerify(orderId);
  }, [orderId]);

  const polling = usePolling<DnsVerifyCheckResult>(fetcher, {
    intervalMs: DNS_VERIFY_POLL_INTERVAL_MS,
    enabled: Boolean(orderId) && Boolean(state.dnsToken) && !state.dnsVerified,
    stopWhen,
  });

  // Mirror the server's reported `remaining_window_seconds` into local state
  // each time it arrives. Between polls, the local countdown ticks 1s each.
  useEffect(() => {
    const next = polling.data?.remaining_window_seconds;
    if (typeof next === 'number') {
      setLocalRemaining(Math.max(0, next));
    }
  }, [polling.data]);

  useEffect(() => {
    if (localRemaining <= 0) return;
    const id = setInterval(() => {
      setLocalRemaining((r) => (r > 0 ? r - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [localRemaining]);

  // On verified=true, dispatch + navigate to step 4.
  useEffect(() => {
    if (polling.data?.verified && !state.dnsVerified) {
      dispatch({ type: 'dnsVerified' });
      if (orderId) {
        navigate(`/wizard/${orderId}/step-4`);
      }
    }
  }, [polling.data, state.dnsVerified, orderId, dispatch, navigate]);

  // ── Derived view values ──
  const txtName = useMemo<string>(
    () => (state.domain ? `_tensol.${state.domain}` : '_tensol.<domain>'),
    [state.domain],
  );
  const txtValue = state.dnsToken ?? '';

  const expired = localRemaining <= 0 && !state.dnsVerified;
  const stallHint = shouldShowStallHint(localRemaining);
  const attempts = polling.data?.attempts ?? 0;
  const lastError = polling.data?.last_error ?? null;

  // ── Render ──
  if (!state.orderId) {
    return (
      <div style={PAGE_STYLE}>
        <Mono size={12} color="var(--red)">
          {t.wizard.errGeneric}
        </Mono>
      </div>
    );
  }

  if (!state.dnsToken) {
    // Container's commitStep2 → step3 entry should have triggered the
    // dns-verify/request. If we land here without a token, surface a
    // loading hint while the container is still in flight.
    return (
      <div style={PAGE_STYLE}>
        <Mono size={12} color="var(--fg-2)">
          {t.wizard.step3.tokenLoading}
        </Mono>
      </div>
    );
  }

  return (
    <div style={PAGE_STYLE}>
      {/* ── Instructions ─────────────────────────────────────────────── */}
      <section style={SECTION_STYLE}>
        <Mono
          size={11}
          color="var(--fg-2)"
          style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {t.wizard.step3.instructionsLabel}
        </Mono>
        <Mono size={11} color="var(--fg-3)">
          {t.wizard.step3.instructionsHint}
        </Mono>
      </section>

      {/* ── TXT record card ──────────────────────────────────────────── */}
      <section style={SECTION_STYLE}>
        <div style={CARD_STYLE} data-testid="wizard-step3-txt-card">
          <div style={ROW_STYLE}>
            <Mono size={11} color="var(--fg-2)">
              {t.wizard.step3.recordType}
            </Mono>
            <Mono size={13} color="var(--fg)">
              TXT
            </Mono>
            <span />
          </div>
          <div style={ROW_STYLE}>
            <Mono size={11} color="var(--fg-2)">
              {t.wizard.step3.recordName}
            </Mono>
            <span style={VALUE_STYLE} data-testid="wizard-step3-txt-name">
              {txtName}
            </span>
            <Btn
              kind="ghost"
              size="sm"
              onClick={() => void copy('name', txtName)}
              title={t.wizard.step3.copy}
            >
              {copiedKey === 'name' ? t.wizard.step3.copied : t.wizard.step3.copy}
            </Btn>
          </div>
          <div style={ROW_STYLE}>
            <Mono size={11} color="var(--fg-2)">
              {t.wizard.step3.recordValue}
            </Mono>
            <span style={VALUE_STYLE} data-testid="wizard-step3-txt-value">
              {txtValue}
            </span>
            <Btn
              kind="ghost"
              size="sm"
              onClick={() => void copy('value', txtValue)}
              title={t.wizard.step3.copy}
            >
              {copiedKey === 'value'
                ? t.wizard.step3.copied
                : t.wizard.step3.copy}
            </Btn>
          </div>
        </div>
      </section>

      {/* ── Status panel ─────────────────────────────────────────────── */}
      <section style={SECTION_STYLE}>
        <Mono
          size={11}
          color="var(--fg-2)"
          style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {t.wizard.step3.statusLabel}
        </Mono>

        {state.dnsVerified ? (
          <Mono size={13} color="var(--fg)">
            {t.wizard.step3.statusVerified}
          </Mono>
        ) : expired ? (
          <Mono size={13} color="var(--red)">
            {t.wizard.step3.statusExpired}
          </Mono>
        ) : (
          <Mono size={13} color="var(--fg)">
            {t.wizard.step3.statusWaiting}
          </Mono>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto auto',
            gap: '4px 16px',
            marginTop: 6,
          }}
        >
          <Mono size={11} color="var(--fg-3)">
            {t.wizard.step3.countdownLabel}
          </Mono>
          <Mono size={11} color={expired ? 'var(--red)' : 'var(--fg-2)'}>
            <span data-testid="wizard-step3-countdown">
              {formatCountdown(localRemaining)}
            </span>
          </Mono>

          <Mono size={11} color="var(--fg-3)">
            {t.wizard.step3.attemptsLabel}
          </Mono>
          <Mono size={11} color="var(--fg-2)">
            {String(attempts)}
          </Mono>

          {lastError ? (
            <>
              <Mono size={11} color="var(--fg-3)">
                {t.wizard.step3.lastErrorLabel}
              </Mono>
              <Mono size={11} color="var(--red)">
                {lastError}
              </Mono>
            </>
          ) : null}
        </div>

        {polling.error ? (
          <Mono size={11} color="var(--red)">
            {t.wizard.step3.networkError}
          </Mono>
        ) : null}

        <div style={{ marginTop: 6 }}>
          <Btn
            kind="ghost"
            size="sm"
            onClick={() => void polling.refetch()}
            disabled={expired || state.dnsVerified}
          >
            {t.wizard.step3.checkNow}
          </Btn>
        </div>
      </section>

      {/* ── Stall / contact-support CTA ──────────────────────────────── */}
      {(stallHint || expired) && !state.dnsVerified ? (
        <section style={SECTION_STYLE}>
          <Mono size={11} color="var(--fg-3)">
            {expired
              ? t.wizard.step3.supportExpired
              : t.wizard.step3.supportStall}
          </Mono>
          <div>
            <a
              href={SUPPORT_TELEGRAM_URL}
              target="_blank"
              rel="noreferrer noopener"
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 13,
                color: 'var(--fg)',
                textDecoration: 'underline',
              }}
              data-testid="wizard-step3-support-link"
            >
              {t.wizard.step3.supportContact}
            </a>
          </div>
        </section>
      ) : null}

      {state.loading ? (
        <Mono size={11} color="var(--fg-2)">
          {t.wizard.step3.saving}
        </Mono>
      ) : null}
    </div>
  );
};

export default Step3DnsVerify;
