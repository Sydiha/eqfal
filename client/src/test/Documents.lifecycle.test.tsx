import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Documents } from '../components/Documents';
import i18n from '../i18n';

const base = { id: 'doc-1', version: 3, original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'uploaded', created_at: '2026-08-15T00:00:00Z', review_note: null, reviewed_at: null, document_type: 'purchase', counterparty_id: null, counterparty_name: 'ACME', relational_counterparty_name: null, document_date: '2026-08-10', reference_number: 'INV-1', total_amount: '100.00', intake_note: null };
const list = (doc: object) => new Response(JSON.stringify({ documents: [doc], counterparties: [] }), { status: 200 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const match = { id: 'x', original_filename: 'older.pdf', status: 'approved', document_date: null, reference_number: 'INV-1', match: 'supplier_reference' };

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });
afterEach(() => { cleanup(); document.documentElement.dir = 'ltr'; });
const renderDocs = () => render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);

describe('Documents R6 lifecycle', () => {
  it('shows the change-reason field only for a previously reviewed document and sends it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(list({ ...base, reviewed_at: '2026-08-12T00:00:00Z' }))
      .mockResolvedValueOnce(json({ document: base })).mockResolvedValue(list(base));
    vi.stubGlobal('fetch', fetchMock);
    renderDocs();
    const reason = await screen.findByLabelText(/Reason for the change/);
    fireEvent.change(screen.getByLabelText('Invoice / Reference Number'), { target: { value: 'INV-2' } });
    fireEvent.change(reason, { target: { value: 'typo' } });
    fireEvent.submit(reason.closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/api/documents/doc-1/intake')).toBe(true));
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/documents/doc-1/intake')!;
    expect(call[1].headers['if-match']).toBe('3');
    expect(JSON.parse(call[1].body)).toMatchObject({ reference_number: 'INV-2', change_reason: 'typo' });
  });

  it('does not show the reason field for a never-reviewed document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(list(base)));
    renderDocs();
    await screen.findByLabelText('Invoice / Reference Number');
    expect(screen.queryByLabelText(/Reason for the change/)).toBeNull();
  });

  it('replaces the file with the revision in If-Match', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(list(base))
      .mockResolvedValueOnce(json({ document: base, duplicate_warnings: [match] })).mockResolvedValue(list(base));
    vi.stubGlobal('fetch', fetchMock);
    renderDocs();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace file' }));
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['%PDF-1.7 new'], 'new.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(put[0]).toBe('/api/documents/doc-1/file');
    expect(put[1].headers['if-match']).toBe('3');
    expect(await screen.findByText(/Possible duplicate/)).toBeInTheDocument();
  });

  it('offers no replacement for approved documents', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(list({ ...base, status: 'approved', reviewed_at: '2026-08-12T00:00:00Z' })));
    renderDocs();
    await screen.findByText('invoice.pdf', { selector: 'span' });
    expect(screen.queryByRole('button', { name: 'Replace file' })).toBeNull();
  });

  it('asks for a reason on a suspected duplicate at submit and resubmits with it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(list(base))
      .mockResolvedValueOnce(json({ error: 'Possible duplicate document', code: 'DOCUMENT_DUPLICATE_SUSPECTED', duplicates: [match] }, 409))
      .mockResolvedValueOnce(json({ document: base })).mockResolvedValue(list(base));
    vi.stubGlobal('fetch', fetchMock);
    renderDocs();
    fireEvent.click(await screen.findByRole('button', { name: /Submit/ }));
    const reason = await screen.findByLabelText(/Why is this a separate document/);
    fireEvent.change(reason, { target: { value: 'credit note' } });
    fireEvent.submit(reason.closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/submit-review')).length).toBe(2));
    const second = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/submit-review'))[1]!;
    expect(JSON.parse(second[1].body)).toEqual({ duplicate_check: 'warn', duplicate_reason: 'credit note' });
  });

  it('shows Arabic copy', async () => {
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(list(base)));
    renderDocs();
    expect(await screen.findByRole('button', { name: 'استبدال الملف' })).toBeInTheDocument();
  });
});
