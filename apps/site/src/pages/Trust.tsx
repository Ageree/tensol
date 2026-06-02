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
import { StatusChip } from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';

function AboutBrandPanel() {
  return (
    <aside className="about-brand-panel" aria-label="Sthrip trust posture">
      <FrameCorners />
      <div className="about-logo-lockup">
        <img
          src="/assets/tensol-logo-mark-white.png"
          alt=""
          aria-hidden="true"
        />
        <img src="/assets/sthrip-wordmark-white.png" alt="STHRIP" />
      </div>
      <div className="about-signal-grid" aria-hidden="true">
        <span>AUTHZ</span>
        <span>REGION</span>
        <span>DPA</span>
        <span>AUDIT</span>
      </div>
      <p>
        Authorized assessments, source-code boundaries, evidence retention,
        and procurement-grade controls.
      </p>
    </aside>
  );
}

function AboutMetricRail() {
  return (
    <div className="about-metric-rail" aria-label="Trust operating model">
      {[
        ['01', 'authorized scope'],
        ['02', 'audit-ready evidence'],
        ['03', 'regional handling'],
      ].map(([index, label]) => (
        <article key={index}>
          <span>{index}</span>
          <strong>{label}</strong>
        </article>
      ))}
    </div>
  );
}

export default function Trust(): ReactNode {
  const navigate = useNavigate();
  const { t } = useTensol();
  const trust = t.trustPage;

  return (
    <div className="minimal-marketing about-page" data-screen-label="About — trust">
      <RouteHead
        title="About Sthrip — Trust & Governance"
        description={trust.sub}
        ogTitle="About Sthrip — Trust & Governance"
        ogDescription={trust.sub}
      />
      <SignalBackground />
      <HudOverlay />
      <div className="minimal-content">
        <MarketingNav onDemo={() => navigate('/contact')} />

        <main className="about-main">
          <section className="about-hero" aria-labelledby="about-title">
            <div className="about-hero-copy">
              <span className="minimal-kicker">ABOUT</span>
              <h1 id="about-title">{trust.title}</h1>
              <p>{trust.sub}</p>
              <div className="minimal-actions">
                <button
                  type="button"
                  className="minimal-button minimal-button-primary"
                  onClick={() => navigate('/contact')}
                >
                  {trust.ctaBtn}
                </button>
                <Link to="/solutions" className="minimal-button minimal-button-secondary">
                  Solutions
                  <ArrowIcon />
                </Link>
              </div>
            </div>
            <AboutBrandPanel />
          </section>

          <AboutMetricRail />

          <section className="about-section about-control-section" aria-labelledby="controls-title">
            <div className="about-section-heading">
              <span className="minimal-kicker">{trust.complianceEyebrow}</span>
              <h2 id="controls-title">{trust.complianceTitle}</h2>
            </div>
            <div className="about-card-grid about-card-grid-two">
              {trust.compliance.map((control) => (
                <article className="about-card" key={control.name}>
                  <FrameCorners />
                  <div className="about-card-title">
                    <h3>{control.name}</h3>
                    <StatusChip
                      status={control.statusLabel}
                      tone={control.statusTone as 'ok' | 'warn' | 'neutral'}
                      size="sm"
                    />
                  </div>
                  <p>{control.body}</p>
                  {control.caption ? <small>{control.caption}</small> : null}
                </article>
              ))}
            </div>
          </section>

          <section className="about-section" aria-labelledby="authz-title">
            <div className="about-section-heading">
              <span className="minimal-kicker">{trust.authzEyebrow}</span>
              <h2 id="authz-title">{trust.authzTitle}</h2>
            </div>
            <div className="about-card-grid about-card-grid-three">
              {trust.authz.map((item, index) => (
                <article className="about-card about-card-compact" key={item.t}>
                  <span className="about-index">{String(index + 1).padStart(2, '0')}</span>
                  <h3>{item.t}</h3>
                  <p>{item.d}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="about-section" aria-labelledby="data-title">
            <div className="about-section-heading">
              <span className="minimal-kicker">{trust.dataEyebrow}</span>
              <h2 id="data-title">{trust.dataTitle}</h2>
            </div>
            <div className="about-card-grid about-card-grid-two">
              {trust.data.map((item, index) => (
                <article className="about-card about-card-compact" key={item.t}>
                  <span className="about-index">{String(index + 1).padStart(2, '0')}</span>
                  <h3>{item.t}</h3>
                  <p>{item.d}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="about-section about-boundary" aria-labelledby="boundary-title">
            <div>
              <span className="minimal-kicker">{trust.boundaryEyebrow}</span>
              <h2 id="boundary-title">{trust.boundaryTitle}</h2>
            </div>
            <div className="about-boundary-grid">
              <article>
                <h3>{trust.boundaryIs}</h3>
                <ul>
                  {trust.boundaryIsList.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
              <article>
                <h3>{trust.boundaryIsNot}</h3>
                <ul>
                  {trust.boundaryIsNotList.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            </div>
          </section>

          <section className="about-section about-documents" aria-labelledby="docs-title">
            <div>
              <span className="minimal-kicker">{trust.docsEyebrow}</span>
              <h2 id="docs-title">{trust.docsTitle}</h2>
              <p>{trust.docsBody}</p>
            </div>
            <div className="about-document-actions">
              {trust.docsButtons.map((button) => (
                <button
                  type="button"
                  className="minimal-button minimal-button-secondary"
                  key={button.topic}
                  onClick={() => navigate(`/contact?topic=${button.topic}`)}
                >
                  {button.label}
                </button>
              ))}
            </div>
          </section>

          <section className="about-cta" aria-labelledby="about-cta-title">
            <span className="minimal-kicker">{trust.ctaEyebrow}</span>
            <h2 id="about-cta-title">{trust.ctaTitle}</h2>
            <p>{trust.ctaBody}</p>
            <button
              type="button"
              className="minimal-button minimal-button-primary"
              onClick={() => navigate('/contact')}
            >
              {trust.ctaBtn}
            </button>
          </section>
        </main>

        <MarketingFooter />
      </div>
    </div>
  );
}
