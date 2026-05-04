import type React from 'react';
import { useState } from 'react';
import { selfRegister } from '../api/auth.ts';
import { useAuth } from '../auth/context.tsx';

interface Props {
  onSuccess: () => void;
  onLoginClick: () => void;
}

export const RegisterPage = ({ onSuccess, onLoginClick }: Props) => {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await selfRegister({ email, password, displayName });
      await refresh();
      onSuccess();
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        setError('An account with this email already exists.');
      } else if (status === 429) {
        setError('Too many registration attempts. Please wait before trying again.');
      } else if (status === 400) {
        setError('Please check your input. Password must be at least 12 characters.');
      } else {
        setError('Registration failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      data-testid="register-page"
      className="min-h-screen flex items-center justify-center bg-gray-50"
    >
      <div className="w-full max-w-md p-8 bg-white rounded shadow">
        <h1 className="text-2xl font-bold mb-6">Create your account</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="displayName" className="block text-sm font-medium mb-1">
              Name
            </label>
            <input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              minLength={1}
              maxLength={128}
              className="w-full border rounded px-3 py-2 text-sm"
              data-testid="register-displayname"
            />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={254}
              className="w-full border rounded px-3 py-2 text-sm"
              data-testid="register-email"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              maxLength={256}
              className="w-full border rounded px-3 py-2 text-sm"
              data-testid="register-password"
            />
            <p className="text-xs text-gray-500 mt-1">Minimum 12 characters.</p>
          </div>
          {error && (
            <p className="text-sm text-red-600" data-testid="register-error">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white rounded py-2 text-sm font-medium disabled:opacity-50"
            data-testid="register-submit"
          >
            {loading ? 'Creating account...' : 'Create account'}
          </button>
        </form>
        <p className="text-sm text-center mt-4">
          Already have an account?{' '}
          <button
            type="button"
            onClick={onLoginClick}
            className="text-blue-600 underline"
            data-testid="register-login-link"
          >
            Log in
          </button>
        </p>
      </div>
    </div>
  );
};
