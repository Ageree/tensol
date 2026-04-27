// LCOV post-hook fallback gate.
// Bun 1.3.11's `coverageThreshold` in bunfig.toml does not currently fail the
// `bun test --coverage` run on threshold breach. This script parses lcov.info
// and exits non-zero when any of {line, function, branch, statement} drops
// below the configured threshold (default 0.80).
//
// Usage:
//   bun test --coverage   # produces coverage/lcov.info
//   bun run scripts/coverage-gate.ts [--threshold=0.80]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lcovPath = `${repoRoot}coverage/lcov.info`;

const args = Bun.argv.slice(2);
const thresholdArg = args.find((a) => a.startsWith('--threshold='));
const threshold = thresholdArg ? Number.parseFloat(thresholdArg.split('=')[1] ?? '0.8') : 0.8;

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  console.error(`invalid threshold: ${threshold}`);
  process.exit(2);
}

interface FileTotals {
  readonly file: string;
  readonly linesFound: number;
  readonly linesHit: number;
  readonly functionsFound: number;
  readonly functionsHit: number;
  readonly branchesFound: number;
  readonly branchesHit: number;
}

const parseLcov = (content: string): ReadonlyArray<FileTotals> => {
  const records: FileTotals[] = [];
  let cur: Partial<FileTotals> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) cur = { file: line.slice(3) };
    else if (line.startsWith('LF:')) cur.linesFound = Number(line.slice(3));
    else if (line.startsWith('LH:')) cur.linesHit = Number(line.slice(3));
    else if (line.startsWith('FNF:')) cur.functionsFound = Number(line.slice(4));
    else if (line.startsWith('FNH:')) cur.functionsHit = Number(line.slice(4));
    else if (line.startsWith('BRF:')) cur.branchesFound = Number(line.slice(4));
    else if (line.startsWith('BRH:')) cur.branchesHit = Number(line.slice(4));
    else if (line === 'end_of_record') {
      records.push({
        file: cur.file ?? '<unknown>',
        linesFound: cur.linesFound ?? 0,
        linesHit: cur.linesHit ?? 0,
        functionsFound: cur.functionsFound ?? 0,
        functionsHit: cur.functionsHit ?? 0,
        branchesFound: cur.branchesFound ?? 0,
        branchesHit: cur.branchesHit ?? 0,
      });
      cur = {};
    }
  }
  return records;
};

const ratio = (hit: number, found: number): number => (found === 0 ? 1 : hit / found);

let content: string;
try {
  content = readFileSync(lcovPath, 'utf8');
} catch {
  console.error(`coverage-gate: cannot read ${lcovPath}. Run \`bun test --coverage\` first.`);
  process.exit(2);
}

const records = parseLcov(content);
if (records.length === 0) {
  console.error('coverage-gate: lcov.info contained no records');
  process.exit(2);
}

const totals = records.reduce(
  (acc, r) => ({
    linesFound: acc.linesFound + r.linesFound,
    linesHit: acc.linesHit + r.linesHit,
    functionsFound: acc.functionsFound + r.functionsFound,
    functionsHit: acc.functionsHit + r.functionsHit,
    branchesFound: acc.branchesFound + r.branchesFound,
    branchesHit: acc.branchesHit + r.branchesHit,
  }),
  {
    linesFound: 0,
    linesHit: 0,
    functionsFound: 0,
    functionsHit: 0,
    branchesFound: 0,
    branchesHit: 0,
  },
);

const lineRatio = ratio(totals.linesHit, totals.linesFound);
const functionRatio = ratio(totals.functionsHit, totals.functionsFound);
const branchRatio = ratio(totals.branchesHit, totals.branchesFound);

const fail = lineRatio < threshold || functionRatio < threshold || branchRatio < threshold;

const fmt = (r: number) => `${(r * 100).toFixed(2)}%`;
console.warn(
  `coverage-gate: lines=${fmt(lineRatio)} functions=${fmt(functionRatio)} branches=${fmt(branchRatio)} (threshold ${fmt(threshold)})`,
);

if (fail) {
  console.error('coverage-gate: FAIL — at least one metric below threshold');
  process.exit(1);
}
