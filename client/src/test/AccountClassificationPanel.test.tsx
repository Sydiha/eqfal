import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountClassificationPanel } from '../components/AccountClassificationPanel';

const account={
  id:'11111111-1111-4111-8111-111111111111',
  code:'1000',
  name:'Cash',
  account_type:'asset' as const,
  parent_account_id:null,
  is_active:true,
  statement_category:'unmapped' as const,
  is_contra:false,
  cash_role:'non_cash' as const,
  cash_flow_category:'unmapped' as const,
};

describe('AccountClassificationPanel',()=>{
  it('discovers unmapped accounts and sends only governed classification fields',async()=>{
    const writes:Record<string,unknown>[]=[];
    const fetchMock=vi.fn(async(url:string,options?:RequestInit)=>{
      if(url==='/api/account-classifications?statement_category=unmapped'){
        return new Response(JSON.stringify({accounts:[account]}));
      }
      if(url===`/api/accounts/${account.id}/classification`&&options?.method==='PATCH'){
        const body=JSON.parse(String(options.body)) as Record<string,unknown>;
        writes.push(body);
        return new Response(JSON.stringify({...account,...body}));
      }
      return new Response(null,{status:404});
    });
    vi.stubGlobal('fetch',fetchMock);

    render(<AccountClassificationPanel canView canManage onUnauthorized={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button',{name:/Financial statement mapping/}));
    expect(await screen.findByRole('cell',{name:'Cash'})).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Statement category 1000'),{target:{value:'current_asset'}});
    fireEvent.change(screen.getByLabelText('Cash role 1000'),{target:{value:'cash'}});
    fireEvent.change(screen.getByLabelText('Cash-flow activity 1000'),{target:{value:'operating'}});
    fireEvent.click(screen.getByRole('button',{name:/Save/}));

    await waitFor(()=>expect(writes).toEqual([{
      statement_category:'current_asset',is_contra:false,cash_role:'cash',cash_flow_category:'operating',
    }]));
    expect(Object.keys(writes[0]!).sort()).toEqual(['cash_flow_category','cash_role','is_contra','statement_category']);
  });

  it('does not offer incompatible categories and disables contra for non-assets',async()=>{
    const liability={...account,id:'22222222-2222-4222-8222-222222222222',code:'2000',name:'Payable',account_type:'liability' as const};
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({accounts:[liability]}))));
    render(<AccountClassificationPanel canView canManage onUnauthorized={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button',{name:/Financial statement mapping/}));
    await screen.findByRole('cell',{name:'Payable'});

    const category=screen.getByLabelText('Statement category 2000');
    expect(category).toHaveTextContent('Current liability');
    expect(category).not.toHaveTextContent('Current asset');
    expect(screen.getByLabelText('Contra account 2000')).toBeDisabled();
    expect(screen.getByLabelText('Cash role 2000')).toHaveTextContent('Non-cash');
    expect(screen.getByLabelText('Cash role 2000')).not.toHaveTextContent('Cash equivalent');
  });

  it('retains classification drafts when an update is rejected',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(_url:string,options?:RequestInit)=>
      options?.method==='PATCH'?new Response(null,{status:400}):new Response(JSON.stringify({accounts:[account]}))));
    render(<AccountClassificationPanel canView canManage onUnauthorized={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button',{name:/Financial statement mapping/}));
    await screen.findByRole('cell',{name:'Cash'});
    fireEvent.change(screen.getByLabelText('Cash role 1000'),{target:{value:'cash_equivalent'}});
    fireEvent.click(screen.getByRole('button',{name:/Save/}));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Cash role 1000')).toHaveValue('cash_equivalent');
  });
});
