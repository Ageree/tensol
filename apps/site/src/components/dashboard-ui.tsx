import {
  FileText,
  Search,
  type LucideIcon,
} from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';

type ClassValue = string | false | null | undefined;

function cx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}

export const DASHBOARD_UI_CSS = `
.app-shell--hacktron-light {
  --h-bg: #f5f5f4;
  --h-sidebar: #eeeeec;
  --h-card: #f2f2f1;
  --h-card-2: #f7f7f6;
  --h-white: #ffffff;
  --h-ink: #1f1f1f;
  --h-text: #4f4f4d;
  --h-muted: #767673;
  --h-faint: #9a9a96;
  --h-line: #dddbd7;
  --h-line-strong: #d2d0cc;
  --h-blue: #7fd0ee;
  --h-violet: #aab5ff;
  --h-black: #111111;
  --h-critical: #ff6b6b;
  --h-high: #ff9b4a;
  --h-medium: #f3c234;
  --h-low: #54d784;
}

.hacktron-dashboard {
  min-height: 100vh;
  padding: 30px 32px 48px;
  background: #f5f5f4;
  color: #202020;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  --h-bg: #f5f5f4;
  --h-sidebar: #eeeeec;
  --h-card: #f2f2f1;
  --h-card-2: #f7f7f6;
  --h-white: #ffffff;
  --h-ink: #1f1f1f;
  --h-text: #4f4f4d;
  --h-muted: #767673;
  --h-faint: #9a9a96;
  --h-line: #dddbd7;
  --h-line-strong: #d2d0cc;
  --h-blue: #7fd0ee;
  --h-violet: #aab5ff;
  --h-black: #111111;
  --h-critical: #ff6b6b;
  --h-high: #ff9b4a;
  --h-medium: #f3c234;
  --h-low: #54d784;
}

.hacktron-dashboard,
.hacktron-dashboard * {
  box-sizing: border-box;
  letter-spacing: 0;
}

.hacktron-dashboard a {
  color: inherit;
  text-decoration: none;
}

.app-shell--hacktron-light .app-shell-main > [data-screen-label]:not(.hacktron-dashboard) {
  min-height: 100vh;
  padding: 30px 32px 48px;
  background: #f5f5f4;
  color: #202020;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}

.app-shell--hacktron-light .app-shell-main > [data-screen-label]:not(.hacktron-dashboard) h1 {
  color: var(--h-ink, #1f1f1f) !important;
  font-family: var(--font-sans) !important;
  font-size: 24px !important;
  font-weight: 600 !important;
  line-height: 1.2 !important;
  letter-spacing: 0 !important;
}

.app-shell--hacktron-light .app-shell-main > [data-screen-label]:not(.hacktron-dashboard) > div:first-child {
  margin-bottom: 24px !important;
}

.app-shell--hacktron-light .app-shell-main > [data-screen-label]:not(.hacktron-dashboard) table {
  color: var(--h-text);
  font-family: var(--font-sans);
}

.app-shell--hacktron-light .app-shell-main > [data-screen-label]:not(.hacktron-dashboard) th {
  color: var(--h-faint) !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  font-weight: 600 !important;
  letter-spacing: 0 !important;
}

.app-shell--hacktron-light .app-shell-main > [data-screen-label]:not(.hacktron-dashboard) input,
.app-shell--hacktron-light .app-shell-main > [data-screen-label]:not(.hacktron-dashboard) select,
.app-shell--hacktron-light .app-shell-main > [data-screen-label]:not(.hacktron-dashboard) textarea {
  border-color: var(--h-line) !important;
  background: var(--h-white) !important;
  color: var(--h-ink) !important;
  font-family: var(--font-sans) !important;
}

.hack-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 58px;
  padding-bottom: 26px;
  border-bottom: 1px solid var(--h-line);
}

.hack-breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 19px;
  font-weight: 500;
}

.hack-breadcrumb strong {
  color: var(--h-ink);
  font-weight: 500;
}

.hack-top-actions {
  display: inline-flex;
  align-items: center;
  gap: 18px;
}

.hack-icon-button {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--h-muted);
  cursor: pointer;
}

.hack-icon-button:hover {
  color: var(--h-ink);
  background: #ececea;
}

.hack-page-intro {
  display: grid;
  gap: 10px;
  margin: 32px 0 30px;
  max-width: 860px;
}

.hack-page-title {
  margin: 0;
  color: var(--h-ink);
  font-family: var(--font-sans);
  font-size: 24px;
  font-weight: 600;
  line-height: 1.2;
}

.hack-page-description,
.hack-muted-copy,
.muted-copy {
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.45;
}

.hack-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 18px;
  align-items: center;
  margin: 32px 0 30px;
}

.hack-tabs {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  border: 1px solid var(--h-line);
  background: #eeeeed;
  padding: 4px;
}

.hack-tab {
  min-height: 40px;
  padding: 0 18px;
  border: 0;
  background: transparent;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.hack-tab[data-active="true"] {
  background: var(--h-white);
  color: var(--h-ink);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.hack-filter-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
}

.hack-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 46px;
  padding: 0 18px;
  border: 1px solid var(--h-line);
  border-radius: 0;
  background: #eeeeed;
  color: var(--h-text);
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.hack-button[data-variant="primary"] {
  background: var(--h-black);
  border-color: var(--h-black);
  color: var(--h-white);
}

.hack-button[data-variant="ghost"] {
  background: transparent;
  border-color: transparent;
}

.hack-button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.hack-button:not(:disabled):hover {
  border-color: var(--h-line-strong);
  background: var(--h-white);
  color: var(--h-ink);
}

.hack-button[data-variant="primary"]:not(:disabled):hover {
  background: var(--h-text);
  border-color: var(--h-text);
  color: var(--h-white);
}

.metrics-grid,
.hack-card-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 28px;
  margin-bottom: 30px;
}

.metric-card,
.chart-panel,
.sla-card,
.activity-panel,
.hack-panel,
.hack-card {
  border: 1px solid var(--h-line);
  border-radius: 0;
  background: var(--h-card);
  box-shadow: none;
}

.metric-card,
.hack-card {
  min-height: 154px;
  padding: 30px 32px;
}

.hack-panel {
  overflow: hidden;
}

.hack-panel-section {
  padding: 24px 28px;
}

.hack-panel-section + .hack-panel-section {
  border-top: 1px solid var(--h-line);
}

.metric-label,
.section-title,
.activity-title,
.hack-card-title,
.hack-section-title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 17px;
  font-weight: 600;
}

.metric-value,
.hack-card-value {
  display: block;
  margin: 22px 0 18px;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 30px;
  font-weight: 600;
  line-height: 1;
}

.metric-description,
.hack-card-description {
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.45;
}

.chart-panel {
  min-height: 346px;
  margin-bottom: 32px;
  padding: 32px;
}

.panel-heading,
.hack-panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 22px;
}

.activity-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 64px;
  padding: 0 24px;
  border-bottom: 1px solid var(--h-line);
}

.activity-controls,
.hack-controls {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.search-field,
.hack-field {
  position: relative;
}

.search-field svg,
.hack-field svg {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--h-faint);
}

.search-input,
.service-select,
.hack-input,
.hack-select,
.hack-textarea {
  border: 1px solid var(--h-line);
  border-radius: 0;
  background: var(--h-white);
  color: var(--h-ink);
  font-family: var(--font-sans);
  font-size: 14px;
  outline: none;
}

.search-input,
.hack-input,
.hack-select {
  height: 40px;
}

.search-input,
.hack-input {
  width: 246px;
  padding: 0 12px 0 38px;
}

.hack-input:not(.hack-input--with-icon) {
  padding-left: 12px;
}

.service-select,
.hack-select {
  width: 156px;
  padding: 0 12px;
}

.hack-textarea {
  min-height: 92px;
  width: 100%;
  padding: 10px 12px;
  resize: vertical;
}

.activity-table-wrap,
.hack-table-wrap {
  width: 100%;
  overflow-x: auto;
}

.activity-table,
.hack-table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  color: var(--h-text);
  font-family: var(--font-sans);
  font-size: 14px;
}

.activity-table th,
.hack-table th {
  height: 46px;
  padding: 0 24px;
  color: var(--h-faint);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  text-transform: uppercase;
}

.activity-table td,
.hack-table td {
  height: 56px;
  padding: 0 24px;
  border-top: 1px solid var(--h-line);
  white-space: nowrap;
}

.hack-table td[data-wrap="true"] {
  white-space: normal;
}

.hack-row-card {
  display: grid;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--h-line);
  background: var(--h-card);
}

.service-cell,
.hack-service-cell {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--h-ink);
  font-weight: 600;
}

.service-icon {
  color: var(--service-color);
}

.status-pill,
.hack-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--status-color, var(--h-text));
  font-size: 13px;
  font-weight: 600;
}

.status-dot,
.hack-badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--status-color, currentColor);
}

.row-action,
.hack-link {
  color: var(--h-ink);
  font-size: 13px;
  font-weight: 600;
}

.empty-state,
.hack-empty-state {
  padding: 34px 24px;
  border-top: 1px solid var(--h-line);
  color: var(--h-muted);
  font-family: var(--font-sans);
  text-align: center;
}

.hack-back-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--h-muted);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
}

.hack-meta-grid {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 12px 24px;
  align-items: baseline;
}

.hack-stack {
  display: grid;
  gap: 24px;
}

.hack-severity-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.hack-severity-list label,
.hack-checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--h-text);
  font-family: var(--font-sans);
  font-size: 14px;
  cursor: pointer;
}

.hack-severity-list input,
.hack-checkbox-label input {
  accent-color: var(--h-black);
}

@media (max-width: 1180px) {
  .hacktron-dashboard {
    padding: 24px 22px 40px;
  }

  .metrics-grid,
  .hack-card-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
  }
}

@media (max-width: 760px) {
  .hacktron-dashboard {
    padding: 20px 14px 34px;
  }

  .hack-header,
  .hack-toolbar,
  .panel-heading,
  .hack-panel-heading,
  .activity-header {
    align-items: stretch;
    flex-direction: column;
  }

  .hack-header,
  .panel-heading,
  .hack-panel-heading,
  .activity-header {
    display: flex;
  }

  .hack-toolbar {
    display: grid;
    grid-template-columns: 1fr;
  }

  .hack-tabs,
  .hack-filter-actions,
  .hack-button,
  .search-input,
  .service-select,
  .hack-input,
  .hack-select {
    width: 100%;
  }

  .hack-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .metrics-grid,
  .hack-card-grid {
    grid-template-columns: 1fr;
  }

  .activity-controls,
  .hack-controls {
    display: grid;
    grid-template-columns: 1fr;
  }

  .metric-card,
  .chart-panel,
  .hack-card,
  .hack-panel-section {
    padding: 22px;
  }

  .hack-meta-grid {
    grid-template-columns: 1fr;
  }
}
`;

export interface DashboardPageProps {
  readonly title: string;
  readonly section?: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly 'data-screen-label'?: string;
}

export function DashboardPage({
  title,
  section,
  description,
  actions,
  children,
  className,
  'data-screen-label': screenLabel,
}: DashboardPageProps): ReactElement {
  return (
    <>
      <style>{DASHBOARD_UI_CSS}</style>
      <div
        data-screen-label={screenLabel}
        className={cx('hacktron-dashboard', className)}
      >
        <header className="hack-header">
          <div className="hack-breadcrumb" aria-label="Breadcrumb">
            <span>Dashboard</span>
            <span>/</span>
            <strong>{section ?? title}</strong>
          </div>
          <div className="hack-top-actions" aria-label={`${title} tools`}>
            {actions ?? (
              <>
                <DashboardIconButton label="Search" icon={Search} />
                <DashboardIconButton label="Reports" icon={FileText} />
              </>
            )}
          </div>
        </header>

        {(title || description) && (
          <div className="hack-page-intro">
            <h1 className="hack-page-title">{title}</h1>
            {description ? <div className="hack-page-description">{description}</div> : null}
          </div>
        )}

        {children}
      </div>
    </>
  );
}

interface DashboardIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly size?: number;
}

export function DashboardIconButton({
  label,
  icon: Icon,
  size = 24,
  ...props
}: DashboardIconButtonProps): ReactElement {
  return (
    <button type="button" aria-label={label} title={label} className="hack-icon-button" {...props}>
      <Icon size={size} strokeWidth={1.9} aria-hidden="true" />
    </button>
  );
}

interface DashboardButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon?: LucideIcon;
  readonly trailingIcon?: LucideIcon;
  readonly variant?: 'default' | 'primary' | 'ghost';
}

export function DashboardButton({
  icon: Icon,
  trailingIcon: TrailingIcon,
  variant = 'default',
  children,
  ...props
}: DashboardButtonProps): ReactElement {
  return (
    <button type="button" data-slot="button" data-variant={variant} className="hack-button" {...props}>
      {Icon ? <Icon size={17} strokeWidth={1.9} aria-hidden="true" /> : null}
      {children}
      {TrailingIcon ? <TrailingIcon size={17} strokeWidth={1.9} aria-hidden="true" /> : null}
    </button>
  );
}

export function DashboardPanel({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement>): ReactElement {
  return (
    <section data-slot="card" className={cx('hack-panel', className)} {...props}>
      {children}
    </section>
  );
}

export function DashboardPanelHeader({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div data-slot="card-header" className={cx('activity-header', className)} {...props}>
      {children}
    </div>
  );
}

export function DashboardPanelSection({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div data-slot="card-content" className={cx('hack-panel-section', className)} {...props}>
      {children}
    </div>
  );
}

export function DashboardCard({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement>): ReactElement {
  return (
    <article data-slot="card" className={cx('hack-card', className)} {...props}>
      {children}
    </article>
  );
}

export function DashboardBadge({
  children,
  color,
  className,
}: {
  readonly children: ReactNode;
  readonly color?: string;
  readonly className?: string;
}): ReactElement {
  return (
    <span
      data-slot="badge"
      className={cx('hack-badge', className)}
      style={{ '--status-color': color } as CSSProperties}
    >
      {color ? <span className="hack-badge-dot" /> : null}
      {children}
    </span>
  );
}

export function DashboardTable({
  className,
  children,
  minWidth,
}: {
  readonly className?: string;
  readonly children: ReactNode;
  readonly minWidth?: number;
}): ReactElement {
  return (
    <div data-slot="table-container" className="hack-table-wrap">
      <table
        data-slot="table"
        className={cx('hack-table', className)}
        style={minWidth ? { minWidth } : undefined}
      >
        {children}
      </table>
    </div>
  );
}
