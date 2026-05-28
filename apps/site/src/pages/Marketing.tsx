import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTensol } from '../context.tsx';
import { LangSwitcher } from '../components/LangSwitcher.tsx';
import { PixelWaveBg } from '../components/PixelWaveBg.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import {
  Btn,
  Eyebrow,
  HalftoneBg,
  HorseMark2,
  LogoLockup,
  Mono,
  SeverityChip,
  StatusChip,
} from '../components/primitives.tsx';

type MarketingPageProps = {
  onSignIn?: () => void;
  onDemo?: () => void;
  monoRatio?: number;
  redUsage?: 'reserved' | 'more';
};

/* ─────────────────────────────────────────────────────────────────────
   MarketingNav
   ───────────────────────────────────────────────────────────────────── */
function MarketingNav({ onSignIn, onDemo }: { onSignIn?: () => void; onDemo?: () => void }) {
  const { t } = useTensol();
  const [hov, setHov] = useState(-1);
  const [hovPricing, setHovPricing] = useState(false);
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
      <LogoLockup size={20} color="var(--ink)" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
        {t.navItems.map((l, i) => (
          <Link
            key={i}
            to={l.to}
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
          </Link>
        ))}
        <Link
          to="/pricing"
          onMouseEnter={() => setHovPricing(true)}
          onMouseLeave={() => setHovPricing(false)}
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            textDecoration: 'none',
            color: hovPricing ? 'var(--red)' : 'var(--ink)',
            transition: 'color 120ms',
          }}
        >
          {t.navPricing}
        </Link>
        <LangSwitcher />
        <Btn kind="secondary" size="sm" onClick={onSignIn}>
          {t.signin} →
        </Btn>
        <Btn kind="primary" size="sm" onClick={onDemo}>
          {t.requestDemo}
        </Btn>
      </div>
    </nav>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   MarketingHero
   ───────────────────────────────────────────────────────────────────── */
function MarketingHero({
  monoRatio,
}: {
  onDemo?: () => void;
  monoRatio: number;
}) {
  const { t } = useTensol();
  const navigate = useNavigate();
  return (
    <section
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '80px 64px 112px',
        position: 'relative',
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
      <div
        style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: '1fr 420px',
          gap: 48,
          alignItems: 'flex-start',
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 500,
              fontSize: 'clamp(40px, 5vw, 64px)',
              lineHeight: 1.02,
              letterSpacing: '-0.03em',
              margin: '0 0 24px',
              color: 'var(--ink)',
              textWrap: 'balance',
            }}
          >
            {t.heroL1}
            <br />
            {t.heroL2}
            <br />
            <span style={{ color: 'var(--red)' }}>{t.heroL3}</span>
          </h1>
          <p
            style={{
              fontFamily: monoRatio > 0.4 ? "'JetBrains Mono', monospace" : "'Inter', sans-serif",
              fontSize: monoRatio > 0.4 ? 16 : 19,
              lineHeight: 1.5,
              maxWidth: '54ch',
              margin: '0 0 36px',
              color: 'var(--fg-2)',
            }}
          >
            {t.heroBlurb}
          </p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn kind="primary" onClick={() => navigate('/scan/new')}>
              {t.ctaQuickFree} ▸
            </Btn>
            <Btn kind="ghost" href="/deep-inquiry">
              {t.ctaDeepAudit} →
            </Btn>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 12 }}>
          <HorseMark2 size={420} color="var(--ink)" />
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   MarketingManifesto — coverage delta + authorized-attacker pair,
   merged inside one shared frame as two stacked sections.
   ───────────────────────────────────────────────────────────────────── */
function MarketingManifesto() {
  const { t } = useTensol();
  return (
    <section id="sec-0" style={{ maxWidth: 1280, margin: '0 auto', padding: '0 64px 96px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
        }}
      >
        <ManifestoCol title={t.coverageTitle} blurb={t.coverageBlurb} divider />
        <ManifestoCol title={t.notScannerTitle} blurb={t.notScannerBlurb} />
      </div>
    </section>
  );
}

function ManifestoCol({
  title,
  blurb,
  divider,
}: {
  title: string;
  blurb: string;
  divider?: boolean;
}) {
  return (
    <div
      style={{
        padding: '56px 40px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        borderRight: divider ? '1px solid var(--ink)' : 'none',
      }}
    >
      <h2
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 500,
          fontSize: 30,
          letterSpacing: '-0.02em',
          lineHeight: 1.1,
          margin: 0,
          color: 'var(--ink)',
          textWrap: 'balance',
        }}
      >
        {title}
      </h2>
      <p
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 16,
          lineHeight: 1.55,
          color: 'var(--fg-2)',
          margin: 0,
        }}
      >
        {blurb}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   LiveTerminal — typewriter replay used inside the proof finding card
   ───────────────────────────────────────────────────────────────────── */
type TermLine = { text: string; color: string };

function LiveTerminal({ lines, lineHeight = 1.7 }: { lines: TermLine[]; lineHeight?: number }) {
  const [lineIdx, setLineIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [holding, setHolding] = useState(false);
  const [cursorOn, setCursorOn] = useState(true);
  const reduceMotion = useRef(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      reduceMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
  }, []);

  useEffect(() => {
    const blink = window.setInterval(() => setCursorOn((v) => !v), 530);
    return () => window.clearInterval(blink);
  }, []);

  useEffect(() => {
    if (reduceMotion.current) {
      setLineIdx(lines.length);
      setCharIdx(0);
      return;
    }
    if (holding) {
      const restart = window.setTimeout(() => {
        setHolding(false);
        setLineIdx(0);
        setCharIdx(0);
      }, 4800);
      return () => window.clearTimeout(restart);
    }
    if (lineIdx >= lines.length) {
      setHolding(true);
      return;
    }
    const current = lines[lineIdx].text;
    if (charIdx < current.length) {
      const t = window.setTimeout(() => setCharIdx((c) => c + 1), 14);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      setLineIdx((i) => i + 1);
      setCharIdx(0);
    }, 480);
    return () => window.clearTimeout(t);
  }, [lineIdx, charIdx, holding, lines]);

  const reservedHeight = `calc(${lines.length}em * ${lineHeight})`;

  return (
    <div
      style={{
        background: 'var(--ink)',
        color: 'var(--paper)',
        padding: '14px 16px',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11.5,
        lineHeight,
        minHeight: reservedHeight,
      }}
      aria-label="Live validator log replay"
    >
      {lines.map((ln, i) => {
        const showCursorHere = !holding && i === lineIdx;
        let visible = '';
        if (i < lineIdx) visible = ln.text;
        else if (i === lineIdx) visible = ln.text.slice(0, charIdx);
        else if (holding) visible = ln.text;
        else visible = '';
        return (
          <div key={i} style={{ color: ln.color, whiteSpace: 'pre' }}>
            {visible}
            {(showCursorHere || (holding && i === lines.length - 1)) && (
              <span style={{ opacity: cursorOn ? 1 : 0, marginLeft: 2 }}>▍</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   MarketingProof — confirmed finding card on dark
   ───────────────────────────────────────────────────────────────────── */
function MarketingProof() {
  const { t } = useTensol();
  return (
    <section
      style={{
        background: 'transparent',
        color: 'var(--ink)',
        borderTop: '1px solid var(--ink)',
        borderBottom: '1px solid var(--ink)',
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto',
          padding: '96px 64px',
          display: 'grid',
          gridTemplateColumns: '320px 1fr',
          gap: 64,
          alignItems: 'flex-start',
        }}
      >
        <div>
          <h2
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 500,
              fontSize: 38,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              margin: '0 0 16px',
              color: 'var(--ink)',
            }}
          >
            {t.proofTitle}
          </h2>
          <p
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 14.5,
              lineHeight: 1.55,
              color: 'var(--fg-2)',
            }}
          >
            {t.proofBlurb}
          </p>
        </div>
        <div style={{ background: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--ink)' }}>
          <div
            style={{
              borderBottom: '1px solid var(--ink)',
              padding: '14px 20px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Mono
              size={11}
              style={{ letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-2)' }}
            >
              finding · f_a3c1 · confirmed
            </Mono>
            <SeverityChip sev="critical" size="sm" />
          </div>
          <div style={{ padding: '20px' }}>
            <h3
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 500,
                fontSize: 22,
                lineHeight: 1.2,
                margin: '0 0 12px',
              }}
            >
              IDOR on /api/v3/accounts/{'{id}'}/statement
            </h3>
            <Mono size={12} color="var(--fg-2)" style={{ display: 'block', marginBottom: 16 }}>
              api.acme-bank.ru · GET /api/v3/accounts/{'{id}'}/statement
            </Mono>
            <LiveTerminal
              lines={[
                { text: '[ok]   validator.authz.idor · seed=42', color: '#5BD27F' },
                {
                  text: '[ok]   GET /api/v3/accounts/9001/statement · 200 ▲ different owner',
                  color: '#5BD27F',
                },
                { text: '[ok]   evidence.diff ev_a3c1_diff.html · sha256:c7b…', color: '#5BD27F' },
                { text: '[done] finding.confirmed → critical · verified', color: '#C9C6BE' },
              ]}
            />
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

/* ─────────────────────────────────────────────────────────────────────
   MarketingMiniBlock — Russia, Supply
   ───────────────────────────────────────────────────────────────────── */
function MarketingMiniBlock({
  id,
  eyebrow,
  title,
  blurb,
  accent,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  blurb: string;
  accent?: boolean;
}) {
  return (
    <section
      id={id}
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '64px 64px',
        borderBottom: '1px solid var(--ink)',
        background: accent ? 'var(--ink)' : 'transparent',
        color: accent ? 'var(--paper)' : 'var(--ink)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: eyebrow ? '320px 1fr' : '1fr',
          gap: 48,
          alignItems: 'flex-start',
        }}
      >
        {eyebrow && (
          <Eyebrow color={accent ? 'rgba(250,249,246,.7)' : 'var(--fg-2)'}>{eyebrow}</Eyebrow>
        )}
        <div>
          <h2
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 500,
              fontSize: 36,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              margin: '0 0 16px',
              maxWidth: '24ch',
            }}
          >
            {title}
          </h2>
          <p
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 16,
              lineHeight: 1.55,
              color: accent ? 'rgba(250,249,246,.75)' : 'var(--fg-2)',
              maxWidth: '60ch',
            }}
          >
            {blurb}
          </p>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   MarketingCta — red full-bleed
   ───────────────────────────────────────────────────────────────────── */
function MarketingCta(_props: { onDemo?: () => void; onSignIn?: () => void }) {
  const { t } = useTensol();
  const navigate = useNavigate();
  return (
    <section
      id="book"
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
          padding: '120px 64px',
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: '1fr 280px',
          gap: 48,
          alignItems: 'center',
        }}
      >
        <div>
          <h2
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 500,
              fontSize: 56,
              lineHeight: 1.02,
              letterSpacing: '-0.03em',
              margin: '0 0 20px',
              textWrap: 'balance',
              maxWidth: '20ch',
            }}
          >
            {t.ctaTitle}
          </h2>
          <p
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 17,
              lineHeight: 1.5,
              color: 'rgba(255,255,255,.85)',
              margin: '0 0 32px',
              maxWidth: '52ch',
            }}
          >
            {t.ctaBody}
          </p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => navigate('/scan/new')}
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
              {t.ctaQuickFree} ▸
            </button>
            <button
              type="button"
              onClick={() => navigate('/deep-inquiry')}
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                padding: '14px 22px',
                border: '1px solid var(--paper)',
                background: 'transparent',
                color: 'var(--paper)',
                cursor: 'pointer',
              }}
            >
              {t.ctaDeepAudit} →
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
          <img
            src="/assets/horse-run-white.gif"
            alt=""
            aria-hidden="true"
            style={{
              width: 440,
              height: 'auto',
              imageRendering: 'pixelated',
            }}
          />
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   MarketingFooter
   ───────────────────────────────────────────────────────────────────── */
function MarketingFooter() {
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
                <a
                  href="https://t.me/kapital0"
                  target="_blank"
                  rel="noopener noreferrer"
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
                </a>
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
      </div>
    </footer>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   MarketingPage — full landing
   ───────────────────────────────────────────────────────────────────── */
export function MarketingPage({
  onSignIn,
  onDemo,
  monoRatio = 0.3,
}: MarketingPageProps) {
  const { t } = useTensol();
  return (
    <>
      <RouteHead
        title="Tensol — AI-Powered Penetration Testing"
        description="AI will hack you in a few hours. Tensol runs the same agent on your side — under signed scope, in your audit log."
        ogTitle="Tensol — AI-Powered Penetration Testing"
        ogDescription="AI will hack you in a few hours. Tensol runs the same agent on your side — under signed scope, in your audit log."
        ogImage="/assets/tensol-horse-red.svg"
      />
    <div
      data-screen-label="01 Marketing — landing"
      style={{
        background: 'var(--paper)',
        color: 'var(--ink)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <PixelWaveBg />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <MarketingNav onSignIn={onSignIn} onDemo={onDemo} />
        <MarketingHero monoRatio={monoRatio} />
        <MarketingManifesto />
        <MarketingProof />
        <MarketingMiniBlock title={t.supplyTitle} blurb={t.supplyBlurb} />
        <MarketingCta onDemo={onDemo} onSignIn={onSignIn} />
        <MarketingFooter />
      </div>
    </div>
    </>
  );
}
