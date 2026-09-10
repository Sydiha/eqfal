import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { loadVatReconciliation } from '../src/modules/vat/vat-reconciliation';

const databaseUrl=process.env['DATABASE_URL'];
const describeDatabase=databaseUrl?describe:describe.skip;
const START='2026-01-01',END='2026-03-31';

type Tenant={company:string;user:string;year:string;account:string;counterparty:string};
type DocumentType='sale'|'purchase'|'expense';
type Treatment='standard'|'zero_rated'|'exempt'|'out_of_scope';
type Line={memo:string;debit:string;credit:string};

describeDatabase('Phase 6B1 reconciliation with PostgreSQL',()=>{
  const pool=new Pool({connectionString:databaseUrl});
  afterAll(()=>pool.end());

  async function tenant(client:PoolClient,label:string):Promise<Tenant>{
    const value={company:randomUUID(),user:randomUUID(),year:randomUUID(),account:randomUUID(),counterparty:randomUUID()};
    await client.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,$3)",[value.company,`vat-reconciliation-${label}-${value.company}`,`VAT Reconciliation ${label}`]);
    await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only')",[value.user,`vat-reconciliation-${label}-${value.user}@example.test`]);
    await client.query("INSERT INTO fiscal_years(id,company_id,name,start_date,end_date) VALUES($1,$2,'2026','2026-01-01','2026-12-31')",[value.year,value.company]);
    await client.query("INSERT INTO accounts(id,company_id,code,name,account_type) VALUES($1,$2,'VAT','VAT test account','asset')",[value.account,value.company]);
    await client.query("INSERT INTO counterparties(id,company_id,name,type,created_by_user_id) VALUES($1,$2,$3,'other',$4)",[value.counterparty,value.company,`Counterparty ${label}`,value.user]);
    return value;
  }

  async function reviewedDocument(client:PoolClient,t:Tenant,options:{type?:DocumentType;vat?:string;treatment?:Treatment;taxDate?:string;documentDate?:string;recoverability?:'fully_recoverable'|'partially_recoverable'|'non_recoverable'|'needs_review';recoverable?:string|null}={}){
    const id=randomUUID(),type=options.type??'sale',vat=options.vat??'15.00';
    await client.query(`INSERT INTO documents(id,company_id,uploaded_by_user_id,status,original_filename,mime_type,size_bytes,storage_key,sha256,document_type,document_date,total_amount)
      VALUES($1,$2,$3,'approved',$4,'application/pdf',1,$5,$6,$7,$8::date,'115.00'::numeric)`,[id,t.company,t.user,`${id}.pdf`,`${t.company}/${id}`,'a'.repeat(64),type,options.documentDate??'2026-02-01']);
    await client.query(`INSERT INTO document_vat_reviews(company_id,document_id,tax_date,treatment,taxable_amount,vat_amount,review_status,reviewed_by_user_id,reviewed_at,recoverability_status,recoverable_vat_amount,recoverability_reviewed_by_user_id,recoverability_reviewed_at)
      VALUES($1,$2,$3::date,$4,'100.00'::numeric,$5::numeric,'reviewed',$6,NOW(),$7,$8::numeric,CASE WHEN $7 IN ('fully_recoverable','partially_recoverable','non_recoverable') THEN $6 ELSE NULL END,CASE WHEN $7 IN ('fully_recoverable','partially_recoverable','non_recoverable') THEN NOW() ELSE NULL END)`,[t.company,id,options.taxDate??'2026-02-01',options.treatment??'standard',vat,t.user,type==='sale'?'not_applicable':options.recoverability??(vat==='0.00'?'fully_recoverable':'fully_recoverable'),type==='sale'?null:(Object.prototype.hasOwnProperty.call(options,'recoverable')?options.recoverable:vat)]);
    return id;
  }

  async function obligation(client:PoolClient,t:Tenant,documentId:string,options:{confirmed?:boolean;cancelled?:boolean}={}){
    const id=randomUUID();
    await client.query(`INSERT INTO obligations(id,company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,is_cancelled,created_by_user_id)
      VALUES($1,$2,'payable',$3,$4,'115.00'::numeric,'2026-02-01',$5,'document',$6,$7)`,[id,t.company,t.counterparty,documentId,options.confirmed===false?'unconfirmed':'confirmed',options.cancelled??false,t.user]);
    return id;
  }

  async function journal(client:PoolClient,t:Tenant,sourceId:string,options:{status?:'draft'|'posted';sourceType?:string;lines?:Line[]}={}){
    const id=randomUUID();
    await client.query(`INSERT INTO journal_entries(id,company_id,fiscal_year_id,accounting_date,description,source_type,source_id,status,created_by)
      VALUES($1,$2,$3,'2026-02-01','VAT reconciliation fixture',$4,$5,'draft',$6)`,[id,t.company,t.year,options.sourceType??'obligation',sourceId,t.user]);
    for(const [index,line] of (options.lines??[]).entries())await client.query(`INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence)
      VALUES($1,$2,$3,$4::numeric,$5::numeric,$6,$7)`,[t.company,id,t.account,line.debit,line.credit,line.memo,index+1]);
    if(options.status!=='draft')await client.query("UPDATE journal_entries SET status='posted',posted_by=$2,posted_at=NOW() WHERE id=$1",[id,t.user]);
    return id;
  }

  async function isolated<T>(run:(client:PoolClient,a:Tenant,b:Tenant)=>Promise<T>):Promise<T>{
    const client=await pool.connect();
    try{await client.query('BEGIN');const a=await tenant(client,'a'),b=await tenant(client,'b');return await run(client,a,b);}
    finally{await client.query('ROLLBACK');client.release();}
  }

  const cases:Array<{name:string;type:DocumentType;lines?:Line[];journalStatus?:'none'|'draft'|'posted';status:string}>= [
    {name:'sale VAT_OUTPUT credit',type:'sale',lines:[{memo:'VAT_OUTPUT',debit:'0.00',credit:'15.00'}],journalStatus:'posted',status:'reconciled'},
    {name:'purchase VAT_INPUT debit',type:'purchase',lines:[{memo:'VAT_INPUT',debit:'15.00',credit:'0.00'}],journalStatus:'posted',status:'reconciled'},
    {name:'expense VAT_INPUT debit',type:'expense',lines:[{memo:'VAT_INPUT',debit:'15.00',credit:'0.00'}],journalStatus:'posted',status:'reconciled'},
    {name:'confirmed obligation without journal',type:'sale',journalStatus:'none',status:'missing_posted_journal'},
    {name:'draft obligation journal',type:'sale',lines:[{memo:'VAT_OUTPUT',debit:'0.00',credit:'15.00'}],journalStatus:'draft',status:'missing_posted_journal'},
    {name:'posted journal without VAT memo',type:'sale',lines:[{memo:'ordinary line',debit:'15.00',credit:'0.00'}],journalStatus:'posted',status:'missing_vat_line'},
    {name:'purchase with only VAT_OUTPUT',type:'purchase',lines:[{memo:'VAT_OUTPUT',debit:'0.00',credit:'15.00'}],journalStatus:'posted',status:'wrong_vat_direction'},
    {name:'sale with only VAT_INPUT',type:'sale',lines:[{memo:'VAT_INPUT',debit:'15.00',credit:'0.00'}],journalStatus:'posted',status:'wrong_vat_direction'},
    {name:'expected memo on wrong side',type:'sale',lines:[{memo:'VAT_OUTPUT',debit:'15.00',credit:'0.00'}],journalStatus:'posted',status:'wrong_vat_direction'},
    {name:'expected memo with wrong amount',type:'sale',lines:[{memo:'VAT_OUTPUT',debit:'0.00',credit:'14.99'}],journalStatus:'posted',status:'vat_amount_mismatch'},
    {name:'multiple expected memo lines',type:'sale',lines:[{memo:'VAT_OUTPUT',debit:'0.00',credit:'10.00'},{memo:'VAT_OUTPUT',debit:'0.00',credit:'5.00'}],journalStatus:'posted',status:'vat_amount_mismatch'},
  ];

  it.each(cases)('classifies $name by executing the reconciliation SQL',async scenario=>isolated(async(client,a)=>{
    const documentId=await reviewedDocument(client,a,{type:scenario.type});
    const obligationId=await obligation(client,a,documentId);
    if(scenario.journalStatus!=='none')await journal(client,a,obligationId,{status:scenario.journalStatus,lines:scenario.lines});
    const value=await loadVatReconciliation(client,a.company,START,END);
    expect(value.documents).toHaveLength(1);
    expect(value.documents[0]?.reconciliation_status).toBe(scenario.status);
  }));

  it.each(['standard','zero_rated','exempt','out_of_scope'] as Treatment[])('reconciles zero VAT treatment %s without a journal',async treatment=>isolated(async(client,a)=>{
    const documentId=await reviewedDocument(client,a,{vat:'0.00',treatment});
    await obligation(client,a,documentId);
    const value=await loadVatReconciliation(client,a.company,START,END);
    expect(value.documents[0]).toMatchObject({reviewed_vat_amount:'0.00',reconciliation_status:'reconciled'});
    expect(value.counts.unreconciled).toBe(0);
  }));

  it('uses tax_date exclusively for period membership',async()=>isolated(async(client,a)=>{
    const outside=await reviewedDocument(client,a,{documentDate:'2026-02-01',taxDate:'2026-04-01'});await obligation(client,a,outside);
    const inside=await reviewedDocument(client,a,{documentDate:'2025-12-31',taxDate:'2026-02-01'});await obligation(client,a,inside);
    const value=await loadVatReconciliation(client,a.company,START,END);
    expect(value.documents.map(row=>row.document_id)).toEqual([inside]);
  }));

  it('excludes cancelled, unconfirmed, and non-document obligations',async()=>isolated(async(client,a)=>{
    const cancelled=await reviewedDocument(client,a);await obligation(client,a,cancelled,{cancelled:true});
    const unconfirmed=await reviewedDocument(client,a);await obligation(client,a,unconfirmed,{confirmed:false});
    const noDocumentObligation=await reviewedDocument(client,a);
    await client.query(`INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,is_cancelled,created_by_user_id)
      VALUES($1,'payable',$2,NULL,'115.00'::numeric,'2026-02-01','confirmed','manual',FALSE,$3)`,[a.company,a.counterparty,a.user]);
    const value=await loadVatReconciliation(client,a.company,START,END);
    expect(value.documents).toEqual([]);
    expect([cancelled,unconfirmed,noDocumentObligation]).toHaveLength(3);
  }));

  it('does not admit or satisfy reconciliation through a custody journal',async()=>isolated(async(client,a)=>{
    const documentId=await reviewedDocument(client,a);
    await journal(client,a,randomUUID(),{sourceType:'custody_allocation',lines:[{memo:'VAT_OUTPUT',debit:'0.00',credit:'15.00'}]});
    expect((await loadVatReconciliation(client,a.company,START,END)).documents).toEqual([]);
    expect(documentId).toBeTruthy();
  }));

  it('isolates documents, obligations, journals, lines, and coincident source IDs by company',async()=>isolated(async(client,a,b)=>{
    const documentB=await reviewedDocument(client,b),obligationB=await obligation(client,b,documentB);
    await journal(client,a,obligationB,{lines:[{memo:'VAT_OUTPUT',debit:'0.00',credit:'15.00'}]});
    const resultB=await loadVatReconciliation(client,b.company,START,END);
    expect(resultB.documents[0]).toMatchObject({document_id:documentB,obligation_id:obligationB,reconciliation_status:'missing_posted_journal'});
    expect((await loadVatReconciliation(client,a.company,START,END)).documents).toEqual([]);
    const crossCompanyDocument=await reviewedDocument(client,b);
    await client.query('SAVEPOINT cross_company_obligation');
    await expect(client.query(`INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id)
      VALUES($1,'payable',$2,$3,'115.00'::numeric,'2026-02-01','confirmed','document',$4)`,[a.company,a.counterparty,crossCompanyDocument,a.user])).rejects.toMatchObject({code:'23503'});
    await client.query('ROLLBACK TO SAVEPOINT cross_company_obligation');
  }));

  it('calculates reviewed, valid ledger, and difference totals with PostgreSQL NUMERIC fixtures',async()=>isolated(async(client,a)=>{
    const sale=await reviewedDocument(client,a,{type:'sale',vat:'15.00'}),saleObligation=await obligation(client,a,sale);await journal(client,a,saleObligation,{lines:[{memo:'VAT_OUTPUT',debit:'0.00',credit:'15.00'}]});
    const purchase=await reviewedDocument(client,a,{type:'purchase',vat:'7.50'}),purchaseObligation=await obligation(client,a,purchase);await journal(client,a,purchaseObligation,{lines:[{memo:'VAT_INPUT',debit:'7.50',credit:'0.00'}]});
    const expense=await reviewedDocument(client,a,{type:'expense',vat:'2.25'}),expenseObligation=await obligation(client,a,expense);await journal(client,a,expenseObligation,{lines:[{memo:'VAT_INPUT',debit:'2.00',credit:'0.00'}]});
    const value=await loadVatReconciliation(client,a.company,START,END);
    expect(value.totals).toEqual({reviewed_output_vat:15,reviewed_input_vat:9.75,gross_reviewed_input_vat:9.75,recoverable_input_vat:9.75,non_recoverable_input_vat:0,ledger_output_vat:15,ledger_input_vat:7.5,output_difference:0,input_difference:2.25});
    expect(value.counts).toEqual({total_in_scope:3,reconciled:2,unreconciled:1});
  }));

  it('uses approved recoverability amounts and excludes needs_review',async()=>isolated(async(client,a)=>{
    const full=await reviewedDocument(client,a,{type:'purchase',vat:'15.00',recoverability:'fully_recoverable',recoverable:'15.00'}),fullObligation=await obligation(client,a,full);await journal(client,a,fullObligation,{lines:[{memo:'VAT_INPUT',debit:'15.00',credit:'0.00'}]});
    const partial=await reviewedDocument(client,a,{type:'purchase',vat:'15.00',recoverability:'partially_recoverable',recoverable:'9.00'}),partialObligation=await obligation(client,a,partial);await journal(client,a,partialObligation,{lines:[{memo:'VAT_INPUT',debit:'9.00',credit:'0.00'}]});
    const none=await reviewedDocument(client,a,{type:'purchase',vat:'15.00',recoverability:'non_recoverable',recoverable:'0.00'});await obligation(client,a,none);
    const pending=await reviewedDocument(client,a,{type:'purchase',vat:'15.00',recoverability:'needs_review',recoverable:null});await obligation(client,a,pending);
    const value=await loadVatReconciliation(client,a.company,START,END);
    expect(value.documents.map(row=>row.document_id).sort()).toEqual([full,partial,none].sort());
    expect(value.documents.find(row=>row.document_id===partial)).toMatchObject({expected_vat_amount:'9.00',recoverable_vat_amount:'9.00',non_recoverable_vat_amount:'6.00',reconciliation_status:'reconciled'});
    expect(value.documents.find(row=>row.document_id===none)).toMatchObject({expected_vat_amount:'0.00',non_recoverable_vat_amount:'15.00',reconciliation_status:'reconciled'});
    expect(value.totals).toMatchObject({reviewed_input_vat:45,gross_reviewed_input_vat:45,recoverable_input_vat:24,non_recoverable_input_vat:21,ledger_input_vat:24,input_difference:0});
  }));

});
