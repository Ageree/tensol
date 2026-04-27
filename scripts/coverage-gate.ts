// LCOV post-hook coverage gate.
//
// Bun 1.3.11's `coverageThreshold` in bunfig.toml does not currently fail the
// `bun test --coverage` run on threshold breach. This script parses
// coverage/lcov.info and exits non-zero when ANY of {line, function, branch,
// statement} drops below the configured threshold (default 0.80).
//
// Statement metric note (Codex review F2): the LCOV format does not expose a
// distinct statement count separate from lines. In LCOV, `DA` records are the
// statement-level execution markers and `LF`/`LH` are their found/hit totals.
// V8/c8 derive their "statement" coverage from the same instrumentation. We
// therefore alias `statement = line` and document this here. If a future Bun
// version emits a separate statement count (e.g. via a JSON reporter), this
// gate can switch to the richer source without breaking the API.
//
// Usage:
//   bun test --coverage   # produces coverage/lcov.info
//   bun run scripts/coverage-gate.ts [--threshold=0.80] [--workspace=packages/db]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type GateResult, evaluateGate, parseLcov } from './coverage-gate-lib.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lcovPath = `${repoRoot}coverage/lcov.info`;

const args = Bun.argv.slice(2);
const thresholdArg = args.find((a) => a.startsWith('--threshold='));
const threshold = thresholdArg ? Number.parseFloat(thresholdArg.split('=')[1] ?? '0.8') : 0.8;

const workspaceArg = args.find((a) => a.startsWith('--workspace='));
const workspace = workspaceArg ? workspaceArg.split('=')[1] : undefined;

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  console.error(`invalid threshold: ${threshold}`);
  process.exit(2);
}

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

const result: GateResult = evaluateGate(records, threshold, workspace);

const fmt = (r: number) => `${(r * 100).toFixed(2)}%`;
const scope = workspace ? ` workspace=${workspace}` : '';
console.warn(
  `coverage-gate:${scope} lines=${fmt(result.ratios.line)} functions=${fmt(result.ratios.function)} branches=${fmt(result.ratios.branch)} statements=${fmt(result.ratios.statement)} (threshold ${fmt(threshold)})`,
);

if (!result.pass) {
  console.error(
    `coverage-gate:${scope} FAIL — metrics below threshold: ${result.failedMetrics.join(', ')}`,
  );
  process.exit(1);
}
