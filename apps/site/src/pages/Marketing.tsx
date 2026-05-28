import { Link, useNavigate } from 'react-router-dom';
import { RouteHead } from '../components/RouteHead.tsx';

type MarketingPageProps = {
  onSignIn?: () => void;
  onDemo?: () => void;
};

const capabilityItems = [
  {
    title: 'Coverage',
    text: 'APIs, web apps, mobile surfaces, cloud, containers, infrastructure, and supply-chain edges.',
  },
  {
    title: 'Control',
    text: 'Runs only inside signed scope. Full confidentiality. Every action is written into the audit trail.',
  },
  {
    title: 'Evidence',
    text: 'Every finding is reproducible. Reports are structured around proof, risk, and remediation.',
  },
] as const;

const proofPoints = ['48 hours', 'signed scope', 'audit log'] as const;

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 18 18"
      className="minimal-arrow"
      focusable="false"
    >
      <path d="M3 9h11" />
      <path d="m10 5 4 4-4 4" />
    </svg>
  );
}

function SignalBackground() {
  return (
    <div className="minimal-bg" aria-hidden="true">
      <div className="minimal-bg-image minimal-bg-image-primary" />
      <div className="minimal-bg-image minimal-bg-image-secondary" />
      <div className="minimal-bg-fade" />
      <div className="minimal-scanline" />
    </div>
  );
}

function MarketingNav({ onSignIn }: { onSignIn?: () => void }) {
  const navigate = useNavigate();
  const signIn = () => {
    if (onSignIn) {
      onSignIn();
      return;
    }
    navigate('/login');
  };

  return (
    <header className="minimal-nav">
      <Link to="/" className="minimal-wordmark" aria-label="STHRIP">
        <img src="/assets/sthrip-wordmark-white.png" alt="STHRIP" />
      </Link>
      <nav className="minimal-nav-links" aria-label="Primary navigation">
        <Link to="/method">Method</Link>
        <a href="#proof">Evidence</a>
        <Link to="/pricing">Pricing</Link>
        <button type="button" onClick={signIn}>
          Sign in
        </button>
      </nav>
    </header>
  );
}

function MarketingHero() {
  const navigate = useNavigate();

  return (
    <section className="minimal-hero" aria-labelledby="minimal-hero-title">
      <div className="minimal-hero-copy">
        <h1 id="minimal-hero-title">
          AI can break in
          <span>within hours.</span>
        </h1>
        <p>
          Sthrip runs autonomous AI penetration tests inside signed scope.
          Every action is recorded. Every finding is reproducible.
        </p>
        <div className="minimal-actions" aria-label="Primary actions">
          <button type="button" className="minimal-button minimal-button-primary" onClick={() => navigate('/scan/new')}>
            Try Quick
            <ArrowIcon />
          </button>
          <button
            type="button"
            className="minimal-button minimal-button-secondary"
            onClick={() => navigate('/deep-inquiry')}
          >
            Request Deep audit
            <ArrowIcon />
          </button>
        </div>
        <ul className="minimal-proofline" aria-label="Key terms">
          {proofPoints.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function CapabilitySection() {
  return (
    <section className="minimal-capabilities" aria-label="What Sthrip covers">
      {capabilityItems.map((item) => (
        <article key={item.title} className="minimal-capability">
          <h2>{item.title}</h2>
          <p>{item.text}</p>
        </article>
      ))}
    </section>
  );
}

function ProofSection() {
  return (
    <section id="proof" className="minimal-proof" aria-labelledby="minimal-proof-title">
      <div>
        <h2 id="minimal-proof-title">Evidence instead of promises.</h2>
      </div>
      <p>
        Each report is built around reproduction: request, response, context,
        risk, remediation, and an immutable history of agent actions.
      </p>
    </section>
  );
}

function ClosingCta() {
  const navigate = useNavigate();

  return (
    <section className="minimal-closing" aria-label="Start an assessment">
      <p>Ready to test your perimeter?</p>
      <button type="button" className="minimal-button minimal-button-secondary" onClick={() => navigate('/scan/new')}>
        Try Quick
        <ArrowIcon />
      </button>
    </section>
  );
}

function MarketingFooter() {
  return (
    <footer className="minimal-footer">
      <span>STHRIP</span>
      <span>© 2026</span>
      <a href="mailto:hello@sthrip.dev">hello@sthrip.dev</a>
    </footer>
  );
}

export function MarketingPage({ onSignIn }: MarketingPageProps) {
  return (
    <>
      <RouteHead
        title="Sthrip — Authorized AI penetration testing"
        description="Autonomous AI penetration testing inside signed scope: every action is recorded, every finding is reproducible."
        ogTitle="Sthrip — Authorized AI penetration testing"
        ogDescription="Autonomous AI penetration testing inside signed scope: every action is recorded, every finding is reproducible."
        ogImage="/assets/sthrip-noise-field.jpg"
      />
      <div className="minimal-marketing" data-screen-label="01 Marketing — minimal landing">
        <SignalBackground />
        <div className="minimal-content">
          <MarketingNav onSignIn={onSignIn} />
          <main>
            <MarketingHero />
            <CapabilitySection />
            <ProofSection />
            <ClosingCta />
          </main>
          <MarketingFooter />
        </div>
      </div>
    </>
  );
}
