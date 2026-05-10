import type { ReactNode } from 'react';
import { Eyebrow } from './primitives.tsx';

/**
 * Placeholder used while the corresponding screen port is in progress.
 * Replace by the real screen file once the parallel-agent port lands.
 */
export const Placeholder = ({
  route,
  title,
  hint,
  children,
}: {
  route: string;
  title: string;
  hint?: string;
  children?: ReactNode;
}) => (
  <div
    style={{
      minHeight: '100vh',
      background: 'var(--paper)',
      color: 'var(--ink)',
      padding: '64px',
      display: 'flex',
      flexDirection: 'column',
      gap: 24,
    }}
  >
    <Eyebrow>{`// ${route} · port pending`}</Eyebrow>
    <h1
      style={{
        fontFamily: "'Space Grotesk', sans-serif",
        fontWeight: 500,
        fontSize: 56,
        lineHeight: 1.05,
        letterSpacing: '-0.02em',
        margin: 0,
      }}
    >
      {title}
    </h1>
    {hint && (
      <p
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 15,
          lineHeight: 1.55,
          color: 'var(--fg-2)',
          margin: 0,
          maxWidth: '70ch',
        }}
      >
        {hint}
      </p>
    )}
    {children}
  </div>
);
