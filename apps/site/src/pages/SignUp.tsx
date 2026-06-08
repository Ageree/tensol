import { SignUp, useAuth } from '@clerk/react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Mono } from '../components/primitives.tsx';
import { normalizeReturnTo } from '../lib/auth-routing.ts';
import { isClerkConfigured } from '../lib/clerk.ts';

export default function SignUpPage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const returnTo = normalizeReturnTo(search.get('return_to'));

  return (
    <AuthShell
      onBack={() => navigate('/')}
      language="en"
      brand="sthrip"
      eyebrow="// SIGN UP"
      title="Create your Sthrip account."
      sub="Use Google or GitHub through Clerk to unlock the workspace."
    >
      <RouteHead title="Sign Up — Sthrip" />
      {isClerkConfigured ? (
        <ClerkSignUp returnTo={returnTo} />
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
    </AuthShell>
  );
}

function ClerkSignUp({ returnTo }: { readonly returnTo: string }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return <Mono size={12}>loading auth</Mono>;
  }

  if (isSignedIn) {
    return <Navigate to={returnTo} replace />;
  }

  return (
    <div className="auth-clerk-frame">
      <SignUp
        routing="path"
        path="/signup"
        signInUrl="/login"
        forceRedirectUrl={returnTo}
        fallback={<Mono size={12}>loading auth</Mono>}
      />
    </div>
  );
}
