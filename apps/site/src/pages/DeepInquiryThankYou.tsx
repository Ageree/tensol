// T107 — Deep-inquiry success page (US2 lead-gen funnel).
//
// Static confirmation screen reached after `POST /v1/deep-inquiries` returns
// 201. Mirrors the visual language of `Contact.tsx`'s SuccessPanel but lives
// as its own route so the form can navigate cleanly and the URL is shareable
// for QA. Constitution VII: ≤ 800 LOC.

import { type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { LangSwitcher } from '../components/LangSwitcher.tsx';
import { AuthWave } from '../components/PixelWaveBg.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import {
  Btn,
  HalftoneBg,
  LogoLockup,
  Mono,
} from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';

export default function DeepInquiryThankYou(): ReactElement {
  const { t } = useTensol();
  const navigate = useNavigate();

  return (
    <>
      <RouteHead
        title="Request received — Tensol"
        description="Deep audit request received."
        ogTitle="Request received — Tensol"
        ogDescription="Deep audit request received."
        ogImage="/assets/tensol-horse-red.svg"
      />
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--paper)',
          color: 'var(--ink)',
          display: 'grid',
          gridTemplateColumns: '1.1fr 1fr',
        }}
      >
        <aside
          style={{
            position: 'relative',
            overflow: 'hidden',
            background: 'var(--ink)',
            color: 'var(--paper)',
            padding: '40px 48px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <HalftoneBg color="var(--paper)" opacity={0.08} />
          <AuthWave />
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => navigate('/')}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--paper)',
                cursor: 'pointer',
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <LogoLockup
                size={20}
                color="var(--paper)"
                onClick={() => navigate('/')}
              />
            </button>
          </div>
        </aside>

        <main
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '40px',
          }}
        >
          <div style={{ position: 'absolute', top: 32, right: 40 }}>
            <LangSwitcher />
          </div>
          <div style={{ width: '100%', maxWidth: 520, marginTop: 64 }}>
            <Mono size={11} color="var(--fg-2)">
              // STATUS · RECEIVED
            </Mono>
            <h1
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 500,
                fontSize: 44,
                lineHeight: 1.05,
                letterSpacing: '-0.02em',
                margin: '20px 0 24px',
              }}
            >
              {t.deepInquiry.thankYou.title}
            </h1>
            <p
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: 15,
                lineHeight: 1.55,
                color: 'var(--fg-2)',
                margin: '0 0 36px',
                maxWidth: '52ch',
              }}
            >
              {t.deepInquiry.thankYou.body}
            </p>
            <Btn kind="secondary" onClick={() => navigate('/')}>
              ← {t.deepInquiry.thankYou.returnLink}
            </Btn>
          </div>
        </main>
      </div>
    </>
  );
}
