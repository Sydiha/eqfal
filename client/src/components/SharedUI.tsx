import { ReactNode } from 'react';

export function PageHeader({ eyebrow, title, description, action, className = '' }: { eyebrow?: string; title: string; description?: string; action?: ReactNode; className?: string }) {
  return <div className={`page-heading shared-page-heading ${className}`.trim()}>
    <div>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
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
