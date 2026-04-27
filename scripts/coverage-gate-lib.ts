// Pure library for coverage-gate.ts. Extracted so the gate is unit-testable
// without spawning a subprocess. See coverage-gate.ts for the runtime entry.

export interface FileTotals {
  readonly file: string;
  readonly linesFound: number;
  readonly linesHit: number;
  readonly functionsFound: number;
  readonly functionsHit: number;
  readonly branchesFound: number;
  readonly branchesHit: number;
}

export type Metric = 'line' | 'function' | 'branch' | 'statement';

export interface GateRatios {
  readonly line: number;
  readonly function: number;
  readonly branch: number;
  readonly statement: number;
}

export interface GateResult {
  readonly pass: boolean;
  readonly ratios: GateRatios;
  readonly failedMetrics: ReadonlyArray<Metric>;
}

const ratio = (hit: number, found: number): number => (found === 0 ? 1 : hit / found);

export const parseLcov = (content: string): ReadonlyArray<FileTotals> => {
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

export const aggregateRatios = (records: ReadonlyArray<FileTotals>): GateRatios => {
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

  const lineR = ratio(totals.linesHit, totals.linesFound);
  // Statement coverage in LCOV is the same instrumentation as line coverage.
  // See coverage-gate.ts header for the rationale; alias is explicit here.
  return {
    line: lineR,
    statement: lineR,
    function: ratio(totals.functionsHit, totals.functionsFound),
    branch: ratio(totals.branchesHit, totals.branchesFound),
  };
};

export const evaluateGate = (records: ReadonlyArray<FileTotals>, threshold: number): GateResult => {
  const ratios = aggregateRatios(records);
  const failedMetrics: Metric[] = [];
  if (ratios.line < threshold) failedMetrics.push('line');
  if (ratios.function < threshold) failedMetrics.push('function');
  if (ratios.branch < threshold) failedMetrics.push('branch');
  if (ratios.statement < threshold) failedMetrics.push('statement');
  return {
    pass: failedMetrics.length === 0,
    ratios,
    failedMetrics: Object.freeze(failedMetrics),
  };
};
