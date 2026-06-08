import { SignIn, useAuth } from '@clerk/react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Mono } from '../components/primitives.tsx';
import { TENSOL_I18N } from '../i18n.ts';
import { normalizeReturnTo } from '../lib/auth-routing.ts';
import { isClerkConfigured } from '../lib/clerk.ts';

const ERROR_COPY: Record<string, string> = {
  auth_not_configured: 'clerk_publishable_key_missing',
  unauthenticated: 'sign_in_required',
};

export default function Login() {
  const t = TENSOL_I18N.en;
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const returnTo = normalizeReturnTo(search.get('return_to'));
  const error = search.get('error');
  const errorCode = error ? ERROR_COPY[error] ?? error : null;

  return (
    <AuthShell
      onBack={() => navigate('/')}
      language="en"
      brand="sthrip"
      eyebrow={t.authLoginEyebrow}
      title="Log in to Sthrip."
      sub="Use Google or GitHub through Clerk to unlock the workspace."
    >
      <RouteHead title="Log In — Sthrip" />
      <div
        data-screen-label="03 Auth — clerk sign in"
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        {errorCode && (
          <div
            style={{
              padding: '10px 12px',
              border: '1px solid var(--red)',
              color: 'var(--red)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
            }}
          >{`[fail] ${errorCode}`}</div>
        )}

        {isClerkConfigured ? (
          <ClerkSignIn returnTo={returnTo} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Mono size={12} color="var(--red)">
              auth_not_configured
            </Mono>
            <Mono size={12} color="var(--fg-2)">
              Set VITE_CLERK_PUBLISHABLE_KEY for local development.
            </Mono>
          </div>
        )}
      </div>
    </AuthShell>
  );
}

function ClerkSignIn({ returnTo }: { readonly returnTo: string }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return <Mono size={12}>loading auth</Mono>;
  }

  if (isSignedIn) {
    return <Navigate to={returnTo} replace />;
  }

  return (
    <div className="auth-clerk-frame">
      <SignIn
        routing="path"
        path="/login"
        signUpUrl="/signup"
        forceRedirectUrl={returnTo}
        fallback={<Mono size={12}>loading auth</Mono>}
      />
    </div>
  );
}
