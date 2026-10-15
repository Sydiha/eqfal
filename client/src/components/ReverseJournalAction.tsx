import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiErrorMessage, parseApiError, toApiError } from '../api/apiError';
import { Dialog } from './Dialog';

interface Props {
  journalId: string;
  /** Original journal date; the reversal date cannot be earlier. */
  journalDate: string;
  onReversed: (reversalJournalId: string) => void | Promise<void>;
  onUnauthorized: () => void;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Reverse a posted MANUAL journal. The original is never changed: the server creates a separate mirror journal (debit and credit swapped)
 * dated on an open period and linked to the original. The server decides eligibility; its stable error code is shown in plain words.
 */
export function ReverseJournalAction({ journalId, journalDate, onReversed, onUnauthorized }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(() => (today() > journalDate ? today() : journalDate));
  const [reason, setReason] = useState('');

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/journals/${journalId}/reverse`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accounting_date: date, reason: reason.trim() }),
      });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) {
        const failure = await parseApiError(response);
        setError(apiErrorMessage(failure, t) ?? (failure.status === 400 ? t('journalReversal.invalid') : t('journalReversal.error')));
        return;
      }
      const created = await response.json() as { reversal?: { id?: string } };
      setOpen(false);
      await onReversed(created.reversal?.id ?? '');
    } catch (reasonError) {
      setError(apiErrorMessage(toApiError(reasonError), t) ?? t('journalReversal.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="ac-tab__ghost" onClick={() => { setError(null); setOpen(true); }}>{t('journalReversal.button')}</button>
      {open && (
        <Dialog title={t('journalReversal.title')} busy={busy} onClose={() => setOpen(false)}>
          <div className="form-grid">
            <p>{t('journalReversal.confirmation')}</p>
            <label>
              <span>{t('journalReversal.date')}</span>
              <input type="date" value={date} min={journalDate} max={today()} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label>
              <span>{t('journalReversal.reason')}</span>
              <textarea value={reason} maxLength={500} rows={3} onChange={(e) => setReason(e.target.value)} />
            </label>
            {error && <p role="alert" className="error">{error}</p>}
            <div className="modal-actions">
              <button type="button" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
              <button type="button" className="primary" disabled={busy || !date || !reason.trim()} onClick={() => void run()}>{t('journalReversal.confirm')}</button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
