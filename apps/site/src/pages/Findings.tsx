// T085 — Findings list (Blackbox MVP).
//
// URL: /scan/:id/findings  (the legacy /findings route used to render the
// design-doc mock; this rewrite is data-driven and fetches from the v1 API).
//
// Renders:
//   - CSS-only severity-distribution donut (conic-gradient, NO chart lib per
//     driver constraint)
//   - Filter bar: per-severity checkboxes + title substring search
//   - Sortable table (default: severity rank DESC, then created_at ASC —
//     matches T071 server-side sort)
//   - Each row links to /scan/:id/findings/:findingId (T086 detail page)

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { DashboardPage } from '../components/dashboard-ui.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Mono, SeverityChip } from '../components/primitives.tsx';
import { TENSOL_I18N } from '../i18n.ts';
import {
  ApiError,
  scans,
  type Finding,
  type Severity,
} from '../lib/api-client.ts';

// ─── Severity helpers ─────────────────────────────────────────────────────
// API ships severity as `informational` (full word); primitives.SeverityChip
// expects the abbreviated `info` token. Map at the rendering boundary.

const SEV_ORDER: readonly Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'informational',
] as const;

const SEV_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  informational: 0,
};

const SEV_COLOR: Record<Severity, string> = {
  critical: 'var(--red)',
  high: '#F26B1F',
  medium: '#E6C76B',
  low: '#5A6B5A',
  informational: 'var(--line-soft)',
};

// SeverityChip wants `info`, API gives `informational`. One-shot adapter.
type ChipSev = 'critical' | 'high' | 'medium' | 'low' | 'info';
function toChipSev(s: Severity): ChipSev {
  return s === 'informational' ? 'info' : s;
}

// ─── Donut (CSS conic-gradient, no chart lib) ─────────────────────────────

interface SevCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
}

function countBySeverity(rows: readonly Finding[]): SevCounts {
  const out: SevCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  for (const f of rows) out[f.severity] += 1;
  return out;
}

interface DonutProps {
  counts: SevCounts;
  total: number;
  size?: number;
}

function SeverityDonut({ counts, total, size = 140 }: DonutProps): ReactElement {
  // Build conic-gradient stops in fixed severity order. If total === 0 the
  // ring is rendered as a single neutral track.
  const stops: string[] = [];
  if (total === 0) {
    stops.push('var(--line-soft) 0deg 360deg');
  } else {
    let acc = 0;
    for (const sev of SEV_ORDER) {
      const c = counts[sev];
      if (c === 0) continue;
      const start = (acc / total) * 360;
      acc += c;
      const end = (acc / total) * 360;
      stops.push(`${SEV_COLOR[sev]} ${start}deg ${end}deg`);
    }
  }
  const gradient = `conic-gradient(${stops.join(', ')})`;
  const hole = Math.round(size * 0.58);

  return (
    <div
      role="img"
      aria-label={`Severity distribution: ${total} findings`}
      style={{
        width: size,
        height: size,
        background: gradient,
        borderRadius: '50%',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: (size - hole) / 2,
          background: 'var(--paper)',
          borderRadius: '50%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Mono size={22} color="var(--fg)" style={{ fontWeight: 500 }}>
          {total}
        </Mono>
        <Mono size={9} color="var(--fg-3)" style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          findings
        </Mono>
      </div>
    </div>
  );
}

interface DonutLegendProps {
  counts: SevCounts;
  labels: Record<Severity, string>;
}

function DonutLegend({ counts, labels }: DonutLegendProps): ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 18px' }}>
      {SEV_ORDER.map((sev) => (
        <div key={sev} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 10,
              height: 10,
              background: SEV_COLOR[sev],
              border: '1px solid var(--ink)',
              flexShrink: 0,
            }}
          />
          <Mono size={11} color="var(--fg-2)" style={{ minWidth: 80 }}>
            {labels[sev]}
          </Mono>
          <Mono size={11} color="var(--fg)" style={{ fontWeight: 500 }}>
            {counts[sev]}
          </Mono>
        </div>
      ))}
    </div>
  );
}

// ─── Page component ───────────────────────────────────────────────────────

type SortKey = 'severity' | 'title' | 'cvss';
type SortDir = 'asc' | 'desc';

function sortFindings(
  rows: readonly Finding[],
  key: SortKey,
  dir: SortDir,
): Finding[] {
  const mul = dir === 'asc' ? 1 : -1;
  const copy = [...rows];
  copy.sort((a, b) => {
    let cmp = 0;
    if (key === 'severity') {
      cmp = SEV_RANK[a.severity] - SEV_RANK[b.severity];
      // Stable secondary: created_at ASC (matches T071 server contract).
      if (cmp === 0) cmp = a.created_at - b.created_at;
      // For severity sort, primary direction inverts the rank delta only.
      return cmp * mul;
    }
    if (key === 'title') cmp = a.title.localeCompare(b.title);
    if (key === 'cvss') {
      const av = a.cvss_score ?? -1;
      const bv = b.cvss_score ?? -1;
      cmp = av - bv;
    }
    return cmp * mul;
  });
  return copy;
}

export default function Findings(): ReactElement {
  const t = TENSOL_I18N.en;
  const { id: scanId } = useParams<{ id: string }>();

  const [rows, setRows] = useState<readonly Finding[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Filter state: which severities are visible (default = all checked).
  const [sevFilter, setSevFilter] = useState<Record<Severity, boolean>>({
    critical: true,
    high: true,
    medium: true,
    low: true,
    informational: true,
  });
  const [search, setSearch] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('severity');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // One-shot fetch on mount. Findings are static once a scan is complete —
  // Constitution V mandates polling only for evolving state (Live, Report).
  useEffect(() => {
    if (!scanId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    scans
      .getFindings(scanId)
      .then((data) => {
        if (cancelled) return;
        setRows(data);
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
  }, [scanId]);

  const allRows: readonly Finding[] = rows ?? [];
  const counts = useMemo(() => countBySeverity(allRows), [allRows]);
  const total = allRows.length;

  const filtered = useMemo<readonly Finding[]>(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((f) => {
      if (!sevFilter[f.severity]) return false;
      if (q.length > 0 && !f.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allRows, sevFilter, search]);

  const sorted = useMemo(
    () => sortFindings(filtered, sortKey, sortDir),
    [filtered, sortKey, sortDir],
  );

  const toggleSev = useCallback((sev: Severity) => {
    setSevFilter((prev) => ({ ...prev, [sev]: !prev[sev] }));
  }, []);

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir(key === 'severity' || key === 'cvss' ? 'desc' : 'asc');
      }
    },
    [sortKey],
  );

  const sevLabels: Record<Severity, string> = {
    critical: t.findings.sevCritical,
    high: t.findings.sevHigh,
    medium: t.findings.sevMedium,
    low: t.findings.sevLow,
    informational: t.findings.sevInformational,
  };

  return (
    <AppShell
      breadcrumb={[t.navFindings, scanId ?? '—']}
      role="security_lead"
      density="comfortable"
      brand="sthrip"
      language="en"
      showLanguageSwitcher={false}
      surface="hacktron-light"
    >
      <RouteHead title={`Sthrip · ${t.findings.title}`} />
      <DashboardPage
        title={t.findings.title}
        section="Findings"
        description={scanId ? `Blackbox scan ${scanId}` : t.findings.noScanId}
        data-screen-label="Findings (T085)"
        actions={
          scanId ? (
            <Link
              to={`/scan/${encodeURIComponent(scanId)}/report`}
              className="hack-button"
              data-slot="button"
              data-variant="primary"
            >
              {t.findings.gotoReport}
            </Link>
          ) : undefined
        }
      >

        {!scanId && (
          <Mono size={12} color="var(--fg-3)">
            {t.findings.noScanId}
          </Mono>
        )}

        {scanId && loading && (
          <Mono size={12} color="var(--fg-3)">
            {t.findings.loading}
          </Mono>
        )}

        {scanId && loadErr && !loading && (
          <Mono size={12} color="var(--red)">
            {t.findings.loadError}: {loadErr}
          </Mono>
        )}

        {scanId && !loading && !loadErr && (
          <>
            {/* Donut + legend */}
            <div
              style={{
                display: 'flex',
                gap: 32,
                alignItems: 'center',
                padding: '24px 0',
                borderTop: '1px solid var(--line-soft)',
                borderBottom: '1px solid var(--line-soft)',
                marginBottom: 24,
              }}
            >
              <SeverityDonut counts={counts} total={total} />
              <div style={{ flex: 1 }}>
                <Mono
                  size={10}
                  color="var(--fg-3)"
                  style={{
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    display: 'block',
                    marginBottom: 8,
                  }}
                >
                  {t.findings.distribution}
                </Mono>
                <DonutLegend counts={counts} labels={sevLabels} />
              </div>
            </div>

            {/* Filter bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                flexWrap: 'wrap',
                marginBottom: 12,
              }}
            >
              <Mono
                size={11}
                color="var(--fg-3)"
                style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
              >
                {t.findings.filterSeverity}
              </Mono>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {SEV_ORDER.map((sev) => (
                  <label
                    key={sev}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      cursor: 'pointer',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: 'var(--fg-2)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={sevFilter[sev]}
                      onChange={() => toggleSev(sev)}
                      style={{ accentColor: SEV_COLOR[sev] }}
                    />
                    {sevLabels[sev]} ({counts[sev]})
                  </label>
                ))}
              </div>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t.findings.searchPlaceholder}
                style={{
                  marginLeft: 'auto',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  padding: '6px 10px',
                  background: 'var(--bg)',
                  border: '1px solid var(--line-soft)',
                  color: 'var(--fg)',
                  minWidth: 220,
                }}
              />
            </div>

            <Mono size={10.5} color="var(--fg-3)" style={{ display: 'block', marginBottom: 8 }}>
              {t.findings.countOf
                .replace('{shown}', String(sorted.length))
                .replace('{total}', String(total))}
            </Mono>

            {/* Table */}
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                background: 'transparent',
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line-soft)' }}>
                  {(
                    [
                      { key: 'severity' as SortKey, label: t.findings.colSeverity },
                      { key: 'title' as SortKey, label: t.findings.colTitle },
                      { key: null, label: t.findings.colSlug },
                      { key: 'cvss' as SortKey, label: t.findings.colCvss },
                      { key: null, label: '' },
                    ] as const
                  ).map((col, i) => (
                    <th
                      key={`${i}-${col.label}`}
                      style={{
                        textAlign: 'left',
                        padding: '10px 4px',
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        fontWeight: 500,
                        color: 'var(--fg-3)',
                        cursor: col.key ? 'pointer' : 'default',
                        userSelect: 'none',
                      }}
                      onClick={() => col.key && toggleSort(col.key)}
                    >
                      {col.label}
                      {col.key === sortKey && (
                        <span style={{ marginLeft: 4 }}>
                          {sortDir === 'asc' ? '▲' : '▼'}
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((f) => (
                  <tr
                    key={f.id}
                    style={{ borderBottom: '1px solid var(--line-soft)' }}
                  >
                    <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                      <SeverityChip sev={toChipSev(f.severity)} size="sm" />
                    </td>
                    <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                      <div
                        style={{
                          fontFamily: "'Inter', sans-serif",
                          fontSize: 14,
                          color: 'var(--fg)',
                        }}
                      >
                        {f.title}
                      </div>
                      <Mono
                        size={10.5}
                        color="var(--fg-3)"
                        style={{ marginTop: 4, display: 'block' }}
                      >
                        {f.target}
                      </Mono>
                    </td>
                    <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                      <Mono size={11} color="var(--fg-2)">
                        {f.external_id}
                      </Mono>
                    </td>
                    <td style={{ padding: '14px 4px', verticalAlign: 'top' }}>
                      <Mono size={11} color="var(--fg)">
                        {f.cvss_score != null ? f.cvss_score.toFixed(1) : '—'}
                      </Mono>
                    </td>
                    <td
                      style={{
                        padding: '14px 4px',
                        textAlign: 'right',
                        verticalAlign: 'top',
                      }}
                    >
                      <Link
                        to={`/scan/${encodeURIComponent(scanId)}/findings/${encodeURIComponent(f.id)}`}
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          color: 'var(--fg)',
                          textDecoration: 'underline',
                        }}
                      >
                        {t.findings.detail} →
                      </Link>
                    </td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: 60, textAlign: 'center' }}>
                      <Mono size={12} color="var(--fg-3)">
                        {total === 0 ? t.findings.empty : t.findings.noMatch}
                      </Mono>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </DashboardPage>
    </AppShell>
  );
}
