import { useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTensol } from '../context.tsx';
import { LangSwitcher } from '../components/LangSwitcher.tsx';
import { PixelWaveBg } from '../components/PixelWaveBg.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import {
  Btn,
  Card,
  Eyebrow,
  HalftoneBg,
  LogoLockup,
} from '../components/primitives.tsx';

/* ─────────────────────────────────────────────────────────────────────
   PricingNav — public marketing nav (mirrors Marketing.tsx MarketingNav)
   ───────────────────────────────────────────────────────────────────── */
function PricingNav() {
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
   PricingHero — mini-hero, 60vh
   ───────────────────────────────────────────────────────────────────── */
function PricingHero() {
  const { t } = useTensol();
  return (
    <section
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '88px 64px 96px',
        position: 'relative',
        minHeight: '60vh',
      }}
    >
      <HalftoneBg
        size={12}
        opacity={0.14}
        style={{
          inset: '40px 64px 0 64px',
          maskImage: 'linear-gradient(to bottom, black 0%, transparent 80%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 80%)',
        }}
      />
      <div style={{ position: 'relative', maxWidth: 880 }}>
        <h1
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 500,
            fontSize: 'clamp(48px, 7.2vw, 80px)',
            lineHeight: 0.98,
            letterSpacing: '-0.03em',
            margin: '0 0 24px',
            color: 'var(--ink)',
            textWrap: 'balance',
          }}
        >
          {t.pricing.title}
        </h1>
        <p
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 19,
            lineHeight: 1.5,
            maxWidth: '60ch',
            margin: 0,
            color: 'var(--fg-2)',
          }}
        >
          {t.pricing.sub}
        </p>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   PricingPlans — 3 columns, middle highlighted
   ───────────────────────────────────────────────────────────────────── */
function PricingPlans() {
  const { t } = useTensol();
  const navigate = useNavigate();

  return (
    <section
      id="plans"
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '0 64px 112px',
        position: 'relative',
      }}
    >
      <p
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 17,
          lineHeight: 1.55,
          color: 'var(--fg-2)',
          maxWidth: '62ch',
          margin: '0 0 40px',
        }}
      >
        {t.pricing.mythosPositioning}
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 32,
        }}
      >
        {t.pricing.plans.map((plan) => (
          <Card
            key={plan.name}
            style={{
              position: 'relative',
              padding: '40px 36px 36px',
              display: 'flex',
              flexDirection: 'column',
              gap: 28,
              minHeight: 560,
            }}
          >
            <div>
              <h3
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 500,
                  fontSize: 44,
                  letterSpacing: '-0.01em',
                  lineHeight: 1,
                  margin: 0,
                  color: 'var(--ink)',
                }}
              >
                {plan.name}
              </h3>
              <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 18 }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 600,
                    fontSize: 28,
                    letterSpacing: '-0.01em',
                    color: 'var(--ink)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {plan.price}
                </span>
                <span
                  style={{
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 15,
                    color: 'var(--fg-2)',
                  }}
                >
                  {plan.unit}
                </span>
              </div>
              {plan.priceAlt ? (
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 14,
                    color: 'var(--fg-2)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {plan.priceAlt}
                </span>
              ) : null}
            </div>

            <p
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 16,
                fontWeight: 500,
                lineHeight: 1.35,
                color: 'var(--ink)',
                margin: 0,
                maxWidth: '32ch',
              }}
            >
              {plan.claim}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--ink)',
                }}
              >
                {t.pricing.bestForLabel}
              </span>
              <p
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 15,
                  lineHeight: 1.5,
                  color: 'var(--fg-2)',
                  margin: 0,
                }}
              >
                {plan.bestFor}
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--ink)',
                }}
              >
                {t.pricing.depthLabel}
              </span>
              <p
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 15,
                  lineHeight: 1.5,
                  color: 'var(--fg-2)',
                  margin: 0,
                }}
              >
                {plan.depth}
              </p>
            </div>

            <div style={{ marginTop: 'auto', paddingTop: 8 }}>
              <Btn
                kind="secondary"
                size="md"
                fullWidth
                onClick={() => navigate(plan.ctaHref ?? '/contact')}
              >
                {plan.ctaLabel ?? t.pricing.contactCta}
              </Btn>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   PricingFaq — 2-col Q/A grid
   ───────────────────────────────────────────────────────────────────── */
function PricingFaq() {
  const { t } = useTensol();
  return (
    <section
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '100px 64px 96px',
        borderTop: '1px solid var(--ink)',
      }}
    >
      <h2
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 500,
          fontSize: 38,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          margin: '0 0 48px',
          maxWidth: '24ch',
          color: 'var(--ink)',
        }}
      >
        {t.pricing.faqTitle}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          columnGap: 48,
          rowGap: 0,
        }}
      >
        {t.pricing.faq.map((qa, i) => (
          <div
            key={i}
            style={{
              padding: '20px 0 22px',
              borderBottom: '1px solid var(--line-soft)',
            }}
          >
            <h3
              style={{
                fontFamily: "'Inter', sans-serif",
                fontWeight: 600,
                fontSize: 17,
                lineHeight: 1.35,
                margin: '0 0 10px',
                color: 'var(--ink)',
              }}
            >
              {qa.q}
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
              {qa.a}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   PricingCta — small red full-bleed strip
   ───────────────────────────────────────────────────────────────────── */
function PricingCta() {
  const { t } = useTensol();
  const navigate = useNavigate();
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
      <HalftoneBg color="var(--paper)" opacity={0.16} />
      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto',
          padding: '72px 64px',
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: 48,
          alignItems: 'center',
        }}
      >
        <div>
          <h2
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 500,
              fontSize: 44,
              lineHeight: 1.04,
              letterSpacing: '-0.03em',
              margin: '0 0 14px',
              textWrap: 'balance',
              maxWidth: '22ch',
              color: 'var(--paper)',
            }}
          >
            {t.pricing.ctaTitle}
          </h2>
          <p
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 16,
              lineHeight: 1.5,
              color: 'rgba(255,255,255,.85)',
              margin: 0,
              maxWidth: '52ch',
            }}
          >
            {t.pricing.ctaBody}
          </p>
        </div>
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
            whiteSpace: 'nowrap',
          }}
        >
          {t.pricing.ctaBtn}
        </button>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   PricingFooter — mirrors MarketingFooter from Marketing.tsx
   ───────────────────────────────────────────────────────────────────── */
function PricingFooter() {
  const { t } = useTensol();
  return (
    <footer
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '64px 64px 32px',
        background: 'var(--paper)',
      }}
    >
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
          <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Eyebrow>{c.h}</Eyebrow>
            {c.l.map((item, i) => {
              const linkStyle: CSSProperties = {
                fontFamily: "'Inter', sans-serif",
                fontSize: 13,
                color: 'var(--ink)',
                textDecoration: 'none',
              };
              if (item.external) {
                return (
                  <a
                    key={i}
                    href={item.href}
                    target={item.href.startsWith('http') ? '_blank' : undefined}
                    rel={item.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                    style={linkStyle}
                  >
                    {item.label}
                  </a>
                );
              }
              return (
                <Link key={i} to={item.href} style={linkStyle}>
                  {item.label}
                </Link>
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
   Pricing — full /pricing page
   ───────────────────────────────────────────────────────────────────── */
const pageStyle: CSSProperties = {
  background: 'var(--paper)',
  color: 'var(--ink)',
  position: 'relative',
  overflow: 'hidden',
  minHeight: '100vh',
};

export default function Pricing() {
  return (
    <>
      <RouteHead
        title="Pricing — Tensol"
        description="No hourly billing. AI-powered penetration testing at a fixed engagement scope."
        ogTitle="Pricing — Tensol"
        ogDescription="No hourly billing. AI-powered penetration testing at a fixed engagement scope."
        ogImage="/assets/tensol-horse-red.svg"
      />
    <div data-screen-label="11 Pricing" style={pageStyle}>
      <PixelWaveBg />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <PricingNav />
        <PricingHero />
        <PricingPlans />
        <PricingFaq />
        <PricingCta />
        <PricingFooter />
      </div>
    </div>
    </>
  );
}
