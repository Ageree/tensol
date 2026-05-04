import type React from 'react';

interface Props {
  children: React.ReactNode;
  email: string;
  role: string;
  onLogout: () => void;
}

export const ProtectedLayout = ({ children, email, role, onLogout }: Props) => {
  return (
    <div data-testid="protected-layout">
      <nav data-testid="app-nav" className="flex items-center justify-between p-4 border-b">
        <span className="font-semibold">CyberStrike</span>
        <span data-testid="current-user">
          {email} ({role})
        </span>
        <button type="button" onClick={onLogout} data-testid="logout-btn">
          Logout
        </button>
      </nav>
      <main className="p-4">{children}</main>
    </div>
  );
};
