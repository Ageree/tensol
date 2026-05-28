import { Link, useNavigate } from 'react-router-dom';
import { RouteHead } from '../components/RouteHead.tsx';
import { TENSOL_I18N } from '../i18n.ts';

const t = TENSOL_I18N.en;
const brandText = (value: string): string => value.replaceAll('Tensol', 'Sthrip');

function ArrowIcon() {
  return (
    <svg className="minimal-arrow" viewBox="0 0 18 18" aria-hidden="true">
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

function PricingNav() {
  const navigate = useNavigate();

  return (
    <header className="minimal-nav">
      <Link className="minimal-wordmark" to="/" aria-label="STHRIP home">
        <img src="/assets/sthrip-wordmark-white.png" alt="STHRIP" />
      </Link>
      <nav className="minimal-nav-links" aria-label="Primary navigation">
        <Link to="/method">Method</Link>
        <a href="#pricing-faq">Evidence</a>
        <Link to="/pricing" aria-current="page">
          Pricing
        </Link>
        <button type="button" onClick={() => navigate('/login')}>
          Sign in
        </button>
      </nav>
    </header>
  );
}

function PricingHero() {
  const proof = ['Quick', 'Deep', 'scope first'];

  return (
    <section className="minimal-page-hero pricing-hero" aria-labelledby="pricing-title">
      <div className="minimal-page-hero-copy">
        <h1 id="pricing-title">{brandText(t.pricing.title)}</h1>
        <p>{brandText(t.pricing.sub)}</p>
        <ul className="minimal-proofline" aria-label="Pricing proof points">
          {proof.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function PricingPlans() {
  const navigate = useNavigate();

  return (
    <section className="minimal-section pricing-plans" aria-label="Pricing plans">
      <p className="pricing-positioning">{brandText(t.pricing.mythosPositioning)}</p>
      <div className="pricing-plan-grid">
        {t.pricing.plans.map((plan) => (
          <article key={plan.name} className="pricing-plan">
            <div className="pricing-plan-head">
              <h2>{brandText(plan.name)}</h2>
              <div>
                <strong>{brandText(plan.price)}</strong>
                <span>{brandText(plan.unit)}</span>
              </div>
              {plan.priceAlt ? <small>{brandText(plan.priceAlt)}</small> : null}
            </div>

            <p className="pricing-plan-claim">{brandText(plan.claim)}</p>

            <div className="pricing-plan-detail">
              <span>{brandText(t.pricing.bestForLabel)}</span>
              <p>{brandText(plan.bestFor)}</p>
            </div>

            <div className="pricing-plan-detail">
              <span>{brandText(t.pricing.depthLabel)}</span>
              <p>{brandText(plan.depth)}</p>
            </div>

            <button
              type="button"
              className="minimal-button minimal-button-secondary"
              onClick={() => navigate(plan.ctaHref ?? '/deep-inquiry')}
            >
              {brandText(plan.ctaLabel ?? t.pricing.contactCta)}
              <ArrowIcon />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function PricingFaq() {
  return (
    <section id="pricing-faq" className="minimal-section pricing-faq" aria-labelledby="pricing-faq-title">
      <div className="minimal-section-heading">
        <p>{brandText(t.pricing.faqTitle)}</p>
        <span>{t.pricing.faq.length} questions</span>
      </div>
      <div className="pricing-faq-grid">
        {t.pricing.faq.map((qa, index) => (
          <article key={qa.q} className="pricing-faq-item">
            <span>{String(index + 1).padStart(2, '0')}</span>
            <h2>{brandText(qa.q)}</h2>
            <p>{brandText(qa.a)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function PricingCta() {
  const navigate = useNavigate();

  return (
    <section className="minimal-closing minimal-page-closing" aria-label="Request pricing">
      <div>
        <p>{brandText(t.pricing.ctaTitle)}</p>
        <span>{brandText(t.pricing.ctaBody)}</span>
      </div>
      <button type="button" className="minimal-button minimal-button-secondary" onClick={() => navigate('/deep-inquiry')}>
        {brandText(t.pricing.ctaBtn)}
        <ArrowIcon />
      </button>
    </section>
  );
}

function PricingFooter() {
  return (
    <footer className="minimal-footer">
      <span>STHRIP</span>
      <span>(c) 2026</span>
      <a href="mailto:hello@sthrip.dev">hello@sthrip.dev</a>
    </footer>
  );
}

export default function Pricing() {
  return (
    <>
      <RouteHead
        title="Pricing - Sthrip"
        description="No hourly billing. AI-powered penetration testing at a fixed engagement scope."
        ogTitle="Pricing - Sthrip"
        ogDescription="No hourly billing. AI-powered penetration testing at a fixed engagement scope."
        ogImage="/assets/sthrip-noise-field.jpg"
      />
      <div className="minimal-marketing minimal-subpage" data-screen-label="11 Pricing - minimal">
        <SignalBackground />
        <div className="minimal-content">
          <PricingNav />
          <main className="minimal-page-main">
            <PricingHero />
            <PricingPlans />
            <PricingFaq />
            <PricingCta />
          </main>
          <PricingFooter />
        </div>
      </div>
    </>
  );
}
