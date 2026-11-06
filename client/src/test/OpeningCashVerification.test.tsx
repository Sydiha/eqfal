import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpeningCashVerification } from '../components/OpeningCashVerification';

afterEach(() => vi.restoreAllMocks());
const item = { item_id: 'cash-1', evidence_reference: 'COUNT-1', document_id: 'doc-1', document_filename: 'count.pdf', document_accessible: true, status: 'pending_verification', issue: { issue_key: 'key', evidence_fingerprint: 'fingerprint' }, latest: null };

describe('cash verification review UI', () => {
  it('shows Arabic RTL status and saves a reviewer decision only when authorized', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) =>
      new Response(JSON.stringify(options?.method === 'POST' ? { decision: {} } : { items: [item] }), { status: options?.method === 'POST' ? 201 : 200 }));
    render(<OpeningCashVerification yearId="fy" reloadToken={0} reviewStatus="in_review" canVerify lang="ar" describeItem={() => 'نقد الصندوق'} onChanged={vi.fn()} />);
    expect(await screen.findByText('بانتظار مراجعة المستند')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'مراجعة أدلة النقد في الصندوق' })).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('link', { name: /فتح محضر الجرد لفحصه/ })).toHaveAttribute('href', '/api/documents/doc-1/file');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'فحص المراجع محضر الجرد والنقد' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'verified' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ القرار' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/opening-balances/fy/cash-verifications/cash-1', expect.objectContaining({ method: 'POST' })));
  });
  it('hides decision controls without verification permission', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [item] }), { status: 200 }));
    render(<OpeningCashVerification yearId="fy" reloadToken={0} reviewStatus="in_review" canVerify={false} lang="en" describeItem={() => 'Cash'} onChanged={vi.fn()} />);
    expect(await screen.findByText('Pending document review')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save decision' })).not.toBeInTheDocument();
  });
  it('keeps reference-only evidence on the unverified path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [{ ...item, document_id: null, document_filename: null, document_accessible: false }] }), { status: 200 }));
    render(<OpeningCashVerification yearId="fy" reloadToken={0} reviewStatus="in_review" canVerify lang="en" describeItem={() => 'Cash'} onChanged={vi.fn()} />);
    expect(await screen.findByText(/A typed reference alone cannot be verified/)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /I reviewed the document and count/ })).not.toBeInTheDocument();
  });
  it('retains a failed POST message after the status reload succeeds', async () => {
    let post = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') { post = true; return new Response(JSON.stringify({ error: 'Conflict', code: 'OB_CASH_EVIDENCE_STALE' }), { status: 409 }); }
      return new Response(JSON.stringify({ items: [{ ...item, status: post ? 'stale' : 'pending_verification' }] }), { status: 200 });
    });
    render(<OpeningCashVerification yearId="fy" reloadToken={0} reviewStatus="in_review" canVerify lang="ar" describeItem={() => 'نقد الصندوق'} onChanged={vi.fn()} />);
    await screen.findByText('بانتظار مراجعة المستند');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'فحص المراجع محضر الجرد والنقد' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'verified' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ القرار' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر حفظ القرار لأن حالة المراجعة أو الدليل تغيرت');
    expect(await screen.findByText(/تحقق قديم/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('explains in Arabic that the administrative override reason needs ten non-whitespace characters', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => options?.method === 'POST'
      ? new Response(JSON.stringify({ code: 'OB_CASH_OVERRIDE_REASON_REQUIRED' }), { status: 400 })
      : new Response(JSON.stringify({ items: [item] }), { status: 200 }));
    render(<OpeningCashVerification yearId="fy" reloadToken={0} reviewStatus="in_review" canVerify isSystemAdmin isPreparer lang="ar" describeItem={() => 'نقد الصندوق'} onChanged={vi.fn()} />);
    await screen.findByText('بانتظار مراجعة المستند');
    fireEvent.change(screen.getByRole('textbox', { name: /مبرر التحقق/ }), { target: { value: 'فحص المراجع محضر الجرد والنقد' } });
    fireEvent.change(screen.getByRole('textbox', { name: /سبب التجاوز الإداري/ }), { target: { value: 'سبب إداري واضح ومفصل' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'verified' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ القرار' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('يلزم إدخال سبب للتجاوز الإداري لا يقل عن 10 أحرف غير بيضاء');
  });
});
