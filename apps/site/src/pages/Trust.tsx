import { type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RouteHead } from '../components/RouteHead.tsx';
import {
  ArrowIcon,
  FrameCorners,
  HudOverlay,
  MarketingFooter,
  MarketingNav,
  SignalBackground,
} from '../components/MarketingChrome.tsx';
import { useTensol } from '../context.tsx';

type AboutMetric = {
  readonly value: string;
  readonly label: string;
};

type AboutSignal = {
  readonly label: string;
  readonly value: string;
};

function AboutSignalPanel({ signals }: { readonly signals: readonly AboutSignal[] }) {
  return (
    <aside className="about-brand-panel" aria-label="Sthrip operating signals">
      <FrameCorners />
      <div className="about-logo-lockup">
        <img
          src="/assets/sthrip-logo-mark-white.png"
          alt=""
          aria-hidden="true"
        />
        <img src="/assets/sthrip-wordmark-white.png" alt="STHRIP" />
      </div>
      <div className="about-signal-grid">
        {signals.map((signal) => (
          <article key={signal.label}>
            <span>{signal.label}</span>
            <strong>{signal.value}</strong>
          </article>
        ))}
      </div>
    </aside>
  );
}

function AboutMetricRail({ metrics }: { readonly metrics: readonly AboutMetric[] }) {
  return (
    <div className="about-metric-rail" aria-label="Sthrip team model">
      {metrics.map((metric) => (
        <article key={metric.label}>
          <span>{metric.value}</span>
          <strong>{metric.label}</strong>
        </article>
      ))}
    </div>
  );
}

export default function Trust(): ReactNode {
  const navigate = useNavigate();
  const { t } = useTensol();
  const about = t.trustPage;

  return (
    <div className="minimal-marketing about-page" data-screen-label="About - team">
      <RouteHead
        title="About Sthrip - Team"
        description={about.sub}
        ogTitle="About Sthrip - Team"
        ogDescription={about.sub}
      />
      <SignalBackground />
      <HudOverlay />
      <div className="minimal-content">
        <MarketingNav onDemo={() => navigate('/contact')} />

        <main className="about-main">
          <section className="about-hero" aria-labelledby="about-title">
            <div className="about-hero-copy">
              <span className="minimal-kicker">{about.eyebrow}</span>
              <h1 id="about-title">{about.title}</h1>
              <p>{about.sub}</p>
              <div className="minimal-actions">
                <button
                  type="button"
                  className="minimal-button minimal-button-primary"
                  onClick={() => navigate('/contact')}
                >
                  {about.primaryCta}
                </button>
                <Link to="/solutions" className="minimal-button minimal-button-secondary">
                  {about.secondaryCta}
                  <ArrowIcon />
                </Link>
              </div>
            </div>
            <AboutSignalPanel signals={about.signals} />
          </section>

          <AboutMetricRail metrics={about.metrics} />

          <section className="about-section about-team-section" aria-labelledby="team-title">
            <div className="about-section-heading">
              <span className="minimal-kicker">{about.teamEyebrow}</span>
              <h2 id="team-title">{about.teamTitle}</h2>
              <p>{about.teamIntro}</p>
            </div>
            <div className="about-card-grid about-team-grid">
              {about.team.map((member, index) => (
                <article className="about-card about-person-card" key={member.name}>
                  <FrameCorners />
                  <span className="about-index">{String(index + 1).padStart(2, '0')}</span>
                  <h3>{member.name}</h3>
                  <strong>{member.role}</strong>
                  <p>{member.bio}</p>
                  <small>{member.focus}</small>
                </article>
              ))}
            </div>
          </section>

          <section className="about-section about-principles" aria-labelledby="principles-title">
            <div className="about-section-heading">
              <span className="minimal-kicker">{about.principlesEyebrow}</span>
              <h2 id="principles-title">{about.principlesTitle}</h2>
            </div>
            <div className="about-card-grid about-principle-grid">
              {about.principles.map((principle, index) => (
                <article className="about-card about-card-compact" key={principle.title}>
                  <span className="about-index">{String(index + 1).padStart(2, '0')}</span>
                  <h3>{principle.title}</h3>
                  <p>{principle.body}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="about-cta" aria-labelledby="about-cta-title">
            <span className="minimal-kicker">{about.ctaEyebrow}</span>
            <h2 id="about-cta-title">{about.ctaTitle}</h2>
            <p>{about.ctaBody}</p>
            <button
              type="button"
              className="minimal-button minimal-button-primary"
              onClick={() => navigate('/contact?topic=careers')}
            >
              {about.ctaBtn}
            </button>
          </section>
        </main>

        <MarketingFooter />
      </div>
    </div>
  );
}
