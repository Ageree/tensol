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
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 80px', gap: 16, alignItems: 'center', padding: '14px 4px', borderBottom: '1px solid var(--line-soft)' }}>
      <div>
        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: 'var(--fg)' }}>{a.name}</div>
        <Mono size={10.5} color="var(--fg-3)" style={{ marginTop: 4 }}>{proj && proj.name}</Mono>
      </div>
      <Mono size={11} color={a.status === 'running' ? 'var(--red)' : 'var(--fg-3)'} style={{ letterSpacing: '0.04em', textTransform: 'uppercase' }}>{a.phase}</Mono>
      <Mono size={11} color="var(--fg-2)" style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{a.findings.confirmed}c · {a.findings.candidate}?</Mono>
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
    <div style={{ padding: '14px 4px', borderBottom: '1px solid var(--line-soft)', display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'center' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.detail}</div>
        <Mono size={10.5} color="var(--fg-3)" style={{ marginTop: 4 }}>{a.target} · {a.requestedBy} · {a.when}</Mono>
      </div>
      <Btn kind="dim" size="sm" onClick={onAct}>Review →</Btn>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 32, flexWrap: 'wrap', gap: 16 }}>
        <h1>{t.dashTitle}</h1>
        <Btn kind="primary" onClick={() => onRoute('builder')}>{t.dashCreate} →</Btn>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 48 }}>
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid var(--fg)' }}>
            <Mono size={11} color="var(--fg)" style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}>active assessments</Mono>
            <a onClick={() => onRoute('live')} style={{ cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.04em' }}>view all →</a>
          </div>
          {active.length > 0 ? active.map(a => <AssessmentRow key={a.id} a={a} />) : (
            <div style={{ padding: '32px 0', color: 'var(--fg-3)' }}>
              <Mono size={12}>{t.dashEmpty}</Mono>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '40px 0 12px', paddingBottom: 8, borderBottom: '1px solid var(--fg)' }}>
            <Mono size={11} color="var(--fg)" style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}>recent confirmed findings</Mono>
            <a onClick={() => onRoute('findings')} style={{ cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.04em' }}>view all →</a>
          </div>
          {recent.map(f => <FindingRow key={f.id} f={f} onOpen={() => onRoute('findings')} />)}
        </section>

        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid var(--fg)' }}>
            <Mono size={11} color="var(--fg)" style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}>pending hitl approvals</Mono>
            <Mono size={11} color="var(--red)">{approvals.length}</Mono>
          </div>
          {approvals.map(a => <ApprovalRow key={a.id} a={a} onAct={() => onRoute('approval')} />)}
        </section>
      </div>
    </div>
  );
}

window.Dashboard = Dashboard;

