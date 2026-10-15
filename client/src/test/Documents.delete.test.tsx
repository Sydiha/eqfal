import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Documents } from '../components/Documents';
import i18n from '../i18n';

// Delete & Void Phase 2: Delete action, permanent-removal confirmation, specific blocked reason, AR/EN.
const doc = (status: string) => ({ id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status, created_at: '2026-08-15T00:00:00Z', review_note: null, reviewed_at: null });
const list = (status = 'uploaded') => new Response(JSON.stringify({ documents: [doc(status)], counterparties: [] }), { status: 200 });
const view = (canDelete: boolean) => render(<Documents canEdit={false} canSubmit={false} canView canUpload={false} canReview={false} canApprove={false} canDelete={canDelete} onUnauthorized={vi.fn()} />);

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });
afterEach(() => cleanup());

describe('Documents delete', () => {
  it('shows no Delete action without document.delete, nor for an approved document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(list()));
    view(false);
    await screen.findAllByText('invoice.pdf');
    expect(screen.queryByRole('button', { name: 'Delete document' })).toBeNull();
    cleanup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(list('approved')));
    view(true);
    await screen.findAllByText('invoice.pdf');
    expect(screen.queryByRole('button', { name: 'Delete document' })).toBeNull();
  });

  it('confirms permanent removal, sends DELETE and reloads', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(list())
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true, storage_cleanup: 'done' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [], counterparties: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    view(true);
    await screen.findAllByText('invoice.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Delete document' }));
    expect(screen.getByText(/permanently remove "invoice.pdf"/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing is sent before confirming
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/documents/doc-1');
    expect(fetchMock.mock.calls[1]![1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
    expect(await screen.findByText('Document deleted.')).toBeInTheDocument();
  });

  it('shows the specific blocking dependency and keeps the document', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(list())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'x', code: 'DOCUMENT_DELETE_BLOCKED', reason: 'invoice', dependency: 'invoice_source_links' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    view(true);
    await screen.findAllByText('invoice.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Delete document' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByText(/attached to an invoice/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders the Arabic labels', async () => {
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(list()));
    view(true);
    await screen.findAllByText('invoice.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'حذف المستند' }));
    expect(screen.getByRole('button', { name: 'حذف نهائي' })).toBeInTheDocument();
    await i18n.changeLanguage('en');
  });
});
