import express,{NextFunction,Request,Response}from'express';
import request from'supertest';
import{beforeEach,describe,expect,it,vi}from'vitest';
import type{Pool}from'pg';

// Regression: asset approval must validate the COMPLETE generated depreciation range
// (first periodStart .. last periodEnd) against monthly-close protections, through the
// real path fixed-assets.router -> assertAccountingRangeWritable -> accounting-period.guard.
const COMPANY='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',ASSET='33333333-3333-4333-8333-333333333333',CATEGORY='44444444-4444-4444-8444-444444444444';
const mocks=vi.hoisted(()=>({context:null as null|{user:{id:string};activeCompanyId:string;capabilities:string[]},pool:null as Pool|null}));
vi.mock('../src/db/pool',()=>({get default(){return mocks.pool}}));
vi.mock('../src/modules/auth/origin.middleware',()=>({requireSameOrigin:(_q:Request,_s:Response,n:NextFunction)=>n()}));
vi.mock('../src/modules/auth/auth.middleware',()=>({getAuthenticatedContext:()=>mocks.context,requireAuth:(_q:Request,s:Response,n:NextFunction)=>mocks.context?n():void s.status(401).end(),requireActiveCompany:(_q:Request,s:Response,n:NextFunction)=>mocks.context?.activeCompanyId?n():void s.status(403).end(),requireCapability:(cap:string)=>(_q:Request,s:Response,n:NextFunction)=>mocks.context?.capabilities.includes(cap)?n():void s.status(403).json({error:'Forbidden'})}));

const{fixedAssetsRouter}=await import('../src/modules/fixed-assets/fixed-assets.router');
const app=express();app.use(express.json());app.use('/api',fixedAssetsRouter);app.use((e:unknown,_q:Request,s:Response,_n:NextFunction)=>s.status(500).json({error:e instanceof Error?e.message:'error'}));
const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});

type ClosedPeriod={company_id:string;period_start:string;period_end:string};
let closedPeriods:ClosedPeriod[];
let assetStatus:string;
let committedEntries:unknown[];
let committedAudit:string[];
let lockedBuckets:string[];
let rangeQueries:string[][];

// 12-month straight-line asset: acquired and starting depreciation 2026-01-01, so the
// schedule covers 2026-01-01 .. 2026-12-31. Acquisition/start dates alone are in an open month.
const assetRow=()=>({id:ASSET,company_id:COMPANY,status:assetStatus,source_type:'manual_opening',source_document_id:null,asset_category_id:CATEGORY,name:'Laptop',description:null,acquisition_cost:'1200.00',acquisition_date:'2026-01-01',placed_in_service_date:'2026-01-01',depreciation_start_date:'2026-01-01',useful_life_months:12,residual_value:'0.00',opening_accumulated_depreciation:'0.00',depreciable:true,asset_account_id:'a',accumulated_depreciation_account_id:'b',depreciation_expense_account_id:'c'});

beforeEach(()=>{
 mocks.context={user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},activeCompanyId:COMPANY,capabilities:['asset.approve']};
 closedPeriods=[];assetStatus='draft';committedEntries=[];committedAudit=[];lockedBuckets=[];rangeQueries=[];
 const client=()=>{
  let pendingEntries:unknown[]=[],pendingStatus:string|null=null,pendingAudit:string[]=[];
  return{
   release:vi.fn(),
   query:vi.fn(async(sql:string,args:unknown[]=[])=>{
    if(sql==='BEGIN'){pendingEntries=[];pendingStatus=null;pendingAudit=[];return result()}
    if(sql==='COMMIT'){committedEntries.push(...pendingEntries);if(pendingStatus)assetStatus=pendingStatus;committedAudit.push(...pendingAudit);return result()}
    if(sql==='ROLLBACK'){pendingEntries=[];pendingStatus=null;pendingAudit=[];return result()}
    if(sql.includes('pg_advisory_xact_lock')){lockedBuckets.push(String(args[0]));return result()}
    if(sql.includes('FROM fixed_assets a JOIN asset_categories'))return args[1]===COMPANY?result([assetRow()]):result();
    if(sql.includes('FROM asset_categories'))return result([{depreciable:true,asset_account_id:'a',accumulated_depreciation_account_id:'b',depreciation_expense_account_id:'c'}]);
    if(sql.includes('FROM monthly_close_periods')){
     const[company,start,end]=args as string[];
     if(sql.includes('BETWEEN')){ // single-date guard
      return result(closedPeriods.filter(p=>p.company_id===company&&p.period_start<=start&&start<=p.period_end).map(()=>({'?column?':1})));
     }
     rangeQueries.push([start!,end!]); // range guard
     return result(closedPeriods.filter(p=>p.company_id===company&&p.period_start<=end!&&p.period_end>=start!).map(()=>({'?column?':1})));
    }
    if(sql.includes('INSERT INTO asset_depreciation_entries')){pendingEntries.push(args);return result()}
    if(sql.includes('UPDATE fixed_assets SET status')){pendingStatus=String(args[2]);return result([{...assetRow(),status:pendingStatus}])}
    if(sql.includes('INSERT INTO audit_log')){pendingAudit.push(String(args[2]??args[1]??'audit'));return result([{id:'audit'}])}
    return result();
   }),
  };
 };
 mocks.pool={connect:vi.fn(async()=>client()),query:vi.fn(async()=>result())}as unknown as Pool;
});

describe('fixed-asset approval validates the complete depreciation recognition range',()=>{
 it('rejects approval when a later month of the generated schedule is closed, atomically',async()=>{
  // June 2026 is closed; acquisition (2026-01-01) and start (2026-01-01) are in open months.
  closedPeriods=[{company_id:COMPANY,period_start:'2026-06-01',period_end:'2026-06-30'}];
  const res=await request(app).post(`/api/assets/${ASSET}/approve`).send({});
  expect(res.status).toBe(409);
  expect(res.body.error).toBe('Accounting period is closed');
  // the real guard was asked about the FULL range, first start .. last end
  expect(rangeQueries).toContainEqual(['2026-01-01','2026-12-31']);
  // atomic: no schedule rows, no status change, no audit rows survive the rollback
  expect(committedEntries).toHaveLength(0);
  expect(assetStatus).toBe('draft');
  expect(committedAudit).toHaveLength(0);
 });

 it('rejects approval when only the last month of the schedule is closed',async()=>{
  closedPeriods=[{company_id:COMPANY,period_start:'2026-12-01',period_end:'2026-12-31'}];
  const res=await request(app).post(`/api/assets/${ASSET}/approve`).send({});
  expect(res.status).toBe(409);
  expect(committedEntries).toHaveLength(0);
  expect(assetStatus).toBe('draft');
 });

 it('serializes every month bucket of the generated range before validating',async()=>{
  const res=await request(app).post(`/api/assets/${ASSET}/approve`).send({});
  expect(res.status).toBe(200);
  for(let m=1;m<=12;m++)expect(lockedBuckets).toContain(`accounting-period:${COMPANY}:2026-${String(m).padStart(2,'0')}`);
 });

 it('approves and persists the full schedule when the whole range is writable',async()=>{
  // a closed period for ANOTHER company and one outside the schedule range must not block
  closedPeriods=[{company_id:OTHER,period_start:'2026-06-01',period_end:'2026-06-30'},{company_id:COMPANY,period_start:'2025-12-01',period_end:'2025-12-31'},{company_id:COMPANY,period_start:'2027-01-01',period_end:'2027-01-31'}];
  const res=await request(app).post(`/api/assets/${ASSET}/approve`).send({});
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('active');
  expect(committedEntries).toHaveLength(12);
  expect(assetStatus).toBe('active');
  expect(committedAudit.length).toBeGreaterThan(0);
 });

 it('still enforces the capability and leaves the draft untouched without it',async()=>{
  mocks.context!.capabilities=[];
  closedPeriods=[];
  expect((await request(app).post(`/api/assets/${ASSET}/approve`).send({})).status).toBe(403);
  expect(assetStatus).toBe('draft');
  expect(committedEntries).toHaveLength(0);
 });

 it('does not see another company\'s asset (tenant isolation)',async()=>{
  mocks.context!.activeCompanyId=OTHER;
  const res=await request(app).post(`/api/assets/${ASSET}/approve`).send({});
  expect(res.status).toBe(404);
  expect(assetStatus).toBe('draft');
  expect(committedEntries).toHaveLength(0);
 });
});
