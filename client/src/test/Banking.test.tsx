import { render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { Banking } from '../components/Banking';

beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});

function renderBanking(props: React.ComponentProps<typeof Banking>) {
  return render(<MantineProvider><Banking {...props}/></MantineProvider>);
}

describe('Banking',()=>{
  it('does not request banking data without bank.view',()=>{
    vi.stubGlobal('fetch',vi.fn());
    renderBanking({ canView:false, canImport:true, canManage:true, onUnauthorized:vi.fn() });
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads company-scoped accounts, batches, and transactions and respects capability presentation',async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({accounts:[{id:'a1',display_name:'Main',bank_name:'Bank',currency_code:'SAR',is_active:true}]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({batches:[]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({transactions:[]}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    renderBanking({ canView:true, canImport:false, canManage:false, onUnauthorized:vi.fn() });
    expect(await screen.findByText('Main')).toBeInTheDocument();
    expect(screen.queryByText('Create account')).not.toBeInTheDocument();
    expect(screen.queryByText('Import statement')).not.toBeInTheDocument();
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(call=>call[0])).toEqual(['/api/bank-accounts','/api/bank-import-batches','/api/bank-transactions']);
  });
});
