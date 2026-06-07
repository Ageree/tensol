// Tensol — C9 Reports + D1 Settings + E states (errors)

const { useState: useStateRS } = React;

function ReportsScreen({ onRoute, role }) {
  const { t } = useTensol();
  const [genOpen, setGenOpen] = useStateRS(false);
  const [generating, setGenerating] = useStateRS(false);
  const [progress, setProgress] = useStateRS(0);

  const startGen = () => {
    setGenerating(true); setProgress(0);
    const id = setInterval(() => {
      setProgress(p => {
        if (p >= 100) { clearInterval(id); setTimeout(() => { setGenerating(false); setGenOpen(false); }, 400); return 100; }
        return p + 8;
      });
    }, 240);
  };

  return (
    <div data-screen-label="11 App — reports">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 32 }}>
        <h1>{t.rTitle}</h1>
        <Btn kind="primary" disabled={role === 'viewer'} onClick={() => setGenOpen(true)}>+ {t.rGenerate}</Btn>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', background: 'transparent' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--line-soft)' }}>
            {[t.rColProject, t.rColType, t.rColDate, t.rColStatus, ''].map((h, i) => (
              <th key={i} style={{ textAlign: 'left', padding: '10px 4px', fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 500, color: 'var(--fg-3)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TENSOL_DATA.reports.map(r => (
            <tr key={r.id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <td style={{ padding: '16px 4px' }}>
                <Mono size={13}>{r.project}</Mono>
                <Mono size={10.5} color="var(--fg-3)" style={{ display: 'block', marginTop: 4 }}>{r.assessment}</Mono>
              </td>
              <td style={{ padding: '16px 4px' }}><Mono size={11.5} color="var(--fg-2)">{ { tech: 'technical', exec: 'executive', comp: 'compliance' }[r.type] }</Mono></td>
              <td style={{ padding: '16px 4px' }}><Mono size={11} color="var(--fg-3)">{r.date}</Mono></td>
              <td style={{ padding: '16px 4px' }}><StatusChip status={r.status} tone="muted" size="sm" /></td>
              <td style={{ padding: '16px 4px', textAlign: 'right' }}>
                <Btn size="sm" kind="dim">PDF</Btn>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Modal open={genOpen} onClose={() => !generating && setGenOpen(false)} title={`// ${t.rGenTitle}`} width={600}>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!generating && <>
            <Field label={t.rGenAss}><Select value="a1" onChange={() => {}} options={TENSOL_DATA.assessments.map(a => ({ value: a.id, label: a.name }))} /></Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label={t.rGenType}><Select value="tech" onChange={() => {}} options={[{ value: 'exec', label: 'executive summary' }, { value: 'tech', label: 'technical pentest' }, { value: 'comp', label: 'compliance mapping' }]} /></Field>
              <Field label={t.rGenLang}><Select value="en" onChange={() => {}} options={[{ value: 'en', label: 'english' }, { value: 'ru', label: 'русский' }]} /></Field>
            </div>
            <Field label={t.rGenTemplate}><Select value="default" onChange={() => {}} options={[{ value: 'default', label: 'default' }, { value: 'gost', label: 'GOST R · FSTEC mapping appendix' }, { value: 'pcidss', label: 'PCI DSS appendix' }]} /></Field>
            <Checkbox checked={true} onChange={() => {}} label={t.rGenRedact} hint="masks credentials, tokens, pii in command output and HTTP capture" />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <Btn kind="dim" onClick={() => setGenOpen(false)}>{t.cancel}</Btn>
              <Btn kind="primary" onClick={startGen}>{t.rGenCta} →</Btn>
            </div>
          </>}
          {generating && <>
            <Eyebrow>// generating · do not close</Eyebrow>
            <ProgressBar value={progress} segments={48} height={10} color="var(--red)" label={`assembling evidence · ${progress}%`} />
            <pre style={{ margin: 0, padding: 12, background: 'var(--ink)', color: 'var(--paper)', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6 }}>
{`[ok]   collect engagement metadata
[ok]   bundle 11 findings
[ok]   resolve 11 evidence packages (sha256 verified)
[${progress > 50 ? 'ok' : 'wait'}]  render attack-graph snapshot
[${progress > 75 ? 'ok' : 'wait'}]  framework mappings · 4 sets
[${progress > 90 ? 'ok' : 'wait'}]  immutable snapshot · sign · seal`}
            </pre>
          </>}
        </div>
      </Modal>
    </div>
  );
}

function SettingsScreen({ onRoute, role }) {
  const { t, lang, setLang } = useTensol();
  const [tab, setTab] = useStateRS(0);
  const isAdmin = role === 'security_lead' || role === 'tenant_admin';
  return (
    <div data-screen-label="12 App — settings">
      <div style={{ marginBottom: 32 }}>
        <h1>{t.sTitle}</h1>
      </div>
      <Card>
        <Tabs value={tab} onChange={setTab} options={t.sTabs.map((l, i) => ({ value: i, label: l }))} />
        <div style={{ padding: '24px 28px' }}>
          {tab === 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, maxWidth: 720 }}>
              <Field label={t.sProfileName}><Input value={TENSOL_DATA.user.name} onChange={() => {}} /></Field>
              <Field label={t.sProfileEmail}><Input value={TENSOL_DATA.user.email} onChange={() => {}} /></Field>
              <Field label={t.sProfileLang}>
                <Segmented value={lang} onChange={setLang} options={[{ value: 'en', label: 'EN' }, { value: 'ru', label: 'RU' }]} />
              </Field>
              <Field label={t.sProfileTz}><Select value="MSK" onChange={() => {}} options={['MSK','UTC','CET']} /></Field>
              <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--line-soft)', paddingTop: 18 }}>
                <Eyebrow style={{ marginBottom: 12 }}>// {t.sProfileMfa}</Eyebrow>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <StatusChip status="enabled · totp" tone="ok" />
                  <Mono size={11} color="var(--fg-3)">enrolled 2026-03-12 · iPhone (iOS 18)</Mono>
                  <Btn size="sm" kind="dim">Re-enroll</Btn>
                </div>
              </div>
              <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--line-soft)', paddingTop: 18 }}>
                <Eyebrow style={{ marginBottom: 10 }}>// {t.sProfileSessions}</Eyebrow>
                {[
                  { d: 'Mac · Chrome 134', ip: '78.41.22.18 · MSK', when: 'this session' },
                  { d: 'iPhone · Safari', ip: '5.18.211.4 · MSK', when: '2h ago' },
                ].map((s,i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px dashed var(--line-soft)' }}>
                    <Mono size={11.5}>{s.d} · {s.ip}</Mono>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <Mono size={11} color="var(--fg-3)">{s.when}</Mono>
                      <Btn size="sm" kind="dim">Revoke</Btn>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--line-soft)', paddingTop: 18 }}>
                <Eyebrow style={{ marginBottom: 10 }}>// {t.sProfileTokens}</Eyebrow>
                <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block', marginBottom: 8 }}>tnsl_pat_3a8f… · created 2026-04-02 · scope read:findings</Mono>
                <Btn size="sm" kind="secondary">+ Issue token</Btn>
              </div>
            </div>
          )}
          {tab === 1 && (
            !isAdmin ? (
              <div style={{ padding: 30, textAlign: 'center' }}>
                <Mono size={12} color="var(--red)">[deny] tenant settings require role tenant_admin or security_lead. you are: {role}.</Mono>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, maxWidth: 760 }}>
                <Field label={t.sTenantName}><Input value="Acme Bank — Production" onChange={() => {}} /></Field>
                <Field label={t.sTenantSlug}><Input value="acme-prod" onChange={() => {}} /></Field>
                <Field label={t.sTenantRegion}><Select value="eu-gcp" onChange={() => {}} options={[{ value: 'eu-gcp', label: 'gcp · europe-west1' }, { value: 'eu-fra', label: 'eu · fra1' }]} /></Field>
                <Field label={t.sTenantRetention}><Select value="365d" onChange={() => {}} options={['90d','180d','365d','730d']} /></Field>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Eyebrow style={{ marginBottom: 10 }}>// {t.sTenantUsers}</Eyebrow>
                  <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--fg)' }}>
                    <thead>
                      <tr style={{ background: 'var(--fg)', color: 'var(--bg)' }}>
                        {['name','email','role','mfa','last seen',''].map((h,i) => <th key={i} style={{ textAlign: 'left', padding: '8px 12px', fontFamily: 'monospace', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { n: 'Alex Kovalev',    e: 'alex.k@acme.com',   r: 'security_lead',  m: 'on',  l: 'now' },
                        { n: 'Maria Petrova',   e: 'maria.p@acme.com',  r: 'operator',       m: 'on',  l: '12m' },
                        { n: 'Dmitry Smirnov',  e: 'dmitry.s@acme.com', r: 'operator',       m: 'on',  l: '2h' },
                        { n: 'Olga Ivanova',    e: 'olga.i@acme.com',   r: 'auditor',        m: 'on',  l: '1d' },
                        { n: 'Pavel Lebedev',   e: 'pavel.l@acme.com',  r: 'developer',      m: 'on',  l: '3d' },
                      ].map((u,i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--line-soft)' }}>
                          <td style={{ padding: '8px 12px' }}><Mono size={12}>{u.n}</Mono></td>
                          <td style={{ padding: '8px 12px' }}><Mono size={11} color="var(--fg-2)">{u.e}</Mono></td>
                          <td style={{ padding: '8px 12px' }}><StatusChip status={u.r} tone="muted" size="sm" /></td>
                          <td style={{ padding: '8px 12px' }}><Mono size={11} color="var(--fg-2)">{u.m}</Mono></td>
                          <td style={{ padding: '8px 12px' }}><Mono size={11} color="var(--fg-3)">{u.l}</Mono></td>
                          <td style={{ padding: '8px 12px', textAlign: 'right' }}><Btn size="sm" kind="dim">Manage</Btn></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: 10 }}><Btn size="sm" kind="secondary">+ Invite user</Btn></div>
                </div>
                <Field label={t.sTenantPwPolicy}><Select value="strict" onChange={() => {}} options={['standard','strict','custom']} /></Field>
                <Field label={t.sTenantMfaPolicy}><Select value="enforced" onChange={() => {}} options={['optional','recommended','enforced']} /></Field>
              </div>
            )
          )}
          {tab === 2 && (
            <div style={{ maxWidth: 720 }}>
              <Eyebrow style={{ marginBottom: 10 }}>// channels</Eyebrow>
              <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--fg)' }}>
                <thead>
                  <tr style={{ background: 'var(--fg)', color: 'var(--bg)' }}>
                    {['event','in-app','email'].map((h,i) => <th key={i} style={{ textAlign: 'left', padding: '8px 12px', fontFamily: 'monospace', fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { ev: 'HITL approval required',     i: true, e: true },
                    { ev: 'validator confirmed finding', i: true, e: true },
                    { ev: 'assessment status changed',   i: true, e: false },
                    { ev: 'report ready',                i: true, e: true },
                    { ev: 'invite accepted',             i: false, e: false },
                  ].map((n,i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--line-soft)' }}>
                      <td style={{ padding: '10px 12px' }}><Mono size={12}>{n.ev}</Mono></td>
                      <td style={{ padding: '10px 12px' }}><Checkbox checked={n.i} onChange={() => {}} label="" /></td>
                      <td style={{ padding: '10px 12px' }}><Checkbox checked={n.e} onChange={() => {}} label="" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ─── E states ───────────────────────────────────────────────── */

function ErrorState({ kind, onRoute }) {
  const { t } = useTensol();
  const map = {
    401: { glyph: '401', title: t.err401Title, sub: t.err401Sub, cta: t.err401Cta, route: 'login' },
    403: { glyph: '403', title: t.err403Title, sub: t.err403Sub, reason: t.err403Reason, cta: t.errCta, route: 'dashboard' },
    404: { glyph: '404', title: t.err404Title, sub: t.err404Sub, cta: 'Back to dashboard', route: 'dashboard' },
    500: { glyph: '5xx', title: t.err500Title, sub: t.err500Sub, cta: t.errCta, route: 'dashboard' },
    offline: { glyph: 'off', title: t.errOfflineTitle, sub: t.errOfflineSub, cta: t.errCta, route: 'dashboard' },
  };
  const e = map[kind];
  return (
    <div data-screen-label={`13 App — error ${kind}`} style={{ minHeight: 480, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, padding: '40px 24px', textAlign: 'center' }}>
      <div style={{ position: 'relative', width: 200, height: 80 }}>
        <HalftoneBg size={6} opacity={0.4} color="var(--fg)" />
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--paper)', margin: 8 }}>
          <Mono size={42} color="var(--red)" style={{ fontFamily: "'Space Grotesk', sans-serif", letterSpacing: '-0.04em' }}>{e.glyph}</Mono>
        </div>
      </div>
      <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 28, letterSpacing: '-0.02em', margin: 0 }}>{e.title}</h2>
      <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: 'var(--fg-2)', margin: 0, maxWidth: 460 }}>{e.sub}</p>
      {e.reason && (
        <div style={{ padding: '10px 14px', border: '1px dashed var(--red)', maxWidth: 460 }}>
          <Mono size={11} color="var(--red)">{e.reason}</Mono>
        </div>
      )}
      <Btn kind="primary" onClick={() => onRoute(e.route)}>{e.cta}</Btn>
    </div>
  );
}

Object.assign(window, { ReportsScreen, SettingsScreen, ErrorState });

