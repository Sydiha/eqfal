import { render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { CustodyPanel } from '../components/CustodyPanel';
beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});
function renderPanel(props:React.ComponentProps<typeof CustodyPanel>){return render(<MantineProvider><CustodyPanel {...props}/></MantineProvider>);}
describe('CustodyPanel capability gating',()=>{
 it('does not request data without custody.view',()=>{vi.stubGlobal('fetch',vi.fn());renderPanel({canView:false,canManage:true,canClose:true,onUnauthorized:vi.fn()});expect(screen.queryByText('Custody & advances')).not.toBeInTheDocument();expect(fetch).not.toHaveBeenCalled();});
 it('loads read-only custody view while hiding mutation controls',async()=>{const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({custodies:[]}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({transactions:[]}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({mapping:null,can_edit:false}),{status:200}));vi.stubGlobal('fetch',fetchMock);renderPanel({canView:true,canManage:false,canClose:false,onUnauthorized:vi.fn()});expect(screen.getByText('Custody & advances')).toBeInTheDocument();await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(3));expect(screen.queryByText('Save account')).not.toBeInTheDocument();expect(screen.queryByText('Create custody')).not.toBeInTheDocument();expect(screen.queryByText('Close custody')).not.toBeInTheDocument();});
 it('warns when no custody ledger account is configured and requires an explicit recipient to create',async()=>{
  const json=(b:unknown)=>new Response(JSON.stringify(b),{status:200});
  const fetchMock=vi.fn().mockResolvedValueOnce(json({custodies:[]})).mockResolvedValueOnce(json({transactions:[{id:'t1',transaction_date:'2026-02-01',description:'transfer',bank_reference:null,amount:'-100.00',currency_code:'SAR',reconciliation_status:'unmatched'}]})).mockResolvedValueOnce(json({recipients:[{id:'u1',email:'mgr@example.test',display_name:'Manager'}]})).mockResolvedValueOnce(json({mapping:null,accounts:[]}));
  vi.stubGlobal('fetch',fetchMock);renderPanel({canView:true,canManage:true,canClose:true,onUnauthorized:vi.fn()});
  await waitFor(()=>expect(screen.getByText(/No custody ledger account is configured/)).toBeInTheDocument());
  expect(screen.getByRole('button',{name:'Create custody'})).toBeDisabled();
  expect(screen.getByText('Recipient')).toBeInTheDocument();
 });
 it('shows the account editor to a viewer without custody permissions when the API grants can_edit',async()=>{
  const json=(b:unknown)=>new Response(JSON.stringify(b),{status:200});
  const fetchMock=vi.fn().mockResolvedValueOnce(json({custodies:[]})).mockResolvedValueOnce(json({transactions:[]})).mockResolvedValueOnce(json({mapping:null,accounts:[{id:'a1',code:'1150',name:'Employee advances'}],can_edit:true}));
  vi.stubGlobal('fetch',fetchMock);renderPanel({canView:true,canManage:false,canClose:false,onUnauthorized:vi.fn()});
  await waitFor(()=>expect(screen.getByText('Save account')).toBeInTheDocument());
  expect(screen.queryByText('Create custody')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/custody/account-mapping',undefined);
 });
});
