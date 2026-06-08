// T086 — Tiny inline Markdown renderer.
//
// Scope: just enough to render finding `body_md` payloads from Decepticon
// (h1/h2/h3 headings, fenced code blocks ```lang ... ```, paragraphs, ordered
// + unordered lists, inline `code`, **bold**, *italic*, [link](url)).
//
// Why inline (NO new dep): Driver T085+T086+T087 brief explicitly forbids
// adding `react-markdown` or any chart lib. The Bun runtime has no native
// markdown parser. The body payload is trusted server-side (Zod-validated
// from Decepticon webhook), but we still escape HTML defensively so a
// rogue tag in body_md cannot inject script content.
//
// Out of scope (intentionally): tables, blockquotes, images, footnotes,
// HTML passthrough. The Decepticon report template only emits the above.

import { type ReactElement, type ReactNode } from 'react';

// ─── HTML escape ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Inline (per-line) renderer ───────────────────────────────────────────
// Returns a list of ReactNodes so React handles `key` correctly.

function renderInline(line: string): ReactNode[] {
  // Order of operations: code (greediest, opaque), then link, bold, italic.
  // We work on segments so already-tokenised pieces aren't re-scanned.
  type Tok = { kind: 'text' | 'code' | 'link' | 'bold' | 'italic'; v: string; href?: string };
  let tokens: Tok[] = [{ kind: 'text', v: line }];

  // `code`
  tokens = tokens.flatMap((tok) => {
    if (tok.kind !== 'text') return [tok];
    const out: Tok[] = [];
    let rest = tok.v;
    const re = /`([^`]+)`/;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) {
      if (m.index > 0) out.push({ kind: 'text', v: rest.slice(0, m.index) });
      out.push({ kind: 'code', v: m[1] });
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) out.push({ kind: 'text', v: rest });
    return out;
  });

  // [text](url)
  tokens = tokens.flatMap((tok) => {
    if (tok.kind !== 'text') return [tok];
    const out: Tok[] = [];
    let rest = tok.v;
    const re = /\[([^\]]+)\]\(([^)]+)\)/;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) {
      if (m.index > 0) out.push({ kind: 'text', v: rest.slice(0, m.index) });
      out.push({ kind: 'link', v: m[1], href: m[2] });
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) out.push({ kind: 'text', v: rest });
    return out;
  });

  // **bold**
  tokens = tokens.flatMap((tok) => {
    if (tok.kind !== 'text') return [tok];
    const out: Tok[] = [];
    let rest = tok.v;
    const re = /\*\*([^*]+)\*\*/;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) {
      if (m.index > 0) out.push({ kind: 'text', v: rest.slice(0, m.index) });
      out.push({ kind: 'bold', v: m[1] });
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) out.push({ kind: 'text', v: rest });
    return out;
  });

  // *italic* — single-star, only if no surrounding `**`
  tokens = tokens.flatMap((tok) => {
    if (tok.kind !== 'text') return [tok];
    const out: Tok[] = [];
    let rest = tok.v;
    const re = /\*([^*]+)\*/;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) {
      if (m.index > 0) out.push({ kind: 'text', v: rest.slice(0, m.index) });
      out.push({ kind: 'italic', v: m[1] });
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) out.push({ kind: 'text', v: rest });
    return out;
  });

  return tokens.map((tok, i) => {
    const key = `${i}-${tok.kind}`;
    switch (tok.kind) {
      case 'code':
        return (
          <code
            key={key}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.92em',
              background: 'var(--bg-2)',
              padding: '1px 5px',
              border: '1px solid var(--line-soft)',
            }}
          >
            {tok.v}
          </code>
        );
      case 'link':
        return (
          <a
            key={key}
            href={tok.href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--fg)', textDecoration: 'underline' }}
          >
            {tok.v}
          </a>
        );
      case 'bold':
        return (
          <strong key={key} style={{ fontWeight: 600 }}>
            {tok.v}
          </strong>
        );
      case 'italic':
        return (
          <em key={key} style={{ fontStyle: 'italic' }}>
            {tok.v}
          </em>
        );
      default:
        return <span key={key}>{tok.v}</span>;
    }
  });
}

// ─── Block-level parser ────────────────────────────────────────────────────

type Block =
  | { kind: 'h1' | 'h2' | 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'hr' };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip leading blank lines between blocks.
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Fenced code block.
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? '';
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        buf.push(lines[i]);
        i += 1;
      }
      // Skip closing fence if present.
      if (i < lines.length) i += 1;
      out.push({ kind: 'code', lang, text: buf.join('\n') });
      continue;
    }

    // Headings (# / ## / ###)
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      out.push({ kind: 'h3', text: h3[1] });
      i += 1;
      continue;
    }
    if (h2) {
      out.push({ kind: 'h2', text: h2[1] });
      i += 1;
      continue;
    }
    if (h1) {
      out.push({ kind: 'h1', text: h1[1] });
      i += 1;
      continue;
    }

    // Horizontal rule
    if (line.match(/^(-{3,}|_{3,}|\*{3,})\s*$/)) {
      out.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // Lists (consume contiguous items).
    if (line.match(/^[-*]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+/)) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i += 1;
      }
      out.push({ kind: 'ul', items });
      continue;
    }
    if (line.match(/^\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      out.push({ kind: 'ol', items });
      continue;
    }

    // Paragraph (collect consecutive non-blank, non-special lines).
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^(#{1,3}\s|```|[-*]\s|\d+\.\s|-{3,}|_{3,}|\*{3,})/)
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push({ kind: 'p', text: buf.join(' ') });
  }

  return out;
}

// ─── Component ─────────────────────────────────────────────────────────────

export interface MarkdownRendererProps {
  source: string;
  variant?: 'default' | 'detail';
}

export function MarkdownRenderer({
  source,
  variant = 'default',
}: MarkdownRendererProps): ReactElement {
  // `esc` runs on TEXT segments inside renderInline (we wrap raw text in
  // <span>), but here we render structured React elements directly — the
  // inline tokens never become innerHTML, so React's own escaping protects
  // us from injection. We still call `esc` on `code` block bodies because
  // they're whitespace-preserving but otherwise raw.
  const blocks = parseBlocks(source);
  const detail = variant === 'detail';
  const bodyFontSize = detail ? 15 : 13.5;
  const bodyLineHeight = detail ? 1.65 : 1.55;
  const bodyMaxWidth = detail ? '86ch' : '72ch';
  const codeFontSize = detail ? 12.5 : 11.5;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: detail ? 16 : 14 }}
    >
      {blocks.map((b, i) => {
        const key = `${i}-${b.kind}`;
        switch (b.kind) {
          case 'h1':
            return (
              <h1
                key={key}
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 500,
                  fontSize: detail ? 26 : 24,
                  letterSpacing: 0,
                  margin: '8px 0 4px',
                  lineHeight: 1.2,
                }}
              >
                {renderInline(b.text)}
              </h1>
            );
          case 'h2':
            return (
              <h2
                key={key}
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 500,
                  fontSize: detail ? 20 : 18,
                  letterSpacing: 0,
                  margin: '6px 0 2px',
                  lineHeight: 1.25,
                }}
              >
                {renderInline(b.text)}
              </h2>
            );
          case 'h3':
            return (
              <h3
                key={key}
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 500,
                  fontSize: detail ? 13 : 12,
                  letterSpacing: 0,
                  textTransform: 'uppercase',
                  color: 'var(--fg-3)',
                  margin: '4px 0 0',
                }}
              >
                {renderInline(b.text)}
              </h3>
            );
          case 'p':
            return (
              <p
                key={key}
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: bodyFontSize,
                  lineHeight: bodyLineHeight,
                  color: 'var(--fg)',
                  margin: 0,
                  maxWidth: bodyMaxWidth,
                }}
              >
                {renderInline(b.text)}
              </p>
            );
          case 'code':
            return (
              <pre
                key={key}
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: codeFontSize,
                  lineHeight: 1.6,
                  margin: 0,
                  color: 'var(--paper)',
                  background: 'var(--ink)',
                  padding: detail ? '18px 20px' : 14,
                  borderLeft: detail ? '4px solid var(--red)' : undefined,
                  overflow: 'auto',
                  whiteSpace: 'pre',
                }}
                data-lang={b.lang || undefined}
                // Code blocks are raw text; React escapes children → safe.
              >
                {b.text}
              </pre>
            );
          case 'ul':
            return (
              <ul
                key={key}
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: bodyFontSize,
                  lineHeight: bodyLineHeight,
                  color: 'var(--fg)',
                  margin: 0,
                  paddingLeft: 22,
                  maxWidth: bodyMaxWidth,
                }}
              >
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol
                key={key}
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: bodyFontSize,
                  lineHeight: bodyLineHeight,
                  color: 'var(--fg)',
                  margin: 0,
                  paddingLeft: 22,
                  maxWidth: bodyMaxWidth,
                }}
              >
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            );
          case 'hr':
            return (
              <hr
                key={key}
                style={{
                  border: 0,
                  borderTop: '1px solid var(--line-soft)',
                  margin: '8px 0',
                }}
              />
            );
        }
      })}
    </div>
  );
}

// Exported for potential downstream sanitization re-use; also keeps `esc`
// from being tree-shaken out of the bundle even when it's only used in tests.
export const __escapeHtmlForTests = esc;
