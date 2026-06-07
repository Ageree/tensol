// Shared split-panel shell for the three Sthrip auth screens.
import type { ReactNode } from 'react';
import { useTensol } from '../context.tsx';
import { TENSOL_I18N, type TensolLang } from '../i18n.ts';
import { LangSwitcher } from './LangSwitcher.tsx';
import { AuthWave } from './PixelWaveBg.tsx';
import { Eyebrow, HalftoneBg, LogoLockup } from './primitives.tsx';

type AuthShellProps = {
  children: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  onBack?: () => void;
  language?: TensolLang;
  brand?: 'sthrip';
};

export function AuthShell({
  children,
  eyebrow,
  title,
  sub,
  onBack,
  language,
  brand = 'sthrip',
}: AuthShellProps) {
  const { t: contextT } = useTensol();
  const t = language ? TENSOL_I18N[language] : contextT;
  const panelLabel = t.authPanelLeft.replace(/^\/\/\s*/, '');
  const isSthrip = brand === 'sthrip';

  return (
    <div
      className="auth-shell"
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
          justifyContent: 'space-between',
        }}
      >
        <HalftoneBg color="var(--paper)" opacity={0.08} />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AuthWave />
        </div>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={onBack}
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
            {isSthrip ? (
              <>
                <img
                  src="/assets/sthrip-logo-mark-white.png"
                  alt=""
                  aria-hidden="true"
                  style={{
                    display: 'block',
                    width: 34,
                    height: 34,
                  }}
                />
                <img
                  src="/assets/sthrip-wordmark-white.png"
                  alt="STHRIP"
                  style={{
                    display: 'block',
                    width: 126,
                    height: 'auto',
                  }}
                />
              </>
            ) : (
              <LogoLockup size={20} color="var(--paper)" onClick={onBack} />
            )}
          </button>
        </div>
        <div
          style={{
            position: 'relative',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'rgba(250, 249, 246, 0.62)',
            letterSpacing: '0.04em',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>{panelLabel}</span>
        </div>
      </aside>
      <main
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px',
          background: 'var(--paper)',
        }}
      >
        <div style={{ position: 'absolute', top: 32, right: 40 }}>
          <LangSwitcher />
        </div>
        <div style={{ width: '100%', maxWidth: 440 }}>
          {eyebrow && <Eyebrow style={{ marginBottom: 12 }}>{eyebrow}</Eyebrow>}
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 500,
              fontSize: 40,
              lineHeight: 1.05,
              letterSpacing: 0,
              margin: '0 0 12px',
            }}
          >
            {title}
          </h1>
          {sub && (
            <p
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 14.5,
                lineHeight: 1.5,
                color: 'var(--fg-2)',
                margin: '0 0 28px',
                maxWidth: '46ch',
              }}
            >
              {sub}
            </p>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
