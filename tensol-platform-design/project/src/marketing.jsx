// Tensol — A1 Marketing landing page (forks the existing marketing kit,
// MVP-aligned: hero + 3 pillars + pipeline + proof + Russia + supply-chain
// + boundary + roles + final CTA + footer).

const { useState: useStateMkt } = React;

function MarketingNav({ onSignIn, onDemo }) {
  const { t } = useTensol();
  const [hov, setHov] = useStateMkt(-1);
  return (
    <nav style={{
      maxWidth: 1280, margin: '0 auto',
      padding: '32px 64px 0',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      position: 'relative', zIndex: 2,
    }}>
      <LogoLockup size={20} color="var(--ink)" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
        {t.nav.map((l, i) => (
          <a key={i} href={`#sec-${i}`}
             onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(-1)}
             style={{
               fontFamily: "'JetBrains Mono', monospace",
               fontSize: 12, letterSpacing: '0.04em',
               textTransform: 'uppercase', textDecoration: 'none',
               color: hov === i ? 'var(--red)' : 'var(--ink)',
               transition: 'color 120ms',
             }}>{l}</a>
        ))}
        <Btn kind="secondary" size="sm" onClick={onSignIn}>{t.signin} →</Btn>
        <Btn kind="primary"   size="sm" onClick={onDemo}>{t.requestDemo}</Btn>
      </div>
    </nav>
  );
}

function MarketingHero({ onDemo, monoRatio }) {
  const { t } = useTensol();
  return (
    <section style={{
      maxWidth: 1280, margin: '0 auto',
      padding: '80px 64px 112px',
      position: 'relative',
    }}>
      <HalftoneBg size={12} opacity={0.16} style={{
        inset: '64px 64px 0 64px',
        maskImage: 'linear-gradient(to bottom, black 0%, transparent 80%)',
        WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 80%)',
      }} />
      <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: '1fr 360px', gap: 64, alignItems: 'flex-start' }}>
        <div>
          <Eyebrow>{t.eyebrowLive}</Eyebrow>
          <h1 style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 500, fontSize: 'clamp(56px, 9vw, 104px)',
            lineHeight: 0.96, letterSpacing: '-0.03em',
            margin: '24px 0 28px', color: 'var(--ink)', textWrap: 'balance',
          }}>
            {t.heroL1}<br/>{t.heroL2}<br/>
            <span style={{ color: 'var(--red)', whiteSpace: 'nowrap' }}>{t.heroL3}</span>
          </h1>
          <p style={{
            fontFamily: monoRatio > 0.4 ? "'JetBrains Mono', monospace" : "'Inter', sans-serif",
            fontSize: monoRatio > 0.4 ? 16 : 19, lineHeight: 1.5,
            maxWidth: '54ch', margin: '0 0 36px', color: 'var(--fg-2)',
          }}>{t.heroBlurb}</p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn kind="primary" onClick={onDemo}>{t.ctaPrimary} ▸</Btn>
            <Btn kind="ghost" href="#sec-1">{t.ctaGhost} →</Btn>
          </div>
          <div style={{ marginTop: 56, display: 'flex', gap: 32, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <Eyebrow>{t.trustEyebrow}</Eyebrow>
            <div style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--fg-2)',
              display: 'flex', gap: 14, flexWrap: 'wrap',
            }}>
              {t.trust.map((x, i) => (
                <React.Fragment key={i}>
                  <span>{x}</span>
                  {i < t.trust.length - 1 && <span>·</span>}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 12 }}>
          <HorseMark size={300} color="var(--ink)" />
        </div>
      </div>
    </section>
  );
}

function MarketingPillars({ redUsage }) {
  const { t } = useTensol();
  return (
    <section id="sec-0" style={{ maxWidth: 1280, margin: '0 auto', padding: '0 64px 96px' }}>
      <Eyebrow style={{ marginBottom: 16 }}>{t.pillarsEyebrow}</Eyebrow>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
        borderTop: '1px solid var(--ink)',
      }}>
        {t.pillars.map((p, i) => {
          const accent = redUsage === 'more' && i === 1;
          return (
            <div key={i} style={{
              padding: '32px 28px',
              borderRight: i < 2 ? '1px solid var(--ink)' : 'none',
              borderBottom: '1px solid var(--ink)',
              background: accent ? 'var(--red)' : 'transparent',
              color: accent ? 'var(--paper)' : 'var(--ink)',
              minHeight: 260, display: 'flex', flexDirection: 'column', gap: 16,
            }}>
              <div style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11, letterSpacing: '0.08em',
                color: accent ? 'rgba(255,255,255,.7)' : 'var(--fg-2)',
              }}>{p.n}</div>
              <h3 style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 500, fontSize: 28, letterSpacing: '-0.02em',
                lineHeight: 1.05, margin: 0,
              }}>{p.t}</h3>
              <p style={{
                fontFamily: "'Inter', sans-serif", fontSize: 14.5, lineHeight: 1.55,
                color: accent ? 'rgba(255,255,255,.85)' : 'var(--fg-2)', margin: 0,
              }}>{p.d}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MarketingNotScanner() {
  const { t } = useTensol();
  return (
    <section id="sec-1" style={{ maxWidth: 1280, margin: '0 auto', padding: '0 64px 96px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 64, alignItems: 'flex-start' }}>
        <Eyebrow>{t.notScannerEyebrow}</Eyebrow>
        <div>
          <h2 style={{
            fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500,
            fontSize: 44, lineHeight: 1.05, letterSpacing: '-0.02em',
            margin: '0 0 24px', textWrap: 'balance', maxWidth: '24ch',
          }}>{t.notScannerTitle}</h2>
          <p style={{
            fontFamily: "'Inter', sans-serif", fontSize: 17, lineHeight: 1.55,
            color: 'var(--fg-2)', maxWidth: '60ch',
          }}>{t.notScannerBlurb}</p>
        </div>
      </div>
    </section>
  );
}

function MarketingPipeline() {
  const { t } = useTensol();
  return (
    <section style={{ maxWidth: 1280, margin: '0 auto', padding: '0 64px 96px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <Eyebrow>{t.pipelineEyebrow}</Eyebrow>
        <Mono size={11} color="var(--fg-2)" style={{ letterSpacing: '0.08em' }}>{t.pipelineMeta}</Mono>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
        borderTop: '1px solid var(--ink)',
      }}>
        {t.steps.map((s, i) => (
          <div key={i} style={{
            padding: '24px 18px',
            borderRight: i < 4 ? '1px solid var(--ink)' : 'none',
            borderBottom: '1px solid var(--ink)',
            display: 'flex', flexDirection: 'column', gap: 12, minHeight: 200,
          }}>
            <Mono size={11} color="var(--fg-2)" style={{ letterSpacing: '0.08em' }}>{s.n}</Mono>
            <h3 style={{
              fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500,
              fontSize: 26, letterSpacing: '-0.02em', margin: 0, lineHeight: 1.05,
            }}>{s.t}</h3>
            <p style={{
              fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.5,
              color: 'var(--fg-2)', margin: 0,
            }}>{s.d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function MarketingProof() {
  const { t } = useTensol();
  // Render a "confirmed finding card" demo
  return (
    <section style={{ background: 'var(--ink)', color: 'var(--paper)', borderTop: '1px solid var(--ink)', borderBottom: '1px solid var(--ink)' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '96px 64px', display: 'grid', gridTemplateColumns: '320px 1fr', gap: 64, alignItems: 'flex-start' }}>
        <div>
          <Eyebrow color="rgba(250,249,246,.7)">{t.proofEyebrow}</Eyebrow>
          <h2 style={{
            fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500,
            fontSize: 38, lineHeight: 1.05, letterSpacing: '-0.02em',
            margin: '12px 0 16px', color: 'var(--paper)',
          }}>{t.proofTitle}</h2>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14.5, lineHeight: 1.55, color: 'rgba(250,249,246,.7)' }}>
            {t.proofBlurb}
          </p>
        </div>
        <div style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--paper)' }}>
          <div style={{ borderBottom: '1px solid var(--ink)', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Mono size={11} style={{ letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-2)' }}>finding · f_a3c1 · confirmed</Mono>
            <SeverityChip sev="critical" size="sm" />
          </div>
          <div style={{ padding: '20px' }}>
            <h3 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 22, lineHeight: 1.2, margin: '0 0 12px' }}>
              IDOR on /api/v3/accounts/{`{id}`}/statement
            </h3>
            <Mono size={12} color="var(--fg-2)" style={{ display: 'block', marginBottom: 16 }}>
              api.acme-bank.ru · GET /api/v3/accounts/{`{id}`}/statement
            </Mono>
            <div style={{ background: 'var(--ink)', color: 'var(--paper)', padding: '14px 16px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.7 }}>
              <div style={{ color: '#5BD27F' }}>[ok]   validator.authz.idor · seed=42</div>
              <div style={{ color: '#5BD27F' }}>[ok]   GET /api/v3/accounts/9001/statement · 200 ▲ different owner</div>
              <div style={{ color: '#5BD27F' }}>[ok]   evidence.diff ev_a3c1_diff.html · sha256:c7b…</div>
              <div style={{ color: '#C9C6BE' }}>[done] finding.confirmed → critical · verified</div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <StatusChip status="T1190" tone="muted" size="sm" />
              <StatusChip status="T1213" tone="muted" size="sm" />
              <StatusChip status="NIST CSF · PR.AC-4" tone="muted" size="sm" />
              <StatusChip status="D3-AZET" tone="muted" size="sm" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function MarketingMiniBlock({ id, eyebrow, title, blurb, accent }) {
  return (
    <section id={id} style={{
      maxWidth: 1280, margin: '0 auto',
      padding: '64px 64px',
      borderBottom: '1px solid var(--ink)',
      background: accent ? 'var(--ink)' : 'transparent',
      color: accent ? 'var(--paper)' : 'var(--ink)',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 48, alignItems: 'flex-start' }}>
        <Eyebrow color={accent ? 'rgba(250,249,246,.7)' : 'var(--fg-2)'}>{eyebrow}</Eyebrow>
        <div>
          <h2 style={{
            fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500,
            fontSize: 36, lineHeight: 1.05, letterSpacing: '-0.02em',
            margin: '0 0 16px', maxWidth: '24ch',
          }}>{title}</h2>
          <p style={{
            fontFamily: "'Inter', sans-serif", fontSize: 16, lineHeight: 1.55,
            color: accent ? 'rgba(250,249,246,.75)' : 'var(--fg-2)', maxWidth: '60ch',
          }}>{blurb}</p>
        </div>
      </div>
    </section>
  );
}

function MarketingBoundary() {
  const { t } = useTensol();
  return (
    <section style={{ maxWidth: 1280, margin: '0 auto', padding: '64px 64px', borderBottom: '1px solid var(--ink)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 48, alignItems: 'flex-start' }}>
        <div>
          <Eyebrow>{t.boundaryEyebrow}</Eyebrow>
          <h2 style={{
            fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500,
            fontSize: 36, lineHeight: 1.05, letterSpacing: '-0.02em',
            margin: '12px 0 0', maxWidth: '20ch',
          }}>{t.boundaryTitle}</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, border: '1px solid var(--ink)' }}>
          <div style={{ padding: '24px', borderRight: '1px solid var(--ink)' }}>
            <Mono size={11} style={{ letterSpacing: '0.08em', color: 'var(--ink)' }}>{`[ok] ${t.boundaryIs}`}</Mono>
            <ul style={{ listStyle: 'none', padding: 0, margin: '16px 0 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {t.boundaryIsList.map((x, i) => (
                <li key={i} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: 'var(--ink)', display: 'flex', gap: 8 }}>
                  <span style={{ color: 'var(--ink)' }}>■</span>{x}
                </li>
              ))}
            </ul>
          </div>
          <div style={{ padding: '24px', background: 'var(--ink)', color: 'var(--paper)' }}>
            <Mono size={11} style={{ letterSpacing: '0.08em', color: 'var(--red)' }}>{`[deny] ${t.boundaryIsNot}`}</Mono>
            <ul style={{ listStyle: 'none', padding: 0, margin: '16px 0 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {t.boundaryIsNotList.map((x, i) => (
                <li key={i} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, display: 'flex', gap: 8 }}>
                  <span style={{ color: 'var(--red)' }}>✕</span>{x}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function MarketingRoles() {
  const { t } = useTensol();
  return (
    <section style={{ maxWidth: 1280, margin: '0 auto', padding: '64px 64px', borderBottom: '1px solid var(--ink)' }}>
      <Eyebrow style={{ marginBottom: 16 }}>{t.rolesEyebrow}</Eyebrow>
      <h2 style={{
        fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500,
        fontSize: 36, lineHeight: 1.05, letterSpacing: '-0.02em',
        margin: '0 0 32px', maxWidth: '32ch',
      }}>{t.rolesTitle}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderTop: '1px solid var(--ink)' }}>
        {t.rolesList.map((r, i) => (
          <div key={i} style={{
            padding: '24px 20px',
            borderRight: i < 3 ? '1px solid var(--ink)' : 'none',
            borderBottom: '1px solid var(--ink)',
          }}>
            <Mono size={11} color="var(--fg-2)" style={{ letterSpacing: '0.08em' }}>0{i+1}</Mono>
            <h3 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500, fontSize: 22, lineHeight: 1.15, margin: '8px 0 10px' }}>{r.t}</h3>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13.5, lineHeight: 1.5, color: 'var(--fg-2)', margin: 0 }}>{r.d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function MarketingCta({ onDemo, onSignIn }) {
  const { t } = useTensol();
  return (
    <section id="book" style={{ background: 'var(--red)', color: 'var(--paper)', borderTop: '1px solid var(--ink)', borderBottom: '1px solid var(--ink)', position: 'relative', overflow: 'hidden' }}>
      <HalftoneBg color="var(--paper)" opacity={0.18} />
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '120px 64px', position: 'relative', display: 'grid', gridTemplateColumns: '1fr 280px', gap: 48, alignItems: 'center' }}>
        <div>
          <Eyebrow color="rgba(255,255,255,.7)">{t.ctaEyebrow}</Eyebrow>
          <h2 style={{
            fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500,
            fontSize: 56, lineHeight: 1.02, letterSpacing: '-0.03em',
            margin: '20px 0 20px', textWrap: 'balance', maxWidth: '20ch',
          }}>{t.ctaTitle}</h2>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 17, lineHeight: 1.5, color: 'rgba(255,255,255,.85)', margin: '0 0 32px', maxWidth: '52ch' }}>
            {t.ctaBody}
          </p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={onDemo} style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              padding: '14px 22px', border: '1px solid var(--paper)',
              background: 'var(--paper)', color: 'var(--red)',
              cursor: 'pointer',
            }}>{t.ctaPrimary} ▸</button>
            <button type="button" onClick={onSignIn} style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              padding: '14px 22px', border: '1px solid var(--paper)',
              background: 'transparent', color: 'var(--paper)',
              cursor: 'pointer',
            }}>{t.ctaSignin} →</button>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <HorseMark size={220} color="var(--paper)" />
        </div>
      </div>
    </section>
  );
}

function MarketingFooter() {
  const { t } = useTensol();
  return (
    <footer style={{ maxWidth: 1280, margin: '0 auto', padding: '64px 64px 32px', background: 'var(--paper)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr', gap: 32, paddingBottom: 48 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <LogoLockup size={20} color="var(--ink)" />
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, lineHeight: 1.5, color: 'var(--fg-2)', margin: 0, maxWidth: '28ch' }}>
            {t.footerBlurb}
          </p>
        </div>
        {t.footerCols.map((c, ci) => (
          <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Eyebrow>{c.h}</Eyebrow>
            {c.l.map((item, i) => (
              <a key={i} href="#" style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'var(--ink)', textDecoration: 'none' }}>{item}</a>
            ))}
          </div>
        ))}
      </div>
      <div style={{
        borderTop: '1px solid var(--ink)', paddingTop: 16,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--fg-2)',
        flexWrap: 'wrap', gap: 12,
      }}>
        <span>{t.footerCopy}</span>
        <span>{t.footerVersion}</span>
        <span>{t.footerTagline}</span>
      </div>
    </footer>
  );
}

function MarketingPage({ onSignIn, onDemo, monoRatio = 0.3, redUsage = 'reserved' }) {
  const { t } = useTensol();
  return (
    <div data-screen-label="01 Marketing — landing" style={{ background: 'var(--paper)', color: 'var(--ink)' }}>
      <MarketingNav onSignIn={onSignIn} onDemo={onDemo} />
      <MarketingHero onDemo={onDemo} monoRatio={monoRatio} />
      <MarketingPillars redUsage={redUsage} />
      <MarketingNotScanner />
      <MarketingPipeline />
      <MarketingProof />
      <MarketingMiniBlock id="sec-2" eyebrow={t.russiaEyebrow}  title={t.russiaTitle}  blurb={t.russiaBlurb} />
      <MarketingMiniBlock           eyebrow={t.supplyEyebrow}  title={t.supplyTitle}  blurb={t.supplyBlurb} accent />
      <MarketingBoundary />
      <MarketingRoles />
      <MarketingCta onDemo={onDemo} onSignIn={onSignIn} />
      <MarketingFooter />
    </div>
  );
}

window.MarketingPage = MarketingPage;
