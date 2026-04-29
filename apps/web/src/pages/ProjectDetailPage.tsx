import { useQuery } from '@tanstack/react-query';
import { listAssessments } from '../api/assessments.ts';
import { getProject } from '../api/projects.ts';

interface Props {
  projectId: string;
  onAssessmentClick: (id: string) => void;
}

export const ProjectDetailPage = ({ projectId, onAssessmentClick }: Props) => {
  const { data: projectData, isLoading: loadingProject } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  });

  const { data: assessmentsData, isLoading: loadingAssessments } = useQuery({
    queryKey: ['assessments', projectId],
    queryFn: () => listAssessments(projectId),
  });

  if (loadingProject || loadingAssessments)
    return <p data-testid="project-detail-loading">Loading...</p>;

  const project = projectData?.project;
  const assessments = assessmentsData?.assessments ?? [];

  return (
    <div data-testid="project-detail-page">
      <h1>{project?.name ?? 'Project'}</h1>
      <p>{project?.description}</p>

      <h2>Assessments</h2>
      {assessments.length === 0 ? (
        <p data-testid="no-assessments">No assessments yet</p>
      ) : (
        <ul data-testid="assessment-list">
          {assessments.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onAssessmentClick(a.id)}
                data-testid={`assessment-item-${a.id}`}
              >
                {a.id} — {a.state}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
