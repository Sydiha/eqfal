import{fireEvent,render,screen,within}from'@testing-library/react';
import{beforeEach,describe,expect,it,vi}from'vitest';
import'../i18n';
import i18n from'../i18n';
import{Obligations}from'../components/Obligations';

const obligation={id:'o1',direction:'receivable' as const,counterparty_id:'c1',counterparty_name:'Acme',source_type:'document' as const,original_amount:'150.00',settled_amount:'0.00',remaining_amount:'150.00',recognized_on:'2026-08-24',due_on:'2026-08-26',verification_status:'unconfirmed' as const,state:'open' as const,is_overdue:true,is_cancelled:false,document_id:'d1',source_note:null,version:1,settlement_history:[]};
const data={obligations:[obligation],eligible_documents:[],summary:{open_receivables:'0.00',open_payables:'0.00',unconfirmed_receivables:'150.00',unconfirmed_payables:'0.00',unconfirmed_count:1,partially_settled_count:0,overdue_count:1}};
const parties={counterparties:[{id:'c1',name:'Acme',type:'customer',is_active:true,version:1}]};

beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();window.history.replaceState(null,'','/?page=obligations');vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(data),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify(parties),{status:200})))});

describe('obligation due-date edit guard',()=>{
 it('does not allow an edited due date before the obligation recognized date',async()=>{
  render(<Obligations canView canManage canSettle={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('cell',{name:'Acme'}));
  fireEvent.click(screen.getByRole('button',{name:'Edit obligation'}));
  const dialog=screen.getByRole('dialog',{name:'Edit obligation'});
  expect(within(dialog).getByLabelText('Due date')).toHaveAttribute('min','2026-08-24');
 });
});
