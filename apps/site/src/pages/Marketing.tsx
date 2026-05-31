import { Link, useNavigate } from 'react-router-dom';
import {
  FrameCorners,
  HudOverlay,
  MarketingFooter,
  MarketingNav,
  SignalBackground,
  SOLUTION_ITEMS,
} from '../components/MarketingChrome.tsx';
import { RouteHead } from '../components/RouteHead.tsx';

type MarketingPageProps = {
  onSignIn?: () => void;
  onDemo?: () => void;
};

const trustCards = [
  {
    label: 'Runtime apps',
    value: 'BLACKBOX',
    meta: 'proven HTTP evidence',
  },
  {
    label: 'Source repos',
    value: 'WHITEBOX',
    meta: 'code-backed exploit paths',
  },
  {
    label: 'Pull requests',
    value: 'PR REVIEW',
    meta: 'pre-merge risk control',
  },
] as const;

const testimonialItems = [
  {
    quote:
      'Sthrip turned a noisy assessment queue into a short list of exploitable issues our developers could replay and fix.',
    person: 'Security Lead',
    company: 'Fintech platform',
    mark: '01',
  },
  {
    quote:
      'The useful part was not more scanning. It was source context, proof, and remediation notes in one delivery loop.',
    person: 'Engineering Director',
    company: 'SaaS infrastructure',
    mark: '02',
  },
  {
    quote:
      'PR review caught the risky authorization change before it hit production and gave the team the exact fix shape.',
    person: 'Platform Owner',
    company: 'Marketplace team',
    mark: '03',
  },
] as const;

function MarketingHero() {
  return (
    <section className="minimal-hero" aria-labelledby="minimal-hero-title">
      <div className="minimal-hero-copy">
        <span className="minimal-section-label">ABOUT</span>
        <div className="minimal-hero-panel">
          <FrameCorners />
          <h1 id="minimal-hero-title">
            Stop chasing alerts.
            <span>Start fixing what&apos;s real.</span>
          </h1>
          <div className="minimal-hero-body">
            <p>You probably use lots of security tools.</p>
            <p>You probably get lots of alerts.</p>
            <p>You probably spend lots of time chasing them down.</p>
            <p>
              <strong>But in the end, how many of them were actually worth your time?</strong>
            </p>
            <p>
              Sthrip finds exploitable vulnerabilities across runtime, source code,
              and pull requests so your team can fix what matters.
            </p>
            <p>
              Built for authorized security work, we operate by one principle:
              proof first, noise last.
            </p>
          </div>
        </div>
      </div>
      <aside className="minimal-trust-rail" aria-label="Sthrip coverage">
        <span className="minimal-section-label">BUILT FOR</span>
        {trustCards.map((card) => (
          <Link key={card.value} to={SOLUTION_ITEMS.find((item) => item.label.toUpperCase() === card.value)?.href ?? '/solutions'} className="minimal-trust-card">
            <FrameCorners />
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.meta}</small>
          </Link>
        ))}
      </aside>
    </section>
  );
}

function ProofSection() {
  return (
    <section id="testimonials" className="minimal-proof" aria-labelledby="minimal-proof-title">
      <div className="minimal-proof-heading">
        <span className="minimal-section-label">TESTIMONIALS</span>
        <h2 id="minimal-proof-title">We protect teams building tomorrow</h2>
        <p>
          When you ship the future, you do not get second chances. Sthrip keeps
          the workflow focused on verified risk and developer-ready fixes.
        </p>
      </div>
      <div className="minimal-testimonial-grid">
        {testimonialItems.map((item) => (
          <article key={item.mark} className="minimal-testimonial">
            <FrameCorners />
            <span aria-hidden="true" className="minimal-quote-mark">
              &quot;
            </span>
            <blockquote>{item.quote}</blockquote>
            <footer>
              <span>{item.mark}</span>
              <div>
                <strong>{item.person}</strong>
                <small>{item.company}</small>
              </div>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

function ClosingCta() {
  const navigate = useNavigate();

  return (
    <section className="minimal-closing" aria-label="Start an assessment">
      <div>
        <p>Ready to see what an AI security teammate would find?</p>
      </div>
      <button
        type="button"
        className="minimal-button minimal-button-primary minimal-closing-cta"
        onClick={() => navigate('/scan/new')}
      >
        Run first assessment
      </button>
    </section>
  );
}

export function MarketingPage({ onDemo }: MarketingPageProps) {
  return (
    <>
      <RouteHead
        title="Sthrip - AI offensive security for blackbox, whitebox, and PR review"
        description="Find exploitable vulnerabilities across running applications, APIs, source code, and pull requests with proof-first AI security assessments."
        ogTitle="Sthrip - AI offensive security for blackbox, whitebox, and PR review"
        ogDescription="Find exploitable vulnerabilities across running applications, APIs, source code, and pull requests with proof-first AI security assessments."
        ogImage="/assets/sthrip-noise-field.jpg"
      />
      <div className="minimal-marketing" data-screen-label="01 Marketing - hacktron structure">
        <SignalBackground />
        <HudOverlay />
        <div className="minimal-content">
          <MarketingNav onDemo={onDemo} />
          <main>
            <MarketingHero />
            <ProofSection />
            <ClosingCta />
          </main>
          <MarketingFooter />
        </div>
      </div>
    </>
  );
}
