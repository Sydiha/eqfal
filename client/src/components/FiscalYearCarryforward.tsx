import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiErrorMessage, parseApiError, toApiError } from '../api/apiError';
import { Dialog } from './Dialog';
import type { FiscalYear } from './FiscalYears';

interface Line { account_id: string; code: string; name: string; side: 'debit' | 'credit'; amount: string }
interface Preview {
  to_year: { name: string } | null; ready: boolean; net_result: string; total_debit: string; total_credit: string;
  blockers: Array<{ code: string; detail?: string }>; lines: Line[]; existing: unknown;
}
interface EquityAccount { id: string; code: string; name: string; name_ar?: string | null; name_en?: string | null; account_type: string; statement_category?: string; is_active: boolean }

/**
 * Year-end carry-forward for a CLOSED fiscal year. Prepares a DRAFT opening balance for the next year from the closed year's final balances;
 * nothing is posted here. The owner then reviews and approves it in Opening Balances.
 */
export function FiscalYearCarryforward({ year, onClose, onUnauthorized }: { year: FiscalYear; onClose: () => void; onUnauthorized: () => void }) {
  const { t, i18n } = useTranslation();
  const [accounts, setAccounts] = useState<EquityAccount[]>([]);
  const [account, setAccount] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const label = (a: { code: string; name: string; name_ar?: string | null; name_en?: string | null }) => `${a.code} ${(i18n.language === 'ar' ? a.name_ar ?? a.name_en : a.name_en ?? a.name_ar) ?? a.name}`;

  const call = async (url: string, init?: RequestInit) => {
    let response: Response;
    try { response = await fetch(url, { credentials: 'same-origin', ...init }); } catch (reason) { throw toApiError(reason); }
    if (response.status === 401) onUnauthorized();
    if (!response.ok) throw await parseApiError(response);
    return response.json();
  };
  const fail = (reason: unknown) => {
    const failure = reason instanceof ApiError ? reason : toApiError(reason);
    setError(apiErrorMessage(failure, t) ?? t('carryforward.error'));
  };

  useEffect(() => {
    void (async () => {
      try {
        const body = await call('/api/accounts') as { accounts: EquityAccount[] };
        setAccounts(body.accounts.filter((a) => a.account_type === 'equity' && a.statement_category === 'equity' && a.is_active));
        setPreview(await call(`/api/fiscal-years/${year.id}/carryforward`) as Preview);
      } catch (reason) { fail(reason); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year.id]);

  const choose = async (id: string) => {
    setAccount(id); setError(null);
    try { setPreview(await call(`/api/fiscal-years/${year.id}/carryforward${id ? `?retained_earnings_account_id=${id}` : ''}`) as Preview); } catch (reason) { fail(reason); }
  };
  const prepare = async () => {
    setBusy(true); setError(null);
    try {
      await call(`/api/fiscal-years/${year.id}/carryforward`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retained_earnings_account_id: account }) });
      setDone(true);
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  return (
    <Dialog title={t('carryforward.title', { name: year.name })} busy={busy} onClose={onClose}>
      <div className="form-grid">
        {done ? <p role="status">{t('carryforward.done')}</p> : <>
          <p>{t('carryforward.intro')}</p>
          <label>
            <span>{t('carryforward.account')}</span>
            <select value={account} onChange={(e) => void choose(e.target.value)}>
              <option value="">{t('carryforward.chooseAccount')}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
            </select>
          </label>
          {preview?.blockers.length ? (
            <ul role="alert" className="fy-findings">
              {preview.blockers.map((b) => <li key={b.code}>{t([`carryforward.blockers.${b.code}`, 'carryforward.blockers.other'])}{b.detail ? ` (${b.detail})` : ''}</li>)}
            </ul>
          ) : null}
          {preview && account && preview.lines.length > 0 && (
            <table>
              <thead><tr><th>{t('carryforward.accountCol')}</th><th>{t('carryforward.debit')}</th><th>{t('carryforward.credit')}</th></tr></thead>
              <tbody>
                {preview.lines.map((l) => <tr key={l.account_id}><td>{l.code} {l.name}</td><td>{l.side === 'debit' ? l.amount : ''}</td><td>{l.side === 'credit' ? l.amount : ''}</td></tr>)}
                <tr><th>{t('carryforward.total')}</th><th>{preview.total_debit}</th><th>{preview.total_credit}</th></tr>
              </tbody>
            </table>
          )}
          {preview && account && <p>{t('carryforward.netResult', { value: preview.net_result })}</p>}
          {error && <p role="alert" className="error">{error}</p>}
        </>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>{t('common.close')}</button>
          {!done && <button type="button" className="primary" disabled={busy || !account || !preview?.ready} onClick={() => void prepare()}>{t('carryforward.prepare')}</button>}
        </div>
      </div>
    </Dialog>
  );
}
