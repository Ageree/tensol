import { Link, useNavigate } from 'react-router-dom';
import { RouteHead } from '../components/RouteHead.tsx';

type MarketingPageProps = {
  onSignIn?: () => void;
  onDemo?: () => void;
};

const capabilityItems = [
  {
    title: 'Blackbox assessments',
    text: 'Autonomous agents test your live application, APIs, and external attack surface from the outside, then keep only findings they can prove.',
  },
  {
    title: 'Whitebox testing',
    text: 'Source code, API specs, and architecture notes give the agent context to reason about business logic, auth boundaries, and hidden attack paths.',
  },
  {
    title: 'PR security review',
    text: 'Continuous review for security-sensitive pull requests, with exploitable risk explained inline before vulnerable code reaches production.',
  },
] as const;

const proofPoints = ['blackbox + whitebox', 'proof-first findings', 'human-reviewed delivery'] as const;

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
      <Link to="/" className="minimal-wordmark minimal-wordmark-with-mark" aria-label="STHRIP">
        <img
          className="minimal-wordmark-mark"
          src="/assets/tensol-logo-mark-white.png"
          alt=""
          aria-hidden="true"
        />
        <img className="minimal-wordmark-type" src="/assets/sthrip-wordmark-white.png" alt="STHRIP" />
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
          AI offensive security
          <span>for teams that ship fast.</span>
        </h1>
        <p>
          Sthrip finds exploitable vulnerabilities across running products and source code.
          Autonomous agents investigate like attackers, validators prove impact, and your team
          gets the evidence needed to fix what matters.
        </p>
        <div className="minimal-actions" aria-label="Primary actions">
          <button type="button" className="minimal-button minimal-button-primary" onClick={() => navigate('/scan/new')}>
            Start blackbox scan
            <ArrowIcon />
          </button>
          <button
            type="button"
            className="minimal-button minimal-button-secondary"
            onClick={() => navigate('/deep-inquiry')}
          >
            Book whitebox assessment
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
        <h2 id="minimal-proof-title">Real vulnerabilities, not alert volume.</h2>
      </div>
      <p>
        Sthrip reports are built around proof: exploit path, request and response,
        affected code or endpoint, business impact, remediation guidance, and an audit
        trail your security team can replay.
      </p>
    </section>
  );
}

function ClosingCta() {
  const navigate = useNavigate();

  return (
    <section className="minimal-closing" aria-label="Start an assessment">
      <p>Ready to see what an AI security teammate would find?</p>
      <button type="button" className="minimal-button minimal-button-secondary" onClick={() => navigate('/scan/new')}>
        Run first assessment
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
        title="Sthrip — AI offensive security for blackbox and whitebox testing"
        description="Find exploitable vulnerabilities across running applications, APIs, and source code with proof-first AI security assessments."
        ogTitle="Sthrip — AI offensive security for blackbox and whitebox testing"
        ogDescription="Find exploitable vulnerabilities across running applications, APIs, and source code with proof-first AI security assessments."
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
