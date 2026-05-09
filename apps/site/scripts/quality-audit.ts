/**
 * Runs axe-core accessibility audits on 5 representative routes.
 * Outputs severity counts to stdout in Markdown table format.
 *
 * Usage:
 *   bun run scripts/quality-audit.ts [--url http://127.0.0.1:5175]
 *
 * Requires a running dev server (default port 5175).
 */
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = (() => {
  const idx = process.argv.indexOf('--url');
  return idx !== -1 ? process.argv[idx + 1] : 'http://127.0.0.1:5175';
})();

const AUDIT_ROUTES: { name: string; path: string }[] = [
  { name: 'Marketing (/)',      path: '/' },
  { name: 'Pricing (/pricing)', path: '/pricing' },
  { name: 'Trust (/trust)',     path: '/trust' },
  { name: 'Login (/login)',     path: '/login' },
  { name: 'Dashboard (/dashboard)', path: '/dashboard' },
];

interface SeverityCounts {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
  total: number;
}

interface RouteResult {
  name: string;
  url: string;
  counts: SeverityCounts;
  violations: { id: string; impact: string; description: string; nodes: number }[];
}

async function auditRoute(
  page: import('@playwright/test').Page,
  route: { name: string; path: string },
): Promise<RouteResult> {
  const url = `${BASE_URL}${route.path}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(500); // let React settle

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'best-practice'])
    .analyze();

  const counts: SeverityCounts = { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 };
  const violations = results.violations.map((v) => {
    const impact = (v.impact ?? 'minor') as keyof Omit<SeverityCounts, 'total'>;
    counts[impact] = (counts[impact] ?? 0) + 1;
    counts.total += 1;
    return {
      id: v.id,
      impact: v.impact ?? 'minor',
      description: v.description,
      nodes: v.nodes.length,
    };
  });

  return { name: route.name, url, counts, violations };
}

function renderMarkdown(results: RouteResult[], label: string): string {
  const lines: string[] = [
    `# Axe Audit — ${label}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    `Base URL: ${BASE_URL}`,
    '',
    '## Summary',
    '',
    '| Route | Critical | Serious | Moderate | Minor | Total |',
    '|-------|----------|---------|----------|-------|-------|',
  ];

  for (const r of results) {
    const { critical, serious, moderate, minor, total } = r.counts;
    lines.push(`| ${r.name} | ${critical} | ${serious} | ${moderate} | ${minor} | ${total} |`);
  }

  lines.push('', '## Violation Detail', '');

  for (const r of results) {
    lines.push(`### ${r.name}`, '');
    if (r.violations.length === 0) {
      lines.push('No violations.', '');
    } else {
      lines.push('| Rule ID | Impact | Nodes | Description |');
      lines.push('|---------|--------|-------|-------------|');
      for (const v of r.violations) {
        const desc = v.description.replace(/\|/g, '\\|').substring(0, 80);
        lines.push(`| \`${v.id}\` | ${v.impact} | ${v.nodes} | ${desc} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`Auditing ${AUDIT_ROUTES.length} routes against ${BASE_URL}...\n`);

  const results: RouteResult[] = [];
  for (const route of AUDIT_ROUTES) {
    process.stdout.write(`  ${route.name} ... `);
    try {
      const r = await auditRoute(page, route);
      results.push(r);
      console.log(`${r.counts.total} violations (C:${r.counts.critical} S:${r.counts.serious} M:${r.counts.moderate} m:${r.counts.minor})`);
    } catch (e) {
      console.log(`ERROR: ${(e as Error).message}`);
      results.push({
        name: route.name,
        url: `${BASE_URL}${route.path}`,
        counts: { critical: -1, serious: -1, moderate: -1, minor: -1, total: -1 },
        violations: [],
      });
    }
  }

  await browser.close();

  // Determine output path from --out flag or default
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx !== -1
    ? process.argv[outIdx + 1]
    : path.resolve(process.cwd(), '.harness/apps-site-quality-baseline/BEFORE.md');

  const label = process.argv.includes('--after') ? 'AFTER (post-fix)' : 'BEFORE (baseline)';
  const md = renderMarkdown(results, label);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`\nReport written to: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
