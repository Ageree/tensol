import {
  type ChangeEvent,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useState,
} from 'react';
import {
  HORSE_COWBOYS,
  HORSE_COWBOYS_RATIO,
  HORSE_RUNNING,
  HORSE_RUNNING_RATIO,
} from './assets/horse.ts';

/* ─────────────────────────────────────────────────────────────────────
   HorseMark — pixel horse mask. currentColor via background-color.
   ───────────────────────────────────────────────────────────────────── */
export function HorseMark({
  size = 40,
  color = 'currentColor',
  src = '/assets/sthrip-horse.svg',
}: {
  size?: number;
  color?: string;
  src?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: Math.round(size * (690 / 550)),
        backgroundColor: color,
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        imageRendering: 'pixelated',
      }}
    />
  );
}

export function Wordmark({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <span
      style={{
        fontFamily: "'Space Grotesk', sans-serif",
        fontWeight: 500,
        fontSize: size,
        letterSpacing: '-0.04em',
        color,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      STHRIP
      <sup style={{ fontSize: size * 0.4, letterSpacing: 0, fontWeight: 400 }}>®</sup>
    </span>
  );
}

export function LogoLockup({
  color = 'var(--ink)',
  size = 18,
  onClick,
  mark = true,
}: {
  color?: string;
  size?: number;
  onClick?: () => void;
  mark?: boolean;
}) {
  return (
    <a
      href="#home"
      onClick={(e) => {
        if (onClick) {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        textDecoration: 'none',
        color,
      }}
    >
      {mark && <HorseMark size={size * 1.4} color={color} />}
      <Wordmark size={size} color={color} />
    </a>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Btn — primary | secondary | red | ghost | dim
   ───────────────────────────────────────────────────────────────────── */
type BtnKind = 'primary' | 'secondary' | 'red' | 'ghost' | 'dim';
type BtnSize = 'sm' | 'md' | 'lg';

export function Btn({
  children,
  kind = 'primary',
  size = 'md',
  onClick,
  href,
  disabled,
  fullWidth,
  title,
  'data-testid': dataTestId,
}: {
  children: ReactNode;
  kind?: BtnKind;
  size?: BtnSize;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  title?: string;
  'data-testid'?: string;
}) {
  const padY = size === 'sm' ? 5 : size === 'lg' ? 14 : 9;
  const padX = size === 'sm' ? 10 : size === 'lg' ? 22 : 14;
  const fz = size === 'sm' ? 11 : size === 'lg' ? 14 : 12;

  const base: CSSProperties = {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: fz,
    fontWeight: 500,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    padding: `${padY}px ${padX}px`,
    border: '1px solid var(--fg)',
    borderRadius: 0,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    transition: 'all 120ms cubic-bezier(.22,1,.36,1)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    textDecoration: 'none',
    background: 'var(--fg)',
    color: 'var(--bg)',
    width: fullWidth ? '100%' : 'auto',
    whiteSpace: 'nowrap',
  };

  const kinds: Record<BtnKind, CSSProperties> = {
    primary: {},
    secondary: { background: 'var(--bg)', color: 'var(--fg)' },
    red: { background: 'var(--red)', borderColor: 'var(--red)', color: 'var(--paper)' },
    ghost: {
      background: 'transparent',
      borderColor: 'transparent',
      color: 'inherit',
      textDecoration: 'underline',
      textUnderlineOffset: 4,
      padding: `${padY}px 4px`,
    },
    dim: { background: 'transparent', color: 'var(--fg-2)', borderColor: 'var(--line-soft)' },
  };

  const [hov, setHov] = useState(false);
  const hovStyles: Record<BtnKind, CSSProperties> = {
    primary: { background: 'var(--bg)', color: 'var(--fg)' },
    secondary: { background: 'var(--fg)', color: 'var(--bg)' },
    red: { background: 'var(--paper)', color: 'var(--red)' },
    ghost: { opacity: 0.6 },
    dim: { color: 'var(--fg)', borderColor: 'var(--fg)' },
  };

  const style: CSSProperties = { ...base, ...kinds[kind], ...(hov && !disabled ? hovStyles[kind] : {}) };

  if (href) {
    return (
      <a
        href={href}
        onClick={disabled ? undefined : onClick}
        title={title}
        data-testid={dataTestId}
        style={style}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      title={title}
      data-testid={dataTestId}
      style={style}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      {children}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Eyebrow / Mono
   ───────────────────────────────────────────────────────────────────── */
function removeDecorativePrefix(children: ReactNode): ReactNode {
  if (typeof children === 'string') {
    return children.replace(/^\/\/\s*/, '');
  }

  return children;
}

export function Eyebrow({
  children,
  color,
  style,
}: {
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: color || 'var(--fg-2)',
        ...style,
      }}
    >
      {removeDecorativePrefix(children)}
    </div>
  );
}

export function Mono({
  children,
  size = 12,
  color,
  style,
  'data-testid': dataTestId,
}: {
  children: ReactNode;
  size?: number;
  color?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}) {
  return (
    <span
      data-testid={dataTestId}
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: size,
        color: color || 'inherit',
        letterSpacing: 0,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Severity / Status badges
   ───────────────────────────────────────────────────────────────────── */
type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export function SeverityChip({ sev, size = 'md' }: { sev: Severity; size?: 'sm' | 'md' }) {
  const colors: Record<Severity, { fg: string; bg: string; bd: string }> = {
    critical: { fg: '#fff', bg: 'var(--red)', bd: 'var(--red)' },
    high: { fg: 'var(--paper)', bg: '#F26B1F', bd: '#F26B1F' },
    medium: { fg: 'var(--ink)', bg: '#E6C76B', bd: '#B8860B' },
    low: { fg: 'var(--ink)', bg: 'var(--bg)', bd: '#5A6B5A' },
    info: { fg: 'var(--fg-2)', bg: 'var(--bg)', bd: 'var(--line-soft)' },
  };
  const c = colors[sev] || colors.info;
  const padY = size === 'sm' ? 1 : 2;
  const padX = size === 'sm' ? 5 : 7;
  const fz = size === 'sm' ? 10 : 11;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: fz,
        letterSpacing: '0.04em',
        padding: `${padY}px ${padX}px`,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bd}`,
        lineHeight: 1.3,
      }}
    >
      <span style={{ width: 6, height: 6, background: c.bd, display: 'inline-block' }} />
      {sev}
    </span>
  );
}

type ChipTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'muted' | 'inverse';

export function StatusChip({
  status,
  tone = 'neutral',
  size = 'md',
}: {
  status: ReactNode;
  tone?: ChipTone;
  size?: 'sm' | 'md';
}) {
  const tones: Record<ChipTone, { fg: string; bg: string; bd: string }> = {
    neutral: { fg: 'var(--fg)', bg: 'var(--bg)', bd: 'var(--fg)' },
    ok: { fg: '#0E5E2A', bg: '#E5F4EB', bd: '#1F7A3A' },
    warn: { fg: '#7A5A05', bg: '#FBF1D9', bd: '#B8860B' },
    danger: { fg: 'var(--paper)', bg: 'var(--red)', bd: 'var(--red)' },
    muted: { fg: 'var(--fg-2)', bg: 'var(--bg)', bd: 'var(--line-soft)' },
    inverse: { fg: 'var(--bg)', bg: 'var(--fg)', bd: 'var(--fg)' },
  };
  const c = tones[tone];
  const padY = size === 'sm' ? 1 : 2;
  const padX = size === 'sm' ? 6 : 8;
  const fz = size === 'sm' ? 10 : 11;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: fz,
        letterSpacing: '0.04em',
        padding: `${padY}px ${padX}px`,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bd}`,
        lineHeight: 1.3,
      }}
    >
      {status}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   HalftoneBg — radial-gradient dot pattern
   ───────────────────────────────────────────────────────────────────── */
export function HalftoneBg({
  size = 8,
  opacity = 0.18,
  color = 'var(--fg)',
  style,
}: {
  size?: number;
  opacity?: number;
  color?: string;
  style?: CSSProperties;
}) {
  const colorRgb = color === 'var(--paper)' ? '255,255,255' : '10,10,10';
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        backgroundImage: `radial-gradient(circle, rgba(${colorRgb},${opacity}) 1px, transparent 1.4px)`,
        backgroundSize: `${size}px ${size}px`,
        ...style,
      }}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Field — label + hint/error wrapper for form inputs
   ───────────────────────────────────────────────────────────────────── */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: error ? 'var(--red)' : 'var(--fg-2)',
        }}
      >
        {label}
      </span>
      {children}
      {hint && !error && (
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: 'var(--fg-3)',
          }}
        >
          {hint}
        </span>
      )}
      {error && (
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: 'var(--red)',
          }}
        >
          {error}
        </span>
      )}
    </label>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Input — bordered mono input
   ───────────────────────────────────────────────────────────────────── */
type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'style'> & {
  error?: boolean;
};

export function Input({ error, type = 'text', ...rest }: InputProps) {
  return (
    <input
      type={type}
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        padding: '10px 12px',
        background: 'var(--bg)',
        color: 'var(--fg)',
        border: `1px solid ${error ? 'var(--red)' : 'var(--fg)'}`,
        borderRadius: 0,
        outline: 'none',
      }}
      {...rest}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────
   AsciiHorse — small ASCII rendition of the horse for hero moments
   ───────────────────────────────────────────────────────────────────── */
const ASCII_HORSE = [
  '                        █▓▓                ',
  '                      ░██▓▓██░             ',
  '                     ▓████▓▓██▓            ',
  '                    ▓██████▓▓██▓           ',
  '                   ▓███████▓▓███           ',
  '                  ▓████████▓███▓           ',
  '                 ▓██████████████▓          ',
  '                ▓███████████████▓          ',
  '          ░░   ▓████████████████░          ',
  '         ▓██▓▓██████████████████           ',
  '        ▓███████████████████████░          ',
  '       ▓████████████████████████▓          ',
  '      ▓██████████████████████████          ',
  '     ▓███████████████████████████░         ',
  '    ▓██████████████   ███████████▓         ',
  '   ▓███████████░       ▓██████████▓        ',
  '  ▓██████████           ▓██████████▓       ',
  ' ▓██████████             ▓██████████▓      ',
  '▓██████████               ▓██████████      ',
  ' ▓████████                 ▓█████████▓     ',
  '  ▓██████                   ▓████████▓     ',
  '   ▓████                     ▓████████▓    ',
  '    ▓██                       ▓███████▓    ',
];

export function AsciiHorse({
  color = 'currentColor',
  fontSize = 8,
}: {
  color?: string;
  fontSize?: number;
}) {
  return (
    <pre
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize,
        lineHeight: 1,
        color,
        margin: 0,
        letterSpacing: 0,
        whiteSpace: 'pre',
        userSelect: 'none',
      }}
    >
      {ASCII_HORSE.join('\n')}
    </pre>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Card — bordered container, optional hover-lift
   ───────────────────────────────────────────────────────────────────── */
export function Card({
  children,
  style,
  hover,
  onClick,
  title,
}: {
  children: ReactNode;
  style?: CSSProperties;
  hover?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const [hov, setHov] = useState(false);
  const lift = hov && hover;
  return (
    <div
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: 'var(--bg)',
        border: `${lift ? 2 : 1}px solid var(--fg)`,
        margin: lift ? -1 : 0,
        cursor: onClick ? 'pointer' : 'default',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Textarea — bordered mono textarea
   ───────────────────────────────────────────────────────────────────── */
type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> & {
  error?: boolean;
};

export function Textarea({ error, rows = 4, ...rest }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        padding: '10px 12px',
        background: 'var(--bg)',
        color: 'var(--fg)',
        border: `1px solid ${error ? 'var(--red)' : 'var(--fg)'}`,
        borderRadius: 0,
        resize: 'vertical',
        outline: 'none',
      }}
      {...rest}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Select — bordered mono select. Accepts string[] or { value, label }[]
   ───────────────────────────────────────────────────────────────────── */
export type SelectOption = string | { value: string; label: string };

export function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        padding: '9px 12px',
        background: 'var(--bg)',
        color: 'var(--fg)',
        border: '1px solid var(--fg)',
        borderRadius: 0,
        outline: 'none',
      }}
    >
      {options.map((opt) => {
        const v = typeof opt === 'string' ? opt : opt.value;
        const l = typeof opt === 'string' ? opt : opt.label;
        return (
          <option key={v} value={v}>
            {l}
          </option>
        );
      })}
    </select>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Checkbox — square pixel checkbox with optional label/hint
   ───────────────────────────────────────────────────────────────────── */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  danger,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
      <span
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          border: `1px solid ${danger ? 'var(--red)' : 'var(--fg)'}`,
          background: checked ? (danger ? 'var(--red)' : 'var(--fg)') : 'transparent',
          position: 'relative',
          marginTop: 2,
        }}
      >
        {checked && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--bg)',
              fontSize: 12,
              lineHeight: 1,
              fontFamily: 'monospace',
            }}
          >
            ✓
          </span>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
        style={{ display: 'none' }}
      />
      {(label || hint) && (
        <span style={{ fontSize: 13, lineHeight: 1.4 }}>
          {label && <span>{label}</span>}
          {hint && (
            <span
              style={{
                display: 'block',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: 'var(--fg-3)',
                marginTop: 2,
              }}
            >
              {hint}
            </span>
          )}
        </span>
      )}
    </label>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   ProgressBar — pixelated step bar
   ───────────────────────────────────────────────────────────────────── */
export function ProgressBar({
  value,
  max = 100,
  segments = 40,
  color = 'var(--fg)',
  height = 8,
  label,
}: {
  value: number;
  max?: number;
  segments?: number;
  color?: string;
  height?: number;
  label?: ReactNode;
}) {
  const pct = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(segments * pct);
  return (
    <div>
      {label && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: 'var(--fg-2)',
            marginBottom: 4,
            letterSpacing: '0.04em',
          }}
        >
          <span>{label}</span>
          <span>{Math.round(pct * 100)}%</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 1, height }}>
        {Array.from({ length: segments }).map((_, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              background: i < filled ? color : 'var(--line-soft)',
              opacity: i < filled ? 1 : 0.4,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Segmented — segmented control (mono caps)
   ───────────────────────────────────────────────────────────────────── */
export type SegOption<V extends string> = { value: V; label: ReactNode };

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: readonly SegOption<V>[];
  value: V;
  onChange: (next: V) => void;
  size?: 'sm' | 'md';
}) {
  const padY = size === 'sm' ? 4 : 6;
  const padX = size === 'sm' ? 8 : 12;
  const fz = size === 'sm' ? 10 : 11;
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--fg)' }}>
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: fz,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: `${padY}px ${padX}px`,
              border: 'none',
              borderRight: i < options.length - 1 ? '1px solid var(--fg)' : 'none',
              background: active ? 'var(--fg)' : 'transparent',
              color: active ? 'var(--bg)' : 'var(--fg)',
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Tabs — top tab strip
   ───────────────────────────────────────────────────────────────────── */
export type TabOption = { value: number; label: ReactNode };

export function Tabs({
  value,
  onChange,
  options,
}: {
  value: number;
  onChange: (next: number) => void;
  options: readonly TabOption[];
}) {
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--fg)' }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              background: active ? 'var(--fg)' : 'transparent',
              color: active ? 'var(--bg)' : 'var(--fg)',
              border: 'none',
              padding: '10px 18px',
              cursor: 'pointer',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              borderRight: '1px solid var(--fg)',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Modal — centered modal with optional title bar
   ───────────────────────────────────────────────────────────────────── */
export function Modal({
  open,
  onClose,
  children,
  width = 560,
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  title?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(10,10,10,0.6)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '80px 24px',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)',
          color: 'var(--fg)',
          border: '1px solid var(--fg)',
          width: '100%',
          maxWidth: width,
        }}
      >
        {title && (
          <div
            style={{
              padding: '14px 20px',
              borderBottom: '1px solid var(--fg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Mono
              size={11}
              style={{ letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-2)' }}
            >
              {title}
            </Mono>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--fg)',
                fontFamily: 'monospace',
                fontSize: 14,
              }}
            >
              ✕
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Drawer — right-slide panel
   ───────────────────────────────────────────────────────────────────── */
export function Drawer({
  open,
  onClose,
  children,
  width = 720,
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  title?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 190,
          background: open ? 'rgba(10,10,10,0.5)' : 'transparent',
          pointerEvents: open ? 'auto' : 'none',
          transition: 'background 200ms',
        }}
      />
      <aside
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width,
          maxWidth: '100vw',
          zIndex: 195,
          background: 'var(--bg)',
          color: 'var(--fg)',
          borderLeft: '1px solid var(--fg)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 240ms cubic-bezier(.22,1,.36,1)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {title && (
          <div
            style={{
              padding: '16px 24px',
              borderBottom: '1px solid var(--fg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
            }}
          >
            <Mono
              size={11}
              style={{ letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-2)' }}
            >
              {title}
            </Mono>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--fg)',
                fontFamily: 'monospace',
                fontSize: 14,
              }}
            >
              ✕
            </button>
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
      </aside>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   HorseMark2 — running stallion silhouette. Single-color, masked.
   Use color="var(--paper)" on dark backgrounds.
   ───────────────────────────────────────────────────────────────────── */
export function HorseMark2({
  size = 200,
  color = 'currentColor',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: Math.round(size * HORSE_RUNNING_RATIO),
        backgroundColor: color,
        WebkitMaskImage: `url("${HORSE_RUNNING}")`,
        maskImage: `url("${HORSE_RUNNING}")`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        imageRendering: 'pixelated',
      }}
    />
  );
}

/* HorseMark3 — two cowboys with dithered halftone fill. */
export function HorseMark3({
  size = 240,
  color = 'currentColor',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: Math.round(size * HORSE_COWBOYS_RATIO),
        backgroundColor: color,
        WebkitMaskImage: `url("${HORSE_COWBOYS}")`,
        maskImage: `url("${HORSE_COWBOYS}")`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        imageRendering: 'pixelated',
      }}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Sparkline — tiny inline series, mono-colored bars
   ───────────────────────────────────────────────────────────────────── */
export function Sparkline({
  values,
  height = 28,
  color = 'var(--fg)',
}: {
  values: readonly number[];
  height?: number;
  color?: string;
}) {
  const max = Math.max(1, ...values);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height }}>
      {values.map((v, i) => (
        <span
          key={i}
          style={{
            flex: 1,
            height: `${Math.max(2, (v / max) * 100)}%`,
            background: color,
            opacity: 0.85,
          }}
        />
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Scroll — fixed-height scrollable container with no scrollbar chrome.
   ───────────────────────────────────────────────────────────────────── */
export function Scroll({
  children,
  maxHeight,
  style,
}: {
  children: ReactNode;
  maxHeight?: number | string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        maxHeight,
        overflowY: 'auto',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
