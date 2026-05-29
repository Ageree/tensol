// B3 — Invited-user finishes account, then enrolls TOTP MFA.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthShell } from '../components/AuthShell.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Field, Input, Mono } from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';

const QR_GRID = 21;

function QrPlaceholder() {
  const seed = (i: number, j: number) => {
    const x = (i * 73856093) ^ (j * 19349663);
    return (x >>> 0) % 7 > 3;
  };
  const cells: boolean[] = [];
  for (let i = 0; i < QR_GRID; i++) {
    for (let j = 0; j < QR_GRID; j++) {
      const corner =
        (i < 7 && j < 7) ||
        (i < 7 && j >= QR_GRID - 7) ||
        (i >= QR_GRID - 7 && j < 7);
      let on = seed(i, j);
      if (corner) {
        const li = i < 7 ? i : QR_GRID - 1 - i;
        const fi = j < 7 ? j : QR_GRID - 1 - j;
        const ci = li;
        const cj = fi;
        on =
          ci === 0 ||
          ci === 6 ||
          cj === 0 ||
          cj === 6 ||
          (ci >= 2 && ci <= 4 && cj >= 2 && cj <= 4);
      }
      cells.push(on);
    }
  }
  return (
    <div
      style={{
        position: 'absolute',
        inset: 8,
        display: 'grid',
        gridTemplateColumns: `repeat(${QR_GRID}, 1fr)`,
        gridTemplateRows: `repeat(${QR_GRID}, 1fr)`,
        gap: 0,
      }}
    >
      {cells.map((on, i) => (
        <div
          key={i}
          style={{ background: on ? 'var(--ink)' : 'transparent' }}
        />
      ))}
    </div>
  );
}

export default function Invite() {
  const { t } = useTensol();
  const navigate = useNavigate();
  const [v, setV] = useState({ name: '', pw: '' });
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState(false);

  const onBack = () => navigate('/');
  const finish = () => navigate('/dashboard');

  const onAccountSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMfa(true);
  };

  if (mfa) {
    return (
      <AuthShell
        onBack={onBack}
        eyebrow={t.authMfaEyebrow}
        title={t.authMfaTitle}
        sub={t.authMfaSub}
      >
        <RouteHead title="Accept Invite — Sthrip" />
        <div
          data-screen-label="03 Auth — invite/MFA"
          style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}
        >
          <div
            style={{
              width: 180,
              height: 180,
              border: '1px solid var(--ink)',
              position: 'relative',
              flexShrink: 0,
              background: 'var(--paper)',
            }}
          >
            <QrPlaceholder />
          </div>
          <div style={{ flex: 1 }}>
            <Mono
              size={11}
              color="var(--fg-2)"
              style={{ letterSpacing: '0.08em', display: 'block', marginBottom: 6 }}
            >
              {t.authMfaSecret}
            </Mono>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 13,
                padding: '8px 10px',
                border: '1px solid var(--ink)',
                background: 'var(--bg)',
                marginBottom: 16,
                wordBreak: 'break-all',
              }}
            >
              JBSW Y3DP EHPK 3PXP JBSW Y3DP
            </div>
            <Field label={t.fMfa}>
              <Input
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                placeholder="123456"
              />
            </Field>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <Btn kind="primary" onClick={finish}>
                {t.authMfaConfirm} →
              </Btn>
              <Btn kind="ghost" onClick={finish}>
                {t.authMfaSkip}
              </Btn>
            </div>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      onBack={onBack}
      eyebrow={t.authInviteEyebrow}
      title={t.authInviteTitle}
      sub={t.authInviteSub}
    >
      <div
        data-screen-label="03 Auth — invite"
        style={{
          padding: '10px 12px',
          border: '1px solid var(--ink)',
          background: 'var(--bg)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          color: 'var(--fg-2)',
          marginBottom: 18,
        }}
      >
        {`[ok] invited as security_lead → tenant=acme-prod · invite_id=inv_a3c1`}
      </div>
      <form
        onSubmit={onAccountSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <Field label={t.fEmail} hint={t.fEmailVerified}>
          <Input value="alex.k@acme.com" disabled readOnly />
        </Field>
        <Field label={t.fName}>
          <Input
            value={v.name}
            onChange={(e) => setV({ ...v, name: e.target.value })}
            placeholder="A. Kovalev"
          />
        </Field>
        <Field label={t.fPassword} hint={t.fPwHint}>
          <Input
            type="password"
            value={v.pw}
            onChange={(e) => setV({ ...v, pw: e.target.value })}
          />
        </Field>
        <Btn kind="primary" fullWidth onClick={() => setMfa(true)}>
          {t.authInviteCta} →
        </Btn>
      </form>
    </AuthShell>
  );
}
