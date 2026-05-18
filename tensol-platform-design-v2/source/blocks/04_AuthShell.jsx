

// Tensol — auth screens (B1 bootstrap, B2 login, B3 invite)

const { useState: useStateAuth } = React;

function AuthShell({ children, eyebrow, title, sub, onBack }) {
  const { t } = useTensol();
  return (
    <div style={{
      minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)',
      display: 'grid', gridTemplateColumns: '1.1fr 1fr',
    }}>
      <aside style={{
        position: 'relative', overflow: 'hidden',
        background: 'var(--ink)', color: 'var(--paper)',
        padding: '40px 48px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      }}>
        <HalftoneBg color="var(--paper)" opacity={0.08} />
        <div style={{ position: 'relative' }}>
          <button type="button" onClick={onBack} style={{
            background: 'transparent', border: 'none', color: 'var(--paper)', cursor: 'pointer', padding: 0,
            display: 'inline-flex', alignItems: 'center', gap: 10,
          }}>
            <LogoLockup size={20} color="var(--paper)" />
          </button>
        </div>
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, alignSelf: 'stretch' }}>
          <AuthWave />
        </div>
        <div style={{ position: 'relative', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'rgba(250,249,246,.6)', letterSpacing: '0.04em', display: 'flex', justifyContent: 'space-between' }}>
          <span>{t.authPanelLeft}</span>
          <span>v0.4.1 · build a8c7d2</span>
        </div>
      </aside>
      <main style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px' }}>
        <div style={{ width: '100%', maxWidth: 440 }}>
          {eyebrow && <Eyebrow style={{ marginBottom: 12 }}>{eyebrow}</Eyebrow>}
          <h1 style={{
            fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500,
            fontSize: 40, lineHeight: 1.05, letterSpacing: '-0.02em',
            margin: '0 0 12px',
          }}>{title}</h1>
          {sub && (
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14.5, lineHeight: 1.5, color: 'var(--fg-2)', margin: '0 0 28px', maxWidth: '46ch' }}>
              {sub}
            </p>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}

function LoginScreen({ onSubmit, onBack }) {
  const { t } = useTensol();
  const [step, setStep] = useStateAuth(1);
  const [email, setEmail] = useStateAuth('alex.k@acme.com');
  const [pw, setPw] = useStateAuth('••••••••••••');
  const [code, setCode] = useStateAuth('');
  const [err, setErr] = useStateAuth(null);

  const submit = () => {
    setErr(null);
    if (step === 1) { setStep(2); return; }
    onSubmit && onSubmit({ email });
  };

  return (
    <AuthShell
      onBack={onBack}
      eyebrow={t.authLoginEyebrow}
      title={t.authLoginTitle}
      sub={t.authLoginSub}
    >
      <form onSubmit={e => { e.preventDefault(); submit(); }}
            data-screen-label="03 Auth — sign in"
            style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label={t.fEmail}>
          <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" />
        </Field>
        <Field label={t.fPassword}>
          <Input type="password" value={pw} onChange={e => setPw(e.target.value)} />
        </Field>
        {step === 2 && (
          <Field label={t.fMfa} hint={t.fMfaHint}>
            <Input value={code} onChange={e =>etCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" autoFocus />
          </Field>
        )}
        {err && (
          <div style={{
            padding: '10px 12px', border: '1px solid var(--red)', color: 'var(--red)',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
          }}>{`[fail] ${err}`}</div>
        )}
        <Btn kind="primary" fullWidth onClick={submit}>
          {step === 1 ? t.authContinue : t.authSignIn} →
        </Btn>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <a href="#forgot" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-2)' }}>
            {t.authForgot}
          </a>
          <Mono size={11} color="var(--fg-3)" style={{ letterSpacing: '0.04em' }}>step {step}/2</Mono>
        </div>
      </form>
    </AuthShell>
  );
}

function BootstrapScreen({ onSubmit, onBack, alreadyDone = false }) {
  const { t } = useTensol();
  const [v, setV] = useStateAuth({
    email: '', pw: '', name: '', tenantSlug: '', tenantName: '', token: '',
  });
  if (alreadyDone) {
    return (
      <AuthShell onBack={onBack} eyebrow="HTTP 410" title={t.authBootGoneTitle} sub={t.authBootGoneSub}>
        <Btn kind="secondary" onClick={onBack}>{t.authGoLogin} →</Btn>
      </AuthShell>
    );
  }
  return (
    <AuthShell onBack={onBack} eyebrow={t.authBootEyebrow} title={t.authBootTitle} sub={t.authBootSub}>
      <form data-screen-label="03 Auth — bootstrap" onSubmit={e => { e.preventDefault(); onSubmit && onSubmit(); }} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label={t.fName}><Input value={v.name} onChange={e => setV({ ...v, name: e.target.value })} /></Field>
        <Field label={t.fEmail}><Input value={v.email} onChange={e => setV({ ...v, email: e.target.value })} /></Field>
        <Field label={t.fPassword} hint={t.fPwHint}><Input type="password" value={v.pw} onChange={e => setV({ ...v, pw: e.target.value })} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label={t.fTenantSlug} hint="lowercase, hyphenated"><Input value={v.tenantSlug} onChange={e => setV({ ...v, tenantSlug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="acme-prod" /></Field>
          <Field label={t.fTenantName}><Input value={v.tenantName} onChange={e => setV({ ...v, tenantName: e.target.value })} placeholder="ACME Production" /></Field>
        </div>
        <Field label={t.fBootstrapToken} hint={t.fBootHint}><Input value={v.token} onChange={e => setV({ ...v, token: e.target.value })} placeholder="bs_…" /></Field>
        <Btn kind="primary" fullWidth onClick={() => onSubmit && onSubmit()}>{t.authBootCta} →</Btn>
      </form>
    </AuthShell>
  );
}

function InviteScreen({ onSubmit, onBack }) {
  const { t } = useTensol();
  const [v, setV] = useStateAuth({ name: '', pw: '' });
  const [mfa, setMfa] = useStateAuth(false);

  if (mfa) {
    // MFA enrollment after register
    return (
      <AuthShell onBack={onBack} eyebrow={t.authMfaEyebrow} title={t.authMfaTitle} sub={t.authMfaSub}>
        <div data-screen-label="03 Auth — invite/MFA" style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
          <div style={{ width: 180, height: 180, border: '1px solid var(--ink)', position: 'relative', flexShrink: 0, background: 'var(--paper)' }}>
            {/* simulated QR — pixel grid */}
            <QrPlaceholder />
          </div>
          <div style={{ flex: 1 }}>
            <Mono size={11} color="var(--fg-2)" style={{ letterSpacing: '0.08em', display: 'block', marginBottom: 6 }}>{t.authMfaSecret}</Mono>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, padding: '8px 10px', border: '1px solid var(--ink)', background: 'var(--bg)', marginBottom: 16, wordBreak: 'break-all' }}>
              JBSW Y3DP EHPK 3PXP JBSW Y3DP
            </div>
            <Field label={t.fMfa}><Input placeholder="123456" /></Field>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <Btn kind="primary" onClick={onSubmit}>{t.authMfaConfirm} →</Btn>
              <Btn kind="ghost" onClick={onSubmit}>{t.authMfaSkip}</Btn>
            </div>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell onBack={onBack} eyebrow={t.authInviteEyebrow} title={t.authInviteTitle} sub={t.authInviteSub}>
      <div data-screen-label="03 Auth — invite" style={{
        padding: '10px 12px', border: '1px solid var(--ink)', background: 'var(--bg)',
        fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--fg-2)',
        marginBottom: 18,
      }}>
        {`[ok] invited as security_lead → tenant=acme-prod · invite_id=inv_a3c1`}
      </div>
      <form onSubmit={e => { e.preventDefault(); setMfa(true); }} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label={t.fEmail} hint={t.fEmailVerified}>
          <Input value="alex.k@acme.com" disabled />
        </Field>
        <Field label={t.fName}><Input value={v.name} onChange={e => setV({ ...v, name: e.target.value })} placeholder="A. Kovalev" /></Field>
        <Field label={t.fPassword} hint={t.fPwHint}><Input type="password" value={v.pw} onChange={e => setV({ ...v, pw: e.target.value })} /></Field>
        <Btn kind="primary" fullWidth onClick={() => setMfa(true)}>{t.authInviteCta} →</Btn>
      </form>
    </AuthShell>
  );
}

function QrPlaceholder() {
  // deterministic pixel grid that *looks* like a QR
  const seed = (i, j) => {
    const x = (i * 73856093) ^ (j * 19349663);
    return ((x >>> 0) % 7) > 3;
  };
  const N = 21;
  const cells = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    // corner finder squares
    const corner = (i < 7 && j < 7) || (i < 7 && j >= N-7) || (i >= N-7 && j < 7);
    let on = seed(i, j);
    if (corner) {
      const li = i < 7 ? i : N-1-i;
      const lj = j < 7 ? j : N-1-j;
      const fi = j < 7 ? j : N-1-j;
      const ci = li, cj = fi;
      on = (ci === 0 || ci === 6 || cj === 0 || cj === 6) || (ci >= 2 && ci <= 4 && cj >= 2 && cj <= 4);
    }
    cells.push(on);
  }
  return (
    <div style={{
      position: 'absolute', inset: 8,
      display: 'grid',
      gridTemplateColumns: `repeat(${N}, 1fr)`,
      gridTemplateRows: `repeat(${N}, 1fr)`,
      gap: 0,
    }}>
      {cells.map((on, i) => <div key={i} style={{ background: on ? 'var(--ink)' : 'transparent' }} />)}
    </div>
  );
}

Object.assign(window, { LoginScreen, BootstrapScreen, InviteScreen });



