// B1 — First-install bootstrap screen with HTTP 410 already-done state.
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Field, Input } from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';

type FormState = {
  email: string;
  pw: string;
  name: string;
  tenantSlug: string;
  tenantName: string;
  token: string;
};

const EMPTY: FormState = {
  email: '',
  pw: '',
  name: '',
  tenantSlug: '',
  tenantName: '',
  token: '',
};

export default function Bootstrap() {
  const { t } = useTensol();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const alreadyDone = params.get('gone') === '1';
  const [v, setV] = useState<FormState>(EMPTY);

  const onBack = () => navigate('/');

  if (alreadyDone) {
    return (
      <AuthShell
        onBack={onBack}
        eyebrow="HTTP 410"
        title={t.authBootGoneTitle}
        sub={t.authBootGoneSub}
      >
        <Btn kind="secondary" onClick={() => navigate('/login')}>
          {t.authGoLogin} →
        </Btn>
      </AuthShell>
    );
  }

  const submit = (e?: FormEvent<HTMLFormElement>) => {
    if (e) e.preventDefault();
    navigate('/dashboard');
  };

  return (
    <AuthShell
      onBack={onBack}
      eyebrow={t.authBootEyebrow}
      title={t.authBootTitle}
      sub={t.authBootSub}
    >
      <RouteHead title="Account Setup — Tensol" />
      <form
        data-screen-label="03 Auth — bootstrap"
        onSubmit={submit}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <Field label={t.fName}>
          <Input
            value={v.name}
            onChange={(e) => setV({ ...v, name: e.target.value })}
          />
        </Field>
        <Field label={t.fEmail}>
          <Input
            value={v.email}
            onChange={(e) => setV({ ...v, email: e.target.value })}
          />
        </Field>
        <Field label={t.fPassword} hint={t.fPwHint}>
          <Input
            type="password"
            value={v.pw}
            onChange={(e) => setV({ ...v, pw: e.target.value })}
          />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label={t.fTenantSlug} hint="lowercase, hyphenated">
            <Input
              value={v.tenantSlug}
              onChange={(e) =>
                setV({
                  ...v,
                  tenantSlug: e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, ''),
                })
              }
              placeholder="acme-prod"
            />
          </Field>
          <Field label={t.fTenantName}>
            <Input
              value={v.tenantName}
              onChange={(e) => setV({ ...v, tenantName: e.target.value })}
              placeholder="ACME Production"
            />
          </Field>
        </div>
        <Field label={t.fBootstrapToken} hint={t.fBootHint}>
          <Input
            value={v.token}
            onChange={(e) => setV({ ...v, token: e.target.value })}
            placeholder="bs_…"
          />
        </Field>
        <Btn kind="primary" fullWidth onClick={() => submit()}>
          {t.authBootCta} →
        </Btn>
      </form>
    </AuthShell>
  );
}
