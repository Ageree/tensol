// Sthrip legal pages — privacy, terms, refund, dpa.
import { useEffect } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  FrameCorners,
  MarketingFooter,
  MarketingNav,
  SignalBackground,
} from '../components/MarketingChrome.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { useTensol } from '../context.tsx';

type LegalKind = 'privacy' | 'terms' | 'refund' | 'dpa';
const VALID_KINDS: ReadonlyArray<LegalKind> = ['privacy', 'terms', 'refund', 'dpa'];

const LEGAL_TITLES: Record<LegalKind, string> = {
  privacy: 'Privacy Policy — Sthrip',
  terms: 'Terms of Service — Sthrip',
  refund: 'Refund Policy — Sthrip',
  dpa: 'Data Processing Agreement — Sthrip',
};

function isValidKind(value: string | undefined): value is LegalKind {
  return !!value && (VALID_KINDS as ReadonlyArray<string>).includes(value);
}

function LegalKindNav({ kind }: { readonly kind: LegalKind }) {
  const { t } = useTensol();

  return (
    <nav className="legal-kind-nav" aria-label="Legal documents">
      {VALID_KINDS.map((item) => (
        <Link
          to={`/legal/${item}`}
          className={item === kind ? 'is-active' : undefined}
          key={item}
        >
          {t.legal[item].navLabel}
        </Link>
      ))}
    </nav>
  );
}

function LegalBody({ kind }: { readonly kind: LegalKind }) {
  const { t } = useTensol();
  const doc = t.legal[kind];

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace('#', '');
    if (!hash) return;
    const element = document.getElementById(hash);
    if (element) {
      requestAnimationFrame(() => element.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, [kind]);

  return (
    <main className="legal-main">
      <section className="legal-hero" aria-labelledby="legal-title">
        <FrameCorners />
        <span className="minimal-kicker">{doc.eyebrow}</span>
        <h1 id="legal-title">{doc.title}</h1>
        <p>{doc.intro}</p>
        <div className="legal-updated">{doc.updated}</div>
      </section>

      <div className="legal-layout">
        <aside className="legal-rail">
          <LegalKindNav kind={kind} />
          <div className="legal-rail-note">
            <span>CONTACT</span>
            <a href="mailto:hello@sthrip.dev">hello@sthrip.dev</a>
          </div>
        </aside>

        <article className="legal-document">
          {doc.sections.map((section, index) => (
            <section
              className="legal-section"
              id={section.anchor || undefined}
              key={`${section.h}-${index}`}
            >
              <span>{section.eyebrow}</span>
              <h2>{section.h}</h2>
              {section.p.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </section>
          ))}

          <div className="legal-tail">
            <p>{doc.tail}</p>
            <p>
              {t.footerLinks.contactQuestion}{' '}
              <a href="mailto:hello@sthrip.dev">hello@sthrip.dev</a>
            </p>
          </div>
        </article>
      </div>
    </main>
  );
}

export default function Legal() {
  const navigate = useNavigate();
  const { kind } = useParams<{ kind: string }>();

  if (!isValidKind(kind)) {
    return <Navigate to="/err/404" replace />;
  }

  return (
    <div className="minimal-marketing legal-page" data-screen-label={`legal-${kind}`}>
      <RouteHead
        title={LEGAL_TITLES[kind]}
        ogTitle={LEGAL_TITLES[kind]}
        ogImage="/assets/sthrip-noise-field.jpg"
      />
      <SignalBackground />
      <div className="minimal-content">
        <MarketingNav onDemo={() => navigate('/contact')} />
        <LegalBody kind={kind} />
        <MarketingFooter />
      </div>
    </div>
  );
}
