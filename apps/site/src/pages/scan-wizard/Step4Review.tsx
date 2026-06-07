// T082 — Step 4: Review & Launch (FR-009 / FR-010 / FR-014).
//
// Drives:
//   - Summary card recapping the wizard inputs (domain, subdomains count,
//     headers count, safety RPS, DNS verified flag).
//   - Free-quota status panel — derived from the latest GET /v1/scan-orders/
//     :id payload. `payment_kind` / `amount_kopecks` are legacy pre-pivot
//     fields; future billing should use provider-agnostic entitlements.
//   - Feature-flag gate via GET /v1/config/feature-flags (T073):
//       * legacy `yookassa_live=false` (MVP default) → free Quick launch CTA
//         (calls scanOrders.launch).
//       * paid billing flag true AND quota exhausted → paid checkout CTA
//         (disabled in MVP — future provider-agnostic feature copy).
//   - On launch success (POST /v1/scan-orders/:id/launch 202 → `{scan_id}`),
//     navigates to `/scan/:scanId` (T087's Live page).
//
// Constitution VII: ≤ 800 LOC.
// Constitution IX: server-side Zod canonical; UI mirrors snake_case.

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, Mono } from '../../components/primitives.tsx';
import { TENSOL_I18N } from '../../i18n.ts';
import {
  ApiError,
  config,
  scanOrders,
  type FeatureFlags,
} from '../../lib/api-client.ts';
import type { ScanWizardStateApi } from './useScanWizardState.ts';

export interface Step4ReviewProps {
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
  gap: 10,
  background: 'var(--bg)',
};

const ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '200px 1fr',
  gap: 12,
  alignItems: 'center',
};

interface SummaryRowProps {
  readonly label: string;
  readonly value: string;
  readonly testId?: string;
}

const SummaryRow = ({ label, value, testId }: SummaryRowProps): ReactElement => (
  <div style={ROW_STYLE}>
    <Mono size={11} color="var(--fg-2)">
      {label}
    </Mono>
    <Mono size={13} color="var(--fg)" {...(testId ? { 'data-testid': testId } : {})}>
      {value}
    </Mono>
  </div>
);

// ─── Component ─────────────────────────────────────────────────────────────

export const Step4Review = ({ api }: Step4ReviewProps): ReactElement => {
  const t = TENSOL_I18N.en;
  const navigate = useNavigate();
  const { state, dispatch } = api;

  const [flags, setFlags] = useState<FeatureFlags | null>(null);
  const [flagsError, setFlagsError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<boolean>(false);
  const [launchErr, setLaunchErr] = useState<string | null>(null);

  // ── Feature-flag fetch (one-shot, on mount) ──
  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const ff = await config.getFeatureFlags();
        if (cancelled) return;
        setFlags(ff);
      } catch (err) {
        if (cancelled) return;
        const code = err instanceof ApiError ? err.code : 'unknown_error';
        setFlagsError(code);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Quota: in MVP, every authenticated user is allowed one free Quick.
  // The current REST shape still exposes legacy `payment_kind` /
  // `amount_kopecks`; the future billing model should use entitlements.
  const quotaAvailable = useMemo<boolean>(() => {
    return true; // MVP default — first scan is free.
  }, []);

  const legacyPaidFlag = flags?.yookassa_live === true;
  // CTA mode: paid only when feature-flag is live AND quota exhausted.
  const ctaMode: 'free' | 'paid' = legacyPaidFlag && !quotaAvailable
    ? 'paid'
    : 'free';

  // ── Launch handler ──
  const onLaunch = async (): Promise<void> => {
    if (!state.orderId) return;
    if (!state.dnsVerified) {
      dispatch({ type: 'error', payload: 'dns_not_verified' });
      return;
    }
    setLaunching(true);
    setLaunchErr(null);
    try {
      const result = await scanOrders.launch(state.orderId);
      navigate(`/scan/${result.scan_id}`);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown_error';
      setLaunchErr(code);
    } finally {
      setLaunching(false);
    }
  };

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

  return (
    <div style={PAGE_STYLE}>
      {/* ── Summary card ─────────────────────────────────────────────── */}
      <section style={SECTION_STYLE}>
        <Mono
          size={11}
          color="var(--fg-2)"
          style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {t.wizard.step4.summaryLabel}
        </Mono>
        <div style={CARD_STYLE} data-testid="wizard-step4-summary-card">
          <SummaryRow
            label={t.wizard.step4.domainLabel}
            value={state.domain}
            testId="wizard-step4-domain"
          />
          <SummaryRow
            label={t.wizard.step4.subdomainsLabel}
            value={String(state.subdomains.length)}
            testId="wizard-step4-subdomains-count"
          />
          <SummaryRow
            label={t.wizard.step4.headersLabel}
            value={String(state.headers.length)}
            testId="wizard-step4-headers-count"
          />
          <SummaryRow
            label={t.wizard.step4.rpsLabel}
            value={String(state.rps)}
            testId="wizard-step4-rps"
          />
          <SummaryRow
            label={t.wizard.step4.dnsVerifiedLabel}
            value={
              state.dnsVerified
                ? t.wizard.step4.dnsVerifiedTrue
                : t.wizard.step4.dnsVerifiedFalse
            }
            testId="wizard-step4-dns-verified"
          />
        </div>
      </section>

      {/* ── Free quota status ────────────────────────────────────────── */}
      <section style={SECTION_STYLE}>
        <Mono
          size={11}
          color="var(--fg-2)"
          style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {t.wizard.step4.quotaLabel}
        </Mono>
        <Mono
          size={12}
          color={quotaAvailable ? 'var(--fg)' : 'var(--fg-3)'}
        >
          {quotaAvailable
            ? t.wizard.step4.quotaAvailable
            : t.wizard.step4.quotaExhausted}
        </Mono>
      </section>

      {/* ── Feature-flag status (debug-ish; helps with sandbox testing) */}
      {flagsError ? (
        <Mono size={11} color="var(--red)">
          {t.wizard.step4.flagsError}: {flagsError}
        </Mono>
      ) : null}

      {/* ── Launch CTA ──────────────────────────────────────────────── */}
      <section style={SECTION_STYLE}>
        {!state.dnsVerified ? (
          <Mono size={12} color="var(--red)">
            {t.wizard.step4.dnsNotVerifiedHint}
          </Mono>
        ) : null}

        <div>
          {ctaMode === 'paid' ? (
            <Btn
              kind="primary"
              size="lg"
              disabled
              title={t.wizard.step4.paidNotYet}
            >
              {t.wizard.step4.launchPaid}
            </Btn>
          ) : (
            <Btn
              kind="primary"
              size="lg"
              onClick={() => void onLaunch()}
              disabled={launching || !state.dnsVerified}
              data-testid="wizard-step4-launch-btn"
            >
              {launching
                ? t.wizard.step4.launching
                : t.wizard.step4.launchFree}
            </Btn>
          )}
        </div>

        {ctaMode === 'paid' ? (
          <Mono size={11} color="var(--fg-3)">
            {t.wizard.step4.paidNotYet}
          </Mono>
        ) : null}

        {launchErr ? (
          <Mono size={11} color="var(--red)">
            {t.wizard.step4.launchError}: {launchErr}
          </Mono>
        ) : null}
      </section>
    </div>
  );
};

export default Step4Review;
