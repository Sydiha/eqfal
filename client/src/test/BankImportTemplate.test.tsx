import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { Banking } from '../components/Banking';
import * as download from '../export/downloadExport';
import { bankImportTemplate, buildBankImportTemplate, BANK_TEMPLATE_HEADERS } from '../export/bankImportTemplate';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('bank import template file', () => {
  it('is a zip-based xlsx with RTL only for Arabic', () => {
    const ar = buildBankImportTemplate('ar'); const en = buildBankImportTemplate('en');
    expect([ar[0], ar[1]]).toEqual([0x50, 0x4b]);
    expect(text(ar)).toContain('rightToLeft="1"');
    expect(text(en)).not.toContain('rightToLeft');
    expect(text(ar)).toContain('قالب استيراد كشف حساب البنك');
    expect(text(en)).toContain('Bank statement import template');
  });
  it('puts the labelled example above the headings and leaves the data area empty', () => {
    for (const lang of ['ar', 'en'] as const) {
      const { rows, layout } = bankImportTemplate(lang);
      const headerIdx = layout.headerRows[0]!;
      expect(rows[headerIdx]).toEqual(BANK_TEMPLATE_HEADERS);
      expect(rows).toHaveLength(headerIdx + 1);
      expect(rows.slice(0, headerIdx).some((r) => r[0] === '2026-01-15')).toBe(true);
    }
  });
});

describe('Banking template button', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ accounts: [], batches: [], transactions: [] }), { status: 200 })))); });
  it.each([['en', 'Download Excel Template', 'eqfal-bank-statement-template-en.xlsx'], ['ar', 'تنزيل قالب Excel', 'eqfal-bank-statement-template-ar.xlsx']])('downloads the %s template', async (lang, label, filename) => {
    await i18n.changeLanguage(lang);
    const spy = vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    render(<MantineProvider><Banking canView canImport canManage={false} canMatch={false} canReconcile={false} onUnauthorized={vi.fn()} /></MantineProvider>);
    fireEvent.click(await screen.findByRole('button', { name: label }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe(filename);
  });
});
