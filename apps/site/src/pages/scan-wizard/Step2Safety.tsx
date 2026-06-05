// T080 — Step 2: Safety / RPS budget (FR-007).
//
// Drives:
//   - Three preset chips (Safe = 10, Default = 50, Aggressive = 200).
//   - A continuous slider over the full server-allowed range [1..500].
//   - A numeric override that mirrors the slider and accepts direct input.
//
// Commit happens through the container's primary Next button. The wire
// shape (`{ safety_rps: number }`) matches `UpdateSafetyBodySchema` in
// `server/src/schemas/scan-orders.ts` (1..500 integer).
//
// Constitution VII: ≤ 800 LOC. Constitution IX: client validates loosely;
// the server-side Zod is the source of truth.

import type { CSSProperties, ReactElement } from 'react';
import { Btn, Field, Input, Mono } from '../../components/primitives.tsx';
import { TENSOL_I18N } from '../../i18n.ts';
import type { ScanWizardStateApi } from './useScanWizardState.ts';

export interface Step2SafetyProps {
  readonly api: ScanWizardStateApi;
}

export const RPS_MIN = 1 as const;
export const RPS_MAX = 500 as const;

export interface RpsPreset {
  readonly key: 'safe' | 'default' | 'aggressive';
  readonly value: number;
}

export const RPS_PRESETS: readonly RpsPreset[] = [
  { key: 'safe', value: 10 },
  { key: 'default', value: 50 },
  { key: 'aggressive', value: 200 },
] as const;

export function clampRps(value: number): number {
  if (!Number.isFinite(value)) return RPS_MIN;
  const i = Math.round(value);
  if (i < RPS_MIN) return RPS_MIN;
  if (i > RPS_MAX) return RPS_MAX;
  return i;
}

export function isValidRps(value: number): boolean {
  return (
    Number.isInteger(value) && value >= RPS_MIN && value <= RPS_MAX
  );
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

const CHIP_ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 12,
};

const SLIDER_STYLE: CSSProperties = {
  width: '100%',
  accentColor: 'var(--fg)',
};

// Preset label resolver — kept inline so we don't pay the cost of a memo
// for three string lookups.
function presetLabel(
  t: typeof TENSOL_I18N.en,
  key: RpsPreset['key'],
): string {
  if (key === 'safe') return t.wizard.step2.presetSafe;
  if (key === 'default') return t.wizard.step2.presetDefault;
  return t.wizard.step2.presetAggressive;
}

function presetHint(
  t: typeof TENSOL_I18N.en,
  key: RpsPreset['key'],
): string {
  if (key === 'safe') return t.wizard.step2.presetSafeHint;
  if (key === 'default') return t.wizard.step2.presetDefaultHint;
  return t.wizard.step2.presetAggressiveHint;
}

export const Step2Safety = ({ api }: Step2SafetyProps): ReactElement => {
  const t = TENSOL_I18N.en;
  const { state, dispatch } = api;

  const activePreset = RPS_PRESETS.find((p) => p.value === state.rps) ?? null;
  const rpsValid = isValidRps(state.rps);

  const onSetRps = (next: number): void => {
    dispatch({ type: 'setRps', payload: clampRps(next) });
  };

  const onOverrideChange = (raw: string): void => {
    // Allow empty string transiently → snap to RPS_MIN. We never write a
    // non-integer to state (Zod rejects it at the server boundary anyway).
    if (raw === '') {
      dispatch({ type: 'setRps', payload: RPS_MIN });
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    dispatch({ type: 'setRps', payload: clampRps(parsed) });
  };

  return (
    <div style={PAGE_STYLE}>
      <section style={SECTION_STYLE}>
        <Mono
          size={11}
          color="var(--fg-2)"
          style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
        >
          {t.wizard.step2.rpsLabel}
        </Mono>
        <Mono size={11} color="var(--fg-3)">
          {t.wizard.step2.rpsHint}
        </Mono>

        {/* ── Preset chips ──────────────────────────────────────────── */}
        <div style={CHIP_ROW_STYLE}>
          {RPS_PRESETS.map((p) => {
            const isActive = activePreset?.key === p.key;
            return (
              <div
                key={p.key}
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <Btn
                  kind={isActive ? 'primary' : 'secondary'}
                  size="md"
                  fullWidth
                  onClick={() => onSetRps(p.value)}
                  title={presetHint(t, p.key)}
                >
                  {`${presetLabel(t, p.key)} · ${p.value}`}
                </Btn>
                <Mono size={11} color="var(--fg-3)">
                  {presetHint(t, p.key)}
                </Mono>
              </div>
            );
          })}
        </div>

        {/* ── Slider ────────────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            marginTop: 4,
          }}
        >
          <input
            type="range"
            min={RPS_MIN}
            max={RPS_MAX}
            step={1}
            value={state.rps}
            onChange={(e) => onSetRps(Number.parseInt(e.target.value, 10))}
            style={SLIDER_STYLE}
            data-testid="wizard-step2-rps-slider"
            aria-label={t.wizard.step2.rpsLabel}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: 'var(--fg-3)',
            }}
          >
            <span>{RPS_MIN}</span>
            <span>{RPS_MAX}</span>
          </div>
        </div>
      </section>

      {/* ── Numeric override ─────────────────────────────────────────── */}
      <section style={SECTION_STYLE}>
        <Field
          label={t.wizard.step2.overrideLabel}
          error={rpsValid ? undefined : t.wizard.step2.errRange}
        >
          <Input
            type="number"
            min={RPS_MIN}
            max={RPS_MAX}
            step={1}
            value={String(state.rps)}
            error={!rpsValid}
            onChange={(e) => onOverrideChange(e.target.value)}
            data-testid="wizard-step2-rps-override"
          />
        </Field>
      </section>

      {state.loading ? (
        <Mono size={11} color="var(--fg-2)">
          {t.wizard.step2.saving}
        </Mono>
      ) : null}
    </div>
  );
};

export default Step2Safety;
