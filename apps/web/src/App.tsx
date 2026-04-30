import { useState } from 'react';
import { useAuth } from './auth/context.tsx';
import { AssessmentPage } from './pages/AssessmentPage.tsx';
import { AssessmentTimelinePage } from './pages/AssessmentTimelinePage.tsx';
import { EvidenceViewerPage } from './pages/EvidenceViewerPage.tsx';
import { FindingDetailPage } from './pages/FindingDetailPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { ProjectDetailPage } from './pages/ProjectDetailPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { TargetCredentialsPage } from './pages/TargetCredentialsPage.tsx';

type Route =
  | { name: 'login' }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'assessment'; id: string }
  | { name: 'assessment-timeline'; id: string }
  | { name: 'finding'; id: string }
  | { name: 'evidence'; id: string }
  | { name: 'target-credentials'; id: string };

export const App = () => {
  const { user, loading, logout } = useAuth();
  const [route, setRoute] = useState<Route>({ name: 'projects' });

  if (loading) return <p data-testid="app-loading">Loading...</p>;

  if (!user) {
    return <LoginPage onSuccess={() => setRoute({ name: 'projects' })} />;
  }

  const nav = (r: Route) => setRoute(r);

  return (
    <div data-testid="app">
      <nav data-testid="app-nav">
        <button type="button" onClick={() => nav({ name: 'projects' })}>
          Projects
        </button>
        <span data-testid="current-user">
          {user.email} ({user.role})
        </span>
        <button type="button" onClick={logout} data-testid="logout-btn">
          Logout
        </button>
      </nav>

      {route.name === 'projects' && (
        <ProjectsPage onProjectClick={(id) => nav({ name: 'project', id })} />
      )}
      {route.name === 'project' && (
        <ProjectDetailPage
          projectId={route.id}
          onAssessmentClick={(id) => nav({ name: 'assessment', id })}
        />
      )}
      {route.name === 'assessment' && (
        <AssessmentPage
          assessmentId={route.id}
          onFindingClick={(id) => nav({ name: 'finding', id })}
        />
      )}
      {route.name === 'assessment-timeline' && (
        <AssessmentTimelinePage assessmentId={route.id} kind="all" />
      )}
      {route.name === 'finding' && (
        <FindingDetailPage
          findingId={route.id}
          onEvidenceClick={(id) => nav({ name: 'evidence', id })}
        />
      )}
      {route.name === 'evidence' && <EvidenceViewerPage evidenceId={route.id} />}
      {route.name === 'target-credentials' && <TargetCredentialsPage targetId={route.id} />}
    </div>
  );
};
