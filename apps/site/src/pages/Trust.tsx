import { useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTensol } from '../context.tsx';
import { LangSwitcher } from '../components/LangSwitcher.tsx';
import { PixelWaveBg } from '../components/PixelWaveBg.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import {
  Btn,
  Eyebrow,
  HalftoneBg,
  HorseMark,
  LogoLockup,
  Mono,
  StatusChip,
} from '../components/primitives.tsx';

/* ─────────────────────────────────────────────────────────────────────
   Local nav — mirrors MarketingNav but routes to /, /pricing, /trust
   ───────────────────────────────────────────────────────────────────── */
function TrustNav() {
  const navigate = useNavigate();
  const { t } = useTensol();
  const [hov, setHov] = useState(-1);
  const links: Array<{ label: string; to: string }> = [
    ...t.navItems,
    { label: t.trustPage.navLabel.toUpperCase(), to: '/trust' },
    { label: 'PRICING', to: '/pricing' },
  ];
  return (
    <nav
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '32px 64px 0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'relative',
        zIndex: 2,
      }}
    >
      <LogoLockup size={20} color="var(--ink)" onClick={() => navigate('/')} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
        {links.map((l, i) => (
          <a
            key={i}
            href={l.to}
            onClick={(e) => {
              e.preventDefault();
              navigate(l.to);
            }}
            onMouseEnter={() => setHov(i)}
            onMouseLeave={() => setHov(-1)}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              textDecoration: 'none',
              color: hov === i ? 'var(--red)' : 'var(--ink)',
              transition: 'color 120ms',
            }}
          >
            {l.label}
          </a>
        ))}
        <LangSwitcher />
        <Btn kind="secondary" size="sm" onClick={() => navigate('/login')}>
          {t.signin} →
        </Btn>
        <Btn kind="primary" size="sm" onClick={() => navigate('/contact')}>
          {t.requestDemo}
        </Btn>
      </div>
    </nav>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Hero — mini, ~50vh, paper bg with halftone
   ───────────────────────────────────────────────────────────────────── */
function TrustHero() {
  const { t } = useTensol();
  return (
    <section
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '80px 64px 96px',
        position: 'relative',
        minHeight: '46vh',
      }}
    >
      <HalftoneBg
        size={12}
        opacity={0.16}
        style={{
          inset: '64px 64px 0 64px',
          maskImage: 'linear-gradient(to bottom, black 0%, transparent 80%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 80%)',
        }}
      />
      <div style={{ position: 'relative', maxWidth: '64ch' }}>
        <Eyebrow>{t.trustPage.eyebrow}</Eyebrow>
        <h1
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 500,
            fontSize: 'clamp(48px, 7.2vw, 72px)',
            lineHeight: 1.02,
            letterSpacing: '-0.03em',
            margin: '20px 0 24px',
            textWrap: 'balance',
          }}
        >
          {t.trustPage.title}
        </h1>
        <p
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 18,
            lineHeight: 1.55,
            color: 'var(--fg-2)',
            margin: 0,
            maxWidth: '60ch',
          }}
        >
          {t.trustPage.sub}
        </p>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Compliance grid — 6 cells, 2-col
   ───────────────────────────────────────────────────────────────────── */
function TrustCompliance() {
  const { t } = useTensol();
  const cells = t.trustPage.compliance;
  return (
    <section
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '64px 64px',
        borderTop: '1px solid var(--ink)',
      }}
    >
      <Eyebrow style={{ marginBottom: 12 }}>{t.trustPage.complianceEyebrow}</Eyebrow>
      <h2
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 500,
          fontSize: 36,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          margin: '0 0 36px',
          maxWidth: '34ch',
        }}
      >
        {t.trustPage.complianceTitle}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 0,
          maxWidth: 1100,
          border: '1px solid var(--ink)',
        }}
      >
        {cells.map((c, i) => {
          const col = i % 2;
          const lastRow = i >= cells.length - 2;
          return (
            <div
              key={i}
              style={{
                padding: '28px 28px',
                borderRight: col === 0 ? '1px solid var(--ink)' : 'none',
                borderBottom: !lastRow ? '1px solid var(--ink)' : 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                background: 'var(--bg)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <h3
                  style={{
                    fontFamily: "'Space Grotesk', sans-serif",
                    fontWeight: 500,
                    fontSize: 22,
                    lineHeight: 1.15,
                    margin: 0,
                  }}
                >
                  {c.name}
                </h3>
                <StatusChip
                  status={c.statusLabel}
                  tone={c.statusTone as 'ok' | 'warn' | 'neutral'}
                  size="sm"
                />
              </div>
              <p
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: 'var(--fg-2)',
                  margin: 0,
                }}
              >
                {c.body}
              </p>
              {c.caption && (
                <Mono size={11} color="var(--fg-3)" style={{ letterSpacing: '0.04em', marginTop: 'auto' }}>
                  {c.caption}
                </Mono>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Authorization — 3-col
   ───────────────────────────────────────────────────────────────────── */
function TrustAuthorization() {
  const { t } = useTensol();
  return (
    <section
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '64px 64px',
        borderTop: '1px solid var(--ink)',
      }}
    >
      <Eyebrow style={{ marginBottom: 12 }}>{t.trustPage.authzEyebrow}</Eyebrow>
      <h2
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 500,
          fontSize: 36,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          margin: '0 0 36px',
          maxWidth: '34ch',
        }}
      >
        {t.trustPage.authzTitle}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          borderTop: '1px solid var(--ink)',
        }}
      >
        {t.trustPage.authz.map((a, i) => (
          <div
            key={i}
            style={{
              padding: '28px 24px',
              borderRight: i < 2 ? '1px solid var(--ink)' : 'none',
              borderBottom: '1px solid var(--ink)',
            }}
          >
            <Mono size={11} color="var(--fg-2)" style={{ letterSpacing: '0.08em' }}>
              0{i + 1}
            </Mono>
            <h3
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 500,
                fontSize: 22,
                lineHeight: 1.15,
                margin: '8px 0 12px',
              }}
            >
              {a.t}
            </h3>
            <p
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: 14,
                lineHeight: 1.55,
                color: 'var(--fg-2)',
                margin: 0,
              }}
            >
              {a.d}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Data — 6 cells in 2-col grid
   ───────────────────────────────────────────────────────────────────── */
function TrustData() {
  const { t } = useTensol();
  const items = t.trustPage.data;
  return (
    <section
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '64px 64px',
        borderTop: '1px solid var(--ink)',
      }}
    >
      <Eyebrow style={{ marginBottom: 12 }}>{t.trustPage.dataEyebrow}</Eyebrow>
      <h2
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 500,
          fontSize: 36,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          margin: '0 0 36px',
          maxWidth: '34ch',
        }}
      >
        {t.trustPage.dataTitle}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          border: '1px solid var(--ink)',
          maxWidth: 1100,
        }}
      >
        {items.map((d, i) => {
          const col = i % 2;
          const lastRow = i >= items.length - 2;
          return (
            <div
              key={i}
              style={{
                padding: '24px 28px',
                borderRight: col === 0 ? '1px solid var(--ink)' : 'none',
                borderBottom: !lastRow ? '1px solid var(--ink)' : 'none',
                background: 'var(--bg)',
              }}
            >
              <Mono size={11} color="var(--fg-2)" style={{ letterSpacing: '0.08em' }}>
                {String(i + 1).padStart(2, '0')}
              </Mono>
              <h3
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 500,
                  fontSize: 19,
                  lineHeight: 1.2,
                  margin: '8px 0 10px',
                }}
              >
                {d.t}
              </h3>
              <p
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 13.5,
                  lineHeight: 1.5,
                  color: 'var(--fg-2)',
                  margin: 0,
                }}
              >
                {d.d}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Boundary — paper / ink two-column
   ───────────────────────────────────────────────────────────────────── */
function TrustBoundary() {
  const { t } = useTensol();
  return (
    <section
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '64px 64px',
        borderTop: '1px solid var(--ink)',
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 48, alignItems: 'flex-start' }}>
        <div>
          <Eyebrow>{t.trustPage.boundaryEyebrow}</Eyebrow>
          <h2
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 500,
              fontSize: 32,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              margin: '12px 0 0',
              maxWidth: '20ch',
            }}
          >
            {t.trustPage.boundaryTitle}
          </h2>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 0,
            border: '1px solid var(--ink)',
          }}
        >
          <div style={{ padding: '24px', borderRight: '1px solid var(--ink)' }}>
            <Mono size={11} style={{ letterSpacing: '0.08em', color: 'var(--ink)' }}>
              {`[ok] ${t.trustPage.boundaryIs}`}
            </Mono>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: '16px 0 0',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {t.trustPage.boundaryIsList.map((x, i) => (
                <li
                  key={i}
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                    color: 'var(--ink)',
                    display: 'flex',
                    gap: 8,
                  }}
                >
                  <span style={{ color: 'var(--ink)' }}>■</span>
                  {x}
                </li>
              ))}
            </ul>
          </div>
          <div style={{ padding: '24px', background: 'var(--ink)', color: 'var(--paper)' }}>
            <Mono size={11} style={{ letterSpacing: '0.08em', color: 'var(--red)' }}>
              {`[deny] ${t.trustPage.boundaryIsNot}`}
            </Mono>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: '16px 0 0',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {t.trustPage.boundaryIsNotList.map((x, i) => (
                <li
                  key={i}
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                    display: 'flex',
                    gap: 8,
                  }}
                >
                  <span style={{ color: 'var(--red)' }}>✕</span>
                  {x}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Documents row — 3 request buttons
   ───────────────────────────────────────────────────────────────────── */
function TrustDocuments() {
  const navigate = useNavigate();
  const { t } = useTensol();
  return (
    <section
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '64px 64px',
        borderTop: '1px solid var(--ink)',
      }}
    >
      <Eyebrow style={{ marginBottom: 12 }}>{t.trustPage.docsEyebrow}</Eyebrow>
      <h2
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 500,
          fontSize: 32,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          margin: '0 0 14px',
          maxWidth: '32ch',
        }}
      >
        {t.trustPage.docsTitle}
      </h2>
      <p
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 15,
          lineHeight: 1.55,
          color: 'var(--fg-2)',
          margin: '0 0 32px',
          maxWidth: '60ch',
        }}
      >
        {t.trustPage.docsBody}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {t.trustPage.docsButtons.map((b, i) => (
          <Btn
            key={i}
            kind={i === 0 ? 'primary' : 'secondary'}
            onClick={() => navigate(`/contact?topic=${encodeURIComponent(b.topic)}`)}
          >
            {b.label} →
          </Btn>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   CTA strip — red, with horse mark
   ───────────────────────────────────────────────────────────────────── */
function TrustCta() {
  const navigate = useNavigate();
  const { t } = useTensol();
  return (
    <section
      style={{
        background: 'var(--red)',
        color: 'var(--paper)',
        borderTop: '1px solid var(--ink)',
        borderBottom: '1px solid var(--ink)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <HalftoneBg color="var(--paper)" opacity={0.18} />
      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto',
          padding: '96px 64px',
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: '1fr 240px',
          gap: 48,
          alignItems: 'center',
        }}
      >
        <div>
          <Eyebrow color="rgba(255,255,255,.7)">{t.trustPage.ctaEyebrow}</Eyebrow>
          <h2
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 500,
              fontSize: 48,
              lineHeight: 1.04,
              letterSpacing: '-0.03em',
              margin: '20px 0 18px',
              textWrap: 'balance',
              maxWidth: '20ch',
            }}
          >
            {t.trustPage.ctaTitle}
          </h2>
          <p
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 17,
              lineHeight: 1.5,
              color: 'rgba(255,255,255,.85)',
              margin: '0 0 28px',
              maxWidth: '52ch',
            }}
          >
            {t.trustPage.ctaBody}
          </p>
          <button
            type="button"
            onClick={() => navigate('/contact')}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              padding: '14px 22px',
              border: '1px solid var(--paper)',
              background: 'var(--paper)',
              color: 'var(--red)',
              cursor: 'pointer',
            }}
          >
            {t.trustPage.ctaBtn}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <HorseMark size={240} color="var(--paper)" />
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Footer — mirrors MarketingFooter
   ───────────────────────────────────────────────────────────────────── */
function TrustFooter() {
  const { t } = useTensol();
  const colStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
  return (
    <footer style={{ maxWidth: 1280, margin: '0 auto', padding: '64px 64px 32px', background: 'var(--paper)' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr',
          gap: 32,
          paddingBottom: 48,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <LogoLockup size={20} color="var(--ink)" />
          <p
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--fg-2)',
              margin: 0,
              maxWidth: '28ch',
            }}
          >
            {t.footerBlurb}
          </p>
        </div>
        {t.footerCols.map((c, ci) => (
          <div key={ci} style={colStyle}>
            <Eyebrow>{c.h}</Eyebrow>
            {c.l.map((item, i) => {
              const it = item as
                | string
                | { label: string; href: string; external?: boolean };
              const isObj = typeof it === 'object';
              const label = isObj ? it.label : it;
              const href = isObj ? it.href : '#';
              const ext = isObj && it.external;
              return (
                <a
                  key={i}
                  href={href}
                  target={ext ? '_blank' : undefined}
                  rel={ext ? 'noopener noreferrer' : undefined}
                  style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'var(--ink)', textDecoration: 'none' }}
                >
                  {label}
                </a>
              );
            })}
          </div>
        ))}
      </div>
      <div
        style={{
          borderTop: '1px solid var(--ink)',
          paddingTop: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: 'var(--fg-2)',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <span>{t.footerCopy}</span>
        <span>{t.footerVersion}</span>
        <span>{t.footerTagline}</span>
      </div>
    </footer>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Trust — page entry point
   ───────────────────────────────────────────────────────────────────── */
export default function Trust(): ReactNode {
  return (
    <>
      <RouteHead
        title="Trust & Compliance — Tensol"
        description="SOC 2-aligned controls, GDPR-ready data handling, and a full authorization chain for every engagement."
        ogTitle="Trust & Compliance — Tensol"
        ogDescription="SOC 2-aligned controls, GDPR-ready data handling, and a full authorization chain for every engagement."
        ogImage="/assets/tensol-horse-red.svg"
      />
    <div
      data-screen-label="Trust — compliance"
      style={{
        background: 'var(--paper)',
        color: 'var(--ink)',
        position: 'relative',
        overflow: 'hidden',
        minHeight: '100vh',
      }}
    >
      <PixelWaveBg />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <TrustNav />
        <TrustHero />
        <TrustCompliance />
        <TrustAuthorization />
        <TrustData />
        <TrustBoundary />
        <TrustDocuments />
        <TrustCta />
        <TrustFooter />
      </div>
    </div>
    </>
  );
}
