export function normalizeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/dashboard';
  }
  return raw;
}

export function githubSsoCallbackUrl(returnTo: string): string {
  const params = new URLSearchParams({ return_to: returnTo });
  return `/sso-callback?${params.toString()}`;
}
