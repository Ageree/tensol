// Tensol — C2 Projects (master-detail) + C3 Targets

const { useState: useStateProj } = React;

function ProjectsScreen({ onRoute, role }) {
  const { t } = useTensol();
  const [openNew, setOpenNew] = useStateProj(false);
  const isReadOnly = role === 'viewer' || role === 'auditor';

  return (
    <div data-screen-label="05 App — projects">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 32 }}>
        <h1>{t.projTitle}</h1>
        <Btn kind="primary" onClick={() => setOpenNew(true)} disabled={isReadOnly} title={isReadOnly ? 'requires operator+' : null}>{t.projNew} →</Btn>
      </div>

      {/* Single-pane list. Each row links straight to assessments — there
          is no need for a separate detail card duplicating the same data. */}
      <div>
        {TENSOL_DATA.projects.map((p, i) => (
          <button key={p.id} type="button" onClick={() => onRoute('targets')} style={{
            width: '100%', textAlign: 'left', cursor: 'pointer',
            display: 'grid', gridTemplateColumns: '1.6fr 1fr 90px 130px', gap: 24,
            padding: '20px 4px', borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
            background: 'transparent', border: 'none', alignItems: 'baseline',
          }}>
            <div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 18, letterSpacing: '-0.01em', color: 'var(--fg)' }}>{p.name}</div>
              <Mono size={11} color="var(--fg-3)" style={{ display: 'block', marginTop: 4 }}>{p.owner}</Mono>
            </div>
            <Mono size={12} color="var(--fg-2)">{p.targets} targets · {p.openAssessments} open</Mono>
            <Mono size={12} style={{ fontVariantNumeric: 'tabular-nums', color: p.confirmed > 0 ? 'var(--red)' : 'var(--fg-3)' }}>
              {p.confirmed > 0 ? `${p.confirmed} confirmed` : '—'}
            </Mono>
            <Mono size={11} color="var(--fg-3)" style={{ textAlign: 'right' }}>{p.last}</Mono>
          </button>
        ))}
      </div>

      <Modal open={openNew} onClose={() => setOpenNew(false)} title="// NEW PROJECT" width={520}>
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="name"><Input placeholder="payment-gateway-prod" /></Field>
          <Field label="owner"><Input value={TENSOL_DATA.user.name} disabled /></Field>
          <Field label="description" hint="short context, not target list"><Textarea rows={3} /></Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn kind="dim" onClick={() => setOpenNew(false)}>cancel</Btn>
            <Btn kind="primary" onClick={() => setOpenNew(false)}>create →</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function TargetsScreen({ onRoute, role }) {
  const { t } = useTensol();
  const [openReg, setOpenReg] = useStateProj(false);
  const isReadOnly = role === 'viewer' || role === 'auditor';
  const ownTone = (s) => s === 'verified' ? 'ok' : s === 'pending' ? 'warn' : 'danger';

  return (
    <div data-screen-label="06 App — targets">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 32 }}>
        <h1>{t.tgtTitle}</h1>
        <Btn kind="primary" onClick={() => setOpenReg(true)} disabled={isReadOnly}>{t.tgtRegister} →</Btn>
      </div>

      {/* Single-pane list. Detail goes in a drawer if/when needed. */}
      <div>
        {TENSOL_DATA.targets.map((x, i) => (
          <div key={x.id} style={{
            display: 'grid', gridTemplateColumns: '1.6fr 110px 1fr 100px', gap: 24,
            padding: '18px 4px', borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
            alignItems: 'baseline',
          }}>
            <div>
              <Mono size={13.5} color="var(--fg)" style={{ wordBreak: 'break-all' }}>{x.ident}</Mono>
              <Mono size={11} color="var(--fg-3)" style={{ display: 'block', marginTop: 4 }}>{x.type} · via {x.method}</Mono>
            </div>
            <StatusChip status={x.ownership} tone={ownTone(x.ownership)} size="sm" />
            <Mono size={11} color="var(--fg-3)">{x.last}</Mono>
            <Mono size={12} style={{ fontVariantNumeric: 'tabular-nums', color: x.findings > 0 ? 'var(--red)' : 'var(--fg-3)', textAlign: 'right' }}>
              {x.findings > 0 ? `${x.findings} findings` : '—'}
            </Mono>
          </div>
        ))}
      </div>

      {/* Register modal */}
      <Modal open={openReg} onClose={() => setOpenReg(false)} title="// REGISTER TARGET" width={620}>
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label={t.tgtTypeLabel}>
              <Select value="web" onChange={() => {}} options={['web','host','network','cloud','api','repository']} />
            </Field>
            <Field label={t.tgtMethodLabel}>
              <Select value="dns" onChange={() => {}} options={[{value:'dns',label:'DNS TXT record'},{value:'file',label:'File on root'},{value:'header',label:'HTTP header'},{value:'email',label:'Email confirmation'},{value:'cloud',label:'Cloud-side proof'}]} />
            </Field>
          </div>
          <Field label={t.tgtIdentLabel} hint="hostname, IP, CIDR, repo URL, cloud folder">
            <Input placeholder="app.acme-bank.ru" />
          </Field>
          <Field label={t.tgtDescLabel}>
            <Textarea rows={2} placeholder="customer-facing banking portal, prod" />
          </Field>
          <Field label={t.tgtContactLabel}>
            <Input placeholder="owner@acme-bank.ru" />
          </Field>
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--line-soft)', padding: '12px 14px' }}>
            <Mono size={11} color="var(--fg-3)" style={{ letterSpacing: '0.08em' }}>// VERIFICATION INSTRUCTIONS</Mono>
            <Mono size={11} color="var(--fg)" style={{ display: 'block', marginTop: 8, lineHeight: 1.5 }}>
              Add a TXT record:<br/>
              _acme-tensol.app.acme-bank.ru. IN TXT "tensol-verify=8f2c…a1b9"<br/>
              We re-check every 5 min for 24h. Until verified, target cannot enter scope.
            </Mono>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn kind="dim" onClick={() => setOpenReg(false)}>{t.cancel}</Btn>
            <Btn kind="primary" onClick={() => setOpenReg(false)}>{t.tgtCreate} →</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

Object.assign(window, { ProjectsScreen, TargetsScreen });

