import { FormEvent, Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusBadge, WorkspaceState } from './SharedUI';
import { formatDisplayDateTime } from '../date-format';
import './AccessAdministration.css';

export interface AuditEntry {
  id: string; created_at: string; actor_user_id: string; actor_email: string | null; action: string;
  entity_type: string; entity_id: string; company_id: string; company_name: string; company_name_ar: string | null;
  reason: string | null; before_data: Record<string, unknown> | null; after_data: Record<string, unknown> | null;
}
interface Facets { actions: string[]; entity_types: string[]; actors: { id: string; email: string | null }[] }
interface Filters { q: string; action: string; entity_type: string; actor_user_id: string; from: string; to: string }
const EMPTY: Filters = { q: '', action: '', entity_type: '', actor_user_id: '', from: '', to: '' };
const PAGE_SIZE = 50;
type ErrorKey = 'error' | 'invalidRequest' | 'forbidden';

class ApiError extends Error { constructor(readonly status: number) { super(`Audit log API returned ${status}`); } }
async function get<T>(url: string, onUnauthorized: () => void, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', signal });
  if (response.status === 401) { onUnauthorized(); throw new ApiError(401); }
  if (!response.ok) throw new ApiError(response.status);
  return response.json() as Promise<T>;
}
function errorKeyFor(reason: unknown): ErrorKey {
  if (reason instanceof ApiError && reason.status === 400) return 'invalidRequest';
  if (reason instanceof ApiError && reason.status === 403) return 'forbidden';
  return 'error';
}

/**
 * Read-only audit log for the active company. No control here can change or delete a record;
 * the server enforces `audit.view` and the company scope on every request.
 */
export function AuditLog({ canView, onUnauthorized }: { canView: boolean; onUnauthorized: () => void }) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Facets>({ actions: [], entity_types: [], actors: [] });
  const [loading, setLoading] = useState(canView);
  const [loaded, setLoaded] = useState(false);
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    get<Facets>('/api/audit-log/facets', onUnauthorized, controller.signal).then(setFacets).catch(() => undefined);
    return () => controller.abort();
  }, [canView, onUnauthorized]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setErrorKey(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    (Object.keys(applied) as (keyof Filters)[]).forEach((key) => { if (applied[key]) params.set(key, applied[key]); });
    try {
      const body = await get<{ entries: AuditEntry[]; total: number }>(`/api/audit-log?${params}`, onUnauthorized, signal);
      setEntries(body.entries); setTotal(body.total); setLoaded(true);
    } catch (reason) {
      const aborted = reason instanceof DOMException && reason.name === 'AbortError';
      const unauthorized = reason instanceof ApiError && reason.status === 401;
      if (!aborted && !unauthorized) setErrorKey(errorKeyFor(reason));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [applied, offset, onUnauthorized]);

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [canView, load]);

  if (!canView) return <section className="panel"><WorkspaceState>{t('auditLog.noAccess')}</WorkspaceState></section>;

  const submit = (event: FormEvent) => { event.preventDefault(); setOffset(0); setApplied(draft); };
  const clear = () => { setDraft(EMPTY); setApplied(EMPTY); setOffset(0); };
  const filtered = (Object.keys(applied) as (keyof Filters)[]).some((key) => applied[key]);
  const set = (key: keyof Filters) => (value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const actor = (e: AuditEntry) => e.actor_email ?? e.actor_user_id;
  const company = (e: AuditEntry) => (i18n.language === 'ar' && e.company_name_ar) || e.company_name;
  const json = (value: Record<string, unknown> | null) => value ? JSON.stringify(value, null, 2) : '—';
  const last = Math.min(offset + entries.length, total);

  return <section className="panel acc-view" aria-labelledby="audit-log-title">
    <header className="acc-header"><div><h2 id="audit-log-title">{t('auditLog.title')}</h2><p>{t('auditLog.description')}</p></div></header>
    <form className="acc-card acc-form" onSubmit={submit} role="search" aria-label={t('auditLog.search')}>
      <label>{t('auditLog.search')}<input type="search" value={draft.q} maxLength={200} placeholder={t('auditLog.searchPlaceholder')} onChange={(e) => set('q')(e.target.value)} /></label>
      <label>{t('auditLog.action')}<select value={draft.action} onChange={(e) => set('action')(e.target.value)}><option value="">{t('auditLog.allActions')}</option>{facets.actions.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
      <label>{t('auditLog.entityType')}<select value={draft.entity_type} onChange={(e) => set('entity_type')(e.target.value)}><option value="">{t('auditLog.allTypes')}</option>{facets.entity_types.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
      <label>{t('auditLog.user')}<select value={draft.actor_user_id} onChange={(e) => set('actor_user_id')(e.target.value)}><option value="">{t('auditLog.allUsers')}</option>{facets.actors.map((a) => <option key={a.id} value={a.id}>{a.email ?? a.id}</option>)}</select></label>
      <label>{t('auditLog.from')}<input type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => set('from')(e.target.value)} /></label>
      <label>{t('auditLog.to')}<input type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => set('to')(e.target.value)} /></label>
      <div className="modal-actions"><button type="submit" className="acc-primary">{t('auditLog.apply')}</button>{filtered && <button type="button" className="acc-ghost" onClick={clear}>{t('auditLog.clear')}</button>}</div>
    </form>
    {errorKey && <WorkspaceState tone="error" action={<button onClick={() => void load()}>{t('auditLog.retry')}</button>}>{t(`auditLog.${errorKey}`)}</WorkspaceState>}
    {loading && !loaded ? <WorkspaceState>{t('auditLog.loading')}</WorkspaceState> : loaded && <div className="acc-card">
      <p className="acc-hint" role="status">{t('auditLog.count', { count: total })}{total > 0 && ` · ${t('auditLog.page', { from: offset + 1, to: last, total })}`}</p>
      <div className="acc-table"><table><thead><tr>
        <th>{t('auditLog.timestamp')}</th><th>{t('auditLog.user')}</th><th>{t('auditLog.action')}</th><th>{t('auditLog.entity')}</th><th>{t('auditLog.reference')}</th><th>{t('auditLog.company')}</th><th>{t('auditLog.reason')}</th><th>{t('auditLog.details')}</th>
      </tr></thead><tbody>
        {entries.length === 0 ? <tr><td colSpan={8} className="acc-empty">{t(filtered ? 'auditLog.noResults' : 'auditLog.empty')}</td></tr> : entries.map((e) => <Fragment key={e.id}>
          <tr>
            <td dir="ltr">{formatDisplayDateTime(e.created_at, i18n.language)}</td>
            <td dir="ltr">{actor(e)}</td>
            <td dir="ltr"><StatusBadge status="open">{e.action}</StatusBadge></td>
            <td dir="ltr">{e.entity_type}</td>
            <td dir="ltr" className="acc-user">{e.entity_id}</td>
            <td>{company(e)}</td>
            <td>{e.reason ?? '—'}</td>
            <td><button className="acc-ghost" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>{t(open === e.id ? 'auditLog.hide' : 'auditLog.show')}</button></td>
          </tr>
          {open === e.id && <tr><td colSpan={8}>{e.before_data || e.after_data
            ? <div className="acc-roles"><div><strong>{t('auditLog.before')}</strong><pre dir="ltr">{json(e.before_data)}</pre></div><div><strong>{t('auditLog.after')}</strong><pre dir="ltr">{json(e.after_data)}</pre></div></div>
            : <span className="acc-hint">{t('auditLog.noDetails')}</span>}</td></tr>}
        </Fragment>)}
      </tbody></table></div>
      {total > PAGE_SIZE && <div className="modal-actions">
        <button className="acc-ghost" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t('auditLog.previous')}</button>
        <button className="acc-ghost" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>{t('auditLog.next')}</button>
      </div>}
    </div>}
  </section>;
}
