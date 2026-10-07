import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiErrorMessage, parseApiError, toApiError } from '../api/apiError';
import { useOptionalCompany } from '../context/CompanyContext';
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

async function request(url: string, options: RequestInit, onUnauthorized: () => void) {
  let response: Response;
  try { response = await fetch(url, { credentials: 'same-origin', ...options }); }
  catch (reason) { throw reason instanceof DOMException && reason.name === 'AbortError' ? reason : toApiError(reason); }
  if (response.status === 401) onUnauthorized();
  if (!response.ok) throw await parseApiError(response);
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

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LOGO_MAX_BYTES = 512 * 1024;

/** Optional company logo: preview / upload / replace / remove. The server re-validates type, bytes, size and permission. */
function CompanyLogoPanel({ companyId, active, canEdit, onUnauthorized }: { companyId: string; active: boolean; canEdit: boolean; onUnauthorized: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready'>(active ? 'loading' : 'ready');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); let made: string | null = null;
    setState('loading');
    fetch(`/api/companies/${companyId}/logo`, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) onUnauthorized();
        if (!response.ok) { setUrl(null); return; }
        made = URL.createObjectURL(await response.blob()); setUrl(made);
      })
      .catch(() => setUrl(null))
      .finally(() => { if (!controller.signal.aborted) setState('ready'); });
    return () => { controller.abort(); if (made) URL.revokeObjectURL(made); };
  }, [companyId, active, version, onUnauthorized]);
  const change = async (work: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMessage(null);
    try { await work(); setVersion((v) => v + 1); setMessage(ok); }
    catch (reason) { setMessage(reason instanceof ApiError && reason.status === 413 ? t('companies.logoTooLarge') : reason instanceof ApiError && reason.status === 403 ? t('companies.forbidden') : t('companies.logoInvalid')); }
    finally { setBusy(false); }
  };
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) { setMessage(t('companies.logoInvalid')); return; }
    if (file.size > LOGO_MAX_BYTES) { setMessage(t('companies.logoTooLarge')); return; }
    void change(() => request(`/api/companies/${companyId}/logo`, { method: 'PUT', headers: { 'content-type': file.type }, body: file }, onUnauthorized), t('companies.logoSaved'));
  };
  return <section className="acc-logo" aria-label={t('companies.logoTitle')}>
    <h3>{t('companies.logoTitle')}</h3>
    <p className="acc-hint">{t('companies.logoHint')}</p>
    {!active ? <p className="acc-hint">{t('companies.logoSwitch')}</p> : <>
      <div className="acc-logo-preview">{state === 'loading' ? <span>{t('companies.loading')}</span> : url ? <img src={url} alt={t('companies.logoAlt')} style={{ maxHeight: 72, maxWidth: 220, objectFit: 'contain' }} /> : <span>{t('companies.logoNone')}</span>}</div>
      {canEdit && <div className="modal-actions">
        <label className="acc-ghost" style={{ cursor: 'pointer' }}>{url ? t('companies.logoReplace') : t('companies.logoUpload')}
          <input type="file" accept={LOGO_TYPES.join(',')} hidden disabled={busy} onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ''; }} />
        </label>
        {url && <button type="button" className="acc-ghost" disabled={busy} onClick={() => void change(() => request(`/api/companies/${companyId}/logo`, { method: 'DELETE' }, onUnauthorized), t('companies.logoRemoved'))}>{t('companies.logoRemove')}</button>}
      </div>}
      {message && <div role="status" className="acc-hint">{message}</div>}
    </>}
  </section>;
}

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
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [busy, setBusy] = useState(false);
  const activeCompanyId = useOptionalCompany()?.activeCompanyId ?? null;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setErrorKey(null); setFailure(null);
    try {
      const response = await request('/api/companies', { signal }, onUnauthorized);
      setCompanies(((await response.json()) as { companies: ManagedCompany[] }).companies);
      setLoaded(true);
    } catch (reason) {
      const aborted = reason instanceof DOMException && reason.name === 'AbortError';
      const unauthorized = reason instanceof ApiError && reason.status === 401;
      if (!aborted && !unauthorized) { setErrorKey(errorKeyFor(reason)); setFailure(reason instanceof ApiError ? reason : null); }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [onUnauthorized]);

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [canView, load]);

  const mutate = async (work: () => Promise<unknown>, afterSuccess?: () => void) => {
    setBusy(true); setErrorKey(null); setFailure(null);
    try { await work(); afterSuccess?.(); await load(); await onChanged(); }
    catch (reason) { if (!(reason instanceof ApiError && reason.status === 401)) { setErrorKey(errorKeyFor(reason)); setFailure(reason instanceof ApiError ? reason : null); } }
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

  const errorText = errorKey ? (failure && apiErrorMessage(failure, t)) || t(`companies.${errorKey}`) : '';
  const dialogError = errorKey && dialog ? <div role="alert" className="acc-alert">{errorText}</div> : null;
  const actions = (onCancel: () => void, label: string) => <div className="modal-actions"><button type="button" className="acc-ghost" onClick={onCancel}>{t('common.cancel')}</button><button className="acc-primary" type="submit" disabled={busy}>{busy ? t('companies.saving') : label}</button></div>;

  return <section className="panel acc-view" aria-labelledby="companies-title">
    <header className="acc-header">
      <div><h2 id="companies-title">{t('companies.title')}</h2><p>{t('companies.description')}</p></div>
      {can('company.create') && <button className="acc-primary" onClick={() => { setErrorKey(null); setDialog({ kind: 'create' }); }}>{t('companies.create')}</button>}
    </header>
    {errorKey && !dialog && <WorkspaceState tone="error" action={<button onClick={() => void load()}>{t('companies.retry')}</button>}>{errorText}</WorkspaceState>}
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
        {actions(() => setDialog(null), t('companies.save'))}</form>
      <CompanyLogoPanel companyId={dialog.company.id} active={dialog.company.id === activeCompanyId} canEdit={can('company.edit') && dialog.company.can_edit} onUnauthorized={onUnauthorized} /></Dialog>}
  </section>;
}
