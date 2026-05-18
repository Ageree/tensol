// Tensol — C6 Live assessment

const { useState: useStateLive, useEffect: useEffLive } = React;

function LiveScreen({ onRoute, role }) {
  const { t } = useTensol();
  const a = TENSOL_DATA.assessments[0]; // a1 — running
  const [paused, setPaused] = useStateLive(false);
  const [progress, setProgress] = useStateLive(a.progress);

  useEffLive(() => {
    if (paused) return;
    const id = setInterval(() => setProgress(p => Math.min(0.92, p + 0.005)), 1200);
    return () => clearInterval(id);
  }, [paused]);

  const isOperator = role === 'operator' || role === 'security_lead';

  return (
    <div data-screen-label="09 App — live assessment">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <Eyebrow>{`// project: core-banking-prod · assessment: ${a.name} · started ${a.startedAt} MSK`}</Eyebrow>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6 }}>
            <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 38, letterSpacing: '-0.02em', margin: 0 }}>{t.liveTitle}</h1>
            <StatusChip status={paused ? 'paused' : `${a.phase} · live`} tone={paused ? 'warn' : 'ok'} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn kind="secondary" disabled={!isOperator} onClick={() => setPaused(p => !p)}>
            {paused ? t.liveResume : t.livePause}
          </Btn>
          <Btn kind="red" disabled={!isOperator}>{t.liveCancel}</Btn>
        </div>
      </div>

      {/* Top KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0, marginBottom: 24, border: '1px solid var(--fg)' }}>
        {[
          { l: 'phase', v: a.phase, mono: true },
          { l: 'confirmed findings', v: '3', mono: true, accent: true },
          { l: 'candidate findings', v: '7', mono: true },
          { l: 'elapsed', v: '4h 42m', mono: true },
        ].map((k, i) => (
          <div key={i} style={{ padding: '16px 20px', borderRight: i < 3 ? '1px solid var(--fg)' : 'none', background: 'var(--bg)' }}>
            <Eyebrow style={{ marginBottom: 8 }}>{k.l}</Eyebrow>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 26, letterSpacing: '-0.02em', color: k.accent ? 'var(--red)' : 'var(--fg)' }}>{k.v}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 24 }}>
        <ProgressBar value={progress * 100} segments={60} height={10} color="var(--red)" label={`${t.liveProgress.replace('// ','')} · recon ▸ exploit ▸ validate`} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24 }}>
        {/* TIMELINE */}
        <Card>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--fg)', display: 'flex', justifyContent: 'space-between' }}>
            <Eyebrow>{t.liveTimeline}</Eyebrow>
            <Mono size={11} color="var(--fg-3)">{paused ? '— paused —' : 'live · ws connected'}</Mono>
          </div>
          <Scroll maxHeight={420}>
            <div style={{ padding: '12px 0' }}>
              {TENSOL_DATA.liveEvents.map((e, i) => {
                const tone = { ok: 'var(--fg)', fail: 'var(--red)', wait: 'var(--fg-3)', warn: '#B8860B', sum: 'var(--fg)' }[e.kind];
                const tag = { ok: '[ok]  ', fail: '[fail]', wait: '[wait]', warn: '[warn]', sum: '[sum] ' }[e.kind];
                return (
                  <div key={i} style={{
                    padding: '4px 18px',
                    display: 'grid', gridTemplateColumns: '64px 56px 1fr', gap: 10,
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5,
                    background: i === TENSOL_DATA.liveEvents.length - 1 ? 'rgba(224,0,27,0.05)' : 'transparent',
                  }}>
                    <span style={{ color: 'var(--fg-3)' }}>{e.t}</span>
                    <span style={{ color: tone, fontWeight: 500 }}>{tag}</span>
                    <span style={{ color: 'var(--fg-2)' }}>{e.m}</span>
                  </div>
                );
              })}
              {!paused && (
                <div style={{ padding: '4px 18px', display: 'grid', gridTemplateColumns: '64px 56px 1fr', gap: 10, fontFamily: 'monospace', fontSize: 11.5 }}>
                  <span style={{ color: 'var(--fg-3)' }}>13:48:34</span>
                  <span style={{ color: 'var(--fg-3)' }}>[…]  </span>
                  <span style={{ color: 'var(--fg-3)' }}>browser.session.next · /api/v3/transfers <span style={{ background: 'var(--fg)', color: 'var(--bg)' }}>▌</span></span>
                </div>
              )}
            </div>
          </Scroll>
        </Card>

        {/* RIGHT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* HITL — priority block */}
          <Card style={{ borderColor: 'var(--red)', borderWidth: 2 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--red)', background: 'var(--red)', color: 'var(--paper)' }}>
              <Eyebrow color="var(--paper)">{t.liveHITL} · 1</Eyebrow>
            </div>
            <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {TENSOL_DATA.approvals.slice(0, 1).map(h => (
                <div key={h.id}>
                  <Mono size={12} color="var(--fg)" style={{ display: 'block', marginBottom: 4 }}>{h.detail}</Mono>
                  <Mono size={11} color="var(--fg-3)" style={{ display: 'block' }}>target {h.target} · requested {h.when}</Mono>
                  <Mono size={11} color="var(--fg-2)" style={{ display: 'block', marginTop: 6, paddingTop: 6, borderTop: '1px dashed var(--line-soft)' }}>{h.justify}</Mono>
                  <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                    <Btn size="sm" kind="primary" disabled={role !== 'security_lead'}>Approve</Btn>
                    <Btn size="sm" kind="dim">Deny</Btn>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Validator queue */}
          <Card>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--fg)' }}>
              <Eyebrow>{t.liveValidator} · 4 queued</Eyebrow>
            </div>
            <div style={{ padding: '10px 16px' }}>
              {[
                { p: 1, name: 'validator.xss', a: 'app.acme-bank.ru', s: 'running' },
                { p: 2, name: 'validator.authz.idor', a: 'api.acme-bank.ru', s: 'queued' },
                { p: 3, name: 'validator.openredirect', a: 'broker-staging', s: 'queued' },
                { p: 4, name: 'validator.crlf', a: 'app.acme-bank.ru', s: 'queued' },
              ].map(v => (
                <div key={v.p} style={{ display: 'grid', gridTemplateColumns: '24px 1fr 80px', gap: 8, padding: '4px 0', fontFamily: 'monospace', fontSize: 11.5 }}>
                  <Mono size={11} color="var(--fg-3)">{v.p}</Mono>
                  <Mono size={11.5}>{v.name}</Mono>
                  <Mono size={10} color={v.s === 'running' ? 'var(--fg)' : 'var(--fg-3)'}>{v.s}</Mono>
                </div>
              ))}
            </div>
          </Card>

          {/* Jobs */}
          <Card>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--fg)' }}>
              <Eyebrow>{t.liveJobs} · 6 / 8 slots</Eyebrow>
            </div>
            <div style={{ padding: '10px 16px' }}>
              {[
                { id: 'j1', name: 'browser.crawl', t: 'app.acme-bank.ru', age: '4m' },
                { id: 'j2', name: 'browser.crawl', t: 'admin.acme-bank.ru', age: '4m' },
                { id: 'j3', name: 'openapi.fuzz', t: 'api.acme-bank.ru/v3', age: '2m' },
                { id: 'j4', name: 'authz-fuzz', t: 'api.acme-bank.ru/v3', age: '1m' },
                { id: 'j5', name: 'ssrf-probe', t: '/avatar/proxy', age: '24s' },
                { id: 'j6', name: 'tls-probe', t: 'gw.acme.ru', age: '12s' },
              ].map(j => (
                <div key={j.id} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 40px', gap: 8, padding: '3px 0', fontFamily: 'monospace', fontSize: 11.5 }}>
                  <Mono size={11.5}>{j.name}</Mono>
                  <Mono size={11} color="var(--fg-3)">{j.t}</Mono>
                  <Mono size={10} color="var(--fg-3)">{j.age}</Mono>
                </div>
              ))}
            </div>
          </Card>

          {/* Kill switch */}
          <Card>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--fg)' }}>
              <Eyebrow>{t.liveKill}</Eyebrow>
            </div>
            <div style={{ padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Mono size={11} color="var(--fg-2)">arms in 2 keypresses · halts all jobs · evidence preserved</Mono>
              <Btn kind="red" size="sm" disabled={!isOperator}>Arm kill-switch</Btn>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

window.LiveScreen = LiveScreen;
