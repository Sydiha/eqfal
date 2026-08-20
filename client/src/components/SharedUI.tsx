import { ReactNode } from 'react';

export function WorkspacePage({ children, className = '', labelledBy }: { children: ReactNode; className?: string; labelledBy?: string }) {
  return <section className={`panel shared-workspace-page ${className}`.trim()} aria-labelledby={labelledBy}>{children}</section>;
}

export function PageHeader({ eyebrow, title, description, action, className = '', titleId }: { eyebrow?: string; title: string; description?: string; action?: ReactNode; className?: string; titleId?: string }) {
  return <div className={`page-heading shared-page-heading ${className}`.trim()}>
    <div>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2 id={titleId}>{title}</h2>
      {description && <p>{description}</p>}
    </div>
    {action && <div className="shared-page-heading__action">{action}</div>}
  </div>;
}

export function StatusBadge({ status, children }: { status: string; children: ReactNode }) {
  return <span className={`badge shared-status-badge ${status}`}>{children}</span>;
}

export function WorkspaceState({ children, tone = 'neutral', action }: { children: ReactNode; tone?: 'neutral' | 'error'; action?: ReactNode }) {
  const role = tone === 'error' ? 'alert' : 'status';
  return <div role={role} className={`shared-workspace-state${tone === 'error' ? ' is-error' : ''}`}>
    <span>{children}</span>
    {action && <div className="shared-workspace-state__action">{action}</div>}
  </div>;
}

export function WorkspaceToolbar({ search, filters, clearAction, resultCount, className = '' }: { search?: ReactNode; filters?: ReactNode; clearAction?: ReactNode; resultCount?: ReactNode; className?: string }) {
  return <div className={`shared-workspace-toolbar ${className}`.trim()}>
    {search && <div className="shared-workspace-toolbar__search">{search}</div>}
    {filters && <div className="shared-workspace-toolbar__filters">{filters}</div>}
    {(clearAction || resultCount) && <div className="shared-workspace-toolbar__meta">{resultCount}{clearAction}</div>}
  </div>;
}

export function MetricStrip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`shared-metric-strip ${className}`.trim()}>{children}</div>;
}

export function Metric({ label, value }: { label: ReactNode; value: ReactNode }) {
  return <div className="shared-metric"><span>{label}</span><strong>{value}</strong></div>;
}

export function DataWorkspace({ children, withDetail = false, className = '' }: { children: ReactNode; withDetail?: boolean; className?: string }) {
  return <div className={`shared-data-workspace${withDetail ? ' has-detail' : ''} ${className}`.trim()}>{children}</div>;
}

export function DetailPane({ children, label }: { children: ReactNode; label?: string }) {
  return <aside className="shared-detail-pane" aria-label={label}>{children}</aside>;
}

export function SectionCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`shared-section-card ${className}`.trim()}>{children}</section>;
}
