import { useNavigate } from 'react-router-dom';
import {
  ArrowIcon,
  HudOverlay,
  MarketingFooter,
  MarketingNav,
  SignalBackground,
} from '../components/MarketingChrome.tsx';
import { RouteHead } from '../components/RouteHead.tsx';
import { TENSOL_I18N } from '../i18n.ts';

const t = TENSOL_I18N.en;
const brandText = (value: string): string => value;

function PricingHero() {
  return (
    <section className="minimal-page-hero pricing-hero" aria-labelledby="pricing-title">
      <div className="minimal-page-hero-copy">
        <h1 id="pricing-title">{brandText(t.pricing.title)}</h1>
      </div>
    </section>
  );
}

function PricingPlans() {
  const navigate = useNavigate();

  return (
    <section className="minimal-section pricing-plans" aria-label="Pricing plans">
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
              onClick={() => navigate(plan.ctaHref ?? '/contact')}
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
      <button type="button" className="minimal-button minimal-button-secondary" onClick={() => navigate('/contact')}>
        {brandText(t.pricing.ctaBtn)}
        <ArrowIcon />
      </button>
    </section>
  );
}

export default function Pricing() {
  return (
    <>
      <RouteHead
        title="Pricing - Sthrip"
        description="Pricing for Sthrip blackbox scans, whitebox assessments, PR security review, and enterprise offensive security coverage."
        ogTitle="Pricing - Sthrip"
        ogDescription="Pricing for Sthrip blackbox scans, whitebox assessments, PR security review, and enterprise offensive security coverage."
        ogImage="/assets/sthrip-noise-field.jpg"
      />
      <div className="minimal-marketing minimal-subpage" data-screen-label="11 Pricing - minimal">
        <SignalBackground />
        <HudOverlay />
        <div className="minimal-content">
          <MarketingNav />
          <main className="minimal-page-main">
            <PricingHero />
            <PricingPlans />
            <PricingFaq />
            <PricingCta />
          </main>
          <MarketingFooter />
        </div>
      </div>
    </>
  );
}
