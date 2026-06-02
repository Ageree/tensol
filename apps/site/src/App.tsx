import { Suspense, lazy, type ComponentType } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Placeholder } from './components/Placeholder.tsx';
import { TensolProvider } from './context.tsx';
import { MarketingPage } from './pages/Marketing.tsx';
import type { ScanWizardContainerProps } from './pages/scan-wizard/ScanWizardContainer.tsx';

// Lazy-loaded screens — files written by parallel agents.
// If a file is missing the lazy import will throw → caught by ErrorBoundary fallback.
const Login = lazy(() => safeImport(() => import('./pages/Login.tsx'), 'login'));
const Bootstrap = lazy(() => safeImport(() => import('./pages/Bootstrap.tsx'), 'bootstrap'));
const Invite = lazy(() => safeImport(() => import('./pages/Invite.tsx'), 'invite'));
const Dashboard = lazy(() => safeImport(() => import('./pages/Dashboard.tsx'), 'dashboard'));
const Live = lazy(() => safeImport(() => import('./pages/Live.tsx'), 'live'));
const Findings = lazy(() => safeImport(() => import('./pages/Findings.tsx'), 'findings'));
const FindingDetail = lazy(() =>
  safeImport(() => import('./pages/FindingDetail.tsx'), 'finding-detail'),
);
const Reports = lazy(() => safeImport(() => import('./pages/Reports.tsx'), 'reports'));
const Settings = lazy(() => safeImport(() => import('./pages/Settings.tsx'), 'settings'));
const ErrorScreen = lazy(() => safeImport(() => import('./pages/ErrorScreen.tsx'), 'errors'));
const Contact = lazy(() => safeImport(() => import('./pages/Contact.tsx'), 'contact'));
const Pricing = lazy(() => safeImport(() => import('./pages/Pricing.tsx'), 'pricing'));
const Trust = lazy(() => safeImport(() => import('./pages/Trust.tsx'), 'trust'));
const Legal = lazy(() => safeImport(() => import('./pages/Legal.tsx'), 'legal'));
const Blog = lazy(() => safeImport(() => import('./pages/Blog.tsx'), 'blog'));
const Solutions = lazy(() => safeImport(() => import('./pages/Solutions.tsx'), 'solutions'));
const Resources = lazy(() => safeImport(() => import('./pages/Resources.tsx'), 'resources'));
const DeepInquiry = lazy(() =>
  safeImport(() => import('./pages/DeepInquiry.tsx'), 'deep-inquiry'),
);
const DeepInquiryThankYou = lazy(() =>
  safeImport(
    () => import('./pages/DeepInquiryThankYou.tsx'),
    'deep-inquiry-thank-you',
  ),
);
const Reviews = lazy(() => safeImport(() => import('./pages/Reviews.tsx'), 'reviews'));
const ReviewDetail = lazy(() =>
  safeImport(() => import('./pages/ReviewDetail.tsx'), 'review-detail'),
);
// T021 — PR Review connect + repository selection (feature 004).
const ConnectGitHub = lazy(() =>
  safeImport(() => import('./pages/ConnectGitHub.tsx'), 'connect-github'),
);
const Repositories = lazy(() =>
  safeImport(() => import('./pages/Repositories.tsx'), 'repositories'),
);
const ScanWizard = lazy(() =>
  safeImport(
    () =>
      import('./pages/scan-wizard/ScanWizardContainer.tsx') as unknown as Promise<{
        default: ComponentType<unknown>;
      }>,
    'wizard',
  ),
) as unknown as ComponentType<ScanWizardContainerProps>;

function safeImport<T extends { default: React.ComponentType<unknown> }>(
  load: () => Promise<T>,
  route: string,
): Promise<T> {
  return load().catch(() => ({
    default: () => (
      <Placeholder
        route={route}
        title="Port pending"
        hint={`This screen has not been ported yet. The design lives at tensol-platform-design/project/src/. Source key: ${route}.`}
      />
    ),
  })) as Promise<T>;
}

const MarketingRoute = () => {
  const navigate = useNavigate();
  return <MarketingPage onSignIn={() => navigate('/login')} onDemo={() => navigate('/contact')} />;
};

export const App = () => (
  <TensolProvider defaultLang="en">
    <Suspense
      fallback={
        <Placeholder
          route="loading"
          title="Loading…"
          hint="Component lazy-loading from /pages/*.tsx"
        />
      }
    >
      <Routes>
        <Route path="/" element={<MarketingRoute />} />
        <Route path="/login" element={<Login />} />
        <Route path="/bootstrap" element={<Bootstrap />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/live" element={<Live />} />
        <Route path="/findings" element={<Findings />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/err/:kind" element={<ErrorScreen />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/trust" element={<Trust />} />
        <Route path="/legal/:kind" element={<Legal />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="/resources" element={<Resources />} />
        <Route path="/solutions" element={<Solutions />} />
        <Route path="/solutions/:productId" element={<Solutions />} />
        {/* T108 — US2 Deep audit lead-gen funnel. */}
        <Route path="/deep-inquiry" element={<DeepInquiry />} />
        <Route
          path="/deep-inquiry/thank-you"
          element={<DeepInquiryThankYou />}
        />
        {/* Reviews — PR Review + Whitebox Pentest (003-whitebox). */}
        <Route path="/reviews" element={<Reviews />} />
        <Route path="/reviews/:id" element={<ReviewDetail />} />
        {/* T021 — Connect GitHub + Repositories (feature 004). */}
        <Route path="/connect" element={<ConnectGitHub />} />
        <Route path="/repositories" element={<Repositories />} />
        {/* T083 — canonical Blackbox MVP scan routes. */}
        <Route path="/scan/new" element={<ScanWizard mode="create" />} />
        <Route
          path="/scan/new/:orderId/:step"
          element={<ScanWizard mode="edit" />}
        />
        <Route path="/scan/:id" element={<Live />} />
        <Route path="/scan/:id/findings" element={<Findings />} />
        <Route path="/scan/:id/findings/:findingId" element={<FindingDetail />} />
        <Route path="/scan/:id/report" element={<Reports />} />
        {/* Legacy aliases — keep existing /wizard/* links working. */}
        <Route path="/wizard/new" element={<ScanWizard mode="create" />} />
        <Route
          path="/wizard/:orderId/:step"
          element={<ScanWizard mode="edit" />}
        />
        <Route path="*" element={<Navigate to="/err/404" replace />} />
      </Routes>
    </Suspense>
  </TensolProvider>
);
