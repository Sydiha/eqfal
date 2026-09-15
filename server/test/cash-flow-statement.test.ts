import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CashFlowClassificationError, CashFlowStatementService, CashFlowValidationError } from '../src/modules/accounting/cash-flow-statement';

const year={start_date:'2026-01-01',end_date:'2026-12-31'};
type Overrides=Partial<{journal_id:string;accounting_date:string;entry_type:'standard'|'opening_balance';source_type:string|null;source_id:string|null;account_id:string;code:string;name:string;cash_role:'non_cash'|'cash'|'cash_equivalent';cash_flow_category:'unmapped'|'operating'|'investing'|'financing';debit:string;credit:string}>;
const line=(overrides:Overrides={})=>({journal_id:'j1',accounting_date:'2026-06-01',entry_type:'standard' as const,source_type:null,source_id:null,account_id:'cash',code:'1000',name:'Cash',cash_role:'cash' as const,cash_flow_category:'unmapped' as const,debit:'0',credit:'0',...overrides});
const database=(lines:unknown[])=>{
  const client={query:vi.fn(async(sql:string)=>sql.startsWith('BEGIN')||sql==='COMMIT'||sql==='ROLLBACK'?{rows:[]}:sql.startsWith('SELECT start_date')?{rows:[year]}:{rows:lines}),release:vi.fn()};
  return{db:{connect:vi.fn().mockResolvedValue(client)},client};
};
const journal=(id:string,category:'operating'|'investing'|'financing',cashAmount:number,date='2026-06-01')=>[
  line({journal_id:id,accounting_date:date,debit:cashAmount>0?String(cashAmount):'0',credit:cashAmount<0?String(-cashAmount):'0'}),
  line({journal_id:id,accounting_date:date,account_id:`${id}-counter`,code:`2-${id}`,name:'Explicit counterpart',cash_role:'non_cash',cash_flow_category:category,debit:cashAmount<0?String(-cashAmount):'0',credit:cashAmount>0?String(cashAmount):'0'}),
];

describe('Phase 5D.2 statement of cash flows',()=>{
  it('exposes a read-only tenant-scoped endpoint protected by accounting.view',()=>{
    const router=readFileSync(new URL('../src/modules/accounting/accounting.router.ts',import.meta.url),'utf8');
    expect(router).toMatch(/get\('\/financial-statements\/cash-flow',\.\.\.base,requireCapability\('accounting\.view'\)/);
    expect(router).not.toContain("post('/financial-statements/cash-flow'");
  });

  it('calculates inflows and outflows for all three categories and reconciles closing cash',async()=>{
    const lines=[...journal('op-in','operating',100),...journal('op-out','operating',-25),...journal('inv-in','investing',80),...journal('inv-out','investing',-30),...journal('fin-in','financing',60),...journal('fin-out','financing',-10)];
    const{db,client}=database(lines);
    const result=await new CashFlowStatementService(db as never).statement('company-a','year');
    expect(result).toMatchObject({operating_cash_flow:'75.00',investing_cash_flow:'50.00',financing_cash_flow:'50.00',net_change_in_cash_and_cash_equivalents:'175.00',opening_cash_and_cash_equivalents:'0.00',closing_cash_and_cash_equivalents:'175.00'});
    expect(result.reconciliation).toEqual({expected:'175.00',actual:'175.00',difference:'0.00',balanced:true});
    expect(client.query.mock.calls[2]![0]).toContain("j.status='posted'");
    expect(client.query.mock.calls[2]![0]).toContain('l.company_id=$1 AND j.company_id=$1');
    expect(client.query.mock.calls[2]![1]).toEqual(['company-a','year','2026-01-01','2026-12-31']);
  });

  it('includes cash equivalents, treats opening journals as opening cash, and excludes internal transfers',async()=>{
    const lines=[
      line({journal_id:'opening',accounting_date:'2026-01-01',entry_type:'opening_balance',cash_role:'cash_equivalent',debit:'40'}),
      line({journal_id:'opening',accounting_date:'2026-01-01',entry_type:'opening_balance',account_id:'equity',cash_role:'non_cash',cash_flow_category:'financing',credit:'40'}),
      line({journal_id:'transfer',accounting_date:'2026-03-01',debit:'10'}),
      line({journal_id:'transfer',accounting_date:'2026-03-01',account_id:'equivalent',cash_role:'cash_equivalent',credit:'10'}),
      ...journal('sale','operating',25),
    ];
    const{db}=database(lines);
    const result=await new CashFlowStatementService(db as never).statement('company','year');
    expect(result).toMatchObject({opening_cash_and_cash_equivalents:'40.00',operating_cash_flow:'25.00',net_change_in_cash_and_cash_equivalents:'25.00',closing_cash_and_cash_equivalents:'65.00'});
  });

  it('allocates an unambiguous compound journal by explicit counterpart categories',async()=>{
    const lines=[line({debit:'100'}),line({account_id:'sales',cash_role:'non_cash',cash_flow_category:'operating',credit:'70'}),line({account_id:'asset',cash_role:'non_cash',cash_flow_category:'investing',credit:'30'})];
    const{db}=database(lines);const result=await new CashFlowStatementService(db as never).statement('company','year');
    expect(result).toMatchObject({operating_cash_flow:'70.00',investing_cash_flow:'30.00',closing_cash_and_cash_equivalents:'100.00'});
  });

  it('fails closed for unmapped and ambiguous compound cash activity without name/code inference',async()=>{
    const unmapped=database([line({debit:'10',code:'CASH'}),line({account_id:'named',name:'Operating revenue',code:'4000',cash_role:'non_cash',cash_flow_category:'unmapped',credit:'10'})]);
    await expect(new CashFlowStatementService(unmapped.db as never).statement('company','year')).rejects.toMatchObject({blockers:[{reason:'unmapped'}]});
    const ambiguous=database([line({debit:'100'}),line({account_id:'cash2',cash_role:'cash_equivalent',credit:'20'}),line({account_id:'op',cash_role:'non_cash',cash_flow_category:'operating',credit:'100'}),line({account_id:'inv',cash_role:'non_cash',cash_flow_category:'investing',debit:'20'})]);
    await expect(new CashFlowStatementService(ambiguous.db as never).statement('company','year')).rejects.toBeInstanceOf(CashFlowClassificationError);
  });

  it('derives opening cash from prior range activity and rejects invalid fiscal-year ranges',async()=>{
    const{db}=database([...journal('prior','operating',30,'2026-02-01'),...journal('period','operating',20,'2026-04-01')]);
    const result=await new CashFlowStatementService(db as never).statement('company','year','2026-03-01','2026-05-01');
    expect(result).toMatchObject({opening_cash_and_cash_equivalents:'30.00',operating_cash_flow:'20.00',closing_cash_and_cash_equivalents:'50.00'});
    const invalid=database([]);
    await expect(new CashFlowStatementService(invalid.db as never).statement('company','year','2025-12-31')).rejects.toBeInstanceOf(CashFlowValidationError);
  });
});
