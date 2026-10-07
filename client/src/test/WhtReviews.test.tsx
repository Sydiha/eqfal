import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhtReviews } from '../components/WhtReviews';
import i18n from '../i18n';

const review = {
  id: 'review-1', source_type: 'document', source_id: 'source-1', counterparty_name: 'Supplier',
  non_resident_assessment: 'unknown', payment_service_category: 'Services', basis_reference: 'Contract',
  professional_review_required: true, workflow_status: 'needs_review', version: 3,
};

const renderReviews = (permissions: Partial<{ canCreate: boolean; canEdit: boolean; canSubmit: boolean; canReview: boolean }> = {}) => render(
  <WhtReviews fiscalYearId="fy-1" canView canCreate={false} canEdit={false} canSubmit={false} canReview={false} onUnauthorized={vi.fn()} onChanged={vi.fn()} {...permissions}/>,
);

describe('WHT review granular capabilities', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage('en');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ reviews: [review] }), { status: 200 }));
  });

  it('gates create, edit, submit, and review actions independently', async () => {
    renderReviews();
    expect(await screen.findByText('Supplier')).toBeInTheDocument();
    for (const action of ['Create review', 'Edit', 'Submit for review', 'Review: not applicable', 'Review: applicable']) {
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument();
    }
  });

  it('shows each action only with its capability', async () => {
    const { unmount } = renderReviews({ canCreate: true });
    expect(await screen.findByRole('button', { name: 'Create review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    unmount();
    renderReviews({ canSubmit: true, canReview: true });
    expect(await screen.findByRole('button', { name: 'Submit for review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review: applicable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('sends a partial PATCH with the current version through the edit path', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ reviews: [review] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ review: { ...review, version: 4 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ reviews: [{ ...review, version: 4 }] }), { status: 200 }));
    renderReviews({ canEdit: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit' });
    const inputs = form.querySelectorAll('input');
    fireEvent.change(inputs[0]!, { target: { value: 'Consulting' } });
    fireEvent.change(inputs[1]!, { target: { value: 'Updated agreement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/wht-reviews/fy-1/review-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ version: 3, payment_service_category: 'Consulting', basis_reference: 'Updated agreement' }),
    })));
  });

  it('renders workflow status and the professional-review flag in the active language', async () => {
    renderReviews();
    expect(await screen.findByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    await i18n.changeLanguage('ar');
    expect(await screen.findByText('يحتاج مراجعة')).toBeInTheDocument();
    expect(screen.getByText('نعم')).toBeInTheDocument();
    expect(screen.queryByText('needs_review')).toBeNull();
  });
});
