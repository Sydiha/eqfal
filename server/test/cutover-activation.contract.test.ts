import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseCutoverInput } from '../src/modules/accounting/ledger-cutover';
import { assertCashFlowRange, assertStatementRange } from '../src/modules/accounting/external-period-guard';

const U = '11111111-1111-4111-8111-111111111111', V = '22222222-2222-4222-8222-222222222222', R = '33333333-3333-4333-8333-333333333333';
const ACK = { retained_earnings: true, current_year_pnl: true, cash_balances: true, account_level_limitations: true };
const ok = () => ({ lines: [{ account_id: U, debit: '10.00', credit: '0' }, { account_id: V, debit: '0', credit: '10.00' }], retained_earnings_account_id: R, tb_reference: 'TB-1', tb_prepared_by: 'A', acknowledgements: ACK, idempotency_key: 'key-12345678' });
const sql = readFileSync(join(__dirname, '../migrations/086_cutover_balance_activation.sql'), 'utf8');

describe('C1B-3b contracts', () => {
  it('parses a complete cut-over body and rejects anything incomplete or unknown', () => {
    expect(parseCutoverInput(ok(), true)).not.toBeNull();
    expect(parseCutoverInput({ ...ok(), idempotency_key: undefined }, true)).toBeNull();
    expect(parseCutoverInput({ ...ok(), idempotency_key: undefined }, false)).not.toBeNull();
    expect(parseCutoverInput({ ...ok(), tb_reference: ' ' }, true)).toBeNull();
    expect(parseCutoverInput({ ...ok(), tb_prepared_by: '' }, true)).toBeNull();
    expect(parseCutoverInput({ ...ok(), acknowledgements: { ...ACK, current_year_pnl: false } }, true)).toBeNull();
    expect(parseCutoverInput({ ...ok(), acknowledgements: { ...ACK, extra: true } }, true)).toBeNull();
    expect(parseCutoverInput({ ...ok(), company_id: U }, true)).toBeNull();
    expect(parseCutoverInput({ ...ok(), lines: [] }, true)).toBeNull();
    expect(parseCutoverInput({ ...ok(), lines: [{ account_id: 'x', debit: '1', credit: '0' }] }, true)).toBeNull();
    expect(parseCutoverInput({ ...ok(), lines: [{ account_id: U, debit: '1.234', credit: '0' }] }, true)).toBeNull();
  });

  it('parses the per-account cash confirmations strictly, de-duplicated and defaulting to none', () => {
    expect(parseCutoverInput(ok(), true)!.cash_non_cash_confirmed_account_ids).toEqual([]);
    expect(parseCutoverInput({ ...ok(), cash_non_cash_confirmed_account_ids: [U.toUpperCase(), U, V] }, true)!.cash_non_cash_confirmed_account_ids).toEqual([U, V]);
    expect(parseCutoverInput({ ...ok(), cash_non_cash_confirmed_account_ids: ['nope'] }, true)).toBeNull();
    expect(parseCutoverInput({ ...ok(), cash_non_cash_confirmed_account_ids: 'all' }, true)).toBeNull();
    expect(parseCutoverInput({ ...ok(), cash_non_cash_confirmed_account_ids: [1] }, true)).toBeNull();
  });

  it('migration 086 never grants the activation capability to a role and protects the cut-over journal', () => {
    expect(sql).toMatch(/INSERT INTO capabilities[^;]*source_authority\.activate/);
    expect(sql).not.toMatch(/INSERT INTO role_capabilities/i);
    expect(sql).toMatch(/journal_entries_one_cutover_uidx/);
    expect(sql).toMatch(/VAT_PERIOD_EXTERNAL/);
    expect(sql).toMatch(/CUTOVER_PROFILE_CHANGE_FORBIDDEN/);
  });

  it('activation is a critical capability', () => {
    expect(readFileSync(join(__dirname, '../src/modules/memberships/capability-sensitivity.ts'), 'utf8')).toMatch(/source_authority\.activate/);
  });

  it('report range guards: external months rejected, YTD-to-D and post-D allowed, cash flow rejects any date <= D', () => {
    const cut = { cutover_from: '2026-01-01', cutover_to: '2026-06-30', start_date: '2026-01-01' } as never;
    expect(() => assertStatementRange(cut, '2026-03-01', '2026-03-31')).toThrow();
    expect(() => assertStatementRange(cut, '2026-01-01', '2026-06-30')).not.toThrow();
    expect(() => assertStatementRange(cut, '2026-07-01', '2026-07-31')).not.toThrow();
    expect(() => assertCashFlowRange(cut, '2026-01-01')).toThrow();
    expect(() => assertCashFlowRange(cut, '2026-07-01')).not.toThrow();
    expect(() => assertStatementRange({ cutover_from: null, cutover_to: null, start_date: '2026-01-01' } as never, '2026-03-01', '2026-03-31')).not.toThrow();
  });
});
