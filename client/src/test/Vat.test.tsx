import {fireEvent,render,screen,within} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import '../i18n';
import i18n from '../i18n';
import {Vat} from '../components/Vat';

const period={id:'vat-1',fiscal_year_id:'fy',period_start:'2026-01-01',period_end:'2026-03-31',status:'open',ready:true,blockers:{unapproved_documents:0,missing_reviews:0,pending_reviews:0,total:0}};
const documents=[
 {id:'d1',status:'approved',original_filename:'sale-acme.pdf',document_type:'sale',document_date:'2026-01-10',counterparty_name:'Acme',total_amount:'115.00',review_id:'r1',tax_date:'2026-01-10',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',review_status:'reviewed',review_note:'Invoice REF-1',version:1},
 {id:'d2',status:'approved',original_filename:'expense-beta.pdf',document_type:'expense',document_date:'2026-01-11',counterparty_name:'Beta',total_amount:'57.50',review_id:null,tax_date:null,treatment:null,taxable_amount:null,vat_amount:null,review_status:null,review_note:null,version:null},
] as any[];
function mock(){vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[period]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[{id:'fy',name:'FY 2026',start_date:'2026-01-01',end_date:'2026-12-31'}]}),{status:200});return new Response(JSON.stringify({period,documents}),{status:200})}))}
beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks()});
describe('VAT review workspace',()=>{
 it('filters displayed documents locally by search and treatment',async()=>{mock();render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);expect(await screen.findByRole('cell',{name:'sale-acme.pdf'})).toBeInTheDocument();fireEvent.change(screen.getByRole('searchbox',{name:'Search documents'}),{target:{value:'Beta'}});expect(screen.queryByRole('cell',{name:'sale-acme.pdf'})).not.toBeInTheDocument();expect(screen.getByRole('cell',{name:'expense-beta.pdf'})).toBeInTheDocument();fireEvent.change(screen.getByLabelText('VAT treatment'),{target:{value:'standard'}});expect(screen.getByText('No documents match the current search and filters.')).toBeInTheDocument()});
 it('keeps period and review actions capability and status gated',async()=>{mock();render(<Vat canView canReview={false} canClose={false} canReopen={false} onUnauthorized={vi.fn()}/>);await screen.findByRole('cell',{name:'sale-acme.pdf'});expect(screen.queryByRole('button',{name:'Create VAT period'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:/Review VAT|Edit VAT review/})).not.toBeInTheDocument();expect(within(screen.getByRole('table')).getAllByText('—').length).toBeGreaterThan(0)});
});
