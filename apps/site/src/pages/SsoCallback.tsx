import { HandleSSOCallback } from '@clerk/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { RouteHead } from '../components/RouteHead.tsx';
import { Mono } from '../components/primitives.tsx';
import { normalizeReturnTo } from '../lib/auth-routing.ts';
import { isClerkConfigured } from '../lib/clerk.ts';

function navigateTo(navigate: ReturnType<typeof useNavigate>, destination: string): void {
  if (/^https?:\/\//i.test(destination)) {
    window.location.href = destination;
    return;
  }
  navigate(destination, { replace: true });
}

export default function SsoCallback() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const returnTo = normalizeReturnTo(search.get('return_to'));

  if (!isClerkConfigured) {
    return (
      <>
        <RouteHead title="Auth Callback — Sthrip" />
        <Mono size={12} color="var(--red)">
          auth_not_configured
        </Mono>
      </>
    );
  }

  return (
    <>
      <RouteHead title="Auth Callback — Sthrip" />
      <HandleSSOCallback
        navigateToApp={({ decorateUrl }) => navigateTo(navigate, decorateUrl(returnTo))}
        navigateToSignIn={() => navigate('/login', { replace: true })}
        navigateToSignUp={() => navigate('/signup', { replace: true })}
      />
    </>
  );
}
