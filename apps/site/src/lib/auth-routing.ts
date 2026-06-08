export function normalizeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/dashboard';
  }
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) {
    return '/dashboard';
  }
  if (raw === '/signup' || raw.startsWith('/signup?') || raw.startsWith('/signup/')) {
    return '/dashboard';
  }
  return raw;
}
