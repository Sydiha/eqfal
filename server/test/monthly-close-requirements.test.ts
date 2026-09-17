import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';

const COMPANY='11111111-1111-4111-8111-111111111111';
const FY='33333333-3333-4333-8333-333333333333';
const PERIOD='44444444-4444-4444-8444-444444444444';
const vatReadiness=vi.hoisted(()=>vi.fn());

vi.mock('../src/db/pool',()=>({default:null}));
vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=vi.fn()}}));
vi.mock('../src/modules/vat/vat.router',()=>({VatService:class{readiness=(...args:unknown[])=>vatReadiness(...args)}}));
vi.mock('../src/modules/accounting/operational-sources',()=>({loadOperationalSources:vi.fn().mockResolvedValue([])}));

const {MonthlyCloseService}=await import('../src/modules/monthly-close/monthly-close.router');

type RequirementRow={
 documents:string;obligations:string;bank_transactions:string;opening_balances:string;periodic_adjustments:string;
 vat_applicable:string;vat_requires_resolution:string;opening_balances_applicable:string;opening_balance_approved:string;
};
const baseRow=(patch:Partial<RequirementRow>={}):RequirementRow=>({documents:'0',obligations:'0',bank_transactions:'0',opening_balances:'0',periodic_adjustments:'0',vat_applicable:'true',vat_requires_resolution:'false',opening_balances_applicable:'false',opening_balance_approved:'false',...patch});
const period={id:PERIOD,company_id:COMPANY,fiscal_year_id:FY,period_start:'2026-01-01',period_end:'2026-01-31',status:'open',created_at:new Date(),updated_at:new Date()};
const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});

function dbFor(row:RequirementRow){
 const query=vi.fn(async(sql:string)=>{
  const q=sql.replace(/\s+/g,' ');
  if(q.startsWith('SELECT *,period_start::text,period_end::text FROM monthly_close_periods'))return result([period]);
  if(q.startsWith('SELECT (SELECT COUNT(*) FROM documents'))return result([row]);
  if(q.startsWith('WITH material AS'))return result();
  if(q.startsWith('SELECT source_type,source_id FROM journal_entries'))return result();
  if(q.startsWith('SELECT (SELECT COUNT(*) FROM asset_depreciation_entries'))return result([{pending:'0',drafts:'0'}]);
  throw new Error(q);
 });
 return{db:{query} as unknown as Pool,query};
}

const allCapabilities=['document.view','obligation.view','bank.view','vat.view','accounting.view','asset.view','opening_balance.view','periodic_adjustment.view'];

beforeEach(()=>{vatReadiness.mockReset().mockResolvedValue({ready:true,blockers:{total:0}})});

describe('Monthly Close company-aware requirements',()=>{
 it('does not create a VAT blocker when the approved company profile makes VAT not applicable',async()=>{
  const{db}=dbFor(baseRow({vat_applicable:'false'}));
  const response=await new MonthlyCloseService(db).list(COMPANY,allCapabilities);
  expect(response.periods[0]).toMatchObject({ready:true,blockers:{vat:0}});
  expect(vatReadiness).not.toHaveBeenCalled();
 });

 it('fails closed when VAT applicability still requires profile review',async()=>{
  const{db}=dbFor(baseRow({vat_applicable:'true',vat_requires_resolution:'true'}));
  const response=await new MonthlyCloseService(db).list(COMPANY,allCapabilities);
  expect(response.periods[0]).toMatchObject({ready:false,blockers:{vat:1}});
  expect(vatReadiness).not.toHaveBeenCalled();
 });

 it('uses VAT readiness when VAT is applicable and resolved',async()=>{
  vatReadiness.mockResolvedValueOnce({ready:false,blockers:{total:1}});
  const{db}=dbFor(baseRow({vat_applicable:'true',vat_requires_resolution:'false'}));
  const response=await new MonthlyCloseService(db).list(COMPANY,allCapabilities);
  expect(response.periods[0]).toMatchObject({ready:false,blockers:{vat:1}});
  expect(vatReadiness).toHaveBeenCalledTimes(1);
 });

 it('requires an approved opening-balance review in the first-live fiscal year even when no review row exists yet',async()=>{
  const{db}=dbFor(baseRow({opening_balances_applicable:'true',opening_balance_approved:'false',opening_balances:'0'}));
  const response=await new MonthlyCloseService(db).list(COMPANY,allCapabilities);
  expect(response.periods[0]).toMatchObject({ready:false,blockers:{opening_balances:1}});
 });

 it('does not block later fiscal years for opening balances when that requirement is not applicable',async()=>{
  const{db}=dbFor(baseRow({opening_balances_applicable:'false',opening_balance_approved:'false',opening_balances:'3'}));
  const response=await new MonthlyCloseService(db).list(COMPANY,allCapabilities);
  expect(response.periods[0]).toMatchObject({ready:true,blockers:{opening_balances:0}});
 });

 it('clears the applicable opening-balance requirement after approval',async()=>{
  const{db}=dbFor(baseRow({opening_balances_applicable:'true',opening_balance_approved:'true',opening_balances:'0'}));
  const response=await new MonthlyCloseService(db).list(COMPANY,allCapabilities);
  expect(response.periods[0]).toMatchObject({ready:true,blockers:{opening_balances:0}});
 });
});
