import { render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { SettlementPanel } from '../components/SettlementPanel';

beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});

function renderPanel(props:React.ComponentProps<typeof SettlementPanel>){return render(<MantineProvider><SettlementPanel {...props}/></MantineProvider>);}

describe('SettlementPanel',()=>{
  it('does not request data without bank.view',()=>{
    vi.stubGlobal('fetch',vi.fn());
    renderPanel({canView:false,canSettle:true,onUnauthorized:vi.fn()});
    expect(screen.queryByText('Payment settlements')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads matched bank transactions while keeping mutation controls hidden without payment.settle',async()=>{
    const tx={id:'11111111-1111-4111-8111-111111111111',transaction_date:'2026-08-01',description:'Vendor',bank_reference:'R1',amount:'-40.00',reconciliation_status:'matched'};
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({transactions:[tx]}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    renderPanel({canView:true,canSettle:false,onUnauthorized:vi.fn()});
    expect(screen.getByText('Payment settlements')).toBeInTheDocument();
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Record settlement')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete settlement')).not.toBeInTheDocument();
  });
});
