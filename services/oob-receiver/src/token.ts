// Sprint 18 — OOB callback token parser.
//
// Token format: <candidateUUID>.<tenantUUID>.<random8hex>
// All three segments must be present. Segment 1 and 2 must be valid UUIDs.
// Segment 3 must be exactly 8 lowercase hex chars.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANDOM8_RE = /^[0-9a-f]{8}$/;

export interface ParsedToken {
  readonly candidateId: string;
  readonly tenantId: string;
  readonly random8: string;
}

export const parseToken = (raw: string | null | undefined): ParsedToken | null => {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [candidateId, tenantId, random8] = parts as [string, string, string];
  if (!UUID_RE.test(candidateId)) return null;
  if (!UUID_RE.test(tenantId)) return null;
  if (!RANDOM8_RE.test(random8)) return null;
  return { candidateId, tenantId, random8 };
};

export const extractTokenFromPath = (
  pathname: string,
  queryToken: string | null,
): string | null => {
  // Try query param first — only if it parses as a valid token.
  if (queryToken && parseToken(queryToken)) return queryToken;
  // Try first path segment that matches token format: /<token>/...
  const segments = pathname.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg.includes('.') && parseToken(seg)) return seg;
  }
  return null;
};
