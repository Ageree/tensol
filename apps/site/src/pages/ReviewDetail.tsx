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

import { ArrowLeft } from 'lucide-react';
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
type ReviewLabels = typeof TENSOL_I18N.en.reviews;

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

function findingCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'finding' : 'findings'}`;
}

function verifiedCount(findings: ReviewFindingWire[]): number {
  return findings.filter((f) => f.verification_status === 'verified').length;
}

function severityAccent(sev: Severity): {
  border: string;
  softBg: string;
  text: string;
} {
  if (sev === 'critical') {
    return { border: 'var(--red)', softBg: '#FFF1F1', text: 'var(--red)' };
  }
  if (sev === 'high') {
    return { border: '#F26B1F', softBg: '#FFF4EA', text: '#9A3F08' };
  }
  if (sev === 'medium') {
    return { border: '#B8860B', softBg: '#FFF8DF', text: '#7A5A05' };
  }
  if (sev === 'low') {
    return { border: '#1F7A3A', softBg: '#EEF8F1', text: '#0E5E2A' };
  }
  return { border: 'var(--line-soft)', softBg: 'var(--bg-2)', text: 'var(--fg-2)' };
}

function cvssTone(score: number): InlineBadgeProps['tone'] {
  if (score >= 9) return 'danger';
  if (score >= 7) return 'warn';
  return 'neutral';
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
  const hasScore = score != null;
  return (
    <span
      style={{
        display: 'inline-flex',
        minWidth: 132,
        minHeight: 82,
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 40,
        fontWeight: 700,
        padding: '10px 18px',
        background: hasScore ? scoreBg(score) : 'var(--bg)',
        color: hasScore ? scoreColor(score) : 'var(--fg-3)',
        border: `1px solid ${hasScore ? scoreBorder(score) : 'var(--line-soft)'}`,
        lineHeight: 1,
      }}
    >
      {hasScore ? `${score}/5` : '—/5'}
    </span>
  );
}

// ─── Inline badge ─────────────────────────────────────────────────────────────

interface InlineBadgeProps {
  label: string;
  value: string;
  tone?: 'neutral' | 'strong' | 'ok' | 'warn' | 'danger';
}

function inlineBadgeTone(tone: InlineBadgeProps['tone']): {
  bg: string;
  color: string;
  border: string;
} {
  if (tone === 'strong') {
    return { bg: 'var(--fg)', color: 'var(--bg)', border: 'var(--fg)' };
  }
  if (tone === 'ok') {
    return { bg: '#E5F4EB', color: '#0E5E2A', border: '#1F7A3A' };
  }
  if (tone === 'warn') {
    return { bg: '#FBF1D9', color: '#7A5A05', border: '#B8860B' };
  }
  if (tone === 'danger') {
    return { bg: '#FEE2E2', color: 'var(--red)', border: 'var(--red)' };
  }
  return { bg: 'var(--bg-2)', color: 'var(--fg)', border: 'var(--line-soft)' };
}

function InlineBadge({ label, value, tone = 'neutral' }: InlineBadgeProps): ReactElement {
  const { bg, color, border } = inlineBadgeTone(tone);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 7,
        padding: '6px 10px',
        border: `1px solid ${border}`,
        background: bg,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        lineHeight: 1.15,
      }}
    >
      <span
        style={{
          color: tone === 'strong' ? 'rgba(255,255,255,0.68)' : 'var(--fg-3)',
          fontSize: 10,
          letterSpacing: 0,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span style={{ color, fontWeight: tone === 'neutral' ? 500 : 700 }}>{value}</span>
    </span>
  );
}

// ─── Collapsible section ──────────────────────────────────────────────────────

interface CollapsibleProps {
  label: string;
  children: ReactElement;
  defaultOpen?: boolean;
}

function Collapsible({ label, children, defaultOpen = false }: CollapsibleProps): ReactElement {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  return (
    <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          background: 'var(--bg-2)',
          border: '1px solid var(--line-soft)',
          borderLeft: '4px solid var(--fg)',
          cursor: 'pointer',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          letterSpacing: 0,
          textTransform: 'uppercase',
          color: 'var(--fg-2)',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span>{label}</span>
        <span style={{ color: 'var(--fg)', fontSize: 14 }}>{open ? '-' : '+'}</span>
      </button>
      {open && <div style={{ marginTop: 14 }}>{children}</div>}
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
        gap: 7,
        padding: '6px 10px',
        border: `1px solid ${border}`,
        background: bg,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        fontWeight: status === 'verified' ? 700 : 500,
        lineHeight: 1.15,
      }}
    >
      <span
        style={{
          color: 'var(--fg-3)',
          fontSize: 10,
          letterSpacing: 0,
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
        gap: 7,
        padding: '6px 10px',
        border: `1px solid ${border}`,
        background: bg,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        fontWeight: status === 'proven' ? 700 : 500,
        lineHeight: 1.15,
      }}
    >
      <span
        style={{
          color: 'var(--fg-3)',
          fontSize: 10,
          letterSpacing: 0,
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

// ─── Review summary ──────────────────────────────────────────────────────────

interface SummaryMetricProps {
  label: string;
  children: ReactElement | string;
  tone?: KindTone;
}

function SummaryMetric({ label, children, tone = 'neutral' }: SummaryMetricProps): ReactElement {
  return (
    <div
      style={{
        minHeight: 84,
        borderTop: '1px solid var(--line-soft)',
        paddingTop: 12,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 10,
      }}
    >
      <Mono
        size={10.5}
        color="var(--fg-3)"
        style={{ display: 'block', textTransform: 'uppercase' }}
      >
        {label}
      </Mono>
      {typeof children === 'string' ? (
        <span
          style={{
            color: tone === 'danger' ? 'var(--red)' : 'var(--fg)',
            fontFamily: "'Inter', sans-serif",
            fontSize: 20,
            fontWeight: 600,
            lineHeight: 1.15,
          }}
        >
          {children}
        </span>
      ) : (
        children
      )}
    </div>
  );
}

function ReviewSummary({
  data,
  labels,
}: {
  data: ReviewResultWire;
  labels: ReviewLabels;
}): ReactElement {
  const verified = verifiedCount(data.findings);
  const kind = kindLabel(data.kind, labels);
  const mode =
    data.mode != null
      ? data.mode === 'deep'
        ? labels.modeDeep
        : labels.modeFast
      : 'standard';
  return (
    <section
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 28,
        alignItems: 'stretch',
        padding: '22px 0 26px',
        borderTop: '1px solid var(--line-soft)',
        borderBottom: '1px solid var(--line-soft)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Mono
          size={10.5}
          color="var(--fg-3)"
          style={{ display: 'block', textTransform: 'uppercase' }}
        >
          Sthrip score
        </Mono>
        <ScoreBadge score={data.score_0_5} />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(142px, 1fr))',
          gap: 18,
        }}
      >
        <SummaryMetric label="Findings">
          {findingCountLabel(data.findings.length)}
        </SummaryMetric>
        <SummaryMetric label="Verified">
          {`${verified}/${data.findings.length}`}
        </SummaryMetric>
        <SummaryMetric label="Status" tone={statusTone(data.status)}>
          <StatusChip status={data.status} tone={statusTone(data.status)} size="md" />
        </SummaryMetric>
        <SummaryMetric label="Run">
          {`${kind} · ${mode}`}
        </SummaryMetric>
      </div>
    </section>
  );
}

// ─── Finding card ─────────────────────────────────────────────────────────────

function FindingCard({ f }: { f: ReviewFindingWire }): ReactElement {
  const tr = TENSOL_I18N.en.reviews;
  const accent = severityAccent(f.severity);

  const location =
    f.start_line != null ? `${f.file_path}:${f.start_line}` : f.file_path;

  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        borderLeft: `5px solid ${accent.border}`,
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      {/* Title row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
          padding: '20px 24px 18px',
          background: accent.softBg,
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        <SeverityChip sev={toChipSev(f.severity)} size="md" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 18,
              lineHeight: 1.35,
              color: 'var(--fg)',
              fontWeight: 650,
            }}
          >
            {f.title}
          </div>
          <Mono
            size={12}
            color="var(--fg-2)"
            style={{ display: 'block', marginTop: 7, wordBreak: 'break-all' }}
          >
            {location}
          </Mono>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          padding: '18px 24px 24px',
        }}
      >
        {/* Chip bar */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {f.category && (
            <InlineBadge label={tr.labelCategory} value={f.category} tone="strong" />
          )}
          {f.cvss_score != null && (
            <InlineBadge
              label={tr.labelCvss}
              value={f.cvss_score.toFixed(1)}
              tone={cvssTone(f.cvss_score)}
            />
          )}
          {f.confidence && (
            <InlineBadge
              label={tr.labelConfidence}
              value={f.confidence as FindingConfidence}
              tone="ok"
            />
          )}
          {f.reachable != null && (
            <InlineBadge
              label={tr.labelReachable}
              value={f.reachable ? tr.reachableYes : tr.reachableNo}
              tone={f.reachable ? 'ok' : 'neutral'}
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
              tone={f.exploitability_score >= 75 ? 'danger' : 'warn'}
            />
          )}
          {f.impact_score != null && (
            <InlineBadge
              label={tr.labelImpact}
              value={String(f.impact_score)}
              tone={f.impact_score >= 75 ? 'danger' : 'warn'}
            />
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
            <Eyebrow style={{ marginBottom: 10, color: accent.text }}>{tr.rationale}</Eyebrow>
            <MarkdownRenderer source={f.rationale_md} variant="detail" />
          </div>
        )}

        {/* Reachability evidence (collapsible) */}
        {f.reachability_evidence_md != null && f.reachability_evidence_md.trim().length > 0 && (
          <Collapsible label={tr.labelReachEvidence} defaultOpen>
            <MarkdownRenderer source={f.reachability_evidence_md} variant="detail" />
          </Collapsible>
        )}

        {/* Proof of concept (collapsible) */}
        {f.poc_md != null && f.poc_md.trim().length > 0 && (
          <Collapsible label={tr.pocLabel} defaultOpen>
            <MarkdownRenderer source={f.poc_md} variant="detail" />
          </Collapsible>
        )}

        {/* Suggested fix (collapsible) */}
        {f.fix_prompt_md != null && f.fix_prompt_md.trim().length > 0 && (
          <Collapsible label={tr.fixLabel} defaultOpen>
            <MarkdownRenderer source={f.fix_prompt_md} variant="detail" />
          </Collapsible>
        )}
      </div>
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
        <Mono size={13} color="var(--fg-3)">
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
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 18,
          paddingBottom: 12,
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>{tr.sectionFindings}</Eyebrow>
          <h2
            style={{
              margin: 0,
              fontFamily: "'Inter', sans-serif",
              fontSize: 24,
              fontWeight: 650,
              lineHeight: 1.2,
              color: 'var(--fg)',
            }}
          >
            Validated security findings
          </h2>
        </div>
        <Mono size={13} color="var(--fg-2)">
          {findingCountLabel(findings.length)}
        </Mono>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
        {SEV_ORDER.map((sev) => {
          const bucket = grouped.get(sev) ?? [];
          if (bucket.length === 0) return null;
          const accent = severityAccent(sev);
          return (
            <div key={sev}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 14,
                  marginBottom: 12,
                  padding: '12px 14px',
                  background: accent.softBg,
                  border: '1px solid var(--line-soft)',
                  borderLeft: `5px solid ${accent.border}`,
                }}
              >
                <SeverityChip sev={toChipSev(sev)} size="md" />
                <Mono size={12} color={accent.text}>
                  {findingCountLabel(bucket.length)}
                </Mono>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
  const pageTitle = data && repoLabel !== '—' ? repoLabel : 'Review detail';
  const pageDescription = data
    ? `${kindLabel(data.kind, tr)} review · ${findingCountLabel(data.findings.length)} · ${data.status}`
    : repoLabel;

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
        title={pageTitle}
        section="PR Reviews"
        description={pageDescription}
        actions={
          <Link
            to="/reviews"
            style={{
              minHeight: 40,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 14px',
              border: '1px solid var(--line-soft)',
              background: 'var(--bg)',
              color: 'var(--fg)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              textDecoration: 'none',
            }}
          >
            <ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" />
            Reviews
          </Link>
        }
        data-screen-label="Review detail"
      >
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
          <article style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
            <ReviewSummary data={data} labels={tr} />

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
              <section
                style={{
                  padding: '18px 22px',
                  border: '1px solid var(--line-soft)',
                  borderLeft: '5px solid var(--fg)',
                  background: 'var(--bg)',
                }}
              >
                <Eyebrow style={{ marginBottom: 12 }}>{tr.sectionSummary}</Eyebrow>
                <MarkdownRenderer source={data.summary_md} variant="detail" />
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
