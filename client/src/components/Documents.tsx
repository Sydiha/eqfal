import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type DocumentItem = {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  created_at: string;
};

interface DocumentsProps {
  canView: boolean;
  canUpload: boolean;
  onUnauthorized: () => void;
}

export function Documents({ canView, canUpload, onUnauthorized }: DocumentsProps) {
  const { t } = useTranslation();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(canView);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (!canView && !canUpload) return null;

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
                  <td>{t(`documents.statuses.${document.status}`)}</td>
                  <td>{Math.max(1, Math.round(document.size_bytes / 1024))} KB</td>
                  <td><a href={`/api/documents/${document.id}/file`} target="_blank" rel="noreferrer">{t('documents.open')}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
