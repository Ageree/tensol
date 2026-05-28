import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTensol } from '../context.tsx';
import { LangSwitcher } from '../components/LangSwitcher.tsx';
import { PixelWaveBg } from '../components/PixelWaveBg.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, HalftoneBg, LogoLockup } from '../components/primitives.tsx';

function PublicNav() {
  const { t } = useTensol();
  const navigate = useNavigate();
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

export default function Blog() {
  const { t } = useTensol();
  return (
    <>
      <RouteHead
        title="Tensol — Blog"
        description="Field notes from live AI pentests — what the agent finds in real perimeters."
      />
      <main
        style={{
          background: 'var(--paper)',
          color: 'var(--ink)',
          minHeight: '100vh',
          position: 'relative',
        }}
      >
        <HalftoneBg size={12} opacity={0.12} style={{ inset: 0 }} />
        <PixelWaveBg />
        <PublicNav />

        <section
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            padding: '88px 64px 96px',
            position: 'relative',
            zIndex: 1,
          }}
        >
          <h1
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 500,
              fontSize: 'clamp(48px, 6vw, 76px)',
              lineHeight: 1.02,
              letterSpacing: '-0.03em',
              margin: '0 0 28px',
              color: 'var(--ink)',
              textWrap: 'balance',
              maxWidth: '20ch',
            }}
          >
            {t.blogTitle}
          </h1>
          <p
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 19,
              lineHeight: 1.5,
              color: 'var(--fg-2)',
              margin: 0,
              maxWidth: '60ch',
            }}
          >
            {t.blogIntro}
          </p>
        </section>

        <section
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            padding: '0 64px 160px',
            position: 'relative',
            zIndex: 1,
          }}
        >
          <div
            style={{
              borderTop: '1px solid var(--ink)',
              padding: '64px 0',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              letterSpacing: '0.04em',
              color: 'var(--fg-2)',
            }}
          >
            {t.blogEmpty}
          </div>
        </section>
      </main>
    </>
  );
}
