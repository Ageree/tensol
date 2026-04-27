// Codex review F2: prove each of the 4 declared metrics can independently
// fail the gate. The `statement` metric is aliased to `line` per the LCOV
// equivalence documented in coverage-gate.ts, so failing line necessarily
// also fails statement; the dedicated statement-only test verifies that
// the `statement` field is reported and used by the gate (not silently
// dropped).

import { describe, expect, test } from 'bun:test';
import { type FileTotals, aggregateRatios, evaluateGate, parseLcov } from './coverage-gate-lib.ts';

const allHit: FileTotals = {
  file: 'a.ts',
  linesFound: 10,
  linesHit: 10,
  functionsFound: 4,
  functionsHit: 4,
  branchesFound: 6,
  branchesHit: 6,
};

const onlyLineDip: FileTotals = {
  ...allHit,
  linesFound: 10,
  linesHit: 7, // 70%
};

const onlyFunctionDip: FileTotals = {
  ...allHit,
  functionsFound: 10,
  functionsHit: 5, // 50%
};

const onlyBranchDip: FileTotals = {
  ...allHit,
  branchesFound: 10,
  branchesHit: 4, // 40%
};

describe('coverage-gate-lib :: parseLcov', () => {
  test('parses a single record', () => {
    const lcov = [
      'SF:foo.ts',
      'LF:10',
      'LH:9',
      'FNF:2',
      'FNH:2',
      'BRF:4',
      'BRH:3',
      'end_of_record',
      '',
    ].join('\n');
    const out = parseLcov(lcov);
    expect(out.length).toBe(1);
    expect(out[0]?.file).toBe('foo.ts');
    expect(out[0]?.linesFound).toBe(10);
    expect(out[0]?.linesHit).toBe(9);
    expect(out[0]?.functionsHit).toBe(2);
    expect(out[0]?.branchesHit).toBe(3);
  });

  test('parses multiple records', () => {
    const lcov = [
      'SF:a.ts',
      'LF:5',
      'LH:5',
      'FNF:1',
      'FNH:1',
      'BRF:0',
      'BRH:0',
      'end_of_record',
      'SF:b.ts',
      'LF:8',
      'LH:6',
      'FNF:3',
      'FNH:2',
      'BRF:2',
      'BRH:1',
      'end_of_record',
      '',
    ].join('\n');
    const out = parseLcov(lcov);
    expect(out.length).toBe(2);
  });

  test('returns empty array for empty input', () => {
    expect(parseLcov('').length).toBe(0);
  });

  test('zero-found metrics report as 1.0 ratio (no instrumentation = pass)', () => {
    const r = aggregateRatios([{ ...allHit, branchesFound: 0, branchesHit: 0 }]);
    expect(r.branch).toBe(1);
  });
});

describe('coverage-gate-lib :: aggregateRatios', () => {
  test('all 100% gives all 1.0', () => {
    const r = aggregateRatios([allHit]);
    expect(r.line).toBe(1);
    expect(r.function).toBe(1);
    expect(r.branch).toBe(1);
    expect(r.statement).toBe(1);
  });

  test('statement is aliased to line', () => {
    const r = aggregateRatios([onlyLineDip]);
    expect(r.line).toBeCloseTo(0.7, 5);
    expect(r.statement).toBeCloseTo(0.7, 5);
    expect(r.statement).toBe(r.line);
  });

  test('aggregates totals across files', () => {
    const r = aggregateRatios([
      {
        file: 'a',
        linesFound: 10,
        linesHit: 8,
        functionsFound: 0,
        functionsHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      },
      {
        file: 'b',
        linesFound: 10,
        linesHit: 10,
        functionsFound: 0,
        functionsHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      },
    ]);
    expect(r.line).toBeCloseTo(0.9, 5);
  });
});

describe('coverage-gate-lib :: evaluateGate (Codex F2 — per-metric independence)', () => {
  test('passes when all metrics meet threshold', () => {
    const result = evaluateGate([allHit], 0.8);
    expect(result.pass).toBe(true);
    expect(result.failedMetrics.length).toBe(0);
  });

  test('LINE metric alone can fail the gate', () => {
    const result = evaluateGate([onlyLineDip], 0.8);
    expect(result.pass).toBe(false);
    expect(result.failedMetrics).toContain('line');
  });

  test('FUNCTION metric alone can fail the gate', () => {
    const result = evaluateGate([onlyFunctionDip], 0.8);
    expect(result.pass).toBe(false);
    expect(result.failedMetrics).toContain('function');
    expect(result.failedMetrics).not.toContain('line');
    expect(result.failedMetrics).not.toContain('branch');
  });

  test('BRANCH metric alone can fail the gate', () => {
    const result = evaluateGate([onlyBranchDip], 0.8);
    expect(result.pass).toBe(false);
    expect(result.failedMetrics).toContain('branch');
    expect(result.failedMetrics).not.toContain('line');
    expect(result.failedMetrics).not.toContain('function');
  });

  test('STATEMENT metric is reported and tracks LINE (LCOV equivalence)', () => {
    // Codex F2 — statement claim must be enforced. Since lcov aliases
    // statement = line, the gate fails on statement whenever line fails.
    const result = evaluateGate([onlyLineDip], 0.8);
    expect(result.pass).toBe(false);
    expect(result.failedMetrics).toContain('statement');
    expect(result.ratios.statement).toBeLessThan(0.8);
  });

  test('all 4 metrics fail simultaneously when threshold raised to 1.0', () => {
    const result = evaluateGate([onlyLineDip, onlyFunctionDip, onlyBranchDip], 1.0);
    expect(result.pass).toBe(false);
    expect(result.failedMetrics).toContain('line');
    expect(result.failedMetrics).toContain('function');
    expect(result.failedMetrics).toContain('branch');
    expect(result.failedMetrics).toContain('statement');
  });

  test('threshold of 0 always passes (sanity)', () => {
    const result = evaluateGate([onlyBranchDip], 0);
    expect(result.pass).toBe(true);
  });
});
