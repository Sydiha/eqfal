import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

const COMPANY='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',FY='33333333-3333-4333-8333-333333333333',PERIOD='44444444-4444-4444-8444-444444444444',DOC='55555555-5555-4555-8555-555555555555',REVIEW='66666666-6666-4666-8666-666666666666';
const mocks=vi.hoisted(()=>({pool:null as Pool|null,audit:vi.fn()}));
vi.mock('../src/db/pool',()=>({get default(){return mocks.pool}}));
vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=(event:unknown,client:unknown)=>mocks.audit(event,client)}}));
const vat=await import('../src/modules/vat/vat.router');
type Result={rows:Record<string,unknown>[];rowCount:number};
const result=(rows:Record<string,unknown>[]=[]):Result=>({rows,rowCount:rows.length});
function poolFor(handler:(sql:string,args:unknown[])=>Result|Promise<Result>){const query=vi.fn((sql:string,args:unknown[]=[])=>handler(sql.replace(/\s+/g,' '),args));const client={query,release:vi.fn()}as unknown as PoolClient;return{pool:{connect:vi.fn().mockResolvedValue(client),query}as unknown as Pool,client,query};}
const period=(status:'open'|'closed'='open')=>({id:PERIOD,company_id:COMPANY,fiscal_year_id:FY,period_start:'2026-01-01',period_end:'2026-03-31',status,created_at:new Date(),updated_at:new Date()});
const profile={id:'77777777-7777-4777-8777-777777777777',company_id:COMPANY,version_no:1,workflow_status:'approved',vat_status:'registered',vat_registered_from:'2025-01-01',vat_deregistered_from:null,vat_filing_frequency:'quarterly'};
const review=(version=1)=>({id:REVIEW,company_id:COMPANY,document_id:DOC,tax_date:'2026-02-10',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',review_status:'reviewed',reviewed_by_user_id:USER,reviewed_at:new Date(),review_note:null,created_at:new Date(),updated_at:new Date(),version});
beforeEach(()=>mocks.audit.mockReset().mockResolvedValue({}));

describe('Phase 6A acceptance coverage',()=>{
 it('rejects a VAT period outside its tenant fiscal year',async()=>{const built=poolFor(sql=>{if(['BEGIN','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return result();if(sql.includes('FROM fiscal_years'))return result([{start_date:'2026-04-01',end_date:'2027-03-31'}]);throw new Error(sql)});await expect(new vat.VatService(built.pool).create(COMPANY,USER,FY,'2026-01-01','2026-03-31')).rejects.toBeInstanceOf(vat.VatValidationError)});
 it('rejects an overlapping VAT period',async()=>{const built=poolFor(sql=>{if(['BEGIN','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return result();if(sql.includes('FROM fiscal_years'))return result([{start_date:'2026-01-01',end_date:'2026-12-31'}]);if(sql.includes('FROM company_accounting_profiles'))return result([profile]);if(sql.includes('SELECT 1 FROM vat_periods WHERE company_id='))return result([{one:1}]);throw new Error(sql)});await expect(new vat.VatService(built.pool).create(COMPANY,USER,FY,'2026-01-01','2026-03-31')).rejects.toBeInstanceOf(vat.VatConflictError)});
 it('audits an existing VAT review update with before/after data',async()=>{const existing=review(1);const built=poolFor(sql=>{if(['BEGIN','COMMIT'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return result();if(sql.startsWith('SELECT id,status,document_type FROM documents'))return result([{id:DOC,status:'approved',document_type:'purchase'}]);if(sql.startsWith('SELECT *,tax_date::text'))return result([existing]);if(sql.startsWith('SELECT 1 FROM monthly_close_periods'))return result();if(sql.includes("FROM vat_periods WHERE company_id=")&&sql.includes("status='closed'"))return result();if(sql.startsWith('UPDATE document_vat_reviews'))return result([review(2)]);throw new Error(sql)});await new vat.VatService(built.pool).saveReview(COMPANY,USER,DOC,{taxDate:'2026-02-10',status:'reviewed',treatment:'standard',taxable:'100.00',vat:'15.00',note:'checked',version:1});expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({action:'document_vat_review.update',before_data:existing,after_data:expect.objectContaining({version:2})}),built.client)});
 it('uses the same VAT company/month advisory key for close and review writes',async()=>{const close=poolFor(sql=>{if(['BEGIN','COMMIT'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return result();if(sql.includes('FROM vat_periods WHERE id='))return result([period('open')]);if(sql.startsWith('SELECT (SELECT COUNT(*) FROM documents'))return result([{unapproved_documents:'0',missing_reviews:'0',pending_reviews:'0'}]);if(sql.startsWith('UPDATE vat_periods'))return result([period('closed')]);throw new Error(sql)});await new vat.VatService(close.pool).close(COMPANY,USER,PERIOD);const closeLocks=close.query.mock.calls.filter(c=>String(c[0]).includes('pg_advisory_xact_lock')).map(c=>c[1]);const write=poolFor(sql=>{if(['BEGIN','COMMIT'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return result();if(sql.startsWith('SELECT id,status,document_type FROM documents'))return result([{id:DOC,status:'approved',document_type:'purchase'}]);if(sql.startsWith('SELECT *,tax_date::text'))return result();if(sql.startsWith('SELECT 1 FROM monthly_close_periods'))return result();if(sql.includes("FROM vat_periods WHERE company_id=")&&sql.includes("status='closed'"))return result();if(sql.startsWith('INSERT INTO document_vat_reviews'))return result([review()]);throw new Error(sql)});await new vat.VatService(write.pool).saveReview(COMPANY,USER,DOC,{taxDate:'2026-02-10',status:'reviewed',treatment:'standard',taxable:'100.00',vat:'15.00',note:null});const writeLock=write.query.mock.calls.find(c=>String(c[0]).includes('pg_advisory_xact_lock'))?.[1];expect(closeLocks).toContainEqual(writeLock)});
 it('wires same-origin protection on every VAT mutation route',()=>{const source=readFileSync(new URL('../src/modules/vat/vat.router.ts',import.meta.url),'utf8');for(const path of ["vatRouter.post('/vat-periods'","vatRouter.post('/vat-periods/:id/close'","vatRouter.post('/vat-periods/:id/reopen'","vatRouter.put('/documents/:id/vat-review'"]) {const line=source.split('\n').find(x=>x.includes(path));expect(line).toContain('requireSameOrigin')}});
});

describe('Phase 6A profile authority cases',()=>{
 const approved=(overrides:Record<string,unknown>={})=>({...profile,...overrides});
 const attempt=async(start:string,end:string,profiles=[approved()],options:{company?:string;fiscalStart?:string;fiscalEnd?:string;overlap?:boolean}={})=>{
  const company=options.company??COMPANY;let index=0;let inserted=false;
  const built=poolFor((sql,args)=>{if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return result();if(sql.includes('FROM fiscal_years'))return result([{start_date:options.fiscalStart??'2026-01-01',end_date:options.fiscalEnd??'2026-12-31'}]);if(sql.includes('FROM company_accounting_profiles')){const row=profiles.length===1?profiles[0]:profiles[index++];return row&&row.company_id===company?result([row]):result();}if(sql.includes('SELECT 1 FROM vat_periods WHERE company_id='))return options.overlap?result([{one:1}]):result();if(sql.startsWith('INSERT INTO vat_periods')){inserted=true;return result([period()]);}throw new Error(sql)});
  const promise=new vat.VatService(built.pool).create(company,USER,FY,start,end);return{built,promise,get inserted(){return inserted}};
 };
 it.each([
  ['1 monthly exact','2026-08-01','2026-08-31',approved({vat_filing_frequency:'monthly'}),true],
  ['2 quarterly exact','2026-04-01','2026-06-30',approved({vat_filing_frequency:'quarterly'}),true],
  ['3 not registered','2026-01-01','2026-03-31',approved({vat_status:'not_registered',vat_filing_frequency:null}),false],
  ['4 needs review','2026-01-01','2026-03-31',approved({vat_status:'needs_review',vat_filing_frequency:null}),false],
  ['5 no approved profile','2026-01-01','2026-03-31',null,false],
  ['6 profile missing at end','2026-01-01','2026-03-31',[approved(),null],false],
  ['7 different versions','2026-01-01','2026-03-31',[approved(),approved({id:'88888888-8888-4888-8888-888888888888',version_no:2})],false],
  ['8 before registration','2026-01-01','2026-03-31',approved({vat_registered_from:'2026-02-01'}),false],
  ['9 deregistered before cutoff','2026-07-01','2026-09-30',approved({vat_status:'deregistered',vat_deregistered_from:'2026-10-01'}),true],
  ['10 starts on deregistration','2026-10-01','2026-10-31',approved({vat_status:'deregistered',vat_deregistered_from:'2026-10-01'}),false],
  ['11 crosses deregistration','2026-09-01','2026-10-31',approved({vat_status:'deregistered',vat_deregistered_from:'2026-10-01'}),false],
  ['12 monthly non-first','2026-08-02','2026-08-31',approved({vat_filing_frequency:'monthly'}),false],
  ['13 monthly non-last','2026-08-01','2026-08-30',approved({vat_filing_frequency:'monthly'}),false],
  ['14 monthly spans months','2026-08-01','2026-09-30',approved({vat_filing_frequency:'monthly'}),false],
  ['15 Q1','2026-01-01','2026-03-31',approved({vat_filing_frequency:'quarterly'}),true],
  ['16 Q2','2026-04-01','2026-06-30',approved({vat_filing_frequency:'quarterly'}),true],
  ['17 Q3','2026-07-01','2026-09-30',approved({vat_filing_frequency:'quarterly'}),true],
  ['18 Q4','2026-10-01','2026-12-31',approved({vat_filing_frequency:'quarterly'}),true],
  ['19 malformed quarter','2026-08-01','2026-10-31',approved({vat_filing_frequency:'quarterly'}),false],
  ['20 outside fiscal year','2026-01-01','2026-03-31',approved({vat_filing_frequency:'quarterly'}),false,'2026-04-01','2027-03-31'],
  ['21 overlap','2026-01-01','2026-03-31',approved({vat_filing_frequency:'quarterly'}),false,undefined,undefined,true],
 ] as const)('%s',async(name,start,end,profiles,allowed,fiscalStart,fiscalEnd,overlap)=>{const rows=profiles===null?[]:Array.isArray(profiles)?profiles: [profiles];const x=await attempt(start,end,rows,{fiscalStart,fiscalEnd,overlap});if(allowed)await expect(x.promise).resolves.toMatchObject({company_id:COMPANY});else await expect(x.promise).rejects.toBeInstanceOf(name==='20 outside fiscal year'?vat.VatValidationError:vat.VatConflictError);});
 it('22 company A profile cannot authorize company B',async()=>{const x=await attempt('2026-01-01','2026-03-31',[approved()],{company:OTHER});await expect(x.promise).rejects.toBeInstanceOf(vat.VatConflictError)});
 it('23 company A non-registration cannot block company B',async()=>{const x=await attempt('2026-01-01','2026-03-31',[approved({company_id:OTHER,vat_status:'registered'})],{company:OTHER});await expect(x.promise).resolves.toBeDefined()});
 it('24 successful creation audits the period',async()=>{const x=await attempt('2026-01-01','2026-03-31');await expect(x.promise).resolves.toBeDefined();expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({action:'vat_period.create'}),x.built.client)});
 it('25 rejected creation inserts no period or successful audit',async()=>{const x=await attempt('2026-08-02','2026-08-31',[approved({vat_filing_frequency:'monthly'})]);await expect(x.promise).rejects.toBeInstanceOf(vat.VatConflictError);expect(x.inserted).toBe(false);expect(mocks.audit).not.toHaveBeenCalledWith(expect.objectContaining({action:'vat_period.create'}),x.built.client)});
 it('rejects a missing filing frequency',async()=>{const x=await attempt('2026-01-01','2026-03-31',[approved({vat_filing_frequency:null})]);await expect(x.promise).rejects.toBeInstanceOf(vat.VatConflictError)});
});
