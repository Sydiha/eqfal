import { describe, expect, it } from 'vitest';
import { inferBankColumnMapping, parseBankFile } from '../src/modules/banking/bank.router';
import { buildXlsx } from '../../client/src/export/xlsx-builder';
import { bankImportTemplate, buildBankImportTemplate, BANK_TEMPLATE_HEADERS } from '../../client/src/export/bankImportTemplate';

const filled = (lang: 'ar' | 'en', data: Parameters<typeof buildXlsx>[1]) => {
  const t = bankImportTemplate(lang);
  return Buffer.from(buildXlsx(t.sheetName, [...t.rows, ...data], t.rtl, t.layout));
};
const n = (num: string) => ({ num });

describe.each(['ar', 'en'] as const)('bank import template round trip (%s)', (lang) => {
  const data = [
    ['2026-01-20', 'Supplier payment', n('250.50'), null, n('11249.50'), 'R-1'],
    ['2026-01-21', 'Customer receipt', null, n('1000.00'), n('12249.50'), 'R-2'],
  ];

  it('ignores instructions and the example, auto-maps debit/credit', () => {
    const table = parseBankFile('xlsx', filled(lang, data));
    expect(table.headers).toEqual(BANK_TEMPLATE_HEADERS);
    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((r) => r[1])).toEqual(['Supplier payment', 'Customer receipt']);
    expect(table.rows.flat()).not.toContain('Customer payment');
    const mapping = inferBankColumnMapping(table);
    expect(mapping).toMatchObject({
      amount_mode: 'debit_credit', date_format: 'YYYY-MM-DD',
      transaction_date: { index: 0 }, debit: { index: 2 }, credit: { index: 3 },
      description: { index: 1 }, bank_reference: { index: 5 }, running_balance: { index: 4 },
    });
  });

  it('keeps debit as outflow and credit as inflow in the importer sign convention', () => {
    const table = parseBankFile('xlsx', filled(lang, data));
    const m = inferBankColumnMapping(table)!;
    const sign = (row: (string | number | null)[]) => {
      const d = Number(row[m.debit!.index] ?? 0); const c = Number(row[m.credit!.index] ?? 0);
      return d ? -Math.abs(d) : Math.abs(c);
    };
    expect(table.rows.map(sign)).toEqual([-250.5, 1000]);
  });

  it('works with a single data row', () => {
    const table = parseBankFile('xlsx', filled(lang, [data[0]!]));
    expect(table.rows).toHaveLength(1);
    expect(inferBankColumnMapping(table)?.amount_mode).toBe('debit_credit');
  });

  it('empty template is rejected by the existing importer (no importable rows)', () => {
    expect(() => parseBankFile('xlsx', Buffer.from(buildBankImportTemplate(lang)))).toThrow('Could not confidently detect bank transaction table');
  });
});
