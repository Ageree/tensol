import { Link, useNavigate } from 'react-router-dom';
import {
  FrameCorners,
  MarketingFooter,
  MarketingNav,
  SignalBackground,
} from '../components/MarketingChrome.tsx';
import { RouteHead } from '../components/RouteHead.tsx';

const RESOURCE_CARDS = [
  {
    label: 'TRUST CENTER',
    title: 'Controls and operating boundaries',
    body: 'Authorization, data handling, evidence retention, and deployment posture.',
    href: '/trust',
  },
  {
    label: 'PRIVACY',
    title: 'Privacy policy',
    body: 'What we collect, why we collect it, and how Sthrip handles personal data.',
    href: '/legal/privacy',
  },
  {
    label: 'LEGAL',
    title: 'Terms and data processing',
    body: 'Acceptable use, service terms, and DPA references for procurement.',
    href: '/legal/terms',
  },
];

export default function Resources() {
  const navigate = useNavigate();

  return (
    <div className="minimal-marketing resources-page" data-screen-label="Resources">
      <RouteHead
        title="Resources — Sthrip"
        description="Sthrip trust, privacy, legal, and product resources."
        ogTitle="Resources — Sthrip"
        ogDescription="Sthrip trust, privacy, legal, and product resources."
      />
      <SignalBackground />
      <div className="minimal-content">
        <MarketingNav onDemo={() => navigate('/contact')} />
        <main className="resources-main">
          <section className="resources-hero">
            <span className="minimal-kicker">RESOURCES</span>
            <h1>Documents without the old-site detour.</h1>
            <p>
              Product references, trust material, privacy terms, and the policies
              your team needs before running an assessment.
            </p>
          </section>
          <section className="resources-grid" aria-label="Resource links">
            {RESOURCE_CARDS.map((item, index) => (
              <Link to={item.href} className="resources-card" key={item.href}>
                <FrameCorners />
                <span>{String(index + 1).padStart(2, '0')} · {item.label}</span>
                <h2>{item.title}</h2>
                <p>{item.body}</p>
              </Link>
            ))}
          </section>
        </main>
        <MarketingFooter />
      </div>
    </div>
  );
}
