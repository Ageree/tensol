import { useState } from 'react';
import { useSignIn, useSignUp } from '@clerk/react';
import { GitBranch } from 'lucide-react';
import { githubSsoCallbackUrl } from '../lib/auth-routing.ts';
import { Btn, Mono } from './primitives.tsx';

type GitHubOAuthButtonProps = {
  mode: 'sign-in' | 'sign-up';
  returnTo: string;
};

function errorMessage(error: unknown): string {
  if (!error) return 'github_oauth_failed';
  if (typeof error !== 'object') return 'github_oauth_failed';

  const candidate = error as { longMessage?: unknown; message?: unknown };
  if (typeof candidate.longMessage === 'string' && candidate.longMessage) {
    return candidate.longMessage;
  }
  if (typeof candidate.message === 'string' && candidate.message) {
    return candidate.message;
  }

  return 'github_oauth_failed';
}

export function GitHubOAuthButton({ mode, returnTo }: GitHubOAuthButtonProps) {
  const { signIn, fetchStatus: signInStatus } = useSignIn();
  const { signUp, fetchStatus: signUpStatus } = useSignUp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = pending || signInStatus === 'fetching' || signUpStatus === 'fetching';

  const startGithubAuth = async () => {
    setPending(true);
    setError(null);

    const redirectCallbackUrl = githubSsoCallbackUrl(returnTo);

    try {
      if (mode === 'sign-in') {
        const result = await signIn.sso({
          strategy: 'oauth_github',
          redirectUrl: returnTo,
          redirectCallbackUrl,
        });
        if (result.error) setError(errorMessage(result.error));
      } else {
        const result = await signUp.sso({
          strategy: 'oauth_github',
          redirectUrl: returnTo,
          redirectCallbackUrl,
        });
        if (result.error) setError(errorMessage(result.error));
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Btn
        kind="primary"
        fullWidth
        onClick={startGithubAuth}
        disabled={busy}
        title="Continue with GitHub"
      >
        <GitBranch size={16} strokeWidth={2} aria-hidden="true" />
        {busy ? 'Connecting...' : 'Continue with GitHub'}
      </Btn>
      {error && (
        <Mono size={12} color="var(--red)">
          {error}
        </Mono>
      )}
    </div>
  );
}
