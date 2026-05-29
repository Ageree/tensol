/**
 * T051 — HTML template for the PDF report.
 *
 * Pure function (no IO, no DB): takes a fully-shaped `ReportTemplateInput`
 * and returns a self-contained HTML string suitable for offline Puppeteer
 * rendering. Per spec 002-blackbox-mvp and research §R7, the document
 * must:
 *
 *   - Render with NO external assets (no <script>, no <link>, no remote
 *     fonts) — Puppeteer is launched without network in production.
 *   - Inline a server-rendered SVG severity histogram (no client JS).
 *   - Honor `@page` margins so the cover and per-finding sections page
 *     break cleanly.
 *
 * Markdown bodies (`body_md` from finding YAML frontmatter) are rendered
 * via a *minimal* converter: headings, paragraphs, fenced code blocks,
 * inline code, ordered/unordered lists, and tables. We deliberately
 * avoid pulling a full CommonMark dependency — the Decepticon body
 * shape is well-bounded and the converter only needs enough fidelity
 * for legible reports. If we ever need full CommonMark we can swap to
 * `marked` here without touching `pdf.ts`.
 *
 * Sibling: `server/src/reports/pdf.ts` (T052) consumes the string this
 * module returns.
 */

export type ReportSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "informational";

export interface ReportFinding {
  readonly id: string;
  readonly externalId?: string;
  readonly title: string;
  readonly severity: ReportSeverity;
  readonly cvssScore?: number | null;
  readonly cvssVector?: string | null;
  readonly cvssVersion?: string | null;
  readonly cwe?: readonly string[];
  readonly mitre?: readonly string[];
  readonly confidence?: string | null;
  readonly affectedTarget?: string | null;
  readonly affectedComponent?: string | null;
  readonly phase?: string | null;
  readonly agent?: string | null;
  readonly bodyMd: string;
}

export interface ReportSummary {
  readonly total: number;
  readonly bySeverity: {
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
    readonly informational: number;
  };
}

export interface ReportScanMeta {
  readonly id: string;
  readonly scanOrderId: string;
  readonly primaryDomain: string;
  readonly completedAt: number;
  readonly durationSeconds: number;
}

export interface ReportTemplateInput {
  readonly scan: ReportScanMeta;
  readonly findings: readonly ReportFinding[];
  readonly summary: ReportSummary;
  readonly generatedAt: number;
  readonly reportId: string;
}

// ---------------------------------------------------------------------------
// Severity → palette. Locked at module scope so the renderer is pure.
// ---------------------------------------------------------------------------
const SEVERITY_COLOR: Record<ReportSeverity, string> = {
  critical: "#b00020",
  high: "#d97706",
  medium: "#ca8a04",
  low: "#2563eb",
  informational: "#6b7280",
};

const SEVERITY_LABEL: Record<ReportSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  informational: "Informational",
};

const SEVERITY_ORDER: readonly ReportSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
];

// ---------------------------------------------------------------------------
// Inline CSS. Kept at module scope (pure constant) so renderReportHtml is
// trivially memoizable.
// ---------------------------------------------------------------------------
const CSS = `
@page { margin: 24mm 18mm; size: A4; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #111;
  font-size: 11pt;
  line-height: 1.45;
  margin: 0;
}
h1 { font-size: 22pt; margin: 0 0 8pt; }
h2 { font-size: 16pt; margin: 24pt 0 8pt; border-bottom: 1px solid #e5e7eb; padding-bottom: 4pt; }
h3 { font-size: 13pt; margin: 18pt 0 6pt; }
h4 { font-size: 11pt; margin: 12pt 0 4pt; }
p  { margin: 0 0 8pt; }
ul, ol { margin: 0 0 8pt 20pt; }
li { margin: 0 0 3pt; }
hr { border: 0; border-top: 1px solid #e5e7eb; margin: 16pt 0; }

.cover { page-break-after: always; padding-top: 30mm; }
.cover .brand { font-size: 10pt; letter-spacing: 0.18em; color: #6b7280; text-transform: uppercase; }
.cover .title { font-size: 30pt; font-weight: 700; line-height: 1.15; margin: 4mm 0 8mm; }
.cover .domain { font-size: 14pt; color: #1a1a1a; font-family: ui-monospace, monospace; }
.cover .meta { margin-top: 18mm; display: grid; grid-template-columns: 1fr 1fr; gap: 8pt; font-size: 10pt; color: #374151; }
.cover .meta dt { font-weight: 600; color: #6b7280; }
.cover .meta dd { margin: 0 0 6pt; }

.summary { page-break-inside: avoid; }
.summary .chart { margin: 12pt 0; }
.summary .totals { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6pt; margin-top: 8pt; }
.summary .totals .cell { padding: 8pt; border: 1px solid #e5e7eb; border-radius: 4pt; text-align: center; }
.summary .totals .cell .n { font-size: 18pt; font-weight: 700; }
.summary .totals .cell .l { font-size: 9pt; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }

.severity-badge {
  display: inline-block;
  padding: 2pt 8pt;
  border-radius: 3pt;
  color: white;
  font-weight: 600;
  font-size: 9pt;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.severity-critical { background: #b00020; }
.severity-high     { background: #d97706; }
.severity-medium   { background: #ca8a04; }
.severity-low      { background: #2563eb; }
.severity-informational { background: #6b7280; }

.finding { page-break-inside: avoid; margin-bottom: 14pt; padding-top: 6pt; }
.finding + .finding { border-top: 1px solid #e5e7eb; padding-top: 14pt; }
.finding .title-row { display: flex; gap: 8pt; align-items: baseline; }
.finding .title-row .id { font-family: ui-monospace, monospace; font-size: 9pt; color: #6b7280; }
.finding .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4pt 12pt; margin: 6pt 0 10pt; font-size: 9.5pt; }
.finding .meta-grid dt { color: #6b7280; font-weight: 600; }
.finding .meta-grid dd { margin: 0; font-family: ui-monospace, monospace; word-break: break-word; }

pre, code { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 9.5pt; }
pre {
  background: #0f172a;
  color: #e5e7eb;
  padding: 8pt 10pt;
  border-radius: 4pt;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
code { background: #f3f4f6; padding: 1pt 4pt; border-radius: 3pt; }
pre code { background: transparent; padding: 0; color: inherit; }

table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 10pt; }
th, td { border: 1px solid #e5e7eb; padding: 4pt 8pt; text-align: left; vertical-align: top; }
th { background: #f9fafb; font-weight: 600; }

.footer-meta { margin-top: 24pt; font-size: 8.5pt; color: #9ca3af; text-align: center; }
`;

// ---------------------------------------------------------------------------
// Public entry.
// ---------------------------------------------------------------------------
export function renderReportHtml(input: ReportTemplateInput): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<title>Sthrip Scan Report ${escapeHtml(input.reportId)}</title>`,
    `<style>${CSS}</style>`,
    "</head><body>",
    renderCover(input),
    renderSummary(input.summary),
    renderFindingsSection(input.findings),
    renderFooter(input),
    "</body></html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Sections.
// ---------------------------------------------------------------------------
function renderCover(input: ReportTemplateInput): string {
  const s = input.scan;
  return [
    '<section class="cover">',
    '<div class="brand">Sthrip — AI Offensive Security Platform</div>',
    `<div class="title">Black-box scan report<br/>${escapeHtml(s.primaryDomain)}</div>`,
    `<div class="domain">${escapeHtml(s.primaryDomain)}</div>`,
    "<dl class=\"meta\">",
    `<dt>Report ID</dt><dd>${escapeHtml(input.reportId)}</dd>`,
    `<dt>Scan ID</dt><dd>${escapeHtml(s.id)}</dd>`,
    `<dt>Scan order</dt><dd>${escapeHtml(s.scanOrderId)}</dd>`,
    `<dt>Completed at (UTC)</dt><dd>${formatTs(s.completedAt)}</dd>`,
    `<dt>Duration</dt><dd>${formatDuration(s.durationSeconds)}</dd>`,
    `<dt>Total findings</dt><dd>${input.summary.total}</dd>`,
    `<dt>Generated at (UTC)</dt><dd>${formatTs(input.generatedAt)}</dd>`,
    "</dl>",
    "</section>",
  ].join("");
}

function renderSummary(summary: ReportSummary): string {
  const cells = SEVERITY_ORDER.map((sev) => {
    const n = summary.bySeverity[sev];
    return `<div class="cell"><div class="n" style="color:${SEVERITY_COLOR[sev]}">${n}</div><div class="l">${SEVERITY_LABEL[sev]}</div></div>`;
  }).join("");
  return [
    '<section class="summary">',
    "<h2>Executive summary</h2>",
    `<p>The scan surfaced <strong>${summary.total}</strong> findings across five severity classes. The distribution is shown below.</p>`,
    `<div class="chart">${renderSeverityChart(summary.bySeverity)}</div>`,
    `<div class="totals">${cells}</div>`,
    "</section>",
  ].join("");
}

function renderSeverityChart(by: ReportSummary["bySeverity"]): string {
  // Inline horizontal bar chart, 5 rows. No external deps, no JS.
  const counts = SEVERITY_ORDER.map((s) => by[s]);
  const max = Math.max(...counts, 1);
  const rowH = 22;
  const rowGap = 6;
  const labelW = 84;
  const numW = 32;
  const chartW = 360;
  const barMax = chartW - labelW - numW;
  const height = SEVERITY_ORDER.length * (rowH + rowGap);

  const rows = SEVERITY_ORDER.map((sev, i) => {
    const v = by[sev];
    const w = (v / max) * barMax;
    const y = i * (rowH + rowGap);
    return [
      `<text x="0" y="${y + 15}" font-size="11" fill="#374151">${SEVERITY_LABEL[sev]}</text>`,
      `<rect x="${labelW}" y="${y}" width="${w.toFixed(2)}" height="${rowH}" fill="${SEVERITY_COLOR[sev]}" rx="2"/>`,
      `<text x="${labelW + w + 6}" y="${y + 15}" font-size="11" fill="#111" font-weight="600">${v}</text>`,
    ].join("");
  }).join("");

  return `<svg width="${chartW}" height="${height}" viewBox="0 0 ${chartW} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Severity distribution chart">${rows}</svg>`;
}

function renderFindingsSection(findings: readonly ReportFinding[]): string {
  if (findings.length === 0) {
    return '<section><h2>Findings</h2><p>No findings were produced by this scan.</p></section>';
  }
  // Group by severity in the canonical order for deterministic output.
  const sorted = [...findings].sort((a, b) => {
    const sa = SEVERITY_ORDER.indexOf(a.severity);
    const sb = SEVERITY_ORDER.indexOf(b.severity);
    if (sa !== sb) return sa - sb;
    return a.title.localeCompare(b.title);
  });
  return [
    "<section>",
    "<h2>Findings</h2>",
    ...sorted.map(renderFinding),
    "</section>",
  ].join("\n");
}

function renderFinding(f: ReportFinding): string {
  const idLabel = f.externalId ?? f.id;
  const meta: string[] = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    meta.push(`<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`);
  };
  push("Target", f.affectedTarget ?? null);
  push("Component", f.affectedComponent ?? null);
  push(
    "CVSS",
    f.cvssScore != null
      ? `${f.cvssScore.toFixed(1)}${f.cvssVersion ? ` (v${f.cvssVersion})` : ""}`
      : null,
  );
  push("CVSS vector", f.cvssVector ?? null);
  push("CWE", f.cwe && f.cwe.length > 0 ? f.cwe.join(", ") : null);
  push("MITRE", f.mitre && f.mitre.length > 0 ? f.mitre.join(", ") : null);
  push("Confidence", f.confidence ?? null);
  push("Phase", f.phase ?? null);
  push("Agent", f.agent ?? null);

  return [
    '<article class="finding">',
    '<div class="title-row">',
    `<span class="severity-badge severity-${f.severity}">${SEVERITY_LABEL[f.severity]}</span>`,
    `<span class="id">${escapeHtml(idLabel)}</span>`,
    "</div>",
    `<h3>${escapeHtml(f.title)}</h3>`,
    meta.length > 0 ? `<dl class="meta-grid">${meta.join("")}</dl>` : "",
    markdownToHtml(f.bodyMd),
    "</article>",
  ].join("");
}

function renderFooter(input: ReportTemplateInput): string {
  return `<div class="footer-meta">Sthrip report ${escapeHtml(input.reportId)} · scan ${escapeHtml(input.scan.id)} · generated ${formatTs(input.generatedAt)}</div>`;
}

// ---------------------------------------------------------------------------
// Markdown → HTML (minimal). Handles the constructs Decepticon emits:
// headings, paragraphs, fenced code blocks, inline code, ordered/unordered
// lists, GFM-style tables. NOT full CommonMark — by design.
// ---------------------------------------------------------------------------
function markdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block ```lang ... ```
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      // Skip the closing fence (or EOF).
      i++;
      out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // ATX heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]?.length ?? 1);
      // Demote so #/## inside a body don't outrank the report's own h2.
      const tag = `h${Math.min(6, level + 2)}`;
      out.push(`<${tag}>${renderInline(heading[2] ?? "")}</${tag}>`);
      i++;
      continue;
    }

    // GFM table: header line followed by --- separator.
    if (isTableHeader(line, lines[i + 1])) {
      const headerCells = splitTableRow(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (
        i < lines.length &&
        (lines[i] ?? "").includes("|") &&
        (lines[i] ?? "").trim() !== ""
      ) {
        bodyRows.push(splitTableRow(lines[i] ?? ""));
        i++;
      }
      const th = headerCells.map((c) => `<th>${renderInline(c)}</th>`).join("");
      const tb = bodyRows
        .map(
          (r) =>
            `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`,
        )
        .join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        const m = /^\s*[-*]\s+(.*)$/.exec(lines[i] ?? "");
        items.push(`<li>${renderInline(m?.[1] ?? "")}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        const m = /^\s*\d+\.\s+(.*)$/.exec(lines[i] ?? "");
        items.push(`<li>${renderInline(m?.[1] ?? "")}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Blank line — paragraph separator.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (gather consecutive non-blank, non-special lines).
    const paragraph: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^```/.test(lines[i] ?? "") &&
      !/^#{1,6}\s+/.test(lines[i] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[i] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[i] ?? "") &&
      !isTableHeader(lines[i] ?? "", lines[i + 1])
    ) {
      paragraph.push(lines[i] ?? "");
      i++;
    }
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return out.join("\n");
}

function isTableHeader(line: string | undefined, next: string | undefined): boolean {
  if (!line || !next) return false;
  if (!line.includes("|")) return false;
  // Separator row like `|---|---|` or `| :--- | :---: |`
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, "");
  return trimmed.split("|").map((c) => c.trim());
}

function renderInline(s: string): string {
  // Order matters: escape FIRST, then re-introduce safe markup.
  let out = escapeHtml(s);
  // Inline code `x`
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // Bold **x**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic *x* (kept simple — single-star, non-greedy, no underscore form)
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:])/g, "$1<em>$2</em>");
  // Links [label](url) — only http/https/mailto for safety.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
    (_m, label, url) => `<a href="${url}">${label}</a>`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTs(ms: number): string {
  // ISO-8601 in UTC; no locale variance — important for deterministic
  // byte-identical reports across hosts.
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}
