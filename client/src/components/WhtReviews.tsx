import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Review = {
  id: string;
  source_type: string;
  source_id: string;
  counterparty_name?: string | null;
  non_resident_assessment: string;
  payment_service_category: string;
  basis_reference: string;
  professional_review_required: boolean;
  workflow_status: string;
  version: number;
};

type Props = {
  fiscalYearId: string;
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  canReview: boolean;
  onUnauthorized: () => void;
  onChanged: () => void;
};

export function WhtReviews({ fiscalYearId, canView, canCreate, canEdit, canSubmit, canReview, onUnauthorized, onChanged }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Review[]>([]);
  const [error, setError] = useState('');
  const [sourceType, setSourceType] = useState('document');
  const [sourceId, setSourceId] = useState('');
  const [category, setCategory] = useState('');
  const [basis, setBasis] = useState('');
  const [editing, setEditing] = useState<Review | null>(null);
  const [editCategory, setEditCategory] = useState('');
  const [editBasis, setEditBasis] = useState('');

  const load = () => {
    if (!canView) return;
    void fetch(`/api/wht-reviews/${encodeURIComponent(fiscalYearId)}`)
      .then(async response => {
        if (response.status === 401) { onUnauthorized(); return null; }
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ reviews: Review[] }>;
      })
      .then(value => value && setItems(value.reviews))
      .catch(() => setError(t('whtReviews.loadError')));
  };

  useEffect(load, [canView, fiscalYearId]);

  const request = async (path: string, method: 'POST' | 'PATCH', body: unknown) => {
    setError('');
    const response = await fetch(`/api/wht-reviews/${encodeURIComponent(fiscalYearId)}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 401) { onUnauthorized(); return false; }
    if (!response.ok) { setError(t('whtReviews.actionError')); return false; }
    load();
    onChanged();
    return true;
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const response = await request('', 'POST', {
      source_type: sourceType,
      source_id: sourceId,
      non_resident_assessment: 'unknown',
      payment_service_category: category,
      basis_reference: basis,
      professional_review_required: true,
    });
    if (response) { setSourceId(''); setCategory(''); setBasis(''); }
  };

  const startEdit = (review: Review) => {
    setEditing(review);
    setEditCategory(review.payment_service_category);
    setEditBasis(review.basis_reference);
  };

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const updated = await request(`/${editing.id}`, 'PATCH', {
      version: editing.version,
      payment_service_category: editCategory,
      basis_reference: editBasis,
    });
    if (updated) setEditing(null);
  };

  if (!canView) return null;
  return <section className="panel">
    <h2>{t('whtReviews.title')}</h2>
    <p>{t('whtReviews.boundary')}</p>
    {error && <p role="alert">{error}</p>}
    {canCreate && <form onSubmit={event => void create(event)}>
      <label>{t('whtReviews.sourceType')}<select value={sourceType} onChange={event => setSourceType(event.target.value)}><option value="document">document</option><option value="obligation">obligation</option><option value="bank_transaction">bank transaction</option></select></label>
      <label>{t('whtReviews.sourceId')}<input required value={sourceId} onChange={event => setSourceId(event.target.value)}/></label>
      <label>{t('whtReviews.category')}<input required maxLength={200} value={category} onChange={event => setCategory(event.target.value)}/></label>
      <label>{t('whtReviews.basis')}<input required maxLength={2000} value={basis} onChange={event => setBasis(event.target.value)}/></label>
      <button>{t('whtReviews.create')}</button>
    </form>}
    {editing && <form aria-label={t('whtReviews.edit')} onSubmit={event => void saveEdit(event)}>
      <label>{t('whtReviews.category')}<input required maxLength={200} value={editCategory} onChange={event => setEditCategory(event.target.value)}/></label>
      <label>{t('whtReviews.basis')}<input required maxLength={2000} value={editBasis} onChange={event => setEditBasis(event.target.value)}/></label>
      <button>{t('whtReviews.save')}</button>
      <button type="button" onClick={() => setEditing(null)}>{t('whtReviews.cancel')}</button>
    </form>}
    <div className="table-wrap"><table><thead><tr><th>{t('whtReviews.source')}</th><th>{t('whtReviews.counterparty')}</th><th>{t('whtReviews.assessment')}</th><th>{t('whtReviews.category')}</th><th>{t('whtReviews.basis')}</th><th>{t('whtReviews.reviewRequired')}</th><th>{t('annualClosing.state')}</th><th>{t('whtReviews.actions')}</th></tr></thead><tbody>
      {items.map(review => <tr key={review.id}><td>{review.source_type}: {review.source_id}</td><td>{review.counterparty_name ?? '—'}</td><td>{review.non_resident_assessment}</td><td>{review.payment_service_category}</td><td>{review.basis_reference}</td><td>{review.professional_review_required ? 'Yes' : 'No'}</td><td>{review.workflow_status}</td><td>
        {canEdit && <button type="button" onClick={() => startEdit(review)}>{t('whtReviews.edit')}</button>}
        {canSubmit && review.workflow_status === 'needs_review' && <button onClick={() => void request(`/${review.id}/submit`, 'POST', { version: review.version })}>{t('whtReviews.submit')}</button>}
        {canReview && ['needs_review', 'submitted'].includes(review.workflow_status) && <><button onClick={() => void request(`/${review.id}/review`, 'POST', { version: review.version, result: 'not_applicable' })}>{t('whtReviews.notApplicable')}</button><button onClick={() => void request(`/${review.id}/review`, 'POST', { version: review.version, result: 'applicable' })}>{t('whtReviews.applicable')}</button></>}
      </td></tr>)}
    </tbody></table></div>
  </section>;
}
