import { describe, expect, it, vi } from 'vitest';
import { FinancialStatementsService, FinancialStatementUnmappedError, FinancialStatementValidationError } from '../src/modules/accounting/financial-statements';

const year={start_date:'2026-01-01',end_date:'2026-12-31'};
const row=(statement_category:string,debit:string,credit:string,overrides:Record<string,unknown>={})=>({account_id:'a',code:'1000',name:'Account',account_type:'asset',statement_category,is_contra:false,debit,credit,...overrides});
const database=(rows:unknown[])=>({query:vi.fn().mockResolvedValueOnce({rows:[year]}).mockResolvedValueOnce({rows})});

describe('Phase 5B financial statements',()=>{
  it('accumulates financial position from fiscal-year start through its as-of date',async()=>{
    const db=database([row('current_asset','200','0'),row('revenue','0','200',{account_id:'b',account_type:'revenue'})]);
    const result=await new FinancialStatementsService(db as never).financialPosition('company','year','2026-06-30');
    expect(db.query.mock.calls[1]![1]).toEqual(['company','year','2026-01-01','2026-06-30']);
    expect(result).toMatchObject({start_date:'2026-01-01',end_date:'2026-06-30',as_of_date:'2026-06-30'});
  });

  it('includes current-period earnings in equity and returns a balanced equation',async()=>{
    const db=database([row('current_asset','200','0'),row('revenue','0','200',{account_id:'b',account_type:'revenue'})]);
    const result=await new FinancialStatementsService(db as never).financialPosition('company','year');
    expect(result.current_period_earnings).toBe('200.00');
    expect(result.total_equity).toBe('200.00');
    expect(result.accounting_equation).toEqual({assets:'200.00',liabilities_and_equity:'200.00',difference:'0.00',balanced:true});
  });

  it('groups financial position accounts and presents contra assets as reductions',async()=>{
    const db=database([row('current_asset','100','0'),row('current_asset','0','25',{account_id:'b',code:'1090',name:'Accumulated depreciation',is_contra:true}),row('equity','0','75',{account_id:'c',account_type:'equity'})]);
    const result=await new FinancialStatementsService(db as never).financialPosition('company','year');
    expect(result.sections[0]).toMatchObject({category:'current_asset',total:'75.00'});
    expect(result.sections[0]!.accounts[1]!.amount).toBe('-25.00');
    expect(result.total_assets).toBe('75.00');
    expect(result.accounting_equation.balanced).toBe(true);
    expect(db.query.mock.calls[1]![0]).toContain("j.status='posted'");
    expect(db.query.mock.calls[1]![0]).toContain('l.company_id=$1 AND j.company_id=$1');
  });

  it('keeps profit or loss on explicit inclusive from/to boundaries',async()=>{
    const db=database([row('revenue','0','200',{account_type:'revenue'}),row('operating_expense','50','0',{account_id:'b',account_type:'expense'})]);
    const result=await new FinancialStatementsService(db as never).profitOrLoss('company','year','2026-02-01','2026-02-28');
    expect(result.profit_or_loss).toBe('150.00');
    expect(db.query.mock.calls[1]![0]).toContain('j.accounting_date BETWEEN $3 AND $4');
    expect(db.query.mock.calls[1]![1]).toEqual(['company','year','2026-02-01','2026-02-28']);
  });

  it('rejects report dates outside the active company fiscal year',async()=>{
    const db=database([]);
    await expect(new FinancialStatementsService(db as never).financialPosition('company','year','2027-01-01')).rejects.toBeInstanceOf(FinancialStatementValidationError);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('company_id=$2'),['year','company']);
  });

  it('blocks any non-zero posted activity on unmapped accounts',async()=>{
    const db=database([row('unmapped','10','0')]);
    await expect(new FinancialStatementsService(db as never).financialPosition('company','year')).rejects.toBeInstanceOf(FinancialStatementUnmappedError);
  });
});
