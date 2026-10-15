import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiErrorMessage, parseApiError, toApiError } from '../api/apiError';
import { Dialog } from './Dialog';

export type DeletableKind = 'journal' | 'periodicAdjustment' | 'bankImport' | 'counterparty' | 'partner';

interface Props {
  kind: DeletableKind;
  /** DELETE endpoint, including ?version=N where the record is versioned. */
  url: string;
  /** Record name shown in the confirmation. */
  name: string;
  onDeleted: () => void | Promise<void>;
  onUnauthorized: () => void;
  className?: string;
}

/**
 * One confirmation flow for permanent deletion (Delete & Void Phase 3). The wording always says "permanently" so it is never confused with
 * cancellation or reversal; the server decides what may be deleted and answers 409 + reason, which is shown here in plain words.
 */
export function DeleteRecordAction({ kind, url, name, onDeleted, onUnauthorized, className }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) {
        let reason = '';
        try { const payload = await response.clone().json() as { reason?: unknown }; if (typeof payload.reason === 'string') reason = payload.reason; } catch { /* no body */ }
        const failure = await parseApiError(response);
        const blocked = failure.code?.endsWith('_DELETE_BLOCKED') ? t([`recordDelete.blocked.${reason}`, 'recordDelete.blocked.other']) : null;
        setError(blocked ?? (failure.code === 'VERSION_CONFLICT' ? t('recordDelete.versionConflict') : null) ?? apiErrorMessage(failure, t) ?? t('recordDelete.error'));
        return;
      }
      setOpen(false);
      await onDeleted();
    } catch (reason) {
      setError(apiErrorMessage(toApiError(reason), t) ?? t('recordDelete.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={className ?? 'danger'} onClick={() => { setError(null); setOpen(true); }}>{t(`recordDelete.${kind}.button`)}</button>
      {open && (
        <Dialog title={t(`recordDelete.${kind}.title`)} busy={busy} onClose={() => setOpen(false)}>
          <div className="form-grid">
            <p>{t(`recordDelete.${kind}.confirmation`, { name })}</p>
            {error && <p role="alert" className="error">{error}</p>}
            <div className="modal-actions">
              <button type="button" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
              <button type="button" className="danger" disabled={busy} onClick={() => void run()}>{t('recordDelete.confirm')}</button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
