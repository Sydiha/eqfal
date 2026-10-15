import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiErrorMessage, parseApiError, toApiError } from '../api/apiError';
import { Dialog } from './Dialog';
import { StatusBadge, WorkspaceState } from './SharedUI';
import { capabilityLabel, langOf } from '../labels/capabilityLabels';

export type EffectiveSource = 'role' | 'full_access_wildcard' | 'system_admin_global' | 'none';
export interface UserCompanyAccess {
  membership_id: string; company_id: string; company_name: string; company_name_ar: string | null; company_is_active: boolean; is_active: boolean; is_current_company: boolean;
  role: { id: string; name: string; is_full_access: boolean } | null; role_capabilities: string[]; effective_capabilities: string[]; effective_source: EffectiveSource;
}
interface Details { user: { id: string; email: string; is_active: boolean; is_system_admin: boolean }; companies: UserCompanyAccess[] }
interface Props { membershipId: string; email: string; onClose: () => void; onUnauthorized: () => void }

/**
 * Read-only consolidated view of one member (GET /api/access/memberships/:id/details). The server returns only the
 * companies the administrator may view; this component never infers or hints at any other company.
 * Role capabilities (explicit rows of the role) are shown apart from effective permissions (what the user can do now).
 */
export function UserAccessDetails({ membershipId, email, onClose, onUnauthorized }: Props) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const [data, setData] = useState<Details | null>(null);
  const [error, setError] = useState<ApiError | null | 'generic'>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    (async () => {
      try {
        let response: Response;
        try { response = await fetch(`/api/access/memberships/${membershipId}/details`, { credentials: 'same-origin', signal: controller.signal }); }
        catch (reason) { throw reason instanceof DOMException && reason.name === 'AbortError' ? reason : toApiError(reason); }
        if (response.status === 401) onUnauthorized();
        if (!response.ok) throw await parseApiError(response);
        setData((await response.json()) as Details);
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        if (!(reason instanceof ApiError && reason.status === 401)) setError(reason instanceof ApiError ? reason : 'generic');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [membershipId, attempt, onUnauthorized]);

  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const companyName = (c: UserCompanyAccess) => (lang === 'ar' && c.company_name_ar) || c.company_name;
  const errorText = error === null ? '' : (error !== 'generic' && apiErrorMessage(error, t)) || t(error !== 'generic' && error.status === 404 ? 'access.notFound' : error !== 'generic' && error.status === 403 ? 'access.forbidden' : 'access.error');

  return <Dialog title={t('access.details.title', { email })} onClose={onClose} size="wide">
    <div className="acc-details">
      {loading ? <WorkspaceState>{t('access.loading')}</WorkspaceState>
        : error !== null ? <WorkspaceState tone="error" action={<button onClick={() => setAttempt((n) => n + 1)}>{t('access.retry')}</button>}>{errorText}</WorkspaceState>
        : data && <>
          <p className="acc-hint">{t('access.details.scopeNote')}</p>
          {data.user.is_system_admin && <p className="acc-note" role="note">{t('access.details.systemAdminNote')}</p>}
          {!data.user.is_active && <p className="acc-note" role="note">{t('access.userDisabled')}</p>}
          {data.companies.length === 0 ? <p className="acc-empty">{t('access.details.empty')}</p>
            : <ul className="acc-details-list" aria-label={t('access.details.companies')}>{data.companies.map((c) => {
              const expanded = open.has(c.membership_id);
              const panelId = `acc-details-${c.membership_id}`;
              return <li key={c.membership_id} className="acc-details-card">
                <div className="acc-details-head">
                  <strong>{companyName(c)}</strong>
                  {c.is_current_company && <small> · {t('access.details.currentCompany')}</small>}
                  {!c.company_is_active && <small> · {t('access.details.companyDisabled')}</small>}
                  <StatusBadge status={c.is_active ? 'open' : 'closed'}>{t(c.is_active ? 'access.active' : 'access.inactive')}</StatusBadge>
                </div>
                <dl className="acc-details-grid">
                  <dt>{t('access.role')}</dt><dd>{c.role ? <>{c.role.name}{c.role.is_full_access && <small> · {t('access.fullAccess')}</small>}</> : t('access.noRole')}</dd>
                  <dt>{t('access.details.roleCapabilities')}</dt><dd>{c.role?.is_full_access ? t('access.details.wildcard') : t('access.capabilityCount', { count: c.role_capabilities.length })}</dd>
                  <dt>{t('access.details.effective')}</dt><dd>{t(`access.details.source.${c.effective_source}`, { count: c.effective_capabilities.length })}</dd>
                </dl>
                {c.effective_capabilities.length > 0 && <>
                  <button type="button" className="acc-ghost" aria-expanded={expanded} aria-controls={panelId} onClick={() => toggle(c.membership_id)}>
                    {expanded ? t('access.details.hideEffective') : t('access.details.showEffective', { count: c.effective_capabilities.length })}
                  </button>
                  {expanded && <ul id={panelId} className="acc-details-caps">{c.effective_capabilities.map((id) => <li key={id} title={id}>{capabilityLabel(id, lang)}</li>)}</ul>}
                </>}
              </li>;
            })}</ul>}
        </>}
      <div className="modal-actions"><button type="button" className="acc-primary" onClick={onClose}>{t('access.close')}</button></div>
    </div>
  </Dialog>;
}
