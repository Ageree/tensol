// ReviewDetail — single-review detail page for Sthrip Review.
//
// URL: /reviews/:id
//
// Renders:
//   - Header: kind badge + repo + PR#, score badge, status chip
//   - summary_md via MarkdownRenderer
//   - Findings grouped by severity (critical → informational)
//     Each finding card: severity, title, file_path:start_line, category,
//     CVSS + confidence + reachable chips, CWE tags, rationale_md,
//     collapsible poc_md + fix_prompt_md
//   - Polling when status is queued/running (3s cadence via usePolling)

import { useCallback, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { DashboardPage } from '../components/dashboard-ui.tsx';
import { MarkdownRenderer } from '../components/MarkdownRenderer.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Eyebrow, Mono, SeverityChip, StatusChip } from '../components/primitives.tsx';
import { TENSOL_I18N } from '../i18n.ts';
import {
  ApiError,
  type ExploitStatus,
  type FindingConfidence,
  type ReviewFindingWire,
  type ReviewKind,
  type ReviewResultWire,
  type ReviewRunStatus,
  type Severity,
  type VerificationStatus,
} from '../lib/api-client.ts';
import { apiClient } from '../lib/api-client.ts';
import { usePolling } from '../lib/poll.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const REVIEW_POLL_MS = 3000;

const SEV_ORDER: readonly Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'informational',
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ChipSev = 'critical' | 'high' | 'medium' | 'low' | 'info';

function toChipSev(s: Severity): ChipSev {
  return s === 'informational' ? 'info' : s;
}

type KindTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'muted' | 'inverse';

function kindTone(kind: ReviewKind | undefined): KindTone {
  if (kind === 'pr') return 'neutral';
  if (kind === 'whitebox') return 'inverse';
  return 'muted';
}

function kindLabel(
  kind: ReviewKind | undefined,
  labels: { readonly kindPr: string; readonly kindWhitebox: string },
): string {
  if (kind === 'pr') return labels.kindPr;
  if (kind === 'whitebox') return labels.kindWhitebox;
  return '—';
}

function statusTone(status: ReviewRunStatus): KindTone {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'muted';
  return 'warn';
}

function isTerminal(status: ReviewRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function scoreColor(score: number): string {
  if (score >= 5) return '#0E5E2A';
  if (score >= 3) return '#7A5A05';
  return 'var(--red)';
}

function scoreBg(score: number): string {
  if (score >= 5) return '#E5F4EB';
  if (score >= 3) return '#FBF1D9';
  return '#FEE2E2';
}

function scoreBorder(score: number): string {
  if (score >= 5) return '#1F7A3A';
  if (score >= 3) return '#B8860B';
  return 'var(--red)';
}

// ─── Score badge ──────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number | null | undefined }): ReactElement {
  if (score == null) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 22,
          fontWeight: 600,
          padding: '4px 14px',
          background: 'var(--bg)',
          color: 'var(--fg-3)',
          border: '1px solid var(--line-soft)',
          lineHeight: 1.2,
        }}
      >
        —/5
      </span>
    );
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 22,
        fontWeight: 600,
        padding: '4px 14px',
        background: scoreBg(score),
        color: scoreColor(score),
        border: `1px solid ${scoreBorder(score)}`,
        lineHeight: 1.2,
      }}
    >
      {score}/5
    </span>
  );
}

// ─── Inline badge ─────────────────────────────────────────────────────────────

interface InlineBadgeProps {
  label: string;
  value: string;
}

function InlineBadge({ label, value }: InlineBadgeProps): ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 5,
        padding: '3px 9px',
        border: '1px solid var(--line-soft)',
        background: 'var(--bg-2)',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      }}
    >
      <span
        style={{
          color: 'var(--fg-3)',
          fontSize: 9.5,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span style={{ color: 'var(--fg)' }}>{value}</span>
    </span>
  );
}

// ─── Collapsible section ──────────────────────────────────────────────────────

interface CollapsibleProps {
  label: string;
  children: ReactElement;
}

function Collapsible({ label, children }: CollapsibleProps): ReactElement {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--fg-2)',
          padding: '4px 0',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>{open ? '▼' : '▶'}</span>
        {label}
      </button>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
}

// ─── Verification status badge ────────────────────────────────────────────────

interface VerificationBadgeProps {
  /** Chip label prefix from i18n. */
  prefix: string;
  /** Human-readable status value in the current locale. */
  value: string;
  status: VerificationStatus;
}

function verificationBadgeStyle(status: VerificationStatus): {
  bg: string;
  color: string;
  border: string;
} {
  if (status === 'verified') {
    return { bg: '#E5F4EB', color: '#0E5E2A', border: '#1F7A3A' };
  }
  if (status === 'refuted') {
    return { bg: '#FEE2E2', color: 'var(--red)', border: 'var(--red)' };
  }
  // unverified
  return { bg: 'var(--bg-2)', color: 'var(--fg-3)', border: 'var(--line-soft)' };
}

function VerificationBadge({ prefix, value, status }: VerificationBadgeProps): ReactElement {
  const { bg, color, border } = verificationBadgeStyle(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 5,
        padding: '3px 9px',
        border: `1px solid ${border}`,
        background: bg,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      }}
    >
      <span
        style={{
          color: 'var(--fg-3)',
          fontSize: 9.5,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {prefix}
      </span>
      <span style={{ color }}>{value}</span>
    </span>
  );
}

// ─── Exploit verdict badge (F2) ───────────────────────────────────────────────

interface ExploitBadgeProps {
  /** Chip label prefix from i18n. */
  prefix: string;
  /** Human-readable status value in the current locale. */
  value: string;
  status: ExploitStatus;
}

function exploitBadgeStyle(status: ExploitStatus): {
  bg: string;
  color: string;
  border: string;
} {
  // A proven exploit is a strong, unambiguous positive signal.
  if (status === 'proven') {
    return { bg: '#E5F4EB', color: '#0E5E2A', border: '#1F7A3A' };
  }
  // failed / error / skipped_* are neutral/muted — no verdict was reached.
  return { bg: 'var(--bg-2)', color: 'var(--fg-3)', border: 'var(--line-soft)' };
}

function ExploitBadge({ prefix, value, status }: ExploitBadgeProps): ReactElement {
  const { bg, color, border } = exploitBadgeStyle(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 5,
        padding: '3px 9px',
        border: `1px solid ${border}`,
        background: bg,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        fontWeight: status === 'proven' ? 600 : 400,
      }}
    >
      <span
        style={{
          color: 'var(--fg-3)',
          fontSize: 9.5,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {prefix}
      </span>
      <span style={{ color }}>{value}</span>
    </span>
  );
}

/** Maps an exploit status to its localized human-readable value. */
function exploitStatusValue(
  status: ExploitStatus,
  tr: typeof TENSOL_I18N.en.reviews,
): string {
  switch (status) {
    case 'proven':
      return tr.exploitProven;
    case 'failed':
      return tr.exploitFailed;
    case 'error':
      return tr.exploitError;
    case 'skipped_budget':
      return tr.exploitSkippedBudget;
    case 'skipped_unauthorized':
      return tr.exploitSkippedUnauthorized;
    case 'not_attempted':
      return tr.exploitFailed; // unreachable — guarded by caller, kept for exhaustiveness
  }
}

// ─── Finding card ─────────────────────────────────────────────────────────────

function FindingCard({ f }: { f: ReviewFindingWire }): ReactElement {
  const tr = TENSOL_I18N.en.reviews;

  const location =
    f.start_line != null ? `${f.file_path}:${f.start_line}` : f.file_path;

  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        background: 'var(--bg)',
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <SeverityChip sev={toChipSev(f.severity)} size="sm" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 14,
              color: 'var(--fg)',
              fontWeight: 500,
            }}
          >
            {f.title}
          </div>
          <Mono
            size={10.5}
            color="var(--fg-3)"
            style={{ display: 'block', marginTop: 3, wordBreak: 'break-all' }}
          >
            {location}
          </Mono>
        </div>
      </div>

      {/* Chip bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {f.category && <InlineBadge label={tr.labelCategory} value={f.category} />}
        {f.cvss_score != null && (
          <InlineBadge label={tr.labelCvss} value={f.cvss_score.toFixed(1)} />
        )}
        {f.confidence && (
          <InlineBadge label={tr.labelConfidence} value={f.confidence as FindingConfidence} />
        )}
        {f.reachable != null && (
          <InlineBadge
            label={tr.labelReachable}
            value={f.reachable ? tr.reachableYes : tr.reachableNo}
          />
        )}
        {f.verification_status != null && (
          <VerificationBadge
            prefix={tr.labelVerification}
            status={f.verification_status}
            value={
              f.verification_status === 'verified'
                ? tr.verificationVerified
                : f.verification_status === 'refuted'
                  ? tr.verificationRefuted
                  : tr.verificationUnverified
            }
          />
        )}
        {f.exploit_status != null && f.exploit_status !== 'not_attempted' && (
          <ExploitBadge
            prefix={tr.labelExploit}
            status={f.exploit_status}
            value={exploitStatusValue(f.exploit_status, tr)}
          />
        )}
        {f.exploitability_score != null && (
          <InlineBadge
            label={tr.labelExploitability}
            value={String(f.exploitability_score)}
          />
        )}
        {f.impact_score != null && (
          <InlineBadge label={tr.labelImpact} value={String(f.impact_score)} />
        )}
        {f.source && (
          <InlineBadge label={tr.labelSource} value={f.source} />
        )}
        {f.cwe.map((c) => (
          <InlineBadge key={`cwe-${c}`} label={tr.labelCwe} value={c} />
        ))}
      </div>

      {/* Rationale */}
      {f.rationale_md.trim().length > 0 && (
        <div>
          <Eyebrow style={{ marginBottom: 8 }}>{tr.rationale}</Eyebrow>
          <MarkdownRenderer source={f.rationale_md} />
        </div>
      )}

      {/* Reachability evidence (collapsible) */}
      {f.reachability_evidence_md != null && f.reachability_evidence_md.trim().length > 0 && (
        <Collapsible label={tr.labelReachEvidence}>
          <MarkdownRenderer source={f.reachability_evidence_md} />
        </Collapsible>
      )}

      {/* Proof of concept (collapsible) */}
      {f.poc_md != null && f.poc_md.trim().length > 0 && (
        <Collapsible label={tr.pocLabel}>
          <MarkdownRenderer source={f.poc_md} />
        </Collapsible>
      )}

      {/* Suggested fix (collapsible) */}
      {f.fix_prompt_md != null && f.fix_prompt_md.trim().length > 0 && (
        <Collapsible label={tr.fixLabel}>
          <MarkdownRenderer source={f.fix_prompt_md} />
        </Collapsible>
      )}
    </div>
  );
}

// ─── Findings grouped by severity ────────────────────────────────────────────

function FindingsSection({ findings }: { findings: ReviewFindingWire[] }): ReactElement {
  const tr = TENSOL_I18N.en.reviews;

  if (findings.length === 0) {
    return (
      <section>
        <Eyebrow style={{ marginBottom: 14 }}>{tr.sectionFindings} {tr.findingsSuffix} 0</Eyebrow>
        <Mono size={12} color="var(--fg-3)">
          {tr.noFindings}
        </Mono>
      </section>
    );
  }

  // Group by severity in canonical order.
  const grouped = new Map<Severity, ReviewFindingWire[]>();
  for (const sev of SEV_ORDER) {
    grouped.set(sev, []);
  }
  for (const f of findings) {
    const bucket = grouped.get(f.severity);
    if (bucket) {
      bucket.push(f);
    }
  }

  return (
    <section>
      <Eyebrow style={{ marginBottom: 14 }}>{tr.sectionFindings} {tr.findingsSuffix} {findings.length}</Eyebrow>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {SEV_ORDER.map((sev) => {
          const bucket = grouped.get(sev) ?? [];
          if (bucket.length === 0) return null;
          return (
            <div key={sev}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 10,
                  paddingBottom: 8,
                  borderBottom: '1px solid var(--line-soft)',
                }}
              >
                <SeverityChip sev={toChipSev(sev)} size="sm" />
                <Mono size={11} color="var(--fg-3)">
                  {bucket.length} {bucket.length === 1 ? 'finding' : 'findings'}
                </Mono>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {bucket.map((f) => (
                  <FindingCard key={f.fingerprint} f={f} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function ReviewDetail(): ReactElement {
  const { id } = useParams<{ id: string }>();
  const tr = TENSOL_I18N.en.reviews;

  const [networkErr, setNetworkErr] = useState<string | null>(null);

  const stopWhen = useCallback(
    (r: ReviewResultWire) => isTerminal(r.status),
    [],
  );
  const onErr = useCallback((e: unknown) => {
    if (e instanceof ApiError) setNetworkErr(e.code);
    else setNetworkErr('network_error');
  }, []);

  const fetcher = useCallback((): Promise<ReviewResultWire> => {
    if (!id) return Promise.reject(new Error('no_id'));
    return apiClient.review.get(id);
  }, [id]);

  const { data, loading } = usePolling<ReviewResultWire>(fetcher, {
    intervalMs: REVIEW_POLL_MS,
    stopWhen,
    onError: onErr,
    enabled: id != null,
  });

  const repoLabel = data
    ? data.repo
      ? data.pr_number != null
        ? `${data.repo} #${data.pr_number}`
        : data.repo
      : '—'
    : '—';

  return (
    <AppShell
      breadcrumb={[tr.title, id ?? '—']}
      role="security_lead"
      density="comfortable"
      brand="sthrip"
      language="en"
      showLanguageSwitcher={false}
      surface="hacktron-light"
    >
      <RouteHead title={`Sthrip · Review ${id ?? ''}`} />
      <DashboardPage
        title="Review detail"
        section="PR Reviews"
        description={repoLabel}
        data-screen-label="Review detail"
      >
        {/* Back link */}
        <div style={{ marginBottom: 16 }}>
          <Link
            to="/reviews"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: 'var(--fg-2)',
              textDecoration: 'none',
            }}
          >
            {tr.back}
          </Link>
        </div>

        {!id && (
          <Mono size={12} color="var(--fg-3)">
            {tr.noId}
          </Mono>
        )}

        {id && loading && !data && (
          <Mono size={12} color="var(--fg-3)">
            {tr.loadingDetail}
          </Mono>
        )}

        {id && networkErr && !data && (
          <Mono size={12} color="var(--red)">
            {tr.errorDetail}: {networkErr}
          </Mono>
        )}

        {data && (
          <article style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
            {/* Header */}
            <header>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <StatusChip
                  status={kindLabel(data.kind, tr)}
                  tone={kindTone(data.kind)}
                  size="sm"
                />
                {data.mode != null && (
                  <StatusChip
                    status={data.mode === 'deep' ? tr.modeDeep : tr.modeFast}
                    tone={data.mode === 'deep' ? 'warn' : 'muted'}
                    size="sm"
                  />
                )}
                <StatusChip status={data.status} tone={statusTone(data.status)} size="sm" />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, flexWrap: 'wrap' }}>
                <h1
                  style={{
                    fontFamily: "'Space Grotesk', sans-serif",
                    fontWeight: 500,
                    fontSize: 32,
                    lineHeight: 1.15,
                    letterSpacing: '-0.02em',
                    margin: 0,
                  }}
                >
                  {repoLabel}
                </h1>
                <ScoreBadge score={data.score_0_5} />
              </div>
            </header>

            {/* In-progress hint */}
            {(data.status === 'queued' || data.status === 'running') && (
              <div
                style={{
                  padding: '14px 18px',
                  border: '1px solid var(--line-soft)',
                  background: 'var(--bg-2)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <Mono size={12} color="var(--fg-2)">
                  {tr.inProgress}
                </Mono>
              </div>
            )}

            {/* Summary */}
            {data.summary_md != null && data.summary_md.trim().length > 0 && (
              <section>
                <Eyebrow style={{ marginBottom: 12 }}>{tr.sectionSummary}</Eyebrow>
                <MarkdownRenderer source={data.summary_md} />
              </section>
            )}

            {/* Findings */}
            <FindingsSection findings={data.findings} />
          </article>
        )}
      </DashboardPage>
    </AppShell>
  );
}
