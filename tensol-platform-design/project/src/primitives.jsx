// Tensol — shared primitives. Keep no-state, theme-aware.
// All components attach to window so other Babel scripts can use them.

const { useState, useEffect, useRef } = React;

/* ─────────────────────────────────────────────────────────────────────
   HorseMark — pixel horse mask. currentColor via background-color.
   ───────────────────────────────────────────────────────────────────── */
function HorseMark({ size = 40, color = 'currentColor', src = 'assets/tensol-horse.svg' }) {
  return (
    <span aria-hidden="true" style={{
      display: 'inline-block',
      width: size,
      height: Math.round(size * (690/550)),
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
    }} />
  );
}

function Wordmark({ size = 18, color = 'currentColor' }) {
  return (
    <span style={{
      fontFamily: "'Space Grotesk', sans-serif",
      fontWeight: 500,
      fontSize: size,
      letterSpacing: '-0.04em',
      color,
      lineHeight: 1,
      whiteSpace: 'nowrap',
    }}>
      TENSOL<sup style={{ fontSize: size * 0.4, letterSpacing: 0, fontWeight: 400 }}>®</sup>
    </span>
  );
}

function LogoLockup({ color = 'var(--ink)', size = 18, onClick }) {
  return (
    <a href="#home" onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 10,
      textDecoration: 'none', color,
    }}>
      <HorseMark size={size * 1.4} color={color} />
      <Wordmark size={size} color={color} />
    </a>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Btn — primary | secondary | red | ghost | dim
   ───────────────────────────────────────────────────────────────────── */
function Btn({ children, kind = 'primary', size = 'md', onClick, href, disabled, fullWidth, title, ...rest }) {
  const padY = size === 'sm' ? 5 : size === 'lg' ? 14 : 9;
  const padX = size === 'sm' ? 10 : size === 'lg' ? 22 : 14;
  const fz   = size === 'sm' ? 11 : size === 'lg' ? 14 : 12;
  const base = {
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
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    textDecoration: 'none',
    background: 'var(--fg)', color: 'var(--bg)',
    width: fullWidth ? '100%' : 'auto',
    whiteSpace: 'nowrap',
  };
  const kinds = {
    primary:   {},
    secondary: { background: 'var(--bg)', color: 'var(--fg)' },
    red:       { background: 'var(--red)', borderColor: 'var(--red)', color: 'var(--paper)' },
    ghost:     { background: 'transparent', borderColor: 'transparent', color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 4, padding: `${padY}px 4px` },
    dim:       { background: 'transparent', color: 'var(--fg-2)', borderColor: 'var(--line-soft)' },
  };
  const [hov, setHov] = useState(false);
  const hovStyles = {
    primary:   { background: 'var(--bg)', color: 'var(--fg)' },
    secondary: { background: 'var(--fg)', color: 'var(--bg)' },
    red:       { background: 'var(--paper)', color: 'var(--red)' },
    ghost:     { opacity: 0.6 },
    dim:       { color: 'var(--fg)', borderColor: 'var(--fg)' },
  };
  const style = { ...base, ...kinds[kind], ...(hov && !disabled ? hovStyles[kind] : {}) };
  const Cmp = href ? 'a' : 'button';
  return (
    <Cmp type={href ? undefined : 'button'} href={href} onClick={disabled ? undefined : onClick}
      title={title} style={style} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} {...rest}>
      {children}
    </Cmp>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Eyebrow / Label / Mono — small uppercase mono labels
   ───────────────────────────────────────────────────────────────────── */
function Eyebrow({ children, color, style }) {
  return (
    <div style={{
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: color || 'var(--fg-2)',
      ...style,
    }}>{children}</div>
  );
}

function Mono({ children, size = 12, color, style, as: As = 'span' }) {
  return (
    <As style={{
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: size,
      color: color || 'inherit',
      letterSpacing: 0,
      ...style,
    }}>{children}</As>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Severity / Status badges. Lowercase mono.
   ───────────────────────────────────────────────────────────────────── */
function SeverityChip({ sev, size = 'md' }) {
  const colors = {
    critical: { fg: '#fff',          bg: 'var(--red)',     bd: 'var(--red)' },
    high:     { fg: 'var(--paper)',  bg: '#F26B1F',        bd: '#F26B1F' },
    medium:   { fg: 'var(--ink)',    bg: '#E6C76B',        bd: '#B8860B' },
    low:      { fg: 'var(--ink)',    bg: 'var(--bg)',      bd: '#5A6B5A' },
    info:     { fg: 'var(--fg-2)',   bg: 'var(--bg)',      bd: 'var(--line-soft)' },
  };
  const c = colors[sev] || colors.info;
  const padY = size === 'sm' ? 1 : 2;
  const padX = size === 'sm' ? 5 : 7;
  const fz   = size === 'sm' ? 10 : 11;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: fz,
      letterSpacing: '0.04em',
      padding: `${padY}px ${padX}px`,
      background: c.bg, color: c.fg, border: `1px solid ${c.bd}`,
      lineHeight: 1.3,
    }}>
      <span style={{ width: 6, height: 6, background: c.bd, display: 'inline-block' }} />
      {sev}
    </span>
  );
}

function StatusChip({ status, tone = 'neutral', size = 'md' }) {
  const tones = {
    neutral: { fg: 'var(--fg)',   bg: 'var(--bg)',   bd: 'var(--fg)' },
    ok:      { fg: '#0E5E2A',     bg: '#E5F4EB',     bd: '#1F7A3A' },
    warn:    { fg: '#7A5A05',     bg: '#FBF1D9',     bd: '#B8860B' },
    danger:  { fg: 'var(--paper)',bg: 'var(--red)',  bd: 'var(--red)' },
    muted:   { fg: 'var(--fg-2)', bg: 'var(--bg)',   bd: 'var(--line-soft)' },
    inverse: { fg: 'var(--bg)',   bg: 'var(--fg)',   bd: 'var(--fg)' },
  };
  const c = tones[tone];
  const padY = size === 'sm' ? 1 : 2;
  const padX = size === 'sm' ? 6 : 8;
  const fz   = size === 'sm' ? 10 : 11;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: fz, letterSpacing: '0.04em',
      padding: `${padY}px ${padX}px`,
      background: c.bg, color: c.fg, border: `1px solid ${c.bd}`,
      lineHeight: 1.3,
    }}>{status}</span>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Card — flat white-on-bg with hairline border
   ───────────────────────────────────────────────────────────────────── */
function Card({ children, style, hover, onClick, title }) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={onClick} title={title}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: 'var(--bg)',
        border: `${hov && hover ? 2 : 1}px solid var(--fg)`,
        margin: hov && hover ? -1 : 0,
        cursor: onClick ? 'pointer' : 'default',
        ...style,
      }}>
      {children}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   FieldGroup — label + input. Mono label, hard-edge input.
   ───────────────────────────────────────────────────────────────────── */
function Field({ label, hint, error, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11, letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: error ? 'var(--red)' : 'var(--fg-2)',
      }}>{label}</span>
      {children}
      {hint && !error && (
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11, color: 'var(--fg-3)',
        }}>{hint}</span>
      )}
      {error && (
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11, color: 'var(--red)',
        }}>{error}</span>
      )}
    </label>
  );
}

function Input({ value, onChange, placeholder, type = 'text', error, ...rest }) {
  return (
    <input type={type} value={value} onChange={onChange} placeholder={placeholder}
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        padding: '10px 12px',
        background: 'var(--bg)',
        color: 'var(--fg)',
        border: `1px solid ${error ? 'var(--red)' : 'var(--fg)'}`,
        borderRadius: 0,
        outline: 'none',
      }} {...rest} />
  );
}

function Textarea({ value, onChange, placeholder, rows = 4, ...rest }) {
  return (
    <textarea value={value} onChange={onChange} placeholder={placeholder} rows={rows}
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        padding: '10px 12px',
        background: 'var(--bg)',
        color: 'var(--fg)',
        border: '1px solid var(--fg)',
        borderRadius: 0,
        resize: 'vertical',
        outline: 'none',
      }} {...rest} />
  );
}

function Select({ value, onChange, options, ...rest }) {
  return (
    <select value={value} onChange={onChange}
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        padding: '9px 12px',
        background: 'var(--bg)',
        color: 'var(--fg)',
        border: '1px solid var(--fg)',
        borderRadius: 0,
        outline: 'none',
      }} {...rest}>
      {options.map(o => (
        <option key={o.value || o} value={o.value || o}>{o.label || o}</option>
      ))}
    </select>
  );
}

function Checkbox({ checked, onChange, label, hint, danger }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
      <span style={{
        width: 16, height: 16, flexShrink: 0,
        border: `1px solid ${danger ? 'var(--red)' : 'var(--fg)'}`,
        background: checked ? (danger ? 'var(--red)' : 'var(--fg)') : 'transparent',
        position: 'relative',
        marginTop: 2,
      }}>
        {checked && (
          <span style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--bg)', fontSize: 12, lineHeight: 1, fontFamily: 'monospace',
          }}>✓</span>
        )}
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ display: 'none' }} />
      <span style={{ fontSize: 13, lineHeight: 1.4 }}>
        <span>{label}</span>
        {hint && <span style={{ display: 'block', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--fg-3)', marginTop: 2 }}>{hint}</span>}
      </span>
    </label>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   ProgressBar — pixelated step bar
   ───────────────────────────────────────────────────────────────────── */
function ProgressBar({ value, max = 100, segments = 40, color = 'var(--fg)', height = 8, label }) {
  const pct = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(segments * pct);
  return (
    <div>
      {label && (
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
          color: 'var(--fg-2)', marginBottom: 4, letterSpacing: '0.04em',
        }}>
          <span>{label}</span>
          <span>{Math.round(pct * 100)}%</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 1, height }}>
        {Array.from({ length: segments }).map((_, i) => (
          <span key={i} style={{
            flex: 1,
            background: i < filled ? color : 'var(--line-soft)',
            opacity: i < filled ? 1 : 0.4,
          }} />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Halftone background — radial-gradient dot pattern, opacity-tunable.
   ───────────────────────────────────────────────────────────────────── */
function HalftoneBg({ size = 8, opacity = 0.18, color = 'var(--fg)', style }) {
  const colorRgb = color === 'var(--paper)' ? '255,255,255' : '10,10,10';
  return (
    <div aria-hidden style={{
      position: 'absolute', inset: 0, pointerEvents: 'none',
      backgroundImage: `radial-gradient(circle, rgba(${colorRgb},${opacity}) 1px, transparent 1.4px)`,
      backgroundSize: `${size}px ${size}px`,
      ...style,
    }} />
  );
}

/* ─────────────────────────────────────────────────────────────────────
   ToolbarToggle — segmented control (mono caps)
   ───────────────────────────────────────────────────────────────────── */
function Segmented({ options, value, onChange, size = 'md' }) {
  const padY = size === 'sm' ? 4 : 6;
  const padX = size === 'sm' ? 8 : 12;
  const fz   = size === 'sm' ? 10 : 11;
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--fg)' }}>
      {options.map((opt, i) => {
        const v = opt.value !== undefined ? opt.value : opt;
        const l = opt.label !== undefined ? opt.label : opt;
        return (
          <button key={v} type="button" onClick={() => onChange(v)} style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: fz, letterSpacing: '0.06em', textTransform: 'uppercase',
            padding: `${padY}px ${padX}px`,
            border: 'none',
            borderRight: i < options.length - 1 ? '1px solid var(--fg)' : 'none',
            background: v === value ? 'var(--fg)' : 'transparent',
            color: v === value ? 'var(--bg)' : 'var(--fg)',
            cursor: 'pointer',
          }}>{l}</button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   AsciiHorse — small ASCII rendition of the horse for hero moments
   ───────────────────────────────────────────────────────────────────── */
const ASCII_HORSE = [
  "                        █▓▓                ",
  "                      ░██▓▓██░             ",
  "                     ▓████▓▓██▓            ",
  "                    ▓██████▓▓██▓           ",
  "                   ▓███████▓▓███           ",
  "                  ▓████████▓███▓           ",
  "                 ▓██████████████▓          ",
  "                ▓███████████████▓          ",
  "          ░░   ▓████████████████░          ",
  "         ▓██▓▓██████████████████           ",
  "        ▓███████████████████████░          ",
  "       ▓████████████████████████▓          ",
  "      ▓██████████████████████████          ",
  "     ▓███████████████████████████░         ",
  "    ▓██████████████   ███████████▓         ",
  "   ▓███████████░       ▓██████████▓        ",
  "  ▓██████████           ▓██████████▓       ",
  " ▓██████████             ▓██████████▓      ",
  "▓██████████               ▓██████████      ",
  " ▓████████                 ▓█████████▓     ",
  "  ▓██████                   ▓████████▓     ",
  "   ▓████                     ▓████████▓    ",
  "    ▓██                       ▓███████▓    ",
];

function AsciiHorse({ color = 'currentColor', fontSize = 8 }) {
  return (
    <pre style={{
      fontFamily: "'JetBrains Mono', monospace",
      fontSize, lineHeight: 1,
      color, margin: 0, letterSpacing: 0,
      whiteSpace: 'pre',
      userSelect: 'none',
    }}>{ASCII_HORSE.join('\n')}</pre>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Sparkline — tiny inline series, mono-colored bars
   ───────────────────────────────────────────────────────────────────── */
function Sparkline({ values, height = 28, color = 'var(--fg)' }) {
  const max = Math.max(1, ...values);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height }}>
      {values.map((v, i) => (
        <span key={i} style={{
          flex: 1,
          height: `${Math.max(2, (v / max) * 100)}%`,
          background: color,
          opacity: 0.85,
        }} />
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   ScrollPanel — scrollable inside a hard border
   ───────────────────────────────────────────────────────────────────── */
function Scroll({ children, maxHeight, style }) {
  return (
    <div style={{
      maxHeight,
      overflowY: 'auto',
      ...style,
    }}>{children}</div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Modal
   ───────────────────────────────────────────────────────────────────── */
function Modal({ open, onClose, children, width = 560, title }) {
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(10,10,10,0.6)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '80px 24px',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg)',
        color: 'var(--fg)',
        border: '1px solid var(--fg)',
        width: '100%', maxWidth: width,
      }}>
        {title && (
          <div style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--fg)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <Mono size={11} style={{ letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-2)' }}>{title}</Mono>
            <button type="button" onClick={onClose} style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--fg)', fontFamily: 'monospace', fontSize: 14,
            }}>✕</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Drawer — slides in from the right
   ───────────────────────────────────────────────────────────────────── */
function Drawer({ open, onClose, children, width = 720, title }) {
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, zIndex: 190,
        background: open ? 'rgba(10,10,10,0.5)' : 'transparent',
        pointerEvents: open ? 'auto' : 'none',
        transition: 'background 200ms',
      }} />
      <aside style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width, maxWidth: '100vw', zIndex: 195,
        background: 'var(--bg)', color: 'var(--fg)',
        borderLeft: '1px solid var(--fg)',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 240ms cubic-bezier(.22,1,.36,1)',
        display: 'flex', flexDirection: 'column',
      }}>
        {title && (
          <div style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--fg)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            <Mono size={11} style={{ letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-2)' }}>{title}</Mono>
            <button type="button" onClick={onClose} style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--fg)', fontFamily: 'monospace', fontSize: 14,
            }}>✕</button>
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
      </aside>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Tab strip
   ───────────────────────────────────────────────────────────────────── */
function Tabs({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--fg)' }}>
      {options.map(o => {
        const v = o.value !== undefined ? o.value : o;
        const l = o.label !== undefined ? o.label : o;
        return (
          <button key={v} type="button" onClick={() => onChange(v)} style={{
            background: v === value ? 'var(--fg)' : 'transparent',
            color: v === value ? 'var(--bg)' : 'var(--fg)',
            border: 'none',
            padding: '10px 18px',
            cursor: 'pointer',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase',
            borderRight: '1px solid var(--fg)',
          }}>{l}</button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Translation hook — reads i18n + lang from app context
   ───────────────────────────────────────────────────────────────────── */
const TensolCtx = React.createContext(null);
function useTensol() {
  const ctx = React.useContext(TensolCtx);
  if (!ctx) throw new Error('useTensol outside provider');
  return ctx;
}

Object.assign(window, {
  HorseMark, Wordmark, LogoLockup, Btn, Eyebrow, Mono,
  SeverityChip, StatusChip, Card, Field, Input, Textarea, Select,
  Checkbox, ProgressBar, HalftoneBg, Segmented, AsciiHorse, Sparkline,
  Scroll, Modal, Drawer, Tabs, TensolCtx, useTensol,
});
