import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite('payroll settlement migration (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());
  async function fixture(name: string) {
    const u = await h.user(name), co = await h.company(name, u.id);
    const fy = await h.fiscalYear(co, 'FY26', '2026-01-01', '2026-12-31');
    const liability = await h.account(co, 'L', 'liability', 'current_liability');
    const expense = await h.account(co, 'E', 'expense', 'operating_expense');
    const cash = await h.account(co, 'B', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [cash]);
    const draft2=(await h.q<{id:string}>("INSERT INTO payroll_drafts(company_id,period_month,created_by,status,approved_by,approved_at) VALUES($1,'2026-02-01',$2,'approved',$2,NOW()) RETURNING id",[co,u.id]))[0]!.id;
    const posted=await h.postedJournal(co,fy,'2026-02-01',u.id,[[expense,'100','0'],[liability,'0','100']],{source_type:'payroll',source_id:draft2,memo:'net_payroll_liability'});
    const line=(await h.q<{id:string}>('SELECT id FROM journal_lines WHERE journal_entry_id=$1 AND account_id=$2',[posted,liability]))[0]!.id;
    const draft3=(await h.q<{id:string}>("INSERT INTO payroll_drafts(company_id,period_month,created_by,status,approved_by,approved_at) VALUES($1,'2026-03-01',$2,'approved',$2,NOW()) RETURNING id",[co,u.id]))[0]!.id;
    const posted2=await h.postedJournal(co,fy,'2026-03-01',u.id,[[expense,'100','0'],[liability,'0','100']],{source_type:'payroll',source_id:draft3,memo:'net_payroll_liability'});
    const line2=(await h.q<{id:string}>('SELECT id FROM journal_lines WHERE journal_entry_id=$1 AND account_id=$2',[posted2,liability]))[0]!.id;
    const bank=(await h.q<{id:string}>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id",[co,u.id]))[0]!.id;
    await h.q("INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)",[co,bank,cash,u.id]);
    async function tx(amount='-100') {return (await h.q<{id:string}>("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id) VALUES($1,$2,'2026-02-10',$3,'SAR','Payroll',$4,$5,'strong','manual','other',$6) RETURNING id",[co,bank,amount,randomUUID(),randomUUID().replaceAll('-',''),u.id]))[0]!.id;}
    async function allocate(bankId:string, amount:string, opts:{line?:string; journalAmount?:string; status?:string}={}) {
      const client=await h.db.connect(), id=randomUUID(), journal=randomUUID();
      try {
        await client.query('BEGIN');
        await client.query("INSERT INTO journal_entries(id,company_id,fiscal_year_id,accounting_date,description,source_type,source_id,created_by) VALUES($1,$2,$3,'2026-02-10','Settlement','payroll_settlement',$4,$5)",[journal,co,fy,id,u.id]);
        await client.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,$5,0,1),($1,$2,$4,0,$5,2)',[co,journal,liability,cash,opts.journalAmount??amount]);
        if(opts.status!=='draft') await client.query("UPDATE journal_entries SET status='posted',posted_by=$2,posted_at=NOW() WHERE id=$1",[journal,u.id]);
        await client.query('INSERT INTO payroll_settlement_allocations(id,company_id,bank_transaction_id,liability_line_id,journal_entry_id,amount,idempotency_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,co,bankId,opts.line??line,journal,amount,randomUUID(),u.id]);
        await client.query('COMMIT'); return {id,journal};
      } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
    }
    return {u,co,fy,line,line2,liability,cash,tx,allocate};
  }
  it('enforces partial settlement and both liability and bank limits',async()=>{
    const x=await fixture('settle-limits'), b=await x.tx('-60');
    await x.allocate(b,'40'); await x.allocate(b,'20');
    await expect(x.allocate(b,'1')).rejects.toThrow(/bank amount exceeded/);
    await expect(x.allocate(await x.tx('-100'),'41')).rejects.toThrow(/liability exceeded/);
    await x.allocate(await x.tx('-40'),'40');
  });
  it('rejects foreign liabilities and inconsistent or unposted journals',async()=>{
    const x=await fixture('settle-tenant-a'), y=await fixture('settle-tenant-b'), b=await x.tx();
    await expect(x.allocate(b,'10',{line:y.line})).rejects.toThrow(/liability not found/);
    await expect(x.allocate(b,'10',{journalAmount:'9'})).rejects.toThrow(/journal does not match/);
    await expect(x.allocate(b,'10',{status:'draft'})).rejects.toThrow(/journal does not match/);
    await x.allocate(b,'10');
  });
  it('excludes other workflows in both directions and protects history',async()=>{
    const x=await fixture('settle-owner'), b=await x.tx();
    const doc=(await h.q<{id:string}>("INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount) VALUES($1,$2,'i.pdf','application/pdf',4,$3,$4,'approved','purchase','2026-02-01',100) RETURNING id",[x.co,x.u.id,randomUUID(),'a'.repeat(64)]))[0]!.id;
    const matched=await x.tx();
    await h.q("INSERT INTO bank_transaction_matches(company_id,document_id,bank_transaction_id,matched_by_user_id,match_type) VALUES($1,$2,$3,$4,'document')",[x.co,doc,matched,x.u.id]);
    await expect(x.allocate(matched,'10')).rejects.toThrow(/unavailable/);
    const a=await x.allocate(b,'10');
    await expect(h.q("INSERT INTO bank_transaction_matches(company_id,document_id,bank_transaction_id,matched_by_user_id,match_type) VALUES($1,$2,$3,$4,'document')",[x.co,doc,b,x.u.id])).rejects.toThrow(/payroll settlement/);
    await expect(h.q('DELETE FROM payroll_settlement_allocations WHERE id=$1',[a.id])).rejects.toThrow(/immutable/);
    await expect(h.q('UPDATE bank_transactions SET amount=-99 WHERE id=$1',[b])).rejects.toThrow(/immutable|payroll settlement history/i);
    await expect(h.q("UPDATE bank_account_ledger_links SET valid_to='2026-02-01',ended_by=$2,ended_at=NOW() WHERE company_id=$1",[x.co,x.u.id])).rejects.toThrow(/payroll settlement history/);
    await expect(h.q('UPDATE journal_lines SET debit=11 WHERE journal_entry_id=$1 AND debit>0',[a.journal])).rejects.toThrow(/immutable/);
  });
  it('serializes concurrent claims for one liability',async()=>{
    const x=await fixture('settle-race'), a=await x.tx(), b=await x.tx();
    const result=await Promise.allSettled([x.allocate(a,'70'),x.allocate(b,'70')]);
    expect(result.filter(v=>v.status==='fulfilled')).toHaveLength(1);
    expect(result.filter(v=>v.status==='rejected')).toHaveLength(1);
  });
  it('serializes competing claims against one bank transaction',async()=>{
    const x=await fixture('settle-bank-race'), bank=await x.tx('-100');
    const result=await Promise.allSettled([x.allocate(bank,'60'),x.allocate(bank,'60',{line:x.line2})]);
    expect(result.filter(v=>v.status==='fulfilled')).toHaveLength(1);
    expect(result.filter(v=>v.status==='rejected')).toHaveLength(1);
  });
});
