import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as authApi from '../api/auth.ts';
import { AuthProvider } from '../auth/context.tsx';
import { LoginPage } from './LoginPage.tsx';

const hasDom = typeof document !== 'undefined';

describe.skipIf(!hasDom)('LoginPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(authApi, 'getMe').mockRejectedValue(new Error('no session'));
  });

  it('renders email and password fields', () => {
    render(
      <AuthProvider>
        <LoginPage onSuccess={vi.fn()} />
      </AuthProvider>,
    );
    expect(screen.getByTestId('email-input')).toBeInTheDocument();
    expect(screen.getByTestId('password-input')).toBeInTheDocument();
    expect(screen.getByTestId('login-submit')).toBeInTheDocument();
  });

  it('calls login on submit', async () => {
    const loginSpy = vi.spyOn(authApi, 'login').mockResolvedValue({ status: 'ok' });
    vi.spyOn(authApi, 'getMe').mockRejectedValue(new Error('no session'));
    const onSuccess = vi.fn();

    render(
      <AuthProvider>
        <LoginPage onSuccess={onSuccess} />
      </AuthProvider>,
    );

    await userEvent.type(screen.getByTestId('email-input'), 'test@example.com');
    await userEvent.type(screen.getByTestId('password-input'), 'password123');
    await userEvent.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(loginSpy).toHaveBeenCalledWith('test@example.com', 'password123');
    });
  });

  it('shows error on bad credentials', async () => {
    vi.spyOn(authApi, 'login').mockRejectedValue(
      Object.assign(new Error('bad'), { name: 'ApiError', status: 401 }),
    );

    render(
      <AuthProvider>
        <LoginPage onSuccess={vi.fn()} />
      </AuthProvider>,
    );

    await userEvent.type(screen.getByTestId('email-input'), 'x@x.com');
    await userEvent.type(screen.getByTestId('password-input'), 'bad');
    await userEvent.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });
  });

  it('shows MFA form when mfa_required', async () => {
    vi.spyOn(authApi, 'login').mockResolvedValue({
      status: 'mfa_required',
      preAuthToken: 'tok123',
    });

    render(
      <AuthProvider>
        <LoginPage onSuccess={vi.fn()} />
      </AuthProvider>,
    );

    await userEvent.type(screen.getByTestId('email-input'), 'mfa@example.com');
    await userEvent.type(screen.getByTestId('password-input'), 'pass');
    await userEvent.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-form')).toBeInTheDocument();
    });
  });
});
