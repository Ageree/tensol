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

function MinimalNav() {
  const navigate = useNavigate();

  return (
    <header className="minimal-nav">
      <Link className="minimal-wordmark" to="/" aria-label="STHRIP home">
        <img src="/assets/sthrip-wordmark-white.png" alt="STHRIP" />
      </Link>
      <nav className="minimal-nav-links" aria-label="Primary navigation">
        <Link to="/method" aria-current="page">
          Method
        </Link>
        <a href="#method-evidence">Evidence</a>
        <Link to="/pricing">Pricing</Link>
        <button type="button" onClick={() => navigate('/login')}>
          Sign in
        </button>
      </nav>
    </header>
  );
}

function MethodHero() {
  const proof = ['5 phases', 'signed scope', 'signed audit log'];

  return (
    <section className="minimal-page-hero method-hero" aria-labelledby="method-title">
      <div className="minimal-page-hero-copy">
        <h1 id="method-title">{brandText(t.methodTitle)}</h1>
        <p>{brandText(t.methodIntro)}</p>
        <ul className="minimal-proofline" aria-label="Method proof points">
          {proof.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function MethodPipeline() {
  return (
    <section className="minimal-section method-pipeline" aria-label={brandText(t.methodPipelineTitle)}>
      <div className="minimal-section-heading">
        <p>{brandText(t.methodPipelineTitle)}</p>
        <span>{brandText(t.methodPipelineMeta)}</span>
      </div>
      <div className="method-timeline">
        {t.methodPhases.map((phase) => (
          <article key={phase.phase} className="method-timeline-item">
            <span>{phase.phase}</span>
            <h2>{brandText(phase.name)}</h2>
            <p>{brandText(phase.claim)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function MethodPhaseRows() {
  const labels = { phase: 'Phase', what: 'What happens', hard: 'Why this is hard', agent: 'What Sthrip does' };

  return (
    <section className="minimal-section method-phase-list" aria-label="Method phases">
      {t.methodPhases.map((phase) => (
        <article key={phase.phase} className="method-phase-row">
          <div className="method-phase-index">
            <span>
              {labels.phase} {phase.phase}
            </span>
            <h2>{brandText(phase.name)}</h2>
            <p>{brandText(phase.claim)}</p>
          </div>
          <div className="method-phase-body">
            <div>
              <span>{labels.what}</span>
              <p>{brandText(phase.what)}</p>
            </div>
            <div>
              <span>{labels.hard}</span>
              <p>{brandText(phase.hard)}</p>
            </div>
            <div>
              <span>{labels.agent}</span>
              <p>{brandText(phase.tensol)}</p>
            </div>
          </div>
        </article>
      ))}
    </section>
  );
}

function MethodEvidence() {
  const evidence = [
    ['01', 'Replay', 'Every chain is replayed by a separate validator before it reaches the report.'],
    ['02', 'Artifacts', 'Request, response, screenshot, callback, and evidence hash stay together.'],
    ['03', 'Audit', 'Every agent action is preserved in a signed log for your team and auditor.'],
  ];

  return (
    <section id="method-evidence" className="minimal-section method-evidence" aria-label="Evidence model">
      {evidence.map(([index, title, body]) => (
        <article key={index}>
          <span>{index}</span>
          <h2>{title}</h2>
          <p>{body}</p>
        </article>
      ))}
    </section>
  );
}

function MethodCta() {
  const navigate = useNavigate();

  return (
    <section className="minimal-closing minimal-page-closing" aria-label="Start an assessment">
      <div>
        <p>{brandText(t.methodCtaTitle)}</p>
        <span>{brandText(t.methodCtaBody)}</span>
      </div>
      <button type="button" className="minimal-button minimal-button-secondary" onClick={() => navigate('/contact')}>
        {brandText(t.methodCtaBtn)}
        <ArrowIcon />
      </button>
    </section>
  );
}

function MinimalFooter() {
  return (
    <footer className="minimal-footer">
      <span>STHRIP</span>
      <span>(c) 2026</span>
      <a href="mailto:hello@sthrip.dev">hello@sthrip.dev</a>
    </footer>
  );
}

export default function Method() {
  return (
    <>
      <RouteHead
        title="Sthrip - Method"
        description="The Sthrip authorized AI penetration testing pipeline: perimeter, recon, exploitation, validation, report."
        ogImage="/assets/sthrip-noise-field.jpg"
      />
      <div className="minimal-marketing minimal-subpage" data-screen-label="03 Method - minimal">
        <SignalBackground />
        <div className="minimal-content">
          <MinimalNav />
          <main className="minimal-page-main">
            <MethodHero />
            <MethodPipeline />
            <MethodPhaseRows />
            <MethodEvidence />
            <MethodCta />
          </main>
          <MinimalFooter />
        </div>
      </div>
    </>
  );
}
