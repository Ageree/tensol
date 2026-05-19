// T078 — Step 1 placeholder. T079 fleshes out the attack-surface UI
// (domain entry, subdomain selection, global headers — FR-006).
import type { ReactElement } from 'react';
import { Mono } from '../../components/primitives.tsx';
import type { ScanWizardStateApi } from './useScanWizardState.ts';

export interface Step1AttackSurfaceProps {
  readonly api: ScanWizardStateApi;
}

export const Step1AttackSurface = ({ api }: Step1AttackSurfaceProps): ReactElement => {
  void api;
  return (
    <div style={{ padding: 24 }}>
      <Mono size={12} color="var(--fg-2)">
        Step 1 — Attack Surface — TODO (T079)
      </Mono>
    </div>
  );
};

export default Step1AttackSurface;
