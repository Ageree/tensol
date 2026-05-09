import { ScanError } from './types.ts';

const SCAN_ID_RE = /^[A-Za-z0-9_-]+$/;

export const buildUserAgent = ({ scanId }: { scanId: string }): string => {
  if (!SCAN_ID_RE.test(scanId)) {
    throw new ScanError({
      code: 'invalid_request',
      message: `Invalid scanId for User-Agent: ${JSON.stringify(scanId)}`,
    });
  }
  return `Tensol-Scan/${scanId}`;
};
