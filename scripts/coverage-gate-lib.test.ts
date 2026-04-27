// Codex review F2: prove each of the 4 declared metrics can independently
// fail the gate. The `statement` metric is aliased to `line` per the LCOV
// equivalence documented in coverage-gate.ts, so failing line necessarily
// also fails statement; the dedicated statement-only test verifies that
// the `statement` field is reported and used by the gate (not silently
// dropped).

import { describe, expect, test } from 'bun:test';
import {
  type FileTotals,
  aggregateRatios,
  evaluateGate,
  filterByWorkspace,
  parseLcov,
} from './coverage-gate-lib.ts';

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

// =================================================================
// Sprint 2 contract B26-B29 — per-workspace coverage gate.
// =================================================================
//
// Two records: one in packages/config (perfect), one in packages/db (60%).
// At threshold 0.80 with workspaceFilter=packages/db, gate FAILS on
// line+statement; with workspaceFilter=packages/config, gate PASSES.
// This proves a real package can dip below 80% even while the global
// aggregate stays green — the per-workspace gate is the real safety net
// from Sprint 2 onward (per Sprint 1 §9 R6 forward note).

const configPerfect: FileTotals = {
  file: '/repo/packages/config/src/index.ts',
  linesFound: 100,
  linesHit: 100,
  functionsFound: 20,
  functionsHit: 20,
  branchesFound: 30,
  branchesHit: 30,
};

const dbPartial: FileTotals = {
  file: '/repo/packages/db/src/repos/aggregates.ts',
  linesFound: 100,
  linesHit: 60, // 60%
  functionsFound: 20,
  functionsHit: 12, // 60%
  branchesFound: 30,
  branchesHit: 18, // 60%
};

describe('coverage-gate-lib :: filterByWorkspace (B26)', () => {
  test('returns all records when workspace is undefined', () => {
    expect(filterByWorkspace([configPerfect, dbPartial], undefined).length).toBe(2);
  });

  test('filters by workspace prefix', () => {
    const out = filterByWorkspace([configPerfect, dbPartial], 'packages/db');
    expect(out.length).toBe(1);
    expect(out[0]?.file).toContain('packages/db');
  });

  test('anchors with trailing slash to avoid prefix collision', () => {
    const sibling: FileTotals = {
      ...configPerfect,
      file: '/repo/packages/db-analytics/src/index.ts',
    };
    const out = filterByWorkspace([dbPartial, sibling], 'packages/db');
    expect(out.length).toBe(1);
    expect(out[0]?.file).toContain('packages/db/');
  });

  test('appends slash automatically if caller forgot it', () => {
    const out = filterByWorkspace([configPerfect, dbPartial], 'packages/db');
    expect(out.length).toBe(1);
  });

  test('empty result when no record matches', () => {
    expect(filterByWorkspace([configPerfect, dbPartial], 'packages/audit').length).toBe(0);
  });
});

describe('coverage-gate-lib :: evaluateGate per-workspace (B27, B28)', () => {
  test('B27 — packages/db at 60% FAILS gate at 0.80; packages/config PASSES', () => {
    const dbResult = evaluateGate([configPerfect, dbPartial], 0.8, 'packages/db');
    expect(dbResult.pass).toBe(false);
    expect(dbResult.failedMetrics).toContain('line');
    expect(dbResult.failedMetrics).toContain('function');
    expect(dbResult.failedMetrics).toContain('branch');
    expect(dbResult.failedMetrics).toContain('statement');

    const configResult = evaluateGate([configPerfect, dbPartial], 0.8, 'packages/config');
    expect(configResult.pass).toBe(true);
    expect(configResult.failedMetrics.length).toBe(0);
  });

  test('B27 — global aggregate (no workspace filter) hides per-package dips', () => {
    // 80% line coverage globally — passes the 0.80 gate even though
    // packages/db is only 60%. This is exactly the gotcha §9 R6 warned about.
    const global = evaluateGate([configPerfect, dbPartial], 0.8);
    expect(global.pass).toBe(true);
  });

  test('B28 — workspace gate raises ratios reflect filtered subset only', () => {
    const r = aggregateRatios([configPerfect, dbPartial], 'packages/db');
    expect(r.line).toBeCloseTo(0.6, 5);
    expect(r.function).toBeCloseTo(0.6, 5);
    expect(r.branch).toBeCloseTo(0.6, 5);
    expect(r.statement).toBeCloseTo(0.6, 5);
  });

  test('B29 — undefined workspace = full aggregate (CI fallback path)', () => {
    const r = aggregateRatios([configPerfect, dbPartial], undefined);
    // 100 + 60 hit / 200 found = 0.80
    expect(r.line).toBeCloseTo(0.8, 5);
  });
});
