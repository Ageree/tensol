// T086 — Single finding detail page (Blackbox MVP).
//
// URL: /scan/:id/findings/:findingId
//
// Renders:
//   - Header: severity chip + title + external_id (slug)
//   - Badge bar: CVSS score+vector, CWE list, MITRE list, confidence,
//     phase, agent, discovered_at
//   - Markdown body (`body_md`) via the tiny inline MarkdownRenderer
//   - Evidence files: download links — for MVP we surface the raw S3 key
//     (presigned URL plumbing is a server follow-up; the field on the API
//     contract is `evidence_keys: string[]`).
//   - Back link → /scan/:id/findings

import { useEffect, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Eyebrow, Mono, SeverityChip } from '../components/primitives.tsx';
import { MarkdownRenderer } from '../components/MarkdownRenderer.tsx';
import { TENSOL_I18N } from '../i18n.ts';
import {
  ApiError,
  scans,
  type FindingDetail as FindingDetailDto,
  type Severity,
} from '../lib/api-client.ts';

// SeverityChip wants `info`, API gives `informational`.
type ChipSev = 'critical' | 'high' | 'medium' | 'low' | 'info';
function toChipSev(s: Severity): ChipSev {
  return s === 'informational' ? 'info' : s;
}

function fmtTimestamp(ms?: number | null): string {
  if (ms == null) return '—';
  try {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return '—';
  }
}

interface BadgeProps {
  label: string;
  value: string;
}

function Badge({ label, value }: BadgeProps): ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '4px 10px',
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

export default function FindingDetail(): ReactElement {
  const t = TENSOL_I18N.en;
  const { id: scanId, findingId } = useParams<{ id: string; findingId: string }>();

  const [data, setData] = useState<FindingDetailDto | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!scanId || !findingId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    scans
      .getFindingDetail(scanId, findingId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoadErr(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadErr(e instanceof ApiError ? e.code : 'network_error');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scanId, findingId]);

  const backHref = scanId
    ? `/scan/${encodeURIComponent(scanId)}/findings`
    : '/dashboard';

  return (
    <AppShell
      breadcrumb={[t.navFindings, scanId ?? '—', findingId ?? '—']}
      role="security_lead"
      density="comfortable"
      brand="sthrip"
      language="en"
      showLanguageSwitcher={false}
      surface="white-mono"
    >
      <RouteHead title={`Sthrip · ${t.findingDetail.title}`} />
      <div data-screen-label="Finding detail (T086)">
        <div style={{ marginBottom: 16 }}>
          <Link
            to={backHref}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: 'var(--fg-2)',
              textDecoration: 'none',
            }}
          >
            ← {t.findingDetail.back}
          </Link>
        </div>

        {(!scanId || !findingId) && (
          <Mono size={12} color="var(--fg-3)">
            {t.findingDetail.missingParams}
          </Mono>
        )}

        {scanId && findingId && loading && (
          <Mono size={12} color="var(--fg-3)">
            {t.findingDetail.loading}
          </Mono>
        )}

        {scanId && findingId && loadErr && !loading && (
          <Mono size={12} color="var(--red)">
            {t.findingDetail.loadError}: {loadErr}
          </Mono>
        )}

        {data && !loading && !loadErr && (
          <article style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {/* Header */}
            <header>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <SeverityChip sev={toChipSev(data.severity)} />
                <Mono size={11} color="var(--fg-3)">
                  {data.external_id}
                </Mono>
              </div>
              <h1
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 500,
                  fontSize: 32,
                  lineHeight: 1.15,
                  letterSpacing: '-0.02em',
                  margin: 0,
                  maxWidth: '52ch',
                }}
              >
                {data.title}
              </h1>
              <Mono
                size={11.5}
                color="var(--fg-3)"
                style={{ display: 'block', marginTop: 8 }}
              >
                {data.target}
              </Mono>
            </header>

            {/* Badge bar */}
            <section
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                padding: '14px 0',
                borderTop: '1px solid var(--line-soft)',
                borderBottom: '1px solid var(--line-soft)',
              }}
            >
              {data.cvss_score != null && (
                <Badge
                  label={`CVSS ${data.cvss_version ?? ''}`.trim()}
                  value={data.cvss_score.toFixed(1)}
                />
              )}
              {data.confidence && (
                <Badge label={t.findingDetail.labelConfidence} value={data.confidence} />
              )}
              {data.phase && (
                <Badge label={t.findingDetail.labelPhase} value={data.phase} />
              )}
              {data.agent && (
                <Badge label={t.findingDetail.labelAgent} value={data.agent} />
              )}
              {data.discovered_at != null && (
                <Badge
                  label={t.findingDetail.labelDiscovered}
                  value={fmtTimestamp(data.discovered_at)}
                />
              )}
              {data.cwe.map((c) => (
                <Badge key={`cwe-${c}`} label="CWE" value={c} />
              ))}
              {data.mitre.map((m) => (
                <Badge key={`mitre-${m}`} label="MITRE" value={m} />
              ))}
            </section>

            {data.cvss_vector && (
              <section>
                <Eyebrow style={{ marginBottom: 6 }}>
                  {t.findingDetail.cvssVector}
                </Eyebrow>
                <Mono size={11} color="var(--fg-2)" style={{ wordBreak: 'break-all' }}>
                  {data.cvss_vector}
                </Mono>
              </section>
            )}

            {/* Markdown body */}
            <section>
              <Eyebrow style={{ marginBottom: 12 }}>{t.findingDetail.report}</Eyebrow>
              {data.body_md.trim().length === 0 ? (
                <Mono size={12} color="var(--fg-3)">
                  {t.findingDetail.emptyBody}
                </Mono>
              ) : (
                <MarkdownRenderer source={data.body_md} />
              )}
            </section>

            {/* Evidence file list */}
            <section>
              <Eyebrow style={{ marginBottom: 8 }}>
                {t.findingDetail.evidence} · {data.evidence_keys.length}
              </Eyebrow>
              {data.evidence_keys.length === 0 ? (
                <Mono size={12} color="var(--fg-3)">
                  {t.findingDetail.noEvidence}
                </Mono>
              ) : (
                <ul
                  style={{
                    listStyle: 'none',
                    padding: 0,
                    margin: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  {data.evidence_keys.map((key) => (
                    <li
                      key={key}
                      style={{
                        padding: '10px 12px',
                        background: 'var(--bg-2)',
                        border: '1px solid var(--line-soft)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}
                    >
                      <Mono
                        size={11}
                        color="var(--fg-2)"
                        style={{ wordBreak: 'break-all' }}
                      >
                        {key}
                      </Mono>
                      <Mono
                        size={10}
                        color="var(--fg-3)"
                        style={{
                          letterSpacing: '0.08em',
                          textTransform: 'uppercase',
                          flexShrink: 0,
                        }}
                      >
                        {t.findingDetail.downloadPending}
                      </Mono>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </article>
        )}
      </div>
    </AppShell>
  );
}
