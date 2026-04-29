import type React from 'react';
import { useState } from 'react';
import { login, loginMfa } from '../api/auth.ts';
import { ApiError } from '../api/client.ts';
import { useAuth } from '../auth/context.tsx';

export const LoginPage = ({ onSuccess }: { onSuccess: () => void }) => {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [preAuthToken, setPreAuthToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await login(email, password);
      if (res.status === 'mfa_required' && res.preAuthToken) {
        setPreAuthToken(res.preAuthToken);
      } else {
        await refresh();
        onSuccess();
      }
    } catch (err) {
      setError(err instanceof ApiError ? 'Invalid credentials' : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preAuthToken) return;
    setError(null);
    setLoading(true);
    try {
      await loginMfa(preAuthToken, mfaCode);
      await refresh();
      onSuccess();
    } catch {
      setError('Invalid MFA code');
    } finally {
      setLoading(false);
    }
  };

  if (preAuthToken) {
    return (
      <div className="login-page" data-testid="mfa-form">
        <h1>Two-factor authentication</h1>
        <form onSubmit={handleMfa}>
          <label>
            Code
            <input
              type="text"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              data-testid="mfa-input"
              required
            />
          </label>
          {error && (
            <p className="error" data-testid="login-error">
              {error}
            </p>
          )}
          <button type="submit" disabled={loading} data-testid="mfa-submit">
            {loading ? 'Verifying...' : 'Verify'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-page" data-testid="login-page">
      <h1>Sign in to CyberStrike</h1>
      <form onSubmit={handleLogin}>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="email-input"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="password-input"
            required
          />
        </label>
        {error && (
          <p className="error" data-testid="login-error">
            {error}
          </p>
        )}
        <button type="submit" disabled={loading} data-testid="login-submit">
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
};
