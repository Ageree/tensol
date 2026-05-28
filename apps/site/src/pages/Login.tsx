// T081 — Magic-link sign-in. Posts to POST /api/auth/request-link and shows an
// inbox-confirmation state. The actual session is established when the user
// clicks the link in their email; that link hits GET /api/auth/verify which
// sets the session cookie and 302-redirects to /dashboard server-side.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Field, Input, Mono } from '../components/primitives.tsx';
import { TENSOL_I18N } from '../i18n.ts';
import { api, ApiError } from '../lib/api.ts';

type LoginStatus = 'idle' | 'submitting' | 'sent' | 'error';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Login() {
  const t = TENSOL_I18N.en;
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const submit = async () => {
    setErrMsg(null);
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setStatus('error');
      setErrMsg('invalid_email');
      return;
    }
    setStatus('submitting');
    try {
      await api.auth.requestLink(trimmed);
      setStatus('sent');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown_error';
      setStatus('error');
      setErrMsg(code);
    }
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (status === 'submitting') return;
    void submit();
  };

  if (status === 'sent') {
    return (
      <AuthShell
        onBack={() => navigate('/')}
        language="en"
        brand="sthrip"
        eyebrow={t.authLoginEyebrow}
        title="Check your inbox."
        sub={`We just sent a sign-in link to ${email}. The link expires in 15 minutes.`}
      >
        <RouteHead title="Check your inbox — Tensol" />
        <div
          data-screen-label="03 Auth — magic link sent"
          style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
        >
          <Mono size={12} color="var(--fg-2)" style={{ letterSpacing: '0.04em' }}>
            STATUS: link_dispatched
          </Mono>
          <Btn
            kind="ghost"
            fullWidth
            onClick={() => {
              setStatus('idle');
              setErrMsg(null);
            }}
          >
            ← use a different email
          </Btn>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      onBack={() => navigate('/')}
      language="en"
      brand="sthrip"
      eyebrow={t.authLoginEyebrow}
      title="Log in to Sthrip."
      sub="Enter your work email. We'll send you a one-time sign-in link."
    >
      <RouteHead title="Log In — Sthrip" />
      <form
        onSubmit={onSubmit}
        data-screen-label="03 Auth — sign in"
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <Field label={t.fEmail}>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoFocus
          />
        </Field>
        {status === 'error' && errMsg && (
          <div
            style={{
              padding: '10px 12px',
              border: '1px solid var(--red)',
              color: 'var(--red)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
            }}
          >{`[fail] ${errMsg}`}</div>
        )}
        <Btn
          kind="primary"
          fullWidth
          onClick={submit}
          disabled={status === 'submitting'}
        >
          {status === 'submitting' ? 'sending…' : `${t.authContinue} →`}
        </Btn>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 4,
          }}
        >
          <Mono size={11} color="var(--fg-3)" style={{ letterSpacing: '0.04em' }}>
            magic link · no password
          </Mono>
        </div>
      </form>
    </AuthShell>
  );
}
