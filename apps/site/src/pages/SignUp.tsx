import { Show, SignUp } from '@clerk/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Mono } from '../components/primitives.tsx';
import { TENSOL_I18N } from '../i18n.ts';
import { isClerkConfigured } from '../lib/clerk.ts';

function normalizeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/dashboard';
  }
  return raw;
}

export default function SignUpPage() {
  const t = TENSOL_I18N.en;
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
      sub="Use Google through Clerk to unlock the workspace."
    >
      <RouteHead title="Sign Up — Sthrip" />
      {isClerkConfigured ? (
        <Show
          when="signed-out"
          fallback={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Mono size={12} color="var(--fg-2)">
                active session detected
              </Mono>
              <Btn kind="primary" href={returnTo}>
                {t.authContinue} →
              </Btn>
            </div>
          }
        >
          <SignUp
            routing="path"
            path="/signup"
            signInUrl="/login"
            forceRedirectUrl={returnTo}
            fallback={<Mono size={12}>loading auth</Mono>}
          />
        </Show>
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
