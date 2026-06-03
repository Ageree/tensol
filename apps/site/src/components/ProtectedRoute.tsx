import type { ReactNode } from 'react';
import { useAuth } from '@clerk/react';
import { Navigate, useLocation } from 'react-router-dom';
import { isClerkConfigured } from '../lib/clerk.ts';
import { Placeholder } from './Placeholder.tsx';

function returnTo(pathname: string, search: string): string {
  const value = `${pathname}${search}`;
  return value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard';
}

function loginPath(pathname: string, search: string, reason?: string): string {
  const params = new URLSearchParams({ return_to: returnTo(pathname, search) });
  if (reason) params.set('error', reason);
  return `/login?${params.toString()}`;
}

export function ProtectedRoute({ children }: { readonly children: ReactNode }) {
  const location = useLocation();

  if (!isClerkConfigured) {
    return (
      <Navigate
        to={loginPath(location.pathname, location.search, 'auth_not_configured')}
        replace
      />
    );
  }

  return <ProtectedRouteInner>{children}</ProtectedRouteInner>;
}

function ProtectedRouteInner({ children }: { readonly children: ReactNode }) {
  const location = useLocation();
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <Placeholder
        route="auth"
        title="Loading auth"
        hint="Checking the active Clerk session."
      />
    );
  }

  if (!isSignedIn) {
    return (
      <Navigate to={loginPath(location.pathname, location.search)} replace />
    );
  }

  return <>{children}</>;
}
