import { describe, expect, it, vi } from 'vitest';
import { SalesService } from '../src/modules/sales/sales.router';

describe('sales operational projection', () => {
  it('is tenant-scoped, includes only sales, links customers/receivables, derives all states, and reuses settlement history', async () => {
    const query=vi.fn()
      .mockResolvedValueOnce({rows:[
        {id:'open',original_filename:'open.pdf',reference_number:'S-1',document_date:'2026-01-01',total_amount:'100.00',document_status:'approved',counterparty_id:'cp-1',customer_name:'Customer One',receivable_id:'r-1',original_amount:'100.00',collected_amount:'0',due_on:'2026-12-01',verification_status:'unconfirmed',is_cancelled:false},
        {id:'partial',original_filename:'partial.pdf',reference_number:'S-2',document_date:'2026-01-01',total_amount:'100.00',document_status:'approved',counterparty_id:'cp-1',customer_name:'Customer One',receivable_id:'r-2',original_amount:'100.00',collected_amount:'25.00',due_on:'2026-12-01',verification_status:'confirmed',is_cancelled:false},
        {id:'paid',original_filename:'paid.pdf',reference_number:'S-3',document_date:'2026-01-01',total_amount:'100.00',document_status:'approved',counterparty_id:'cp-2',customer_name:'Customer Two',receivable_id:'r-3',original_amount:'100.00',collected_amount:'100.00',due_on:'2026-01-02',verification_status:'confirmed',is_cancelled:false},
        {id:'overdue',original_filename:'late.pdf',reference_number:'S-4',document_date:'2026-01-01',total_amount:'100.00',document_status:'needs_review',counterparty_id:'cp-2',customer_name:'Customer Two',receivable_id:'r-4',original_amount:'100.00',collected_amount:'10.00',due_on:'2026-01-02',verification_status:'unconfirmed',is_cancelled:false},
      ]})
      .mockResolvedValueOnce({rows:[{id:'s-1',document_id:'partial',amount:'25.00',transaction_date:'2026-02-01',description:'Customer transfer'}]});
    const result=await new SalesService({query} as never).list('company-a','2026-06-01');
    expect(query.mock.calls[0][0]).toContain("d.document_type='sale'");
    expect(query.mock.calls[0][0]).toContain('d.company_id=$1');
    expect(query.mock.calls[0][1]).toEqual(['company-a']);
    expect(query.mock.calls[1][1][0]).toBe('company-a');
    expect(result.sales.map(s=>s.financial_state)).toEqual(['open','partial','paid','overdue']);
    expect(result.sales[0]).toMatchObject({customer_name:'Customer One',receivable_id:'r-1',remaining_amount:'100.00'});
    expect(result.sales[1]!.settlement_history).toEqual([expect.objectContaining({id:'s-1',amount:'25.00'})]);
  });
});
