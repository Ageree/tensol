import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';
import { checkout } from '../api/billing.ts';
import { launchScan } from '../api/scans.ts';
import { type Target, listTargets } from '../api/targets.ts';

type Tier = 'light' | 'medium' | 'aggressive';

interface Props {
  projectId: string;
  onScanLaunched: (scanId: string) => void;
  onBack: () => void;
}

export const ScanWizardPage = ({ projectId, onScanLaunched, onBack }: Props) => {
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [tier, setTier] = useState<Tier>('light');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['targets', projectId],
    queryFn: () => listTargets(projectId),
  });

  const targets: Target[] = data?.targets ?? [];
  const verifiedTargets = targets.filter((t) => t.ownershipStatus === 'verified');

  const toggleTarget = (id: string) => {
    setSelectedTargetIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleLaunch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedTargetIds.length === 0) {
      setError('Select at least one verified target.');
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      await checkout(tier);
      const result = await launchScan({
        project_id: projectId,
        tier,
        target_ids: selectedTargetIds,
      });
      onScanLaunched(result.scan_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Launch failed';
      setError(msg);
    } finally {
      setLaunching(false);
    }
  };

  if (isLoading) return <p data-testid="scan-wizard-loading">Loading targets...</p>;

  return (
    <div data-testid="scan-wizard-page">
      <h1>New Scan</h1>
      <button type="button" onClick={onBack} data-testid="scan-wizard-back">
        Back
      </button>

      <form onSubmit={handleLaunch} data-testid="scan-wizard-form">
        <section>
          <h2>1. Select Verified Targets</h2>
          {verifiedTargets.length === 0 ? (
            <p data-testid="no-verified-targets">
              No verified targets. Verify ownership of targets before launching a scan.
            </p>
          ) : (
            <ul data-testid="target-list">
              {verifiedTargets.map((t) => (
                <li key={t.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedTargetIds.includes(t.id)}
                      onChange={() => toggleTarget(t.id)}
                      data-testid={`target-checkbox-${t.id}`}
                    />
                    {t.value} ({t.kind})
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>2. Select Tier</h2>
          {(['light', 'medium', 'aggressive'] as Tier[]).map((t) => (
            <label key={t}>
              <input
                type="radio"
                name="tier"
                value={t}
                checked={tier === t}
                onChange={() => setTier(t)}
                data-testid={`tier-radio-${t}`}
              />
              {t}
            </label>
          ))}
        </section>

        <section>
          <h2>3. Billing</h2>
          <p>
            Selecting a tier will activate your subscription for this tier (no payment required in
            v1).
          </p>
        </section>

        {error && (
          <p data-testid="scan-wizard-error" style={{ color: 'red' }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={launching || selectedTargetIds.length === 0}
          data-testid="scan-wizard-submit"
        >
          {launching ? 'Launching...' : 'Launch Scan'}
        </button>
      </form>
    </div>
  );
};
