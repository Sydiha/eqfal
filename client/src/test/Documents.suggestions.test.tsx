import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Documents } from '../components/Documents';
import i18n from '../i18n';

const counterparties = [{ id: 'cp-1', name: 'ACME Supplies LLC', type: 'supplier', is_active: true }];
const pdfDocument = { id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'uploaded', created_at: '2026-08-15T00:00:00Z', review_note: null, reviewed_at: null, document_type: 'purchase', counterparty_id: null, counterparty_name: null, document_date: null, reference_number: null, total_amount: null, intake_note: null };
const list = (documents: unknown[]) => new Response(JSON.stringify({ documents, counterparties }), { status: 200 });
const suggestions = { status: 'ok', fields: {
  supplier_name: { value: 'ACME Supplies LLC', state: 'found' }, invoice_number: { value: 'INV-9', state: 'found' },
  invoice_date: { value: '2024-03-15', state: 'found' }, total_amount: { value: '1150.05', state: 'found' },
} };

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });
afterEach(() => { cleanup(); document.documentElement.dir = 'ltr'; });

const renderEditor = () => render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);

describe('Documents T7.1 PDF suggestions', () => {
  it('shows suggestions and only fills the form after explicit Apply, then saves through the existing intake update', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([pdfDocument]))
      .mockResolvedValueOnce(new Response(JSON.stringify(suggestions), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: pdfDocument }), { status: 200 }))
      .mockResolvedValue(list([pdfDocument]));
    vi.stubGlobal('fetch', fetchMock);
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: 'Read PDF text' }));
    const panel = await screen.findByRole('region', { name: 'Suggestions from PDF' });
    expect(await within(panel).findByText('INV-9')).toBeInTheDocument();
    const reference = screen.getByLabelText('Invoice / Reference Number') as HTMLInputElement;
    const total = screen.getByLabelText('Total Amount') as HTMLInputElement;
    expect(reference.value).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/documents/doc-1/suggestions');

    for (const button of within(panel).getAllByRole('button', { name: 'Apply' })) fireEvent.click(button);
    expect(reference.value).toBe('INV-9');
    expect(total.value).toBe('1150.05');
    expect((screen.getByLabelText('Document Date') as HTMLInputElement).value).toBe('2024-03-15');
    expect((screen.getByLabelText('Counterparty / Supplier / Entity name') as HTMLSelectElement).value).toBe('cp-1');
    expect(fetchMock).toHaveBeenCalledTimes(2); // applying never writes

    fireEvent.submit(screen.getByLabelText('Invoice / Reference Number').closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/documents/doc-1/intake');
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toMatchObject({ reference_number: 'INV-9', document_date: '2024-03-15', total_amount: 1150.05, counterparty_id: 'cp-1' });
  });

  it('offers no Apply for ambiguous or missing values and falls back to manual entry for scanned PDFs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([pdfDocument]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', fields: { supplier_name: { value: 'Unknown Co', state: 'found' }, invoice_number: { value: null, state: 'ambiguous' }, invoice_date: { value: null, state: 'not_found' }, total_amount: { value: null, state: 'not_found' } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'no_text', fields: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: 'Read PDF text' }));
    const panel = await screen.findByRole('region', { name: 'Suggestions from PDF' });
    expect(await within(panel).findByText('More than one value found: enter it manually')).toBeInTheDocument();
    expect(within(panel).getByText('No single matching supplier in your list. Choose or add it manually.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Apply' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Read PDF text' }));
    expect(await within(panel).findByText(/no readable text/)).toBeInTheDocument();
    expect(screen.getByLabelText('Invoice / Reference Number')).not.toBeDisabled();
  });

  it('does not offer suggestions for images', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(list([{ ...pdfDocument, mime_type: 'image/png', original_filename: 'scan.png' }])));
    renderEditor();
    await screen.findByLabelText('Invoice / Reference Number');
    expect(screen.queryByRole('button', { name: 'Read PDF text' })).toBeNull();
  });

  it('renders Arabic labels and keeps extracted text as plain text', async () => {
    await i18n.changeLanguage('ar');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([pdfDocument]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', fields: { ...suggestions.fields, supplier_name: { value: '<img src=x onerror=alert(1)>', state: 'found' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: 'قراءة نص PDF' }));
    const panel = await screen.findByRole('region', { name: 'اقتراحات من ملف PDF' });
    expect(await within(panel).findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(within(panel).getByText('رقم الفاتورة')).toBeInTheDocument();
  });
});

describe('Documents T7.1 duplicate warning', () => {
  it('warns before storing a duplicate and resends only after the user chooses to continue', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'DOCUMENT_DUPLICATE', duplicate_count: 1, duplicates: [{ original_filename: 'old-invoice.pdf' }] }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { id: 'doc-2' } }), { status: 201 }))
      .mockResolvedValue(list([]));
    vi.stubGlobal('fetch', fetchMock);
    renderEditor();
    await screen.findByText('No documents uploaded yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'invoice.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText(/Choose document/), { target: { files: [file] } });
    const form = screen.getAllByRole('button', { name: 'Upload document' }).find((b) => b.closest('form'))!.closest('form')!;
    fireEvent.submit(form);
    expect(await screen.findByText(/already uploaded to this company/)).toBeInTheDocument();
    expect(screen.getByText('old-invoice.pdf')).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]![1].headers['x-duplicate-check']).toBe('warn');
    expect(screen.getByRole('button', { name: 'Upload anyway' })).toBeInTheDocument();
    fireEvent.submit(form);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[2]![1].headers['x-duplicate-check']).toBe('allow');
  });
});
