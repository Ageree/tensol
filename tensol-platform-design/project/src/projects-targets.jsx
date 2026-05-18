// Tensol — C2 Projects (master-detail) + C3 Targets

const { useState: useStateProj } = React;

function ProjectsScreen({ onRoute, role }) {
  const { t } = useTensol();
  const [sel, setSel] = useStateProj(TENSOL_DATA.projects[0].id);
  const [openNew, setOpenNew] = useStateProj(false);
  const proj = TENSOL_DATA.projects.find(p => p.id === sel);
  const projTargets = TENSOL_DATA.targets.filter(x => x.project === sel);
  const projAss = TENSOL_DATA.assessments.filter(a => a.project === sel);
  const projFindings = TENSOL_DATA.findings.filter(f => projAss.find(a => a.id === f.assessment));
  const isReadOnly = role === 'viewer' || role === 'auditor';

  return (
    <div data-screen-label="05 App — projects">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 38, lineHeight: 1.05, letterSpacing: '-0.02em', margin: 0 }}>{t.projTitle}</h1>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14.5, color: 'var(--fg-2)', margin: '6px 0 0' }}>{t.projSub}</p>
        </div>
        <Btn kind="primary" onClick={() => setOpenNew(true)} disabled={isReadOnly} title={isReadOnly ? 'requires operator+' : null}>{t.projNew} →</Btn>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24, alignItems: 'flex-start' }}>
        {/* Master */}
        <Card>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ink)', display: 'grid', gridTemplateColumns: '1.4fr 0.9fr 60px 60px 80px 110px', gap: 12 }}>
            {[t.projColName, t.projColOwner, t.projColTargets, t.projColOpen, t.projColConfirmed, t.projColLast].map((c,i) => (
              <Mono key={i} size={10} color="var(--fg-3)" style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}>{c}</Mono>
            ))}
          </div>
          {TENSOL_DATA.projects.map(p => (
            <button key={p.id} type="button" onClick={() => setSel(p.id)} style={{
              width: '100%', textAlign: 'left', cursor: 'pointer',
              display: 'grid', gridTemplateColumns: '1.4fr 0.9fr 60px 60px 80px 110px', gap: 12,
              padding: '12px 16px', borderBottom: '1px solid var(--line-soft)',
              background: sel === p.id ? 'var(--bg-2)' : 'transparent',
              borderLeft: `3px solid ${sel === p.id ? 'var(--red)' : 'transparent'}`,
              alignItems: 'center', border: 'none',
            }}>
              <Mono size={13} color="var(--fg)">{p.name}</Mono>
              <Mono size={12} color="var(--fg-2)">{p.owner}</Mono>
              <Mono size={12} style={{ fontVariantNumeric: 'tabular-nums' }}>{p.targets}</Mono>
              <Mono size={12} style={{ fontVariantNumeric: 'tabular-nums' }}>{p.openAssessments}</Mono>
              <Mono size={12} style={{ fontVariantNumeric: 'tabular-nums', color: p.confirmed > 0 ? 'var(--red)' : 'var(--fg-2)' }}>{p.confirmed}</Mono>
              <Mono size={11} color="var(--fg-3)">{p.last}</Mono>
            </button>
          ))}
        </Card>

        {/* Detail */}
        <Card>
          <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--ink)' }}>
            <Eyebrow>{`// PROJECT · ${proj.id}`}</Eyebrow>
            <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 26, letterSpacing: '-0.02em', margin: '6px 0 0' }}>{proj.name}</h2>
          </div>
          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <Eyebrow style={{ marginBottom: 8 }}>{t.projDetailMeta}</Eyebrow>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Mono size={11} color="var(--fg-3)">owner</Mono><Mono size={11}>{proj.owner}</Mono>
                <Mono size={11} color="var(--fg-3)">targets</Mono><Mono size={11}>{proj.targets}</Mono>
                <Mono size={11} color="var(--fg-3)">last activity</Mono><Mono size={11}>{proj.last}</Mono>
              </div>
            </div>
            <div>
              <Eyebrow style={{ marginBottom: 8 }}>{t.projDetailTargets}</Eyebrow>
              {projTargets.length === 0 ? (
                <Mono size={11} color="var(--fg-3)">{t.emptyTgt}</Mono>
              ) : projTargets.slice(0, 6).map(tg => (
                <div key={tg.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                  <Mono size={11} color="var(--fg-2)">{tg.ident}</Mono>
                  <StatusChip status={tg.ownership} tone={tg.ownership === 'verified' ? 'ok' : tg.ownership === 'pending' ? 'warn' : 'danger'} size="sm" />
                </div>
              ))}
            </div>
            <div>
              <Eyebrow style={{ marginBottom: 8 }}>{t.projDetailAss}</Eyebrow>
              {projAss.length === 0 ? <Mono size={11} color="var(--fg-3)">{t.emptyAss}</Mono> : projAss.map(a => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                  <Mono size={11} color="var(--fg-2)">{a.name}</Mono>
                  <StatusChip status={a.status} tone={a.status === 'running' ? 'inverse' : a.status === 'completed' ? 'ok' : 'muted'} size="sm" />
                </div>
              ))}
            </div>
            <div>
              <Eyebrow style={{ marginBottom: 8 }}>{t.projDetailFindings}</Eyebrow>
              <Mono size={11} color="var(--fg-2)">{projFindings.filter(f => f.status === 'confirmed').length} confirmed · {projFindings.filter(f => f.status === 'candidate').length} candidate</Mono>
            </div>
            <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--line-soft)' }}>
              <Btn kind="secondary" size="sm" onClick={() => onRoute('targets')}>open targets →</Btn>
              <Btn kind="primary" size="sm" disabled={isReadOnly} onClick={() => onRoute('builder')}>new assessment →</Btn>
            </div>
          </div>
        </Card>
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
  const [sel, setSel] = useStateProj('t1');
  const [openReg, setOpenReg] = useStateProj(false);
  const tg = TENSOL_DATA.targets.find(x => x.id === sel);
  const isReadOnly = role === 'viewer' || role === 'auditor';

  const ownTone = (s) => s === 'verified' ? 'ok' : s === 'pending' ? 'warn' : 'danger';

  return (
    <div data-screen-label="06 App — targets">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 38, lineHeight: 1.05, letterSpacing: '-0.02em', margin: 0 }}>{t.tgtTitle}</h1>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14.5, color: 'var(--fg-2)', margin: '6px 0 0' }}>{t.tgtSub}</p>
        </div>
        <Btn kind="primary" onClick={() => setOpenReg(true)} disabled={isReadOnly}>{t.tgtRegister} →</Btn>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24, alignItems: 'flex-start' }}>
        <Card>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ink)', display: 'grid', gridTemplateColumns: '70px 1fr 90px 70px 110px 60px', gap: 12 }}>
            {[t.tgtColType, t.tgtColIdent, t.tgtColOwn, t.tgtColMethod, t.tgtColLast, t.tgtColFindings].map((c,i) => (
              <Mono key={i} size={10} color="var(--fg-3)" style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}>{c}</Mono>
            ))}
          </div>
          {TENSOL_DATA.targets.map(x => (
            <button key={x.id} type="button" onClick={() => setSel(x.id)} style={{
              width: '100%', textAlign: 'left', cursor: 'pointer',
              display: 'grid', gridTemplateColumns: '70px 1fr 90px 70px 110px 60px', gap: 12,
              padding: '12px 16px', borderBottom: '1px solid var(--line-soft)',
              background: sel === x.id ? 'var(--bg-2)' : 'transparent',
              borderLeft: `3px solid ${sel === x.id ? 'var(--red)' : 'transparent'}`,
              alignItems: 'center', border: 'none',
            }}>
              <StatusChip status={x.type} tone="muted" size="sm" />
              <Mono size={12} color="var(--fg)">{x.ident}</Mono>
              <StatusChip status={x.ownership} tone={ownTone(x.ownership)} size="sm" />
              <Mono size={11} color="var(--fg-2)">{x.method}</Mono>
              <Mono size={11} color="var(--fg-3)">{x.last}</Mono>
              <Mono size={12} style={{ fontVariantNumeric: 'tabular-nums', color: x.findings > 0 ? 'var(--red)' : 'var(--fg-2)', textAlign: 'right' }}>{x.findings}</Mono>
            </button>
          ))}
        </Card>

        <Card>
          <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--ink)' }}>
            <Eyebrow>{`// TARGET · ${tg.id} · ${tg.type}`}</Eyebrow>
            <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 22, letterSpacing: '-0.02em', margin: '6px 0 0', wordBreak: 'break-all' }}>{tg.ident}</h2>
          </div>
          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <Eyebrow style={{ marginBottom: 8 }}>{t.tgtCardOwn}</Eyebrow>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <StatusChip status={tg.ownership} tone={ownTone(tg.ownership)} />
                <Mono size={11} color="var(--fg-2)">via {tg.method} · last {tg.last}</Mono>
              </div>
              <div style={{ background: 'var(--bg-2)', padding: '10px 12px', border: '1px solid var(--line-soft)' }}>
                <Mono size={11} color="var(--fg-2)">_acme-tensol.app.acme-bank.ru. IN TXT "tensol-verify=8f2c…a1b9"</Mono>
              </div>
            </div>
            <div>
              <Eyebrow style={{ marginBottom: 8 }}>{t.tgtCardScope}</Eyebrow>
              <Mono size={11} color="var(--fg-2)" style={{ display: 'block' }}>allow: {tg.ident}/*</Mono>
              <Mono size={11} color="var(--fg-2)" style={{ display: 'block' }}>deny: {tg.ident}/admin/super/*</Mono>
              <Mono size={11} color="var(--fg-2)" style={{ display: 'block' }}>deny: {tg.ident}/api/v3/internal/*</Mono>
            </div>
            <div>
              <Eyebrow style={{ marginBottom: 8 }}>{t.tgtCardCreds}</Eyebrow>
              <Mono size={11} color="var(--fg-2)" style={{ display: 'block' }}>user_low_001 · pw=•••• (masked)</Mono>
              <Mono size={11} color="var(--fg-2)" style={{ display: 'block' }}>user_admin_001 · pw=•••• (masked)</Mono>
            </div>
            <div>
              <Eyebrow style={{ marginBottom: 8 }}>{t.tgtCardHigh}</Eyebrow>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['post-exploit', 'webshell', 'reverse-shell'].map(c => (
                  <StatusChip key={c} status={c} tone="danger" size="sm" />
                ))}
                <StatusChip status="+ 4 not authorized" tone="muted" size="sm" />
              </div>
            </div>
          </div>
        </Card>
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
