// B2 — Sign-in screen with optional MFA second step.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Field, Input, Mono } from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';

export default function Login() {
  const { t } = useTensol();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('alex.k@acme.com');
  const [pw, setPw] = useState('••••••••••••');
  const [code, setCode] = useState('');
  const [err] = useState<string | null>(null);

  const submit = () => {
    if (step === 1) {
      setStep(2);
      return;
    }
    navigate('/dashboard');
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit();
  };

  return (
    <AuthShell
      onBack={() => navigate('/')}
      eyebrow={t.authLoginEyebrow}
      title={t.authLoginTitle}
      sub={t.authLoginSub}
    >
      <RouteHead title="Sign In — Tensol" />
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
          />
        </Field>
        <Field label={t.fPassword}>
          <Input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </Field>
        {step === 2 && (
          <Field label={t.fMfa} hint={t.fMfaHint}>
            <Input
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
              }
              placeholder="123456"
              autoFocus
            />
          </Field>
        )}
        {err && (
          <div
            style={{
              padding: '10px 12px',
              border: '1px solid var(--red)',
              color: 'var(--red)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
            }}
          >{`[fail] ${err}`}</div>
        )}
        <Btn kind="primary" fullWidth onClick={submit}>
          {step === 1 ? t.authContinue : t.authSignIn} →
        </Btn>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 4,
          }}
        >
          <a
            href="#forgot"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--fg-2)',
            }}
          >
            {t.authForgot}
          </a>
          <Mono size={11} color="var(--fg-3)" style={{ letterSpacing: '0.04em' }}>
            step {step}/2
          </Mono>
        </div>
      </form>
    </AuthShell>
  );
}
