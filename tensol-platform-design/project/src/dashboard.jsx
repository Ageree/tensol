// Tensol — C1 Dashboard. Operations overview for security_lead/operator.

const { useState: useStateDash } = React;

function KpiCell({ label, value, sub, accent }) {
  return (
    <div style={{
      padding: '20px 24px',
      background: accent ? 'var(--red)' : 'transparent',
      color: accent ? 'var(--paper)' : 'var(--ink)',
      borderRight: '1px solid var(--ink)',
      display: 'flex', flexDirection: 'column', gap: 8,
      minHeight: 132,
    }}>
      <Eyebrow color={accent ? 'rgba(255,255,255,.7)' : 'var(--fg-2)'}>{label}</Eyebrow>
      <div style={{
        fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500,
        fontSize: 56, lineHeight: 1, letterSpacing: '-0.03em',
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
      <Mono size={11} color={accent ? 'rgba(255,255,255,.7)' : 'var(--fg-3)'}>{sub}</Mono>
    </div>
  );
}

function AssessmentRow({ a }) {
  const proj = TENSOL_DATA.projects.find(p => p.id === a.project);
  const phaseColor = a.status === 'running' ? 'var(--red)' : 'var(--fg-3)';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 110px 80px 110px 1fr', gap: 16, alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--line-soft)' }}>
      <div>
        <Mono size={13} color="var(--fg)" style={{ display: 'block' }}>{a.name}</Mono>
        <Mono size={11} color="var(--fg-3)">{proj && proj.name}</Mono>
      </div>
      <StatusChip status={a.status} tone={a.status === 'running' ? 'inverse' : a.status === 'completed' ? 'ok' : a.status === 'awaiting_approval' ? 'warn' : 'muted'} size="sm" />
      <Mono size={11} color={phaseColor} style={{ letterSpacing: '0.04em', textTransform: 'uppercase' }}>{a.phase}</Mono>
      <Mono size={12} color="var(--fg-2)" style={{ fontVariantNumeric: 'tabular-nums' }}>{a.findings.confirmed}c · {a.findings.candidate}?</Mono>
      <Mono size={11} color="var(--fg-3)">{a.startedAt}</Mono>
      <ProgressBar value={a.progress * 100} segments={28} height={6} color="var(--red)" />
    </div>
  );
}

function FindingRow({ f, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen && onOpen(f)} style={{
      width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
      padding: '12px 16px', borderBottom: '1px solid var(--line-soft)',
      display: 'grid', gridTemplateColumns: '90px 1fr 80px 110px', gap: 12, alignItems: 'center', cursor: 'pointer',
    }}
    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-2)'}
    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
      <SeverityChip sev={f.sev} size="sm" />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 13.5, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title}</div>
        <Mono size={11} color="var(--fg-3)">{f.asset}</Mono>
      </div>
      <Mono size={11} color="var(--fg-2)">{f.conf}</Mono>
      <Mono size={11} color="var(--fg-3)" style={{ textAlign: 'right' }}>{f.foundAt.split(' ')[1]}</Mono>
    </button>
  );
}

function ApprovalRow({ a, onAct }) {
  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Mono size={12} color="var(--fg)" style={{ fontWeight: 500 }}>{a.detail}</Mono>
        <StatusChip status={a.kind} tone="warn" size="sm" />
      </div>
      <Mono size={11} color="var(--fg-3)" style={{ display: 'block' }}>target: {a.target} · {a.requestedBy} · {a.when}</Mono>
      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.4 }}>{a.justify}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Btn kind="primary" size="sm" onClick={onAct}>Approve</Btn>
        <Btn kind="dim" size="sm" onClick={onAct}>Decline</Btn>
      </div>
    </div>
  );
}

function Dashboard({ onRoute }) {
  const { t } = useTensol();
  const active = TENSOL_DATA.assessments.filter(a => a.status === 'running');
  const recent = TENSOL_DATA.findings.filter(f => f.status === 'confirmed').slice(0, 5);
  const approvals = TENSOL_DATA.approvals;
  const sparks = [3,5,2,8,4,7,9,6,11,8,12,9,15,11,14,10,8,5,9,12,14,11,9,7,5,11,13,10,9,12];

  return (
    <div data-screen-label="04 App — dashboard">
      {/* Title row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
        <div>
          <Eyebrow style={{ marginBottom: 8 }}>{`// ${TENSOL_DATA.user.tenant} · ${new Date().toISOString().slice(0,10)}`}</Eyebrow>
          <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 44, lineHeight: 1.05, letterSpacing: '-0.02em', margin: 0 }}>{t.dashTitle}</h1>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 15, color: 'var(--fg-2)', margin: '8px 0 0' }}>{t.dashSub}</p>
        </div>
        <Btn kind="primary" onClick={() => onRoute('builder')}>{t.dashCreate} →</Btn>
      </div>

      {/* KPI strip */}
      <div style={{ border: '1px solid var(--ink)', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <KpiCell label={t.dashKpiActive}    value="2"    sub={`+1 vs prior 7d`} />
        <KpiCell label={t.dashKpiConfirmed} value="11"   sub={`3 critical · 5 high · 3 medium`} accent />
        <KpiCell label={t.dashKpiPending}   value="2"    sub={`oldest: 14m ago`} />
        <KpiCell label={t.dashKpiUptime}    value="99.94%" sub={`14ms p50 · 41ms p95`} />
      </div>

      {/* 2x2 grid: assessments + findings + approvals + telemetry */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24, marginTop: 24 }}>
        <Card>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ink)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Eyebrow>{t.dashActiveAssessments}</Eyebrow>
            <a onClick={() => onRoute('live')} style={{ cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--fg-2)', letterSpacing: '0.04em' }}>view all →</a>
          </div>
          {active.length > 0 ? active.map(a => <AssessmentRow key={a.id} a={a} />) : (
            <div style={{ padding: '32px', textAlign: 'center', color: 'var(--fg-3)' }}>
              <Mono size={12}>{t.dashEmpty}</Mono>
            </div>
          )}
        </Card>

        <Card>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ink)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Eyebrow>{t.dashApprovals}</Eyebrow>
            <Mono size={11} color="var(--red)">{approvals.length} pending</Mono>
          </div>
          {approvals.map(a => <ApprovalRow key={a.id} a={a} onAct={() => {}} />)}
        </Card>

        <Card>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ink)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Eyebrow>{t.dashRecentFindings}</Eyebrow>
            <a onClick={() => onRoute('findings')} style={{ cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--fg-2)', letterSpacing: '0.04em' }}>view all →</a>
          </div>
          {recent.map(f => <FindingRow key={f.id} f={f} onOpen={() => onRoute('findings')} />)}
        </Card>

        <Card>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ink)' }}>
            <Eyebrow>{t.dashEngine}</Eyebrow>
          </div>
          <div style={{ padding: '20px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div>
              <Mono size={11} color="var(--fg-3)" style={{ letterSpacing: '0.08em', display: 'block', marginBottom: 8 }}>// VALIDATOR JOBS · 30 MIN</Mono>
              <Sparkline values={sparks} height={48} color="var(--fg)" />
              <Mono size={11} color="var(--fg-2)" style={{ marginTop: 8, display: 'block' }}>peak 15/min · now 9/min</Mono>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Mono size={11} color="var(--fg-2)">workers</Mono>
                <Mono size={11}>14 / 16 ready</Mono>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Mono size={11} color="var(--fg-2)">browser pool</Mono>
                <Mono size={11}>22 / 32 used</Mono>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Mono size={11} color="var(--fg-2)">queue depth</Mono>
                <Mono size={11}>3</Mono>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Mono size={11} color="var(--fg-2)">llm tokens · 24h</Mono>
                <Mono size={11}>4.18M</Mono>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Mono size={11} color="var(--fg-2)">audit writes · 24h</Mono>
                <Mono size={11}>61,402</Mono>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

window.Dashboard = Dashboard;
