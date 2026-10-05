import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { StatusBadge, WorkspaceState } from './SharedUI';
import './AccessAdministration.css';

export interface ManagedCompany { id: string; slug: string; name: string; name_ar: string | null; is_active: boolean; can_edit: boolean; can_toggle: boolean }
interface Props {
  capabilities: readonly string[];
  onUnauthorized: () => void;
  /** Called after any successful change so the session (company switcher) is reloaded from the server. */
  onChanged: () => Promise<void> | void;
}
type ErrorKey = 'error' | 'invalidRequest' | 'forbidden' | 'notFound' | 'conflict';
type Dialogs = { kind: 'create' } | { kind: 'edit'; company: ManagedCompany } | null;

class ApiError extends Error { constructor(readonly status: number) { super(`Companies API returned ${status}`); } }
async function request(url: string, options: RequestInit, onUnauthorized: () => void) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  if (response.status === 401) { onUnauthorized(); throw new ApiError(401); }
  if (!response.ok) throw new ApiError(response.status);
  return response;
}
function errorKeyFor(reason: unknown): ErrorKey {
  if (!(reason instanceof ApiError)) return 'error';
  if (reason.status === 400) return 'invalidRequest';
  if (reason.status === 403) return 'forbidden';
  if (reason.status === 404) return 'notFound';
  if (reason.status === 409) return 'conflict';
  return 'error';
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * Operational UI for companies the current user belongs to. Every action is also enforced
 * server-side (capability, tenant scope); hiding controls here is only a convenience.
 * There is intentionally no delete: companies are disabled, never removed.
 */
export function CompaniesManagement({ capabilities, onUnauthorized, onChanged }: Props) {
  const { t, i18n } = useTranslation();
  const can = (capability: string) => capabilities.includes(capability);
  const canView = can('company.view');
  const [companies, setCompanies] = useState<ManagedCompany[]>([]);
  const [loading, setLoading] = useState(canView);
  const [loaded, setLoaded] = useState(false);
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setErrorKey(null);
    try {
      const response = await request('/api/companies', { signal }, onUnauthorized);
      setCompanies(((await response.json()) as { companies: ManagedCompany[] }).companies);
      setLoaded(true);
    } catch (reason) {
      const aborted = reason instanceof DOMException && reason.name === 'AbortError';
      const unauthorized = reason instanceof ApiError && reason.status === 401;
      if (!aborted && !unauthorized) setErrorKey(errorKeyFor(reason));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [onUnauthorized]);

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [canView, load]);

  const mutate = async (work: () => Promise<unknown>, afterSuccess?: () => void) => {
    setBusy(true); setErrorKey(null);
    try { await work(); afterSuccess?.(); await load(); await onChanged(); }
    catch (reason) { if (!(reason instanceof ApiError && reason.status === 401)) setErrorKey(errorKeyFor(reason)); }
    finally { setBusy(false); }
  };

  if (!canView) return <section className="panel"><WorkspaceState>{t('companies.noAccess')}</WorkspaceState></section>;

  const displayName = (company: ManagedCompany) => (i18n.language === 'ar' && company.name_ar) || company.name;
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body: Record<string, string> = { slug: String(data.get('slug') ?? '').trim().toLowerCase(), name: String(data.get('name') ?? '').trim() };
    const nameAr = String(data.get('name_ar') ?? '').trim();
    if (nameAr) body.name_ar = nameAr;
    void mutate(() => request('/api/companies', json('POST', body), onUnauthorized), () => setDialog(null));
  };
  const edit = (event: FormEvent<HTMLFormElement>, company: ManagedCompany) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = { name: String(data.get('name') ?? '').trim(), name_ar: String(data.get('name_ar') ?? '').trim() };
    void mutate(() => request(`/api/companies/${company.id}`, json('PATCH', body), onUnauthorized), () => setDialog(null));
  };
  const setActive = (company: ManagedCompany, isActive: boolean) =>
    mutate(() => request(`/api/companies/${company.id}/active`, json('PATCH', { is_active: isActive }), onUnauthorized));

  const dialogError = errorKey && dialog ? <div role="alert" className="acc-alert">{t(`companies.${errorKey}`)}</div> : null;
  const actions = (onCancel: () => void, label: string) => <div className="modal-actions"><button type="button" className="acc-ghost" onClick={onCancel}>{t('common.cancel')}</button><button className="acc-primary" type="submit" disabled={busy}>{busy ? t('companies.saving') : label}</button></div>;

  return <section className="panel acc-view" aria-labelledby="companies-title">
    <header className="acc-header">
      <div><h2 id="companies-title">{t('companies.title')}</h2><p>{t('companies.description')}</p></div>
      {can('company.create') && <button className="acc-primary" onClick={() => { setErrorKey(null); setDialog({ kind: 'create' }); }}>{t('companies.create')}</button>}
    </header>
    {errorKey && !dialog && <WorkspaceState tone="error" action={<button onClick={() => void load()}>{t('companies.retry')}</button>}>{t(`companies.${errorKey}`)}</WorkspaceState>}
    {loading && !loaded ? <WorkspaceState>{t('companies.loading')}</WorkspaceState> : loaded && <div className="acc-card">
      <p className="acc-hint">{t('companies.disableHint')}</p>
      <div className="acc-table"><table><thead><tr><th>{t('companies.name')}</th><th>{t('companies.slug')}</th><th>{t('companies.status')}</th><th>{t('companies.actions')}</th></tr></thead>
        <tbody>{companies.length === 0 ? <tr><td colSpan={4} className="acc-empty">{t('companies.empty')}</td></tr> : companies.map((company) => <tr key={company.id}>
          <td><strong>{displayName(company)}</strong>{company.name_ar && company.name_ar !== displayName(company) && <small> · {company.name_ar}</small>}{company.name !== displayName(company) && <small> · {company.name}</small>}</td>
          <td dir="ltr" className="acc-user">{company.slug}</td>
          <td><StatusBadge status={company.is_active ? 'open' : 'closed'}>{t(company.is_active ? 'companies.active' : 'companies.inactive')}</StatusBadge></td>
          <td>
            {can('company.edit') && company.can_edit && <button className="acc-ghost" disabled={busy} onClick={() => { setErrorKey(null); setDialog({ kind: 'edit', company }); }}>{t('companies.edit')}</button>}
            {can('company.status.edit') && company.can_toggle && <button className="acc-ghost" disabled={busy} onClick={() => void setActive(company, !company.is_active)}>{t(company.is_active ? 'companies.disable' : 'companies.enable')}</button>}
          </td>
        </tr>)}</tbody></table></div>
    </div>}
    {dialog?.kind === 'create' && <Dialog title={t('companies.createTitle')} busy={busy} onClose={() => setDialog(null)}>{dialogError}
      <form onSubmit={create} className="acc-form">
        <label>{t('companies.name')}<input name="name" required maxLength={200} /></label>
        <label>{t('companies.nameAr')}<input name="name_ar" maxLength={200} dir="rtl" /></label>
        <label>{t('companies.slug')}<input name="slug" required maxLength={64} dir="ltr" pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*" /></label><small>{t('companies.slugHint')}</small>
        {actions(() => setDialog(null), t('companies.createAction'))}</form></Dialog>}
    {dialog?.kind === 'edit' && <Dialog title={t('companies.editTitle')} busy={busy} onClose={() => setDialog(null)}>{dialogError}
      <form onSubmit={(event) => edit(event, dialog.company)} className="acc-form">
        <label>{t('companies.name')}<input name="name" required maxLength={200} defaultValue={dialog.company.name} /></label>
        <label>{t('companies.nameAr')}<input name="name_ar" maxLength={200} dir="rtl" defaultValue={dialog.company.name_ar ?? ''} /></label>
        <label>{t('companies.slug')}<input value={dialog.company.slug} readOnly dir="ltr" /></label><small>{t('companies.slugLocked')}</small>
        {actions(() => setDialog(null), t('companies.save'))}</form></Dialog>}
  </section>;
}
