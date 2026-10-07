import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Documents } from '../components/Documents';
import i18n from '../i18n';

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.restoreAllMocks();
});

describe('Documents', () => {
  const counterparties = [{ id: 'cp-1', name: 'Relational Supplier', is_active: true }, { id: 'cp-inactive', name: 'Inactive Supplier', is_active: false }];
  const intakeDocument = { id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'uploaded', created_at: '2026-08-15T00:00:00Z', review_note: null, reviewed_at: null, document_type: 'purchase', counterparty_id: 'cp-1', counterparty_name: 'Legacy Supplier', relational_counterparty_name: 'Relational Supplier', document_date: '2026-08-14', reference_number: 'INV-7', total_amount: '42.50', intake_note: 'Original note' };
  it('renders nothing without document capabilities', () => {
    const { container } = render(<Documents canEdit={false} canSubmit={false} canView={false} canUpload={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('loads company documents when view capability is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      documents: [{ id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'approved', review_note: 'Looks good', reviewed_at: '2026-08-15T12:00:00Z', created_at: '2026-08-15T00:00:00Z' }],
    }), { status: 200 })));

    render(<Documents canEdit={false} canSubmit={false} canView canUpload={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findAllByText('invoice.pdf')).toHaveLength(2);
    expect(screen.getByText('Looks good')).toBeInTheDocument();
    expect(screen.getByText('Review note')).toBeInTheDocument();
    expect(screen.getByText('Reviewed at')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/api/documents/doc-1/file');
  });

  it('uploads the selected file as the raw request body and refreshes the list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { id: 'doc-1' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    await screen.findByText('No documents uploaded yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));

    const file = new File([new Uint8Array([0x25,0x50,0x44,0x46,0x2d])], 'invoice.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText(/Choose document/), { target: { files: [file] } });
    const form = screen.getAllByRole('button', { name: 'Upload document' }).find(button => button.closest('form'))?.closest('form');
    expect(form).toBeTruthy();
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

    render(<Documents canEdit={false} canSubmit={false} canView canUpload={false} canReview canApprove={false} onUnauthorized={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Mark incomplete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows Submit for review only to uploaders for uploaded documents', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      documents: [{ id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'uploaded', created_at: '2026-08-15T00:00:00Z' }],
    }), { status: 200 })));

    render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Submit for review' })).toBeInTheDocument();
  });

  it('gates upload, intake edit, and submit independently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      documents: [intakeDocument], counterparties,
    }), { status: 200 }))));

    const uploadOnly = render(<Documents canView canUpload canEdit={false} canSubmit={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    await screen.findAllByText('invoice.pdf');
    expect(screen.getByRole('button', { name: 'Upload document' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Intake' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument();
    uploadOnly.unmount();

    const editOnly = render(<Documents canView canUpload={false} canEdit canSubmit={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Save Intake' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload document' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument();
    editOnly.unmount();

    render(<Documents canView canUpload={false} canEdit={false} canSubmit canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Submit for review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload document' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Intake' })).not.toBeInTheDocument();
  });

  it.each([
    ['', { decision: 'approved' }],
    ['  Ready to post  ', { decision: 'approved', note: 'Ready to post' }],
  ])('approves with the supported optional note value %j', async (note, expectedBody) => {
    const reviewDocument = { ...intakeDocument, status: 'needs_review' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [reviewDocument] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: reviewDocument }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [reviewDocument] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Documents canEdit={false} canSubmit={false} canView canUpload={false} canReview={false} canApprove onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: note } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(expectedBody);
  });

  it.each([['Mark incomplete'], ['Reject']])('requires a reason before submitting %s', async (action) => {
    const reviewDocument = { ...intakeDocument, status: 'needs_review' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: [reviewDocument] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Documents canEdit={false} canSubmit={false} canView canUpload={false} canReview canApprove={false} onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: action }));
    fireEvent.submit(screen.getByRole('button', { name: 'Confirm' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('A reason is required.');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('shows stored intake and editable controls only to uploaders while uploaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: [intakeDocument], counterparties }), { status: 200 })));
    const onUnauthorized = vi.fn();
    const { rerender } = render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={onUnauthorized} />);
    expect(await screen.findByRole('button', { name: 'Save Intake' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Relational Supplier')).toBeInTheDocument();
    expect(screen.getByDisplayValue('INV-7')).toBeInTheDocument();
    rerender(<Documents canEdit={false} canSubmit={false} canView canUpload={false} canReview canApprove={false} onUnauthorized={onUnauthorized} />);
    expect(screen.queryByRole('button', { name: 'Save Intake' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Relational Supplier').length).toBeGreaterThan(0);
  });

  it.each(['needs_review', 'approved', 'incomplete', 'rejected'])('hides editable Intake controls from uploaders when status is %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      documents: [{ ...intakeDocument, status }],
    }), { status: 200 })));

    render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);

    expect(await screen.findAllByText('invoice.pdf')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Save Intake' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Document Type')).not.toBeInTheDocument();
  });

  it.each([
    ['en', ['Document Type', 'Counterparty / Supplier / Entity name', 'Document Date', 'Invoice / Reference Number', 'Total Amount', 'Optional Note', 'Save Intake']],
    ['ar', ['نوع المستند', 'اسم الطرف المقابل / المورد / الجهة', 'تاريخ المستند', 'رقم الفاتورة / المرجع', 'المبلغ الإجمالي', 'ملاحظة اختيارية', 'حفظ بيانات الإدخال']],
  ] as const)('shows all Intake editor labels in %s', async (language, labels) => {
    await i18n.changeLanguage(language);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: [intakeDocument], counterparties }), { status: 200 })));

    render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);

    expect(await screen.findByLabelText(labels[0])).toBeInTheDocument();
    for (const label of labels.slice(1, 6)) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: labels[6] })).toBeInTheDocument();
  });

  it('does not retain intake editor data after remounting for another company', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [intakeDocument], counterparties }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [{ ...intakeDocument, id: 'doc-2', counterparty_id: 'cp-2', counterparty_name: 'Legacy B', relational_counterparty_name: 'Supplier B' }], counterparties: [{ id: 'cp-2', name: 'Supplier B', is_active: true }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByDisplayValue('Relational Supplier')).toBeInTheDocument();
    first.unmount();
    render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByDisplayValue('Supplier B')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Relational Supplier')).not.toBeInTheDocument();
  });

  it('submits a relational counterparty id and never writes the legacy name', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [{ ...intakeDocument, counterparty_id: null, relational_counterparty_name: null }], counterparties }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: intakeDocument }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [intakeDocument], counterparties }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Counterparty / Supplier / Entity name'), { target: { value: 'cp-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Intake' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.counterparty_id).toBe('cp-1');
    expect(body).not.toHaveProperty('counterparty_name');
  });

  it('displays an inactive historical link but does not offer other inactive counterparties', async () => {
    const historical = { ...intakeDocument, counterparty_id: 'cp-inactive', relational_counterparty_name: 'Inactive Supplier' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: [historical], counterparties: [...counterparties, { id: 'cp-other-inactive', name: 'Other Inactive', is_active: false }] }), { status: 200 })));
    render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    const selector = await screen.findByLabelText('Counterparty / Supplier / Entity name');
    expect(selector).toHaveDisplayValue('Inactive Supplier');
    expect(screen.getByRole('option', { name: 'Inactive Supplier' })).toBeDisabled();
    expect(screen.queryByRole('option', { name: 'Other Inactive' })).not.toBeInTheDocument();
  });

  it('uses legacy counterparty text only when no relational name exists', async () => {
    const legacy = { ...intakeDocument, status: 'approved', counterparty_id: null, relational_counterparty_name: null, counterparty_name: 'Legacy Supplier' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: [legacy], counterparties }), { status: 200 })));
    render(<Documents canEdit={false} canSubmit={false} canView canUpload={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
    expect((await screen.findAllByText('Legacy Supplier')).length).toBeGreaterThan(0);
  });

  describe('coded errors (Task 35D Phase 2)', () => {
    const needsReviewDoc = { id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'needs_review', created_at: '2026-08-15T00:00:00Z', review_note: null, reviewed_at: null };
    const reviewFetch = (failure: () => Response | Promise<Response>) => vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return failure();
      return new Response(JSON.stringify({ documents: [needsReviewDoc] }), { status: 200 });
    });
    const approve = async () => {
      render(<Documents canEdit={false} canSubmit={false} canView canUpload={false} canReview canApprove onUnauthorized={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    };

    it.each([
      ['DOCUMENT_STATE_CONFLICT', 409, 'The document state has changed or no longer allows this action. Refresh and try again.'],
      ['DOCUMENT_COUNTERPARTY_INVALID', 409, 'Select a valid counterparty for this document before continuing.'],
      ['DOCUMENT_APPROVAL_DATA_INCOMPLETE', 409, 'The document cannot be approved until it has a valid document date and total amount.'],
      ['ACCOUNTING_PERIOD_CLOSED', 409, null],
      ['DB_UNAVAILABLE', 503, null],
    ] as const)('shows the translated message for review failure %s', async (code, status, message) => {
      vi.stubGlobal('fetch', reviewFetch(() => new Response(JSON.stringify({ error: 'Document review conflict', code }), { status })));
      await approve();
      const expected = message ?? i18n.t(`errors.${code}`);
      expect(await screen.findByText(expected)).toBeInTheDocument();
      expect(screen.queryByText('Document review conflict')).toBeNull();
    });

    it('keeps the legacy conflict message for a code-less 409 and a generic one for an unknown 500', async () => {
      vi.stubGlobal('fetch', reviewFetch(() => new Response(JSON.stringify({ error: 'Document review conflict' }), { status: 409 })));
      const first = render(<Documents canEdit={false} canSubmit={false} canView canUpload={false} canReview canApprove onUnauthorized={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
      expect(await screen.findByText(i18n.t('documents.reviewConflict'))).toBeInTheDocument();
      first.unmount();
      vi.stubGlobal('fetch', reviewFetch(() => new Response(JSON.stringify({ error: 'pg: deadlock detected' }), { status: 500 })));
      await approve();
      expect(await screen.findByText(i18n.t('documents.reviewError'))).toBeInTheDocument();
      expect(screen.queryByText(/deadlock/)).toBeNull();
    });

    it('shows the shared network message when a review request cannot reach the server', async () => {
      vi.stubGlobal('fetch', reviewFetch(() => { throw new TypeError('Failed to fetch'); }));
      await approve();
      expect(await screen.findByText(i18n.t('errors.NETWORK_ERROR'))).toBeInTheDocument();
    });

    it.each([
      [400, 'documents.invalid'],
      [413, 'documents.tooLarge'],
      [403, 'documents.error'],
      [500, 'documents.error'],
    ] as const)('maps upload status %i to %s so a 403 never reads as an invalid file', async (status, key) => {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
        ? new Response(JSON.stringify({ error: 'Forbidden' }), { status })
        : new Response(JSON.stringify({ documents: [] }), { status: 200 })));
      render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
      await screen.findByText('No documents uploaded yet.');
      fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));
      fireEvent.change(screen.getByLabelText(/Choose document/), { target: { files: [new File([new Uint8Array([1])], 'invoice.pdf', { type: 'application/pdf' })] } });
      fireEvent.submit(screen.getAllByRole('button', { name: 'Upload document' }).find(button => button.closest('form'))!.closest('form')!);
      expect((await screen.findAllByText(i18n.t(key))).length).toBeGreaterThan(0);
    });

    it('uses DB_UNAVAILABLE for an upload 503 and NETWORK_ERROR when the upload cannot connect', async () => {
      const upload = async () => {
        render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} onUnauthorized={vi.fn()} />);
        await screen.findByText('No documents uploaded yet.');
        fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));
        fireEvent.change(screen.getByLabelText(/Choose document/), { target: { files: [new File([new Uint8Array([1])], 'invoice.pdf', { type: 'application/pdf' })] } });
        fireEvent.submit(screen.getAllByRole('button', { name: 'Upload document' }).find(button => button.closest('form'))!.closest('form')!);
      };
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
        ? new Response(JSON.stringify({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }), { status: 503 })
        : new Response(JSON.stringify({ documents: [] }), { status: 200 })));
      await upload();
      expect((await screen.findAllByText(i18n.t('errors.DB_UNAVAILABLE'))).length).toBeGreaterThan(0);
      cleanup();
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ documents: [] }), { status: 200 });
      }));
      await upload();
      expect((await screen.findAllByText(i18n.t('errors.NETWORK_ERROR'))).length).toBeGreaterThan(0);
    });
  });
});
