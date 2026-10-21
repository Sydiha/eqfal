import { describe, expect, it } from 'vitest';
import { buildCutoverDisclosure, preCutover } from '../src/modules/accounting/cutover-disclosure';

const row = (acks: Record<string, unknown> | null, snapshot: Record<string, unknown> | null) => ({
  from_date: '2025-01-01', to_date: '2025-09-30', cutover_journal_id: 'j1', tb_reference: 'TB-1', tb_prepared_by: 'A', acknowledgements: acks, activation_snapshot: snapshot,
});
const ACK = { retained_earnings: true, current_year_pnl: true, cash_balances: true, account_level_limitations: true };

describe('S1 cut-over disclosure', () => {
  it('never certifies full-year completeness, even with complete trial balance evidence', () => {
    const d = buildCutoverDisclosure(row({ ...ACK, pre_closing_trial_balance: true }, { tb_basis: 'pre_closing', tb_source_system: 'Legacy ERP' }));
    expect([d.tb_basis, d.tb_source_system, d.evidence_missing]).toEqual(['pre_closing_acknowledged', 'Legacy ERP', []]);
    for (const c of Object.values(d.completeness)) expect([c.full_year_complete, c.status]).toEqual([false, 'unverified']);
    expect(d.completeness.income_statement.availability).toBe('ledger_calculated');
    expect(d.completeness.cash_flow.availability).toBe('post_cutover_only');
    expect(d.completeness.cash_flow.reasons).toContain('PRE_CUTOVER_CASH_FLOWS_NOT_RECORDED');
  });

  it('legacy activations (no S1 evidence) are disclosed as missing evidence, read as stored', () => {
    const acks = { ...ACK }; const snapshot = { summary: {} };
    const d = buildCutoverDisclosure(row(acks, snapshot));
    expect([d.tb_basis, d.tb_source_system]).toEqual(['not_recorded', null]);
    expect(d.evidence_missing).toEqual(['TB_BASIS_NOT_RECORDED', 'TB_SOURCE_SYSTEM_NOT_RECORDED']);
    expect(d.completeness.financial_position.reasons).toEqual(expect.arrayContaining(['TB_BASIS_NOT_RECORDED', 'TB_SOURCE_SYSTEM_NOT_RECORDED']));
    expect([acks, snapshot]).toEqual([{ ...ACK }, { summary: {} }]);
    expect(buildCutoverDisclosure(row(null, null)).tb_basis).toBe('not_recorded');
  });

  it('adds nothing for a year without an active cut-over range', () => {
    expect(preCutover(null, 'income_statement', true)).toEqual({});
    const d = buildCutoverDisclosure(row({ ...ACK, pre_closing_trial_balance: true }, { tb_source_system: 'X' }));
    expect(preCutover(d, 'cash_flow', true)).toEqual({ pre_cutover: expect.objectContaining({ cutover_date: '2025-09-30', completeness: d.completeness.cash_flow }) });
  });
});
