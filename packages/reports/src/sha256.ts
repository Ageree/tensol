import { createHash } from 'node:crypto';

export const computeSha256 = (buf: Buffer | Uint8Array): string =>
  createHash('sha256').update(buf).digest('hex');
