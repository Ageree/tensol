export const MARKETING_ROUTES = [
  '/',
  '/pricing',
  '/solutions',
  '/solutions/blackbox',
  '/solutions/whitebox',
  '/solutions/pr-review',
  '/trust',
  '/resources',
  '/contact',
] as const;

export const LEGAL_ROUTES = [
  '/legal/privacy',
  '/legal/terms',
  '/legal/refund',
  '/legal/dpa',
] as const;

export const AUTH_ROUTES = ['/login', '/bootstrap', '/invite'] as const;

export const APP_ROUTES = [
  '/dashboard',
  '/projects',
  '/targets',
  '/builder',
  '/approval',
  '/live',
  '/findings',
  '/reports',
  '/settings',
] as const;

export const ERROR_KINDS = ['401', '403', '404', '500', 'offline'] as const;

export const ERROR_ROUTES = ERROR_KINDS.map((k) => `/err/${k}` as const);

export const ALL_ROUTES = [
  ...MARKETING_ROUTES,
  ...LEGAL_ROUTES,
  ...AUTH_ROUTES,
  ...APP_ROUTES,
  ...ERROR_ROUTES,
] as const;
