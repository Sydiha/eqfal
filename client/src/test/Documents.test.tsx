import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Documents } from '../components/Documents';
import i18n from '../i18n';

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.restoreAllMocks();
});

describe('Documents', () => {
  const intakeDocument = { id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'uploaded', created_at: '2026-08-15T00:00:00Z', review_note: null, reviewed_at: null, document_type: 'purchase', counterparty_name: 'Supplier A', document_date: '2026-08-14', reference_number: 'INV-7', total_amount: '42.50', intake_note: 'Original note' };
  it('renders nothing without document capabilities', () => {
    const { container } = render(<Documents canView={false} canUpload={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('loads company documents when view capability is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      documents: [{ id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'approved', review_note: 'Looks good', reviewed_at: '2026-08-15T12:00:00Z', created_at: '2026-08-15T00:00:00Z' }],
    }), { status: 200 })));

    render(<Documents canView canUpload={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();
    expect(screen.getByText('Review note: Looks good')).toBeInTheDocument();
    expect(screen.getByText(/Reviewed at:/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/api/documents/doc-1/file');
  });

  it('uploads the selected file as the raw request body and refreshes the list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { id: 'doc-1' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Documents canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    await screen.findByText('No documents uploaded yet.');

    const file = new File([new Uint8Array([0x25,0x50,0x44,0x46,0x2d])], 'invoice.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Choose document'), { target: { files: [file] } });
    const form = screen.getByRole('button', { name: 'Upload document' }).closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const uploadCall = fetchMock.mock.calls[1]!;
    expect(uploadCall[0]).toBe('/api/documents');
    expect(uploadCall[1]).toEqual(expect.objectContaining({ method: 'POST', body: file }));
  });

  it('hides Approve from a document.review-only user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      documents: [{ id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'needs_review', created_at: '2026-08-15T00:00:00Z' }],
    }), { status: 200 })));

    render(<Documents canView canUpload={false} canReview canApprove={false} onUnauthorized={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Mark incomplete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows Submit for review only to uploaders for uploaded documents', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      documents: [{ id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'uploaded', created_at: '2026-08-15T00:00:00Z' }],
    }), { status: 200 })));

    render(<Documents canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Submit for review' })).toBeInTheDocument();
  });

  it('shows stored intake and editable controls only to uploaders while uploaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: [intakeDocument] }), { status: 200 })));
    const { rerender } = render(<Documents canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Save Intake' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Supplier A')).toBeInTheDocument();
    expect(screen.getByText('Invoice / Reference Number: INV-7')).toBeInTheDocument();
    rerender(<Documents canView canUpload={false} canReview canApprove={false} onUnauthorized={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Save Intake' })).not.toBeInTheDocument();
    expect(screen.getByText('Counterparty / Supplier / Entity name: Supplier A')).toBeInTheDocument();
  });

  it('does not retain intake editor data after remounting for another company', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [intakeDocument] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [{ ...intakeDocument, id: 'doc-2', counterparty_name: 'Supplier B' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = render(<Documents canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByDisplayValue('Supplier A')).toBeInTheDocument();
    first.unmount();
    render(<Documents canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByDisplayValue('Supplier B')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Supplier A')).not.toBeInTheDocument();
  });
});
