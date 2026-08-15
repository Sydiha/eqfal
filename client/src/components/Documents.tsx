import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type DocumentItem = {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
};

interface DocumentsProps {
  canView: boolean;
  canUpload: boolean;
  canReview: boolean;
  canApprove: boolean;
  onUnauthorized: () => void;
}

export function Documents({ canView, canUpload, canReview, canApprove, onUnauthorized }: DocumentsProps) {
  const { t } = useTranslation();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(canView);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/documents', { credentials: 'same-origin' });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error('load');
      const body = await response.json() as { documents: DocumentItem[] };
      setDocuments(body.documents);
    } catch {
      setError(t('documents.error'));
    } finally {
      setLoading(false);
    }
  }, [canView, onUnauthorized, t]);

  useEffect(() => { void load(); }, [load]);

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem('document') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      const response = await fetch('/api/documents', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        setError(response.status === 413 ? t('documents.tooLarge') : t('documents.invalid'));
        return;
      }
      form.reset();
      if (canView) await load();
    } catch {
      setError(t('documents.error'));
    } finally {
      setUploading(false);
    }
  };

  const mutateReview = async (documentId: string, path: 'submit-review' | 'review', body?: object) => {
    setReviewingId(documentId); setError(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/${path}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
      });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) { setError(response.status === 409 ? t('documents.reviewConflict') : t('documents.reviewError')); return; }
      await load();
    } catch { setError(t('documents.reviewError')); }
    finally { setReviewingId(null); }
  };

  const decide = (documentId: string, decision: 'approved' | 'incomplete' | 'rejected') => {
    let note: string | undefined;
    if (decision !== 'approved') {
      note = window.prompt(t('documents.reviewReason'))?.trim();
      if (!note) return;
    }
    void mutateReview(documentId, 'review', { decision, ...(note ? { note } : {}) });
  };

  if (!canView && !canUpload && !canReview && !canApprove) return null;

  return (
    <section className="panel">
      <h2>{t('documents.title')}</h2>
      <p>{t('documents.description')}</p>

      {canUpload && (
        <form onSubmit={upload} style={{ display: 'grid', gap: '0.75rem', marginBlock: '1rem' }}>
          <input
            name="document"
            type="file"
            aria-label={t('documents.chooseFile')}
            accept="application/pdf,image/jpeg,image/png,image/webp"
            required
          />
          <button disabled={uploading}>{uploading ? t('documents.uploading') : t('documents.upload')}</button>
        </form>
      )}

      {error && <p role="alert">{error}</p>}
      {canView && loading && <p role="status">{t('documents.loading')}</p>}
      {canView && !loading && documents.length === 0 && <p>{t('documents.empty')}</p>}
      {canView && documents.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>{t('documents.file')}</th><th>{t('documents.status')}</th><th>{t('documents.size')}</th><th>{t('documents.actions')}</th></tr></thead>
            <tbody>
              {documents.map(document => (
                <tr key={document.id}>
                  <td>{document.original_filename}</td>
                  <td>
                    <div>{t(`documents.statuses.${document.status}`)}</div>
                    {document.review_note && <div>{t('documents.reviewNote')}: {document.review_note}</div>}
                    {document.reviewed_at && <div>{t('documents.reviewedAt')}: {new Date(document.reviewed_at).toLocaleString()}</div>}
                  </td>
                  <td>{Math.max(1, Math.round(document.size_bytes / 1024))} KB</td>
                  <td>
                    <a href={`/api/documents/${document.id}/file`} target="_blank" rel="noreferrer">{t('documents.open')}</a>
                    {((canUpload && document.status === 'uploaded') || ((canReview || canApprove) && document.status === 'needs_review')) && <span className="document-review-actions">
                      {canUpload && document.status === 'uploaded' && <button disabled={reviewingId === document.id} onClick={() => void mutateReview(document.id, 'submit-review')}>{t('documents.reviewActions.submit')}</button>}
                      {canReview && document.status === 'needs_review' && <>
                        <button disabled={reviewingId === document.id} onClick={() => decide(document.id, 'incomplete')}>{t('documents.reviewActions.incomplete')}</button>
                        <button disabled={reviewingId === document.id} onClick={() => decide(document.id, 'rejected')}>{t('documents.reviewActions.rejected')}</button>
                      </>}
                      {canApprove && document.status === 'needs_review' && <button disabled={reviewingId === document.id} onClick={() => decide(document.id, 'approved')}>{t('documents.reviewActions.approved')}</button>}
                    </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
