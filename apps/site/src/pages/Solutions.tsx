import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowIcon,
  FrameCorners,
  HudOverlay,
  MarketingFooter,
  MarketingNav,
  SignalBackground,
} from '../components/MarketingChrome.tsx';
import { RouteHead } from '../components/RouteHead.tsx';

const products = {
  blackbox: {
    label: 'Blackbox assessments',
    navLabel: 'Blackbox',
    title: 'Runtime security tests in hours, not weeks.',
    summary:
      'Sthrip tests live applications, APIs, and exposed infrastructure from the outside. Autonomous agents explore the surface, validators replay exploit paths, and your team receives only findings with proof.',
    cta: 'Start blackbox scan',
    ctaHref: '/scan/new',
    secondary: 'See pricing',
    secondaryHref: '/pricing',
    visualTitle: 'Runtime attack surface',
    diagnostics: ['surface map', 'auth flows', 'validated PoC', 'report-ready evidence'],
    metrics: ['HTTP replay', 'OOB callback', 'endpoint proof'],
  },
  whitebox: {
    label: 'Whitebox pentests',
    navLabel: 'Whitebox',
    title: 'White-box penetration tests in hours, not weeks.',
    summary:
      'Source code, routes, API specs, dependencies, and architecture notes give Sthrip the context needed to find business logic, authorization, and data-flow vulnerabilities that blackbox scans miss.',
    cta: 'Book whitebox audit',
    ctaHref: '/contact',
    secondary: 'Meet the team',
    secondaryHref: '/about',
    visualTitle: 'Source-backed exploit chain',
    diagnostics: ['code context', 'data flow trace', 'reachable sink', 'human review'],
    metrics: ['repo graph', 'auth boundary', 'fix prompt'],
  },
  'pr-review': {
    label: 'PR security review',
    navLabel: 'PR Review',
    title: 'Security review before risky code lands.',
    summary:
      'Sthrip reviews pull requests for exploitable changes before merge. It links findings to the exact diff, explains impact in developer language, and returns a fix-ready remediation path.',
    cta: 'Connect a repository',
    ctaHref: '/reviews',
    secondary: 'View resources',
    secondaryHref: '/resources',
    visualTitle: 'Pre-merge risk control',
    diagnostics: ['diff triage', 'reachable path', 'severity rationale', 'inline fix'],
    metrics: ['PR gate', 'CWE mapping', 'review score'],
  },
} as const;

type ProductId = keyof typeof products;

function isProductId(value: string | undefined): value is ProductId {
  return value != null && value in products;
}

function ProductVisual({ product }: { readonly product: (typeof products)[ProductId] }) {
  return (
    <div className="solution-visual" aria-label={`${product.navLabel} workflow preview`}>
      <FrameCorners />
      <div className="solution-visual-grid">
        <span>{product.visualTitle}</span>
        <button type="button" aria-label={`Preview ${product.navLabel}`}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m9 6 9 6-9 6V6Z" />
          </svg>
        </button>
      </div>
      <div className="solution-diagnostics">
        {product.diagnostics.map((item, index) => (
          <div key={item}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{item}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductPage({ productId }: { readonly productId: ProductId }) {
  const navigate = useNavigate();
  const product = products[productId];

  return (
    <>
      <RouteHead
        title={`${product.label} - Sthrip`}
        description={product.summary}
        ogTitle={`${product.label} - Sthrip`}
        ogDescription={product.summary}
        ogImage="/assets/sthrip-noise-field.jpg"
      />
      <main className="minimal-page-main">
        <section className="solution-hero" aria-labelledby="solution-title">
          <div className="solution-hero-copy">
            <span className="minimal-section-label">{product.label}</span>
            <h1 id="solution-title">{product.title}</h1>
            <p>{product.summary}</p>
            <div className="minimal-actions" aria-label={`${product.navLabel} actions`}>
              <button
                type="button"
                className="minimal-button minimal-button-primary"
                onClick={() => navigate(product.ctaHref)}
              >
                {product.cta}
                <ArrowIcon />
              </button>
              <button
                type="button"
                className="minimal-button minimal-button-secondary"
                onClick={() => navigate(product.secondaryHref)}
              >
                {product.secondary}
                <ArrowIcon />
              </button>
            </div>
          </div>
          <ProductVisual product={product} />
        </section>
        <section className="solution-metrics" aria-label={`${product.navLabel} delivery model`}>
          {product.metrics.map((metric) => (
            <article key={metric}>
              <FrameCorners />
              <span>{product.navLabel}</span>
              <h2>{metric}</h2>
              <p>
                Evidence stays tied to the target, source, and decision trail so security
                and engineering can prioritize without another alert queue.
              </p>
            </article>
          ))}
        </section>
      </main>
    </>
  );
}

function SolutionsIndex() {
  return (
    <>
      <RouteHead
        title="Solutions - Sthrip"
        description="Sthrip product pages for blackbox assessments, whitebox pentests, and PR security review."
        ogTitle="Solutions - Sthrip"
        ogDescription="Sthrip product pages for blackbox assessments, whitebox pentests, and PR security review."
        ogImage="/assets/sthrip-noise-field.jpg"
      />
      <main className="minimal-page-main">
        <section className="solution-index" aria-labelledby="solutions-title">
          <span className="minimal-section-label">SOLUTIONS</span>
          <h1 id="solutions-title">One security teammate for every shipping surface.</h1>
          <p>
            Choose the part of the delivery loop you want Sthrip to cover: live
            application testing, source-backed assessment, or pull-request review.
          </p>
          <div className="solution-index-grid">
            {Object.entries(products).map(([id, product]) => (
              <Link key={id} to={`/solutions/${id}`} className="solution-index-card">
                <FrameCorners />
                <span>{product.navLabel}</span>
                <h2>{product.title}</h2>
                <p>{product.summary}</p>
                <ArrowIcon />
              </Link>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}

export default function Solutions() {
  const { productId } = useParams();

  if (productId === undefined) {
    return (
      <div className="minimal-marketing minimal-subpage" data-screen-label="12 Solutions - index">
        <SignalBackground />
        <HudOverlay />
        <div className="minimal-content">
          <MarketingNav />
          <SolutionsIndex />
          <MarketingFooter />
        </div>
      </div>
    );
  }

  if (!isProductId(productId)) {
    return <Navigate to="/err/404" replace />;
  }

  return (
    <div className="minimal-marketing minimal-subpage" data-screen-label={`12 Solutions - ${productId}`}>
      <SignalBackground />
      <HudOverlay />
      <div className="minimal-content">
        <MarketingNav />
        <ProductPage productId={productId} />
        <MarketingFooter />
      </div>
    </div>
  );
}
