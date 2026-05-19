// T078 — Scan Wizard Container (Blackbox MVP, FR-004 .. FR-009).
//
// 4-step stepper that drives Quick-scan order creation:
//   1. Attack Surface (T079)
//   2. Safety        (T080)
//   3. DNS Verify    (T082)
//   4. Review/Launch (T083)
//
// This file owns: routing-aware step selection, reducer wiring, refresh
// hydration, and the Cancel button (DELETE /v1/scan-orders/:id then nav to
// /dashboard). Step content lives in sibling Step{1..4}*.tsx files; they
// receive a `{state, dispatch}` API and own their own validation + writes.
//
// URLs (T083, canonical):
//   /scan/new                                       — create draft, redirect
//   /scan/new/:orderId/{surface|safety|verify|launch} — render given step
//
// Constitution V: NO SSE — DNS-verify uses the polling primitive (T075).
// Constitution IX: server-side Zod is canonical; this UI mirrors snake_case.

import { useEffect, type ReactElement } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/AppShell.tsx';
import { RouteHead } from '../../components/RouteHead.tsx';
import { Btn, Mono } from '../../components/primitives.tsx';
import { useTensol } from '../../context.tsx';
import {
  ApiError,
  scanOrders,
  type AttackSurfaceEntry,
} from '../../lib/api-client.ts';
import { isValidHostname, Step1AttackSurface } from './Step1AttackSurface.tsx';
import { isValidRps, Step2Safety } from './Step2Safety.tsx';
import { Step3DnsVerify } from './Step3DnsVerify.tsx';
import { Step4Review } from './Step4Review.tsx';
import {
  hydrateFromOrder,
  useScanWizardState,
  type WizardStep,
} from './useScanWizardState.ts';

export type WizardMode = 'create' | 'edit';

export interface ScanWizardContainerProps {
  readonly mode: WizardMode;
}

const STEP_COUNT = 4 as const;

/**
 * Gate the container's Next button based on the active step's minimum
 * client-side prerequisites. The server still validates with Zod (canonical
 * per Constitution IX); this only avoids obvious round-trips.
 */
function nextEnabled(
  step: WizardStep,
  state: ReturnType<typeof useScanWizardState>['state'],
): boolean {
  if (step === 1) return isValidHostname(state.domain.trim().toLowerCase());
  if (step === 2) return isValidRps(state.rps);
  if (step === 3) return state.dnsVerified;
  return true;
}

// T083: canonical path segments are surface/safety/verify/launch. We also
// accept the legacy step-1..step-4 form so old links keep working.
const STEP_SLUG_TO_NUM: Record<string, WizardStep> = {
  surface: 1,
  safety: 2,
  verify: 3,
  launch: 4,
};

const STEP_NUM_TO_SLUG: Record<WizardStep, string> = {
  1: 'surface',
  2: 'safety',
  3: 'verify',
  4: 'launch',
};

const parseStep = (raw: string | undefined): WizardStep | null => {
  if (!raw) return null;
  const slug = STEP_SLUG_TO_NUM[raw];
  if (slug) return slug;
  const match = /^step-([1-4])$/.exec(raw);
  if (!match) return null;
  const n = Number(match[1]);
  if (n === 1 || n === 2 || n === 3 || n === 4) return n;
  return null;
};

const stepLabels = (t: ReturnType<typeof useTensol>['t']): string[] => [
  t.wizard.step1Title,
  t.wizard.step2Title,
  t.wizard.step3Title,
  t.wizard.step4Title,
];

// ─── Stepper bar ───────────────────────────────────────────────────────────

interface StepperProps {
  readonly active: WizardStep;
  readonly labels: string[];
}

const Stepper = ({ active, labels }: StepperProps): ReactElement => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${STEP_COUNT}, 1fr)`,
      gap: 12,
      padding: '20px 24px',
      borderBottom: '1px solid var(--line-soft)',
    }}
  >
    {labels.map((label, idx) => {
      const stepNum = (idx + 1) as WizardStep;
      const isActive = stepNum === active;
      const isDone = stepNum < active;
      const color = isActive
        ? 'var(--fg)'
        : isDone
          ? 'var(--fg-2)'
          : 'var(--fg-3)';
      return (
        <div
          key={label}
          style={{
            paddingTop: 8,
            borderTop: `2px solid ${
              isActive ? 'var(--red)' : isDone ? 'var(--fg-2)' : 'var(--line-soft)'
            }`,
          }}
        >
          <Mono
            size={10.5}
            color={color}
            style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}
          >
            {`0${stepNum}`}
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

// ─── Container ─────────────────────────────────────────────────────────────

export const ScanWizardContainer = ({
  mode,
}: ScanWizardContainerProps): ReactElement => {
  const { t } = useTensol();
  const navigate = useNavigate();
  const params = useParams<{ orderId?: string; step?: string }>();
  const api = useScanWizardState();
  const { state, dispatch } = api;

  // ── Mode `create`: POST /v1/scan-orders then redirect to step-1 ──
  useEffect(() => {
    if (mode !== 'create') return;
    let cancelled = false;
    const run = async (): Promise<void> => {
      dispatch({ type: 'loading', payload: true });
      try {
        // Domain is empty at draft-create; T079 PUTs it via attack-surface.
        // Backend allows an empty primary_domain on draft creation; if not,
        // T079 will surface the 422 inline.
        const order = await scanOrders.create({
          tier: 'quick',
          primary_domain: '',
        });
        if (cancelled) return;
        navigate(`/scan/new/${order.id}/${STEP_NUM_TO_SLUG[1]}`, {
          replace: true,
        });
      } catch (err) {
        if (cancelled) return;
        const code = err instanceof ApiError ? err.code : 'unknown_error';
        dispatch({ type: 'error', payload: code });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // navigate is stable; dispatch is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Mode `edit`: GET /v1/scan-orders/:id → hydrate reducer ──
  useEffect(() => {
    if (mode !== 'edit') return;
    if (!params.orderId) return;
    if (state.orderId === params.orderId) return; // already hydrated
    let cancelled = false;
    const run = async (): Promise<void> => {
      dispatch({ type: 'loading', payload: true });
      try {
        const order = await scanOrders.get(params.orderId!);
        if (cancelled) return;
        dispatch({ type: 'loaded', payload: hydrateFromOrder(order) });
        dispatch({ type: 'loading', payload: false });
      } catch (err) {
        if (cancelled) return;
        const code = err instanceof ApiError ? err.code : 'unknown_error';
        dispatch({ type: 'error', payload: code });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, params.orderId]);

  // ── URL → reducer step sync ──
  const urlStep = parseStep(params.step);
  useEffect(() => {
    if (urlStep && urlStep !== state.step) {
      dispatch({ type: 'stepTo', payload: urlStep });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlStep]);

  // ── Step 3 fallback entry: request DNS token if the user lands on
  // step 3 via direct URL/refresh without one. Idempotent on the server.
  useEffect(() => {
    if (urlStep !== 3) return;
    if (!state.orderId) return;
    if (state.dnsToken) return;
    if (state.loading) return;
    let cancelled = false;
    const run = async (): Promise<void> => {
      dispatch({ type: 'loading', payload: true });
      try {
        const result = await scanOrders.requestDnsVerify(state.orderId!);
        if (cancelled) return;
        dispatch({ type: 'dnsToken', payload: result.token });
        dispatch({ type: 'loading', payload: false });
      } catch (err) {
        if (cancelled) return;
        const code = err instanceof ApiError ? err.code : 'unknown_error';
        dispatch({ type: 'error', payload: code });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlStep, state.orderId, state.dnsToken]);

  // ── Cancel: DELETE order, then back to dashboard ──
  const onCancel = async (): Promise<void> => {
    if (!state.orderId) {
      navigate('/dashboard');
      return;
    }
    dispatch({ type: 'loading', payload: true });
    try {
      await scanOrders.cancel(state.orderId);
    } catch {
      // Even if cancel fails (already cancelled / not found), we still leave
      // the wizard — silent best-effort. Server is the source of truth.
    }
    navigate('/dashboard');
  };

  // ── Navigation between steps ──
  const goToStep = (next: WizardStep): void => {
    if (!state.orderId) return;
    navigate(`/scan/new/${state.orderId}/${STEP_NUM_TO_SLUG[next]}`);
  };

  const onBack = (): void => {
    if (state.step <= 1) return;
    goToStep((state.step - 1) as WizardStep);
  };

  // `Next` performs the per-step commit before navigating. Step components
  // own their own form fields + validation hints; the container is the only
  // place that touches the server so loading/error state remains unified.
  // Step 1: PUT /v1/scan-orders/:id/attack-surface
  // Step 2: PUT /v1/scan-orders/:id/safety
  // Step 3: T082 (DNS poll) — no commit on Next, but the polling primitive
  //         must have reported `dnsVerified` before we advance.
  // Step 4: uses Launch, not Next (handled inside the step).
  const commitStep1 = async (): Promise<boolean> => {
    if (!state.orderId) return false;
    const trimmedDomain = state.domain.trim().toLowerCase();
    if (!isValidHostname(trimmedDomain)) {
      dispatch({ type: 'error', payload: 'invalid_domain' });
      return false;
    }
    // Build attack_surface array — exactly one primary entry + opted-in subs.
    // Global headers attach to the primary entry per FR-006.
    const primary: AttackSurfaceEntry = {
      domain: trimmedDomain,
      primary: true,
      headers: state.headers,
    };
    const subEntries: AttackSurfaceEntry[] = state.subdomains
      .map((s) => s.trim().toLowerCase())
      .filter((s) => isValidHostname(s) && s !== trimmedDomain)
      .map((s) => ({ domain: s, primary: false, headers: [] }));
    const entries: AttackSurfaceEntry[] = [primary, ...subEntries];

    dispatch({ type: 'loading', payload: true });
    try {
      const order = await scanOrders.updateAttackSurface(state.orderId, {
        attack_surface: entries,
      });
      dispatch({ type: 'loaded', payload: hydrateFromOrder(order) });
      dispatch({ type: 'loading', payload: false });
      return true;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown_error';
      dispatch({ type: 'error', payload: code });
      return false;
    }
  };

  const commitStep2 = async (): Promise<boolean> => {
    if (!state.orderId) return false;
    if (!isValidRps(state.rps)) {
      dispatch({ type: 'error', payload: 'invalid_rps' });
      return false;
    }
    dispatch({ type: 'loading', payload: true });
    try {
      const order = await scanOrders.updateSafety(state.orderId, {
        safety_rps: state.rps,
      });
      dispatch({ type: 'loaded', payload: hydrateFromOrder(order) });
      dispatch({ type: 'loading', payload: false });
      return true;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown_error';
      dispatch({ type: 'error', payload: code });
      return false;
    }
  };

  // Step 3 entry: POST /v1/scan-orders/:id/dns-verify/request once. Idempotent
  // on the server side — re-requesting returns the same token while the
  // verification window is open. Step3DnsVerify then drives the 5s poll loop.
  const commitStep3Entry = async (): Promise<boolean> => {
    if (!state.orderId) return false;
    if (state.dnsToken) return true; // already issued — Step3 will poll
    dispatch({ type: 'loading', payload: true });
    try {
      const result = await scanOrders.requestDnsVerify(state.orderId);
      dispatch({ type: 'dnsToken', payload: result.token });
      dispatch({ type: 'loading', payload: false });
      return true;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown_error';
      dispatch({ type: 'error', payload: code });
      return false;
    }
  };

  const onNext = async (): Promise<void> => {
    if (state.step >= STEP_COUNT) return;
    if (state.step === 1) {
      const ok = await commitStep1();
      if (!ok) return;
    } else if (state.step === 2) {
      const ok = await commitStep2();
      if (!ok) return;
      // Eagerly request the DNS token so Step 3 has it on first render.
      const ok3 = await commitStep3Entry();
      if (!ok3) return;
    }
    // Step 3 → 4: Next advances once `dnsVerified` is true (gated by
    // nextEnabled). Step 4 launches via its own button, no Next.
    goToStep((state.step + 1) as WizardStep);
  };

  // ── Routing guards ──
  if (mode === 'create') {
    if (state.error) {
      return (
        <AppShell breadcrumb={['wizard', 'new']}>
          <RouteHead title="Tensol · New scan" />
          <div style={{ padding: 24 }}>
            <Mono size={12} color="var(--red)">
              {`${t.wizard.errCreate}: ${state.error}`}
            </Mono>
            <div style={{ marginTop: 16 }}>
              <Btn kind="ghost" size="md" onClick={() => navigate('/dashboard')}>
                {t.wizard.cancel}
              </Btn>
            </div>
          </div>
        </AppShell>
      );
    }
    return (
      <AppShell breadcrumb={['wizard', 'new']}>
        <RouteHead title="Tensol · New scan" />
        <div style={{ padding: 24 }}>
          <Mono size={12} color="var(--fg-2)">
            {t.wizard.creating}
          </Mono>
        </div>
      </AppShell>
    );
  }

  // mode === 'edit'
  if (!params.orderId) return <Navigate to="/dashboard" replace />;
  if (!urlStep) {
    return (
      <Navigate
        to={`/scan/new/${params.orderId}/${STEP_NUM_TO_SLUG[1]}`}
        replace
      />
    );
  }

  const labels = stepLabels(t);
  const renderStep = (): ReactElement => {
    switch (state.step) {
      case 1:
        return <Step1AttackSurface api={api} />;
      case 2:
        return <Step2Safety api={api} />;
      case 3:
        return <Step3DnsVerify api={api} />;
      case 4:
        return <Step4Review api={api} />;
      default:
        return (
      <Navigate
        to={`/scan/new/${params.orderId}/${STEP_NUM_TO_SLUG[1]}`}
        replace
      />
    );
    }
  };

  return (
    <AppShell
      breadcrumb={['wizard', params.orderId, `step-${state.step}`]}
      actions={
        <Btn kind="ghost" size="sm" onClick={() => void onCancel()}>
          {t.wizard.cancel}
        </Btn>
      }
    >
      <RouteHead title={`Tensol · ${labels[state.step - 1]}`} />
      <Stepper active={state.step} labels={labels} />

      {state.error ? (
        <div
          style={{
            padding: '12px 24px',
            borderBottom: '1px solid var(--line-soft)',
          }}
        >
          <Mono size={11} color="var(--red)">
            {`${t.wizard.errGeneric}: ${state.error}`}
          </Mono>
        </div>
      ) : null}

      {renderStep()}

      <div
        style={{
          display: 'flex',
          gap: 12,
          justifyContent: 'space-between',
          padding: '20px 24px',
          borderTop: '1px solid var(--line-soft)',
        }}
      >
        <Btn
          kind="ghost"
          size="md"
          onClick={onBack}
          disabled={state.step <= 1 || state.loading}
        >
          {t.wizard.back}
        </Btn>
        <div style={{ display: 'flex', gap: 12 }}>
          <Btn kind="ghost" size="md" onClick={() => void onCancel()}>
            {t.wizard.cancel}
          </Btn>
          {state.step < STEP_COUNT ? (
            <Btn
              kind="primary"
              size="md"
              onClick={() => void onNext()}
              disabled={state.loading || !nextEnabled(state.step, state)}
            >
              {t.wizard.next}
            </Btn>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
};

export default ScanWizardContainer;
