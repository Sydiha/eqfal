import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseApiError, screenErrorMessage, toApiError } from '../api/apiError';

type Policy = 'required' | 'optional';
interface Props {
  fiscalYearId: string; policy: Policy; yearStatus: string; summary: Record<string, string | number | boolean>;
  canManage: boolean; onChanged: () => void; onUnauthorized: () => void;
}

/** Shows the monthly closing policy and the actual monthly statuses; authorised users may change it only while the fiscal year is open. */
export function MonthlyClosePolicyCard({ fiscalYearId, policy, yearStatus, summary, canManage, onChanged, onUnauthorized }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const selected = draft ?? policy;
  const closed = yearStatus === 'closed';
  const save = async () => {
    if (selected === policy) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/fiscal-years/${encodeURIComponent(fiscalYearId)}/monthly-close-policy`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: selected }),
      }).catch(e => { throw toApiError(e); });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw await parseApiError(response);
      setDraft(null); setMessage({ kind: 'ok', text: t('annualClosing.monthlyPolicy.saved') }); onChanged();
    } catch (e) {
      setMessage({ kind: 'error', text: screenErrorMessage(e, t, t('annualClosing.monthlyPolicy.error')) });
    } finally { setBusy(false); }
  };
  const n = (key: string) => Number(summary[key] ?? 0);
  return <div className="ac-card ac-monthly-policy" aria-labelledby="monthly-policy-title">
    <h2 id="monthly-policy-title">{t('annualClosing.monthlyPolicy.title')}</h2>
    <p className="ac-note">{t('annualClosing.monthlyPolicy.description')}</p>
    <p><span className="ac-muted">{t('annualClosing.monthlyPolicy.label')}: </span><strong>{t(`annualClosing.monthlyPolicy.${policy}Short`)}</strong></p>
    <p className="ac-note">{t('annualClosing.monthlyPolicy.counts', { closed: n('closed_periods'), open: n('open_periods'), missing: n('missing_periods'), expected: n('expected_periods') })}</p>
    {policy === 'optional' && <p className="ac-note">{t('annualClosing.monthlyPolicy.optionalNote')}</p>}
    {closed && <p role="status" className="ac-note">{t('annualClosing.monthlyPolicy.locked')}</p>}
    {canManage && !closed && <div className="ac-actions">
      <label><span className="ac-muted">{t('annualClosing.monthlyPolicy.label')}</span>{' '}
        <select value={selected} disabled={busy} onChange={event => { setMessage(null); setDraft(event.target.value as Policy); }}>
          <option value="required">{t('annualClosing.monthlyPolicy.required')}</option>
          <option value="optional">{t('annualClosing.monthlyPolicy.optional')}</option>
        </select></label>
      <button type="button" className="ac-btn ac-btn--primary" disabled={busy || selected === policy} onClick={() => void save()}>{busy ? t('annualClosing.monthlyPolicy.saving') : t('annualClosing.monthlyPolicy.save')}</button>
    </div>}
    {message && <p role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>}
  </div>;
}
