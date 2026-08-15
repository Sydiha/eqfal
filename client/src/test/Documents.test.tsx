import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Documents } from '../components/Documents';
import i18n from '../i18n';

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.restoreAllMocks();
});

describe('Documents', () => {
  it('renders nothing without document capabilities', () => {
    const { container } = render(<Documents canView={false} canUpload={false} onUnauthorized={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('loads company documents when view capability is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      documents: [{ id: 'doc-1', original_filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, status: 'uploaded', created_at: '2026-08-15T00:00:00Z' }],
    }), { status: 200 })));

    render(<Documents canView canUpload={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/api/documents/doc-1/file');
  });

  it('uploads the selected file as the raw request body and refreshes the list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { id: 'doc-1' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ documents: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<Documents canView canUpload onUnauthorized={vi.fn()} />);
    await screen.findByText('No documents uploaded yet.');

    const file = new File([new Uint8Array([0x25,0x50,0x44,0x46,0x2d])], 'invoice.pdf', { type: 'application/pdf' });
    const input = screen.getByLabelText('', { selector: 'input[type="file"]' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const uploadCall = fetchMock.mock.calls[1]!;
    expect(uploadCall[0]).toBe('/api/documents');
    expect(uploadCall[1]).toEqual(expect.objectContaining({ method: 'POST', body: file }));
  });
});
