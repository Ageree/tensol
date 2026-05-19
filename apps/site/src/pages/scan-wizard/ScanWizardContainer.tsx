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
// URLs:
//   /wizard/new                       — create draft, redirect to /:id/step-1
//   /wizard/:orderId/step-:stepIndex — render given step
//
// Constitution V: NO SSE — DNS-verify uses the polling primitive (T075).
// Constitution IX: server-side Zod is canonical; this UI mirrors snake_case.

import { useEffect, type ReactElement } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/AppShell.tsx';
import { RouteHead } from '../../components/RouteHead.tsx';
import { Btn, Mono } from '../../components/primitives.tsx';
import { useTensol } from '../../context.tsx';
import { ApiError, scanOrders } from '../../lib/api-client.ts';
import { Step1AttackSurface } from './Step1AttackSurface.tsx';
import { Step2Safety } from './Step2Safety.tsx';
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

const parseStep = (raw: string | undefined): WizardStep | null => {
  if (!raw) return null;
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
        navigate(`/wizard/${order.id}/step-1`, { replace: true });
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
    navigate(`/wizard/${state.orderId}/step-${next}`);
  };

  const onBack = (): void => {
    if (state.step <= 1) return;
    goToStep((state.step - 1) as WizardStep);
  };

  // `Next` placeholder: each Step{N} component will own its own primary CTA
  // (which performs the relevant write before advancing). Container exposes
  // a generic Next as a fallback that just moves the URL — steps will
  // override behavior via their own buttons. For now we keep it disabled on
  // step 4 (which uses Launch, not Next).
  const onNext = (): void => {
    if (state.step >= STEP_COUNT) return;
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
    return <Navigate to={`/wizard/${params.orderId}/step-1`} replace />;
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
        return <Navigate to={`/wizard/${params.orderId}/step-1`} replace />;
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
              onClick={onNext}
              disabled={state.loading}
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
