import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayDate } from '../date-format';

export interface FiscalYear {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
}

interface Props {
  canView: boolean;
  canManage: boolean;
  onUnauthorized: () => void;
}

type FormMode = { kind: 'create' } | { kind: 'edit'; fiscalYear: FiscalYear };
type ErrorKey =
  | 'error'
  | 'invalidRequest'
  | 'forbidden'
  | 'notFound'
  | 'conflict'
  | 'invalidRange';

class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Fiscal Year API returned ${status}`);
  }
}

async function request(url: string, options: RequestInit, onUnauthorized: () => void) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  if (response.status === 401) {
    onUnauthorized();
    throw new ApiError(401);
  }
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

export function FiscalYears({ canView, canManage, onUnauthorized }: Props) {
  const { t, i18n } = useTranslation();
  const [years, setYears] = useState<FiscalYear[]>([]);
  const [loading, setLoading] = useState(canView);
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);
  const [form, setForm] = useState<FormMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [closeTarget, setCloseTarget] = useState<FiscalYear | null>(null);

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setErrorKey(null);
    try {
      const response = await request('/api/fiscal-years', { signal }, onUnauthorized);
      const body = await response.json() as { fiscalYears: FiscalYear[] };
      setYears(body.fiscalYears);
    } catch (reason) {
      const aborted = reason instanceof DOMException && reason.name === 'AbortError';
      const unauthorized = reason instanceof ApiError && reason.status === 401;
      if (!aborted && !unauthorized) setErrorKey(errorKeyFor(reason));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  // A remount on company switch deliberately starts a fresh request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  if (!canView) return <section className="panel"><p role="status">{t('fiscalYears.noAccess')}</p></section>;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form) return;
    const data = new FormData(event.currentTarget);
    const payload = {
      name: String(data.get('name')),
      start_date: String(data.get('start_date')),
      end_date: String(data.get('end_date')),
    };
    if (payload.start_date >= payload.end_date) {
      setErrorKey('invalidRange');
      return;
    }
    setSaving(true);
    setErrorKey(null);
    try {
      const url = form.kind === 'create' ? '/api/fiscal-years' : `/api/fiscal-years/${form.fiscalYear.id}`;
      await request(url, {
        method: form.kind === 'create' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, onUnauthorized);
      setForm(null);
      await load();
    } catch (reason) {
      if (!(reason instanceof ApiError && reason.status === 401)) {
        setErrorKey(errorKeyFor(reason));
      }
    } finally {
      setSaving(false);
    }
  };

  const close = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!closeTarget) return;
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    setSaving(true);
    setErrorKey(null);
    try {
      await request(`/api/fiscal-years/${closeTarget.id}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reason ? { reason } : {}),
      }, onUnauthorized);
      setCloseTarget(null);
      await load();
    } catch (reason) {
      if (!(reason instanceof ApiError && reason.status === 401)) {
        setErrorKey(errorKeyFor(reason));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel fiscal-years-page" aria-labelledby="fiscal-years-title">
      <div className="section-heading fiscal-years-heading">
        <div>
          <p className="eyebrow">{t('fiscalYears.title')}</p>
          <h2 id="fiscal-years-title">{t('fiscalYears.title')}</h2>
          <p>{t('fiscalYears.description')}</p>
        </div>
        {canManage && <button className="primary" onClick={() => setForm({ kind: 'create' })}>{t('fiscalYears.create')}</button>}
      </div>

      {errorKey && !form && !closeTarget && <div role="alert" className="message error fiscal-years-message">{t(`fiscalYears.${errorKey}`)} {errorKey !== 'invalidRange' && <button onClick={() => void load()}>{t('fiscalYears.retry')}</button>}</div>}
      {loading ? <p role="status" className="state-card fiscal-years-state">{t('fiscalYears.loading')}</p> : years.length === 0 ? <p role="status" className="empty fiscal-years-state">{t('fiscalYears.empty')}</p> : (
        <div className="fiscal-years-grid">
          {years.map(year => (
            <article key={year.id} className={`fiscal-year-card ${year.status}`}>
              <div className="fiscal-year-card-header">
                <div>
                  <h3>{year.name}</h3>
                  <span className={`badge ${year.status}`}>{t(`fiscalYears.${year.status}`)}</span>
                </div>
              </div>
              <dl className="fiscal-year-dates">
                <div><dt>{t('fiscalYears.start')}</dt><dd>{formatDisplayDate(year.start_date, i18n.language)}</dd></div>
                <div><dt>{t('fiscalYears.end')}</dt><dd>{formatDisplayDate(year.end_date, i18n.language)}</dd></div>
              </dl>
              {canManage && year.status === 'open' && (
                <div className="fiscal-year-actions">
                  <button onClick={() => setForm({ kind: 'edit', fiscalYear: year })}>{t('fiscalYears.edit')}</button>
                  <button className="danger" onClick={() => setCloseTarget(year)}>{t('fiscalYears.close')}</button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {form && <div className="modal-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="fy-form-title" className="modal fiscal-year-modal"><h3 id="fy-form-title">{t(form.kind === 'create' ? 'fiscalYears.createTitle' : 'fiscalYears.editTitle')}</h3>{errorKey && <div role="alert" className="message error">{t(`fiscalYears.${errorKey}`)}</div>}<form onSubmit={save} className="form-grid fiscal-year-form">
        <label>{t('fiscalYears.name')}<input name="name" required maxLength={120} defaultValue={form.kind === 'edit' ? form.fiscalYear.name : ''} /></label>
        <div className="fiscal-year-date-fields">
          <label>{t('fiscalYears.start')}<input name="start_date" type="date" required defaultValue={form.kind === 'edit' ? form.fiscalYear.start_date.slice(0, 10) : ''} /></label>
          <label>{t('fiscalYears.end')}<input name="end_date" type="date" required defaultValue={form.kind === 'edit' ? form.fiscalYear.end_date.slice(0, 10) : ''} /></label>
        </div>
        <div className="modal-actions"><button type="button" onClick={() => setForm(null)}>{t('common.cancel')}</button><button className="primary" type="submit" disabled={saving}>{t('common.save')}</button></div>
      </form></div></div>}

      {closeTarget && <div className="modal-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="close-title" className="modal fiscal-year-modal fiscal-year-close-modal"><h3 id="close-title">{t('fiscalYears.closeTitle')}</h3><p>{t('fiscalYears.closeConfirmation', { name: closeTarget.name })}</p>{errorKey && <div role="alert" className="message error">{t(`fiscalYears.${errorKey}`)}</div>}<form onSubmit={close} className="form-grid"><label>{t('fiscalYears.reason')}<textarea name="reason" maxLength={500} /></label><div className="modal-actions"><button type="button" onClick={() => setCloseTarget(null)}>{t('common.cancel')}</button><button className="danger" type="submit" disabled={saving}>{t('fiscalYears.confirmClose')}</button></div></form></div></div>}
    </section>
  );
}
