// T078 — Step 2 placeholder. T080 fleshes out the safety/RPS slider (FR-007).
import type { ReactElement } from 'react';
import { Mono } from '../../components/primitives.tsx';
import type { ScanWizardStateApi } from './useScanWizardState.ts';

export interface Step2SafetyProps {
  readonly api: ScanWizardStateApi;
}

export const Step2Safety = ({ api }: Step2SafetyProps): ReactElement => {
  void api;
  return (
    <div style={{ padding: 24 }}>
      <Mono size={12} color="var(--fg-2)">
        Step 2 — Safety — TODO (T080)
      </Mono>
    </div>
  );
};

export default Step2Safety;
