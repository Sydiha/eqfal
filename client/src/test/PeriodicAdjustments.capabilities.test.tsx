import {render,screen} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import i18n from '../i18n';
import {PeriodicAdjustments} from '../components/PeriodicAdjustments';

const draft={id:'draft',adjustment_type:'accrued_expense',total_amount:'100.00',recognition_start:'2026-01-01',recognition_end:'2026-01-31',document_id:null,obligation_id:null,document_name:null,description:'Draft item',reference:null,notes:null,balance_account_id:'a',pnl_account_id:'b',workflow_status:'draft',review_note:null,version:1,schedule:[]};
const reviewed={...draft,id:'reviewed',description:'Reviewed item',workflow_status:'in_review'};
const mount=(capabilities:Partial<{canCreate:boolean;canEdit:boolean;canSubmit:boolean;canReview:boolean}>)=>render(<PeriodicAdjustments canView canCreate={false} canEdit={false} canSubmit={false} canReview={false} canApprove={false} canPost={false} {...capabilities} onUnauthorized={vi.fn()}/>);

beforeEach(async()=>{
 vi.restoreAllMocks();
 await i18n.changeLanguage('en');
 vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
  const url=String(input);
  if(url==='/api/periodic-adjustments')return new Response(JSON.stringify({adjustments:[draft,reviewed]}));
  if(url==='/api/accounts')return new Response(JSON.stringify({accounts:[]}));
  if(url==='/api/documents')return new Response(JSON.stringify({documents:[]}));
  if(url==='/api/obligations')return new Response(JSON.stringify({obligations:[]}));
  throw Error(url);
 }));
});

describe('Periodic Adjustments action gating',()=>{
 it('shows creation only with create',async()=>{mount({canCreate:true});expect(await screen.findByText('Add periodic adjustment')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Update'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Submit for review'})).not.toBeInTheDocument();});
 it('shows draft editing only with edit',async()=>{mount({canEdit:true});expect(await screen.findByRole('button',{name:'Update'})).toBeInTheDocument();expect(screen.queryByText('Add periodic adjustment')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Submit for review'})).not.toBeInTheDocument();});
 it('shows submission only with submit',async()=>{mount({canSubmit:true});expect(await screen.findByRole('button',{name:'Submit for review'})).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Update'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Return to draft'})).not.toBeInTheDocument();});
 it('shows return-to-draft only with review',async()=>{mount({canReview:true});expect(await screen.findByRole('button',{name:'Return to draft'})).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Submit for review'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Update'})).not.toBeInTheDocument();});
});
