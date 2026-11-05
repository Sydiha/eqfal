import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpeningCashVerification } from '../components/OpeningCashVerification';

afterEach(() => vi.restoreAllMocks());
const item = { item_id: 'cash-1', evidence_reference: 'COUNT-1', status: 'pending_verification', issue: { issue_key: 'key', evidence_fingerprint: 'fingerprint' }, latest: null };

describe('cash verification review UI', () => {
  it('shows Arabic RTL status and saves a reviewer decision only when authorized', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) =>
      new Response(JSON.stringify(options?.method === 'POST' ? { decision: {} } : { items: [item] }), { status: options?.method === 'POST' ? 201 : 200 }));
    render(<OpeningCashVerification yearId="fy" reloadToken={0} reviewStatus="in_review" canVerify lang="ar" describeItem={() => 'نقد الصندوق'} onChanged={vi.fn()} />);
    expect(await screen.findByText('بانتظار التحقق')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'التحقق من أدلة النقد في الصندوق' })).toHaveAttribute('dir', 'rtl');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'فحص المراجع محضر الجرد والنقد' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ القرار' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/opening-balances/fy/cash-verifications/cash-1', expect.objectContaining({ method: 'POST' })));
  });
  it('hides decision controls without verification permission', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [item] }), { status: 200 }));
    render(<OpeningCashVerification yearId="fy" reloadToken={0} reviewStatus="in_review" canVerify={false} lang="en" describeItem={() => 'Cash'} onChanged={vi.fn()} />);
    expect(await screen.findByText('Pending verification')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save decision' })).not.toBeInTheDocument();
  });
});
