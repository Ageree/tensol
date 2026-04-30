// Sprint 18 — header redaction for OOB callbacks.
// Authorization and Cookie values replaced with '[REDACTED]' before DB insert.

const REDACTED_HEADERS: ReadonlySet<string> = new Set(['authorization', 'cookie']);

export const redactHeaders = (headers: Record<string, string>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return result;
};
