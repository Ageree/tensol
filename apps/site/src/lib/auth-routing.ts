export function normalizeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/dashboard';
  }
  return raw;
}
