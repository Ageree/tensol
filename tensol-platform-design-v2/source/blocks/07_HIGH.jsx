// Tensol — C4 Assessment builder + C5 Approval

const { useState: useStateBld } = React;

const HIGH_IMPACT = [
  'foothold', 'post-exploit', 'lateral-movement', 'ad-attack-path',
  'credential-dump-sim', 'password-audit', 'hash-cracking',
  'phishing-sim', 'evilginx-sim', 'responder-relay-sim',
  'sliver-c2', 'metasploit', 'msfvenom-payload',
  'webshell', 'reverse-shell', 'persistence-test',
];

const TOOLS = [
  { id: 'browser-recon',     name: 'browser-recon',     v: '0.4.1', state: 'available', cat: 'recon' },
  { id: 'openapi-fuzz',      name: 'openapi-fuzz',      v: '0.3.7', state: 'available', cat: 'recon' },
  { id: 'dns-enum',          name: 'dns-enum',          v: '0.2.0', state: 'available', cat: 'recon' },
  { id: 'sqlmap',            name: 'sqlmap',            v: '1.7.12', state: 'available', cat: 'exploit' },
  { id: 'xsstrike',          name: 'xsstrike',          v: '3.1.5', state: 'available', cat: 'exploit' },
  { id: 'ssrf-probe',        name: 'ssrf-probe',        v: '0.5.2', state: 'available', cat: 'exploit' },
  { id: 'authz-fuzz',        name: 'authz-fuzz',        v: '0.4.0', state: 'available', cat: 'exploit' },
  { id: 'nuclei',            name: 'nuclei',            v: '3.2.4', state: 'available', cat: 'exploit' },
  { id: 'sliver-c2',         name: 'sliver-c2',         v: '1.5.42', state: 'unauthorized', cat: 'post', reason: 'requires sliver-c2 authorization on target' },
  { id: 'msfvenom',          name: 'msfvenom',          v: '6.4.5', state: 'unauthorized', cat: 'post', reason: 'requires msfvenom-payload authorization on target' },
  { id: 'mimikatz-sim',      name: 'mimikatz-sim',      v: '0.1.3', state: 'no-creds',     cat: 'post', reason: 'no managed credentials on this target' },
  { id: 'evilginx-sim',      name: 'evilginx-sim',      v: '0.2.1', state: 'region-block', cat: 'phishing', reason: 'phishing-sim disabled by region policy (ru)' },
];

function StepHeader({ idx, total, title, sub }) {
  return (
    <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--line-soft)' }}>
      <Mono size={11} color="var(--fg-3)" style={{ letterSpacing: '0.08em' }}>{`${String(idx).padStart(2,'0')} / ${String(total).padStart(2,'0')}`}</Mono>
      <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 24, letterSpacing: '-0.02em', margin: '4px 0 4px' }}>{title}</h2>
      {sub && <Mono size={12} color="var(--fg-2)">{sub}</Mono>}
    </div>
  );
}

function BuilderScreen({ onRoute, role }) {
  const { t } = useTensol();
  const [tab, setTab] = useStateBld(0);
  const [selTargets, setSelTargets] = useStateBld(['t1','t2','t3']);
  const [scopeAllow, setScopeAllow] = useStateBld('app.acme-bank.ru/*\nadmin.acme-bank.ru/*\napi.acme-bank.ru/v3/*');
  const [scopeDeny, setScopeDeny] = useStateBld('*/admin/super/*\n*/api/v3/internal/*\n*/health\n*/version');
  const [exclusions, setExclusions] = useStateBld('do not touch /payment/initiate (rate-limited critical path)');
  const [auths, setAuths] = useStateBld(new Set(['foothold', 'post-exploit', 'webshell']));
  const toggleAuth = (k) => {
    const s = new Set(auths);
    s.has(k) ? s.delete(k) : s.add(k);
    setAuths(s);
  };
  const verified = TENSOL_DATA.targets.filter(x => x.ownership === 'verified');
  const tabs = t.bldTabs;

  return (
    <div data-screen-label="07 App — assessment builder">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 32 }}>
        <div>
          <h1>{t.bldTitle}</h1>
          <Mono size={11} color="var(--fg-3)" style={{ display: 'block', marginTop: 6, letterSpacing: '0.08em', textTransform: 'uppercase' }}>core-banking-prod</Mono>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn kind="secondary" onClick={() => {}}>{t.bldDryRun}</Btn>
          <Btn kind="primary" onClick={() => onRoute('approval')}>{t.bldSubmit} →</Btn>
        </div>
      </div>

      <Card>
        <Tabs value={tab} onChange={setTab} options={tabs.map((l, i) => ({ value: i, label: `${String(i+1).padStart(2,'0')} ${l}` }))} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 0, alignItems: 'stretch' }}>
          <div style={{ padding: '24px', minHeight: 480 }}>
            {tab === 0 && (
              <>
                <StepHeader idx={1} total={tabs.length} title={tabs[0]} sub="only verified targets are selectable" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {verified.map(x => (
                    <Checkbox key={x.id}
                      checked={selTargets.includes(x.id)}
                      onChange={() => setSelTargets(s => s.includes(x.id) ? s.filter(y => y !== x.id) : [...s, x.id])}
                      label={`${x.ident}`}
                      hint={`type ${x.type} · verified via ${x.method}`}
                    />
                  ))}
                  <Checkbox checked={false} onChange={() => {}} label="beta.broker-staging.acme-bank.ru" hint="ownership pending — not selectable" />
                </div>
              </>
            )}
            {tab === 1 && (
              <>
                <StepHeader idx={2} total={tabs.length} title={tabs[1]} sub="scope is normalized at runtime: URL canonicalization, DNS resolve, IP expansion" />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <Field label="allow rules" hint="one rule per line">
                    <Textarea value={scopeAllow} onChange={e => setScopeAllow(e.target.value)} rows={6} />
                  </Field>
                  <Field label="deny rules" hint="evaluated after allow">
                    <Textarea value={scopeDeny} onChange={e => setScopeDeny(e.target.value)} rows={6} />
                  </Field>
                </div>
                <div style={{ marginTop: 12 }}>
                  <Field label="exclusions" hint="free-form notes for the operator">
                    <Textarea value={exclusions} onChange={e => setExclusions(e.target.value)} rows={2} />
                  </Field>
                </div>
              </>
            )}
            {tab === 2 && (
              <>
                <StepHeader idx={3} total={tabs.length} title={tabs[2]} sub="agent will only act inside this window" />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <Field label="start"><Input value="2026-05-08 09:00 MSK" onChange={() => {}} /></Field>
                  <Field label="end"><Input value="2026-05-10 18:00 MSK" onChange={() => {}} /></Field>
                  <Field label="active hours per day"><Input value="09:00–22:00" onChange={() => {}} /></Field>
                  <Field label="timezone"><Select value="Europe/Moscow" onChange={() => {}} options={['Europe/Moscow','UTC','Europe/Berlin']} /></Field>
                </div>
              </>
            )}
            {tab === 3 && (
              <>
                <StepHeader idx={4} total={tabs.length} title={tabs[3]} sub="depth and methodology" />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <Field label="methodology"><Select value="ptes" onChange={() => {}} options={[{value:'ptes',label:'PTES (Penetration Testing Execution Standard)'},{value:'ossam',label:'OSSAM'},{value:'custom',label:'custom OPPLAN'}]} /></Field>
                  <Field label="depth"><Select value="deep" onChange={() => {}} options={[{value:'shallow',label:'shallow · recon-only'},{value:'standard',label:'standard · exploit + validate'},{value:'deep',label:'deep · exploit + post-exploit'}]} /></Field>
                  <Field label="parallel browsers"><Input value="6" onChange={() => {}} /></Field>
                  <Field label="finding suppression" hint="merge duplicates by signature"><Select value="strict" onChange={() => {}} options={['strict','permissive','off']} /></Field>
                </div>
              </>
            )}
            {tab === 4 && (
              <>
                <StepHeader idx={5} total={tabs.length} title={tabs[4]} sub="effective catalog. items are surfaced based on tenant access + target authorizations" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {TOOLS.map(tool => (
                    <div key={tool.id} style={{
                      padding: '10px 12px', border: '1px solid var(--line-soft)',
                      display: 'grid', gridTemplateColumns: '1.6fr 80px 110px 1fr', gap: 12, alignItems: 'center',
                      opacity: tool.state === 'available' ? 1 : 0.7,
                    }}>
                      <Mono size={12} color="var(--fg)">{tool.name}</Mono>
                      <Mono size={11} color="var(--fg-3)">v{tool.v}</Mono>
                      <StatusChip status={tool.state} tone={tool.state === 'available' ? 'ok' : 'muted'} size="sm" />
                      <Mono size={11} color={tool.state === 'available' ? 'var(--fg-3)' : 'var(--red)'}>{tool.reason || tool.cat}</Mono>
                    </div>
                  ))}
                </div>
              </>
            )}
            {tab === 5 && (
              <>
                <StepHeader idx={6} total={tabs.length} title={tabs[5]} sub="declare authorizations as part of target authorization. unchecked = engine refuses." />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {HIGH_IMPACT.map(c => (
                    <Checkbox key={c} danger
                      checked={auths.has(c)}
                      onChange={() => toggleAuth(c)}
                      label={c}
                      hint={c.includes('phishing') || c.includes('evilginx') ? 'requires legal sign-off attached to target' : null}
                    />
                  ))}
                </div>
              </>
            )}
            {tab === 6 && (
              <>
                <StepHeader idx={7} total={tabs.length} title={tabs[6]} sub="OpenAPI documents and contextual notes — fed to recon and validators" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ padding: '12px 14px', border: '1px dashed var(--fg)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Mono size={12}>openapi-v3-acme-bank.json · 184 KB</Mono>
                    <Mono size={11} color="var(--fg-3)">uploaded · 2026-05-04 09:14</Mono>
                  </div>
                  <div style={{ padding: '12px 14px', border: '1px dashed var(--line-soft)', textAlign: 'center', color: 'var(--fg-3)' }}>
                    <Mono size={12}>drop additional openapi / postman / swagger here</Mono>
                  </div>
                  <Field label="masked credentials" hint="add login recipes per role">
                    <Textarea rows={3} value={`user_low_001 :: cookie-recipe via /auth/login\nuser_admin_001 :: cookie-recipe via /auth/login + mfa-fixture`} onChange={() => {}} />
                  </Field>
                </div>
              </>
            )}
            {tab === 7 && (
              <>
                <StepHeader idx={8} total={tabs.length} title={tabs[7]} sub="effective scope preview. confirm and submit for approval." />
                <ReviewBlock auths={auths} selTargets={selTargets} />
              </>
            )}
          </div>

          {/* Sidebar — live summary */}
          <aside style={{
            background: 'var(--bg-2)', borderLeft: '1px solid var(--ink)',
            padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 18,
          }}>
            <Eyebrow>// EFFECTIVE SUMMARY</Eyebrow>
            <SummaryRow label="targets" value={`${selTargets.length} verified`} />
            <SummaryRow label="scope rules" value={`${scopeAllow.split('\n').filter(Boolean).length} allow · ${scopeDeny.split('\n').filter(Boolean).length} deny`} />
            <SummaryRow label="window" value="2026-05-08 → 2026-05-10" />
            <SummaryRow label="profile" value="ptes · deep" />
            <SummaryRow label="tools" value={`${TOOLS.filter(t => t.state === 'available').length} available · ${TOOLS.filter(t => t.state !== 'available').length} blocked`} />
            <SummaryRow label="high-impact authorized" value={`${auths.size} / ${HIGH_IMPACT.length}`} accent={auths.size > 6} />
            <SummaryRow label="hitl gates expected" value="3" />
            <div style={{ marginTop: 'auto', paddingTop: 16, borderTop: '1px solid var(--line-soft)' }}>
              <Mono size={11} color="var(--fg-3)" style={{ display: 'block', marginBottom: 8 }}>{`step ${tab+1}/${tabs.length}`}</Mono>
              <ProgressBar value={(tab+1)/tabs.length*100} segments={tabs.length} height={6} color="var(--red)" />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="dim" size="sm" disabled={tab === 0} onClick={() => setTab(t => Math.max(0, t-1))}>← {t.bldBack}</Btn>
              <Btn kind="primary" size="sm" disabled={tab === tabs.length-1} onClick={() => setTab(t => Math.min(tabs.length-1, t+1))}>{t.bldNext} →</Btn>
            </div>
          </aside>
        </div>
      </Card>
    </div>
  );
}

function SummaryRow({ label, value, accent }) {
  return (
    <div>
      <Mono size={10} color="var(--fg-3)" style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</Mono>
      <Mono size={13} color={accent ? 'var(--red)' : 'var(--fg)'} style={{ display: 'block', marginTop: 2 }}>{value}</Mono>
    </div>
  );
}

function ReviewBlock({ auths, selTargets }) {
  const targets = TENSOL_DATA.targets.filter(x => selTargets.includes(x.id));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Section h="targets">
        {targets.map(x => <Mono key={x.id} size={12} style={{ display: 'block' }}>{`■ ${x.ident}`} <span style={{ color: 'var(--fg-3)' }}>· {x.type}</span></Mono>)}
      </Section>
      <Section h="effective scope (preview)">
        <pre style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.55, margin: 0, color: 'var(--fg-2)', background: 'var(--ink)', padding: 14 }}>
{`[ok]   normalize · 3 hostnames → 4 canonical
[ok]   resolve · 4 A records, 0 CNAME loops
[ok]   ip-expand · 10.42.18.0/29 = 6 hosts
[deny] /admin/super/*  · 14 paths suppressed
[deny] /api/v3/internal/* · 22 paths suppressed
[ok]   final scope: 412 reachable endpoints`}
        </pre>
      </Section>
      <Section h="declared high-impact authorizations">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {[...auths].map(a => <StatusChip key={a} status={a} tone="danger" size="sm" />)}
          {auths.size === 0 && <Mono size={11} color="var(--fg-3)">none declared. agent will operate in non-destructive mode only.</Mono>}
        </div>
      </Section>
      <Section h="next">
        <Mono size={12} color="var(--fg-2)">submit → routed to security_lead for approval. you receive an in-app notification on decision.</Mono>
      </Section>
    </div>
  );
}

function Section({ h, children }) {
  return (
    <div>
      <Eyebrow style={{ marginBottom: 8 }}>{`// ${h.toUpperCase()}`}</Eyebrow>
      {children}
    </div>
  );
}

function ApprovalScreen({ onRoute, role }) {
  const { t } = useTensol();
  const isApprover = role === 'security_lead';
  return (
    <div data-screen-label="08 App — approval">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 32 }}>
        <h1>{t.apprTitle}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn kind="dim" disabled={!isApprover}>{t.apprReject}</Btn>
          <Btn kind="secondary" disabled={!isApprover}>{t.apprSendBack}</Btn>
          <Btn kind="primary" disabled={!isApprover} onClick={() => onRoute('live')}>{t.apprApprove} →</Btn>
        </div>
      </div>
      {!isApprover && (
        <div style={{ marginBottom: 16, padding: '12px 14px', background: 'var(--bg-2)', border: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Mono size={11} color="var(--red)">[deny] approve requires role security_lead. you are: {role}.</Mono>
          <Mono size={11} color="var(--fg-3)">read-only view enabled</Mono>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24, alignItems: 'flex-start' }}>
        <Card>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--ink)' }}>
            <Eyebrow>// SUBMITTED · a3 · broker-staging-baseline</Eyebrow>
            <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 26, letterSpacing: '-0.02em', margin: '6px 0 0' }}>broker-portal-staging — Q2 baseline</h2>
            <Mono size={12} color="var(--fg-3)" style={{ display: 'block', marginTop: 4 }}>by M. Petrova · 2026-05-04 13:38 MSK · awaiting decision · 23m</Mono>
          </div>
          <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 22 }}>
            <Section h="targets">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {['broker-staging.acme-bank.ru','beta.broker-staging.acme-bank.ru','github.com/acme/broker-portal'].map((x,i) => (
                  <Mono key={i} size={12}>■ {x}</Mono>
                ))}
              </div>
            </Section>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
              <Section h="scope">
                <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>allow: broker-staging.acme-bank.ru/*</Mono>
                <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>deny: */admin/* */health */version</Mono>
              </Section>
              <Section h="exclusions">
                <Mono size={11.5} color="var(--fg-2)">do not touch /payment/initiate (rate-limited critical path)</Mono>
              </Section>
              <Section h="window">
                <Mono size={11.5} color="var(--fg-2)">2026-05-08 09:00 → 2026-05-10 18:00 MSK · 09:00–22:00 daily</Mono>
              </Section>
              <Section h="profile">
                <Mono size={11.5} color="var(--fg-2)">PTES · deep · 6 parallel browsers</Mono>
              </Section>
            </div>
            <Section h="declared high-impact authorizations">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['foothold','post-exploit','webshell','reverse-shell'].map(c => <StatusChip key={c} status={c} tone="danger" size="sm" />)}
              </div>
            </Section>
            <Section h="opplan summary">
              <Mono size={11.5} color="var(--fg-2)" style={{ lineHeight: 1.55, display: 'block' }}>
                phase 1 recon → 2h budget · phase 2 exploit (web + api) → 8h budget · phase 3 post-exploit on confirmed foothold only · 3 expected hitl gates (credential-dump-sim, lateral-movement, persistence-test).
              </Mono>
            </Section>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
              <Section h="openapi documents">
                <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>broker-v1-openapi.json · 96 KB</Mono>
                <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>partner-v1-openapi.json · 41 KB</Mono>
              </Section>
              <Section h="credentials (no values)">
                <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>user_broker_low</Mono>
                <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>user_broker_admin</Mono>
              </Section>
            </div>
          </div>
        </Card>

        <Card>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ink)' }}>
            <Eyebrow>// approval log</Eyebrow>
          </div>
          <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Mono size={11} color="var(--fg-2)">2026-05-04 13:38 — submitted by M. Petrova</Mono>
            <Mono size={11} color="var(--fg-2)">2026-05-04 13:38 — assigned to A. Kovalev</Mono>
            <Mono size={11} color="var(--fg-3)">— pending decision —</Mono>
          </div>
          <div style={{ padding: '14px 16px', borderTop: '1px solid var(--ink)' }}>
            <Eyebrow style={{ marginBottom: 8 }}>// requires acknowledgement</Eyebrow>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Checkbox checked={true} onChange={() => {}} label="targets are owned and authorized" />
              <Checkbox checked={true} onChange={() => {}} label="declared high-impact categories are accepted" />
              <Checkbox checked={false} onChange={() => {}} label="legal sign-off filed for the engagement" />
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

Object.assign(window, { BuilderScreen, ApprovalScreen });

