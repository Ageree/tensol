// Sprint 10 — evidence-collector. Pure helper. Hashes screenshot + trace
// bytes from each replay run and packages them as object-storage put inputs.

import { createHash } from 'node:crypto';
import type { XssReplayResult } from './xss-replay-driver.ts';

export type EvidenceKind = 'screenshot' | 'trace';

export interface EvidenceBlob {
  readonly kind: EvidenceKind;
  readonly attempt: number;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

const sha256Hex = (buf: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(buf)).digest('hex');

export const collectEvidence = (
  runs: ReadonlyArray<XssReplayResult>,
): ReadonlyArray<EvidenceBlob> => {
  const out: EvidenceBlob[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run) continue;
    out.push({
      kind: 'screenshot',
      attempt: i + 1,
      body: run.screenshot,
      contentType: 'image/png',
      sha256: sha256Hex(run.screenshot),
      sizeBytes: run.screenshot.byteLength,
    });
    out.push({
      kind: 'trace',
      attempt: i + 1,
      body: run.trace,
      contentType: 'application/zip',
      sha256: sha256Hex(run.trace),
      sizeBytes: run.trace.byteLength,
    });
  }
  return out;
};

export const evidenceObjectKey = (args: {
  tenantId: string;
  findingId: string;
  kind: EvidenceKind;
  attempt: number;
  sha256: string;
}): string => {
  const ext = args.kind === 'screenshot' ? 'png' : 'zip';
  return `tenant/${args.tenantId}/finding/${args.findingId}/${args.kind}-${args.attempt}-${args.sha256}.${ext}`;
};
