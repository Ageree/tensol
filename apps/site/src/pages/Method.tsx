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

/* ─────────────────────────────────────────────────────────────────────
   AnimatedPipeline — horizontal 5-node SVG with a pulse traveling the
   line indefinitely; each node lights up briefly as the pulse passes.
   ───────────────────────────────────────────────────────────────────── */
function AnimatedPipeline({ phases }: { phases: { phase: string; name: string }[] }) {
  const W = 1100;
  const H = 140;
  const yLine = 70;
  const nodeR = 22;
  const padX = 90;
  const lineLen = W - padX * 2;
  const step = lineLen / (phases.length - 1);
  const xs = phases.map((_, i) => padX + i * step);
  const dur = 20; // full there-and-back cycle (10s forward + 10s reverse)

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: W,
        margin: '0 auto',
      }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label="Tensol pipeline animation"
      >
        {/* Static base line */}
        <line
          x1={padX}
          y1={yLine}
          x2={W - padX}
          y2={yLine}
          stroke="var(--ink)"
          strokeWidth="1.5"
          opacity="0.35"
        />

        {/* Traveling pulse — drawn BEFORE nodes so it passes UNDER each circle.
            Path goes there-and-back so the dot reverses at the right edge. */}
        <circle r="6" fill="var(--red)">
          <animateMotion
            dur={`${dur}s`}
            repeatCount="indefinite"
            path={`M${padX},${yLine} L${W - padX},${yLine} L${padX},${yLine}`}
          />
        </circle>

        {/* Nodes */}
        {phases.map((p, i) => {
          // Dot path is there-and-back, so forward-arrival and reverse-arrival
          // fractions of the cycle are symmetric around 0.5:
          //   forward arrival: p_f = i / (N-1) * 0.5
          //   reverse arrival: p_r = 1 - p_f
          // Ring opacity stays at 0 until forward arrival, jumps to 0.7 (lit),
          // holds until reverse arrival, then drops to 0 until cycle end.
          const ramp = 0.005; // 0.1s fade window (with dur=20s)
          const minLit = 0.04; // ensure even the apex node stays visibly lit ≥0.8s
          const p_f_raw = (i / (phases.length - 1)) * 0.5;
          const p_r_raw = 1 - p_f_raw;
          const p_f = p_f_raw;
          const p_r = Math.max(p_r_raw, p_f + minLit);

          let opValues: string;
          let opKeyTimes: string;
          if (p_f === 0) {
            // Node 0 — lit from start of cycle until reverse arrival
            opValues = `0.7;0.7;0;0`;
            opKeyTimes = `0;${p_r};${Math.min(p_r + ramp, 1)};1`;
          } else if (p_r >= 1) {
            // Should not happen given symmetry, but guard anyway
            opValues = `0;0;0.7`;
            opKeyTimes = `0;${Math.max(p_f - ramp, 0)};${p_f}`;
          } else {
            opValues = `0;0;0.7;0.7;0;0`;
            opKeyTimes = `0;${Math.max(p_f - ramp, 0)};${p_f};${p_r};${Math.min(p_r + ramp, 1)};1`;
          }

          return (
            <g key={i} transform={`translate(${xs[i]} ${yLine})`}>
              {/* Persistent ring — lit when the dot has passed forward, unlit after reverse.
                  Independent breathing animation on radius keeps lit rings gently alive. */}
              <circle r={nodeR + 8} fill="none" stroke="var(--red)" strokeWidth="1.5" opacity="0">
                <animate
                  attributeName="opacity"
                  values={opValues}
                  keyTimes={opKeyTimes}
                  dur={`${dur}s`}
                  begin="0s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="r"
                  values={`${nodeR + 8};${nodeR + 11};${nodeR + 8}`}
                  keyTimes="0;0.5;1"
                  dur="2.4s"
                  begin="0s"
                  repeatCount="indefinite"
                />
              </circle>

              {/* Node circle — drawn ON TOP of the traveling dot, so dot passes under */}
              <circle
                r={nodeR}
                fill="var(--paper)"
                stroke="var(--ink)"
                strokeWidth="2"
              />

              {/* Phase number inside */}
              <text
                textAnchor="middle"
                dy="4"
                fontSize="13"
                fontFamily="'JetBrains Mono', monospace"
                fontWeight="600"
                fill="var(--ink)"
              >
                {p.phase}
              </text>

              {/* Phase name below */}
              <text
                textAnchor="middle"
                y={nodeR + 26}
                fontSize="11"
                fontFamily="'JetBrains Mono', monospace"
                letterSpacing="0.08em"
                fill="var(--ink)"
              >
                {p.name.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   PhaseCard — one expanded section per phase
   ───────────────────────────────────────────────────────────────────── */
function PhaseCard({
  phase,
  name,
  what,
  hard,
  tensol,
  claim,
  labels,
}: {
  phase: string;
  name: string;
  what: string;
  hard: string;
  tensol: string;
  claim: string;
  labels: { what: string; hard: string; tensol: string };
}) {
  return (
    <article
      style={{
        borderTop: '1px solid var(--ink)',
        padding: '56px 0',
        display: 'grid',
        gridTemplateColumns: '220px 1fr',
        gap: 56,
        alignItems: 'flex-start',
      }}
    >
      {/* Left column — phase label */}
      <div>
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            letterSpacing: '0.12em',
            color: 'var(--fg-2)',
            marginBottom: 6,
          }}
        >
          ФАЗА {phase}
        </div>
        <h2
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 500,
            fontSize: 40,
            lineHeight: 1.02,
            letterSpacing: '-0.02em',
            margin: 0,
            color: 'var(--ink)',
          }}
        >
          {name}
        </h2>
        <div
          style={{
            marginTop: 24,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            letterSpacing: '0.08em',
            color: 'var(--red)',
            maxWidth: '24ch',
            lineHeight: 1.5,
          }}
        >
          {claim}
        </div>
      </div>

      {/* Right column — three-block content */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <PhaseBlock label={labels.what} body={what} />
        <PhaseBlock label={labels.hard} body={hard} />
        <PhaseBlock label={labels.tensol} body={tensol} accent />
      </div>
    </article>
  );
}

function PhaseBlock({ label, body, accent }: { label: string; body: string; accent?: boolean }) {
  return (
    <div>
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: accent ? 'var(--red)' : 'var(--fg-2)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <p
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 16,
          lineHeight: 1.55,
          color: 'var(--ink)',
          margin: 0,
          maxWidth: '68ch',
        }}
      >
        {body}
      </p>
    </div>
  );
}

export default function Method() {
  const { t, lang } = useTensol();
  const navigate = useNavigate();

  const labels =
    lang === 'ru'
      ? { what: 'Что происходит', hard: 'Почему это сложно', tensol: 'Что делает Tensol' }
      : { what: 'What happens', hard: 'Why this is hard', tensol: 'What Tensol does' };

  return (
    <>
      <RouteHead
        title={lang === 'ru' ? 'Tensol — Как мы ломаем' : 'Tensol — How we break in'}
        description={
          lang === 'ru'
            ? 'Полный пайплайн авторизованной атакующей платформы Tensol: периметр, разведка, эксплуатация, валидация, отчёт.'
            : 'The full pipeline of the Tensol authorized offensive platform: perimeter, recon, exploitation, validation, report.'
        }
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

        {/* Hero */}
        <section
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            padding: '88px 64px 64px',
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
            {t.methodTitle}
          </h1>
          <p
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: 19,
              lineHeight: 1.55,
              color: 'var(--fg-2)',
              margin: 0,
              maxWidth: '68ch',
            }}
          >
            {t.methodIntro}
          </p>
        </section>

        {/* Animated pipeline diagram */}
        <section
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            padding: '24px 64px 64px',
            position: 'relative',
            zIndex: 1,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              marginBottom: 32,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              letterSpacing: '0.08em',
              color: 'var(--fg-2)',
              textTransform: 'uppercase',
            }}
          >
            <span>{t.methodPipelineTitle}</span>
            <span>{t.methodPipelineMeta}</span>
          </div>
          <AnimatedPipeline phases={t.methodPhases.map((p) => ({ phase: p.phase, name: p.name }))} />
        </section>

        {/* Phase deep-dives */}
        <section
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            padding: '40px 64px 96px',
            position: 'relative',
            zIndex: 1,
          }}
        >
          {t.methodPhases.map((p) => (
            <PhaseCard
              key={p.phase}
              phase={p.phase}
              name={p.name}
              what={p.what}
              hard={p.hard}
              tensol={p.tensol}
              claim={p.claim}
              labels={labels}
            />
          ))}
        </section>

        {/* Closing CTA */}
        <section
          style={{
            background: 'var(--red)',
            position: 'relative',
            borderTop: '1px solid var(--ink)',
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
                {t.methodCtaTitle}
              </h2>
              <p
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 16,
                  lineHeight: 1.5,
                  color: 'rgba(255,255,255,.85)',
                  margin: 0,
                  maxWidth: '54ch',
                }}
              >
                {t.methodCtaBody}
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
              {t.methodCtaBtn}
            </button>
          </div>
        </section>
      </main>
    </>
  );
}
