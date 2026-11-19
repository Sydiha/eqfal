import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi, expect, it } from 'vitest';
import { ZakatRegulatoryReview } from '../components/ZakatRegulatoryReview';

it('shows the B9 binding and submits only the server supplied version and suite digest', async () => {
  const write = vi.fn().mockResolvedValue(true);
  const binding = { engine_version: `sha256:${'a'.repeat(64)}`, reference_suite_digest: `sha256:${'b'.repeat(64)}` };
  render(<ZakatRegulatoryReview
    data={{ regulatory_binding: binding, regulatory_decisions: [], regulatory_reviewers: [], finalization: { status: 'BLOCKED', blockers: ['B9'], payable_amount_halalas: null } }}
    ar={false} busy={false} reviewed canSubmit canApprove={false} canViewDocuments version={3}
    documents={[{ id: 'document-1', original_filename: 'review.pdf', status: 'approved' }]}
    write={write} blockerLabel={(code) => code}
  />);
  const b9 = screen.getByText(/Authorized accountant sign-off/).closest('.zw-card') as HTMLElement;
  expect(within(b9).getByText(binding.engine_version)).toBeInTheDocument();
  expect(within(b9).getByText(binding.reference_suite_digest)).toBeInTheDocument();
  fireEvent.click(within(b9).getByRole('button', { name: 'Submit evidence for review' }));
  fireEvent.change(within(b9).getByLabelText('Approved evidence document'), { target: { value: 'document-1' } });
  fireEvent.change(within(b9).getByLabelText('Authority and evidence location'), { target: { value: 'Signed review, page 2' } });
  fireEvent.click(within(b9).getByRole('button', { name: 'Send for review' }));
  await waitFor(() => expect(write).toHaveBeenCalledWith('/regulatory-decisions', 'POST', {
    gate: 'B9', version: 3, evidence_document_id: 'document-1', authority_reference: 'Signed review, page 2',
    facts: { engineVersion: binding.engine_version, referenceSuiteDigest: binding.reference_suite_digest },
  }));
});
