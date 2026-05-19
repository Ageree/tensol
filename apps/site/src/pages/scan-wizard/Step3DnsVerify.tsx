// T078 — Step 3 placeholder. T082 fleshes out the TXT-token poll loop using
// usePolling (T075) per FR-008 / FR-009.
import type { ReactElement } from 'react';
import { Mono } from '../../components/primitives.tsx';
import type { ScanWizardStateApi } from './useScanWizardState.ts';

export interface Step3DnsVerifyProps {
  readonly api: ScanWizardStateApi;
}

export const Step3DnsVerify = ({ api }: Step3DnsVerifyProps): ReactElement => {
  void api;
  return (
    <div style={{ padding: 24 }}>
      <Mono size={12} color="var(--fg-2)">
        Step 3 — DNS Verify — TODO (T082)
      </Mono>
    </div>
  );
};

export default Step3DnsVerify;
