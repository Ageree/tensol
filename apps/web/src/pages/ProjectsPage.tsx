import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';
import { type Project, createProject, listProjects } from '../api/projects.ts';

interface Props {
  onProjectClick: (id: string) => void;
}

export const ProjectsPage = ({ onProjectClick }: Props) => {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await createProject({ name, description: desc });
      setName('');
      setDesc('');
      await refetch();
    } finally {
      setCreating(false);
    }
  };

  if (isLoading) return <p data-testid="projects-loading">Loading...</p>;
  if (error) return <p data-testid="projects-error">Failed to load projects</p>;

  const projects: Project[] = data?.projects ?? [];

  return (
    <div data-testid="projects-page">
      <h1>Projects</h1>
      <form onSubmit={handleCreate} data-testid="create-project-form">
        <input
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          data-testid="project-name-input"
        />
        <input
          placeholder="Description"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          data-testid="project-desc-input"
        />
        <button type="submit" disabled={creating} data-testid="create-project-submit">
          {creating ? 'Creating...' : 'Create project'}
        </button>
      </form>

      <ul data-testid="project-list">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onProjectClick(p.id)}
              data-testid={`project-item-${p.id}`}
            >
              {p.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
