import express,{NextFunction,Request,Response} from 'express';
import request from 'supertest';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const CUSTODY='33333333-3333-4333-8333-333333333333';
const mocks=vi.hoisted(()=>({context:null as null|{user:{id:string;email:string};allowedCompanies:{id:string;name:string;name_ar:string|null}[];activeCompanyId:string|null;capabilities:string[]},query:vi.fn(),connect:vi.fn(),audit:vi.fn()}));
vi.mock('../src/db/pool',()=>({default:{query:mocks.query,connect:mocks.connect}}));
vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=mocks.audit;}}));
vi.mock('../src/modules/auth/origin.middleware',()=>({requireSameOrigin:(_req:Request,_res:Response,next:NextFunction)=>next()}));
vi.mock('../src/modules/auth/auth.middleware',()=>({getAuthenticatedContext:vi.fn(()=>mocks.context),requireAuth:(_req:Request,res:Response,next:NextFunction)=>mocks.context?next():void res.status(401).json({error:'Unauthenticated'}),requireActiveCompany:(_req:Request,res:Response,next:NextFunction)=>mocks.context?.activeCompanyId?next():void res.status(403).json({error:'No active company'}),requireCapability:(cap:string)=>(_req:Request,res:Response,next:NextFunction)=>mocks.context?.capabilities.includes(cap)?next():void res.status(403).json({error:'Forbidden'})}));
import {custodyRouter} from '../src/modules/banking/custody.router';

const app=express();app.use(express.json());app.use('/api',custodyRouter);
function ctx(caps:string[],company:string|null='co-a'){mocks.context={user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'u@example.com'},allowedCompanies:[{id:'co-a',name:'A',name_ar:null}],activeCompanyId:company,capabilities:caps};}
const URL_=`/api/custodies/${CUSTODY}/eligible-documents`;
const DOC={id:'d1',original_filename:'inv.pdf',reference_number:'INV-1',counterparty_name:'Acme',document_date:'2026-02-01',total_amount:'250.00'};
/** Answers each repository query by its SQL text; the pool is shared by all queries of the service. */
function stub(opts:{custody?:object|null;docs?:object[]}={}){
  const custody=opts.custody===undefined?{id:CUSTODY,company_id:'co-a',status:'open'}:opts.custody;
  mocks.query.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM custody_advances'))return{rows:custody?[custody]:[]};
    if(sql.includes("t.id,t.company_id,t.amount::text"))return{rows:[{id:'tx',company_id:'co-a',amount:'-1000.00',currency_code:'SAR',transaction_date:'2026-01-01',description:null,bank_reference:null,reconciliation_status:'matched'}]};
    if(sql.includes('FROM custody_document_allocations a JOIN'))return{rows:[]};
    if(sql.includes('t.id AS bank_transaction_id'))return{rows:[]};
    if(sql.includes('SUM(amount)'))return{rows:[{total:'300.00'}]};
    if(sql.includes('SUM(t.amount)'))return{rows:[{total:'0'}]};
    if(sql.includes('FROM documents d'))return{rows:opts.docs??[DOC]};
    return{rows:[]};
  });
}
const docQuery=()=>mocks.query.mock.calls.find(c=>String(c[0]).includes('FROM documents d'))!;

beforeEach(()=>{mocks.context=null;mocks.query.mockReset();mocks.connect.mockReset();});

describe('GET /custodies/:id/eligible-documents',()=>{
  it('requires authentication, an active company, and custody.manage (view alone is not enough)',async()=>{
    expect((await request(app).get(URL_)).status).toBe(401);
    ctx(['custody.manage'],null);
    expect((await request(app).get(URL_)).status).toBe(403);
    ctx(['custody.view','custody.close']);
    expect((await request(app).get(URL_)).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects malformed ids and over-long search text before touching the database',async()=>{
    ctx(['custody.manage']);
    expect((await request(app).get('/api/custodies/nope/eligible-documents')).status).toBe(400);
    expect((await request(app).get(`${URL_}?q=${'x'.repeat(101)}`)).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns 404 for a custody that is not in the active company (tenant isolation)',async()=>{
    ctx(['custody.manage']);stub({custody:null});
    expect((await request(app).get(URL_)).status).toBe(404);
    const custodyCall=mocks.query.mock.calls[0];
    expect(custodyCall[1]).toEqual([CUSTODY,'co-a']);
    expect(mocks.query.mock.calls.some(c=>String(c[0]).includes('FROM documents d'))).toBe(false);
  });

  it('refuses a closed custody',async()=>{
    ctx(['custody.manage']);stub({custody:{id:CUSTODY,company_id:'co-a',status:'closed'}});
    expect((await request(app).get(URL_)).status).toBe(409);
  });

  it('scopes the search to the active company and encodes every eligibility rule in SQL, with the custody remaining balance as the ceiling',async()=>{
    ctx(['custody.manage']);stub();
    const r=await request(app).get(URL_);
    expect(r.status).toBe(200);
    expect(r.body.documents).toEqual([DOC]);
    const [sql,params]=docQuery();
    expect(params[0]).toBe('co-a');
    expect(params[1]).toBe('700.00');
    for(const rule of ["d.company_id=$1","d.status='approved'","d.document_type='expense'",'d.total_amount IS NOT NULL','d.total_amount<=$2','FROM obligations o','FROM document_settlements s','FROM custody_document_allocations a','LIMIT 25'])expect(String(sql)).toContain(rule);
  });

  it('passes the search text as a bound, LIKE-escaped parameter and never as SQL',async()=>{
    ctx(['custody.manage']);stub();
    await request(app).get(URL_).query({q:"50%_x' OR 1=1 --"});
    const [sql,params]=docQuery();
    expect(String(sql)).not.toContain('OR 1=1');
    expect(params[2]).toBe("50%_x' OR 1=1 --");
    expect(params[3]).toBe("%50\\%\\_x' OR 1=1 --%");
  });
});
