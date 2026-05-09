// Tensol legal pages — privacy, terms, dpa.
// Single component handles all 3 kinds via :kind from useParams.
// Inlines the marketing nav + footer for layout continuity.
import { Fragment, useEffect, useState } from 'react';
import { RouteHead } from '../components/RouteHead.tsx';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTensol } from '../context.tsx';
import { LangSwitcher } from '../components/LangSwitcher.tsx';
import { PixelWaveBg } from '../components/PixelWaveBg.tsx';
import { Btn, Eyebrow, LogoLockup } from '../components/primitives.tsx';

type LegalKind = 'privacy' | 'terms' | 'dpa';
const VALID_KINDS: ReadonlyArray<LegalKind> = ['privacy', 'terms', 'dpa'];

function isValidKind(x: string | undefined): x is LegalKind {
  return !!x && (VALID_KINDS as ReadonlyArray<string>).includes(x);
}

/* ─────────────────────────────────────────────────────────────────────
   LegalNav — copy of MarketingNav but with router-aware links
   ───────────────────────────────────────────────────────────────────── */
function LegalNav() {
  const { t } = useTensol();
  const navigate = useNavigate();
  const [hov, setHov] = useState(-1);
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
        {t.nav.map((l, i) => (
          <Link
            key={i}
            to={`/#sec-${i}`}
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
            {l}
          </Link>
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
   LegalFooter — copy of MarketingFooter with router-aware links
   ───────────────────────────────────────────────────────────────────── */
function LegalFooter() {
  const { t } = useTensol();
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
        {t.footerCols.map((c, ci) => {
          const isContact = ci === t.footerCols.length - 1;
          return (
            <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Eyebrow>{c.h}</Eyebrow>
              {isContact && (
                <Link
                  to="/contact"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    padding: '7px 12px',
                    border: '1px solid var(--ink)',
                    background: 'var(--ink)',
                    color: 'var(--paper)',
                    textDecoration: 'none',
                    alignSelf: 'flex-start',
                    marginBottom: 2,
                  }}
                >
                  {t.footerLinks.contactCta}
                </Link>
              )}
              {c.l.map((item, i) =>
                item.external ? (
                  <a
                    key={i}
                    href={item.href}
                    style={{
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 13,
                      color: 'var(--ink)',
                      textDecoration: 'none',
                    }}
                  >
                    {item.label}
                  </a>
                ) : (
                  <Link
                    key={i}
                    to={item.href}
                    style={{
                      fontFamily: "'Inter', sans-serif",
                      fontSize: 13,
                      color: 'var(--ink)',
                      textDecoration: 'none',
                    }}
                  >
                    {item.label}
                  </Link>
                ),
              )}
            </div>
          );
        })}
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
   LegalBody — renders sections, eyebrow, h1, sections, tail
   ───────────────────────────────────────────────────────────────────── */
function LegalBody({ kind }: { kind: LegalKind }) {
  const { t } = useTensol();
  const doc = t.legal[kind];

  // Smooth-scroll to fragment if present (e.g. #acceptable-use)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace('#', '');
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, [kind]);

  return (
    <main
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: '80px 64px 120px',
        position: 'relative',
        zIndex: 1,
        background: 'var(--paper)',
      }}
    >
      <Eyebrow>{doc.eyebrow}</Eyebrow>
      <h1
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 500,
          fontSize: 'clamp(40px, 6vw, 56px)',
          lineHeight: 1.02,
          letterSpacing: '-0.03em',
          margin: '24px 0 18px',
          color: 'var(--ink)',
          textWrap: 'balance',
        }}
      >
        {doc.title}
      </h1>
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          letterSpacing: '0.04em',
          color: 'var(--fg-2)',
          marginBottom: 32,
        }}
      >
        {doc.updated}
      </div>
      <hr
        style={{
          border: 0,
          borderTop: '1px solid var(--ink)',
          margin: '0 0 40px',
        }}
      />
      <p
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 17,
          lineHeight: 1.6,
          color: 'var(--fg)',
          margin: '0 0 48px',
        }}
      >
        {doc.intro}
      </p>

      {doc.sections.map((s, i) => (
        <section
          key={i}
          id={s.anchor || undefined}
          style={{
            scrollMarginTop: 100,
            marginBottom: 48,
          }}
        >
          <Eyebrow style={{ marginBottom: 10 }}>{s.eyebrow}</Eyebrow>
          <h2
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 500,
              fontSize: 28,
              lineHeight: 1.15,
              letterSpacing: '-0.02em',
              margin: '0 0 18px',
              color: 'var(--ink)',
            }}
          >
            {s.h}
          </h2>
          {s.p.map((para, pi) => (
            <p
              key={pi}
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: 16,
                lineHeight: 1.6,
                color: 'var(--fg)',
                margin: '0 0 14px',
              }}
            >
              {para}
            </p>
          ))}
        </section>
      ))}

      <hr
        style={{
          border: 0,
          borderTop: '1px solid var(--ink)',
          margin: '40px 0 24px',
        }}
      />

      <p
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12.5,
          lineHeight: 1.6,
          color: 'var(--fg-2)',
          margin: '0 0 20px',
        }}
      >
        {doc.tail}
      </p>

      <p
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 14,
          lineHeight: 1.5,
          color: 'var(--fg-2)',
          margin: 0,
        }}
      >
        {t.footerLinks.contactQuestion}{' '}
        <a
          href="mailto:nikto256@gmail.com"
          style={{ color: 'var(--red)', textDecoration: 'underline', textUnderlineOffset: 3 }}
        >
          nikto256@gmail.com
        </a>
      </p>
    </main>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Legal — top-level page
   ───────────────────────────────────────────────────────────────────── */
const LEGAL_TITLES: Record<string, string> = {
  privacy: 'Privacy Policy — Tensol',
  terms: 'Terms of Service — Tensol',
  dpa: 'Data Processing Agreement — Tensol',
};

export default function Legal() {
  const { kind } = useParams<{ kind: string }>();
  if (!isValidKind(kind)) {
    return <Navigate to="/err/404" replace />;
  }
  return (
    <Fragment>
      <RouteHead
        title={LEGAL_TITLES[kind] ?? 'Legal — Tensol'}
        ogTitle={LEGAL_TITLES[kind] ?? 'Legal — Tensol'}
        ogImage="/assets/tensol-horse-red.svg"
      />
      <div
        data-screen-label={`legal-${kind}`}
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
          <LegalNav />
          <LegalBody kind={kind} />
          <LegalFooter />
        </div>
      </div>
    </Fragment>
  );
}
