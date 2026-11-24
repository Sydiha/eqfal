import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Documents } from '../components/Documents';
import i18n from '../i18n';

const doc = (id: string, name: string) => ({ id, original_filename: name, mime_type: 'application/pdf', size_bytes: 10, status: 'approved', review_note: null, reviewed_at: null, created_at: '2026-08-15T00:00:00Z', document_type: 'purchase', counterparty_id: null, counterparty_name: null, document_date: null, reference_number: null, total_amount: null, intake_note: null });

beforeEach(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

it('does not open any document preview until a row is selected explicitly', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: [doc('d1', 'first.pdf'), doc('d2', 'second.pdf')] }), { status: 200 })));
  render(<Documents canEdit={false} canSubmit={false} canView canUpload={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
  await screen.findByRole('button', { name: 'first.pdf' });
  expect(screen.getAllByText('first.pdf')).toHaveLength(1);
  expect(screen.queryByRole('link', { name: 'Open' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'second.pdf' }));
  await waitFor(() => expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/api/documents/d2/file'));
});
