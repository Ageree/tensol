// T078 — Step 4 placeholder. T083 fleshes out review + launch (POST
// /v1/scan-orders/:id/launch → redirect to /live).
import type { ReactElement } from 'react';
import { Mono } from '../../components/primitives.tsx';
import type { ScanWizardStateApi } from './useScanWizardState.ts';

export interface Step4ReviewProps {
  readonly api: ScanWizardStateApi;
}

export const Step4Review = ({ api }: Step4ReviewProps): ReactElement => {
  void api;
  return (
    <div style={{ padding: 24 }}>
      <Mono size={12} color="var(--fg-2)">
        Step 4 — Review &amp; Launch — TODO (T083)
      </Mono>
    </div>
  );
};

export default Step4Review;
