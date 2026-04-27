/**
 * Evaluator-authored probes for Sprint 1 codex-review fixes.
 * Independent of Generator's tests. Run with:
 *   bun .harness/cyberstrike-hybrid/evaluator-probe-fixes.ts
 *
 * Covers:
 *   F2 — every metric (line, function, branch, statement) can independently
 *        fail the gate when its threshold is raised. Statement is verified
 *        as a real participant, not a silent alias.
 */
import { aggregateRatios, evaluateGate, parseLcov } from '../../scripts/coverage-gate-lib.ts';

let failures = 0;
const log = (label: string, pass: boolean, detail = '') => {
  const tag = pass ? 'PASS' : 'FAIL';
  if (!pass) failures++;
  console.log(`${tag}  ${label}${detail ? ' — ' + detail : ''}`);
};

// Synthetic LCOV fixture where each metric can be tuned independently.
const buildLcov = (opts: {
  linesFound: number;
  linesHit: number;
  fnFound: number;
  fnHit: number;
  brFound: number;
  brHit: number;
}): string =>
  [
    'TN:',
    'SF:src/synthetic.ts',
    `LF:${opts.linesFound}`,
    `LH:${opts.linesHit}`,
    `FNF:${opts.fnFound}`,
    `FNH:${opts.fnHit}`,
    `BRF:${opts.brFound}`,
    `BRH:${opts.brHit}`,
    'end_of_record',
    '',
  ].join('\n');

// All-perfect baseline. Every metric at 100%.
const perfect = buildLcov({
  linesFound: 100,
  linesHit: 100,
  fnFound: 10,
  fnHit: 10,
  brFound: 20,
  brHit: 20,
});

// === F2 PROBE 1: Baseline pass at threshold=0.8 ===
{
  const r = evaluateGate(parseLcov(perfect), 0.8);
  log(
    'F2.baseline: perfect coverage at threshold=0.80 passes',
    r.pass && r.failedMetrics.length === 0,
    `pass=${r.pass} failed=[${r.failedMetrics.join(',')}]`,
  );
}

// === F2 PROBE 2: Each metric can independently fail ===
const cases: Array<{
  label: string;
  metric: 'line' | 'function' | 'branch' | 'statement';
  lcov: string;
}> = [
  {
    label: 'line metric drops to 50% — gate must list line+statement',
    metric: 'line',
    lcov: buildLcov({ linesFound: 100, linesHit: 50, fnFound: 10, fnHit: 10, brFound: 20, brHit: 20 }),
  },
  {
    label: 'function metric drops to 50% — gate must list function',
    metric: 'function',
    lcov: buildLcov({ linesFound: 100, linesHit: 100, fnFound: 10, fnHit: 5, brFound: 20, brHit: 20 }),
  },
  {
    label: 'branch metric drops to 50% — gate must list branch',
    metric: 'branch',
    lcov: buildLcov({ linesFound: 100, linesHit: 100, fnFound: 10, fnHit: 10, brFound: 20, brHit: 10 }),
  },
];

for (const c of cases) {
  const r = evaluateGate(parseLcov(c.lcov), 0.8);
  if (c.metric === 'line') {
    // line and statement share LCOV instrumentation, so statement must also fail.
    const ok =
      !r.pass &&
      r.failedMetrics.includes('line') &&
      r.failedMetrics.includes('statement');
    log(c.label, ok, `failedMetrics=[${r.failedMetrics.join(',')}] line=${r.ratios.line.toFixed(2)} statement=${r.ratios.statement.toFixed(2)}`);
  } else {
    const ok = !r.pass && r.failedMetrics.includes(c.metric);
    log(c.label, ok, `failedMetrics=[${r.failedMetrics.join(',')}]`);
  }
}

// === F2 PROBE 3: Statement is NOT silently dropped at high threshold ===
// Even on perfect coverage, raising threshold to 1.001 must list statement.
{
  // Force statement < 1.001 by using a lcov where line=100/100 (=1.0) but threshold>1.
  const r = evaluateGate(parseLcov(perfect), 1.001);
  const ok = !r.pass && r.failedMetrics.includes('statement') && r.failedMetrics.includes('line');
  log(
    'F2.statement-active: statement appears in failedMetrics when threshold > 1.0',
    ok,
    `failedMetrics=[${r.failedMetrics.join(',')}]`,
  );
}

// === F2 PROBE 4: Statement is the same as line (alias verified) ===
{
  const ratios = aggregateRatios(parseLcov(buildLcov({
    linesFound: 100, linesHit: 73, fnFound: 10, fnHit: 10, brFound: 20, brHit: 20,
  })));
  const ok = ratios.line === ratios.statement && Math.abs(ratios.line - 0.73) < 1e-9;
  log(
    'F2.alias: statement === line in aggregateRatios output (lcov has no separate statement record)',
    ok,
    `line=${ratios.line.toFixed(4)} statement=${ratios.statement.toFixed(4)}`,
  );
}

// === F2 PROBE 5: failedMetrics is frozen (immutability) ===
{
  const r = evaluateGate(parseLcov(perfect), 0.8);
  const ok = Object.isFrozen(r.failedMetrics);
  log('F2.immutable: failedMetrics array is frozen', ok);
}

console.log(`=== ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
