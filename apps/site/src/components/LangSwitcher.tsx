// Compact EN/RU switch. Uses currentColor so it adapts to dark (AuthShell aside)
// and light (MarketingNav, AppShell topbar) surfaces without per-call theming.
import { useTensol } from '../context.tsx';
import type { TensolLang } from '../i18n.ts';

const OPTIONS: TensolLang[] = ['en', 'ru'];

type Props = {
  size?: 'sm' | 'md';
  tone?: 'auto' | 'inverse';
};

export function LangSwitcher({ size = 'sm', tone = 'auto' }: Props) {
  const { lang, setLang } = useTensol();
  const padY = size === 'sm' ? 3 : 5;
  const padX = size === 'sm' ? 7 : 10;
  const fz = size === 'sm' ? 10 : 11;
  const fg = tone === 'inverse' ? 'var(--paper)' : 'var(--fg)';
  const bg = tone === 'inverse' ? 'var(--ink)' : 'var(--bg)';

  return (
    <div
      role="radiogroup"
      aria-label="Language"
      style={{
        display: 'inline-flex',
        border: `1px solid ${fg}`,
        userSelect: 'none',
      }}
    >
      {OPTIONS.map((opt, i) => {
        const active = opt === lang;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setLang(opt)}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: fz,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: `${padY}px ${padX}px`,
              border: 'none',
              borderRight: i < OPTIONS.length - 1 ? `1px solid ${fg}` : 'none',
              background: active ? fg : 'transparent',
              color: active ? bg : fg,
              cursor: 'pointer',
              minWidth: 28,
              lineHeight: 1.4,
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
