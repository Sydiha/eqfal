import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildXlsx, crc32, type XlsxImage } from '../export/xlsx-builder';
import { trialBalanceExport } from '../export/reportExport';
import { CompanyProvider } from '../context/CompanyContext';
import i18n from '../i18n';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../export/branding', () => ({ loadReportBranding: mocks.load }));

const t = (k: string) => k;
const sum = (v: string[]) => (v.reduce((a, x) => a + Math.round(Number(x) * 100), 0) / 100).toFixed(2);
const rows = [{ id: 'a', code: '1000', name: 'Bank', debit_movement: '0.00', credit_movement: '100.00', debit_balance: '0.00', credit_balance: '100.00' },
  { id: 'b', code: '2000', name: 'Pay', debit_movement: '100.00', credit_movement: '0.00', debit_balance: '100.00', credit_balance: '0.00' }];
const doc = () => trialBalanceExport({ ar: false, company: 'Acme Co', generatedAt: 'now', t, accountName: (r) => r.name, sum, yearName: '2026', rows });
const png = (n: number): XlsxImage => ({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]), width: 300, height: 100 });

function unzip(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const out: Record<string, Uint8Array> = {}; let pos = 0;
  while (dv.getUint32(pos, true) === 0x04034b50) {
    const crc = dv.getUint32(pos + 14, true), size = dv.getUint32(pos + 18, true), nl = dv.getUint16(pos + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 30, pos + 30 + nl)); const data = bytes.subarray(pos + 30 + nl, pos + 30 + nl + size);
    expect(crc32(data)).toBe(crc); out[name] = data; pos += 30 + nl + size;
  }
  return out;
}
const txt = (f: Record<string, Uint8Array>, n: string) => new TextDecoder().decode(f[n]);

describe('XLSX logo embedding', () => {
  it('embeds company + EQFAL images with valid drawing parts and keeps numerics, styles and freeze pane', () => {
    const d = doc();
    const f = unzip(buildXlsx(d.sheetName, d.rows, true, d.layout, 'EQFAL', { company: png(1), eqfal: png(2) }));
    expect(Object.keys(f)).toEqual(expect.arrayContaining(['xl/drawings/drawing1.xml', 'xl/drawings/_rels/drawing1.xml.rels', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/media/image1.png', 'xl/media/image2.png']));
    expect(txt(f, '[Content_Types].xml')).toContain('Extension="png"'); expect(txt(f, '[Content_Types].xml')).toContain('/xl/drawings/drawing1.xml');
    const sheet = txt(f, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<drawing r:id="rId1"/>'); expect(sheet).toContain('xmlns:r=');
    expect(sheet).toContain('<row r="1" ht="48" customHeight="1"></row>');
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('<pane ySplit="9" topLeftCell="A10" activePane="bottomLeft" state="frozen"/>'); // one extra band row
    expect(sheet).toContain('<c r="A9" s="4"'); expect(sheet).toContain('<c r="B10" s="5"><v>0.00</v></c>'); expect(sheet).toMatch(/<c r="B12" s="9"><v>100\.00<\/v><\/c>/);
    expect(sheet).not.toContain('t="inlineStr"><is><t xml:space="preserve">0.00');
    const drawing = txt(f, 'xl/drawings/drawing1.xml');
    expect(drawing.match(/<xdr:pic>/g)).toHaveLength(2); expect(drawing).toContain('Company logo'); expect(drawing).toContain('EQFAL logo');
    expect(txt(f, 'xl/drawings/_rels/drawing1.xml.rels')).toContain('../media/image2.png');
    expect(Array.from(f['xl/media/image1.png']!.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it('EQFAL image alone goes in column A; no images keeps the original package unchanged', () => {
    const d = doc();
    const only = unzip(buildXlsx(d.sheetName, d.rows, false, d.layout, 'EQFAL', { company: null, eqfal: png(2) }));
    expect(txt(only, 'xl/drawings/drawing1.xml')).toContain('<xdr:col>0</xdr:col>'); expect(only['xl/media/image2.png']).toBeUndefined();
    const none = unzip(buildXlsx(d.sheetName, d.rows, false, d.layout, 'EQFAL'));
    expect(Object.keys(none)).toHaveLength(6); expect(txt(none, 'xl/worksheets/sheet1.xml')).not.toContain('<drawing');
    expect(txt(none, 'xl/worksheets/sheet1.xml')).toContain('<pane ySplit="8"');
  });
});

describe('print header branding', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); mocks.load.mockReset(); vi.stubGlobal('print', vi.fn()); });
  const mount = async (branding: unknown) => {
    mocks.load.mockResolvedValue(branding);
    const { ExportButtons } = await import('../components/ExportButtons');
    render(<CompanyProvider allowedCompanies={[{ id: 'c1', name: 'Acme Co' }]} initialCompanyId="c1"><ExportButtons language="en" document={doc()} landscape /></CompanyProvider>);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith('c1'));
    await Promise.resolve();
    fireEvent.click(screen.getByRole('button', { name: 'Print / Save PDF' }));
    return document.body.querySelector('.eqfal-print-doc')!;
  };
  it('shows company logo, company name, title and the EQFAL mark', async () => {
    const d = await mount({ logoDataUrl: 'data:image/png;base64,AAAA', logoPng: null, eqfalPng: null });
    await waitFor(() => expect(d.querySelector('img.eqfal-print-logo')).not.toBeNull());
    expect(d.querySelector('.eqfal-print-company-name')).toHaveTextContent('Acme Co');
    expect(d.querySelector('h1')).toHaveTextContent('accounting.tabs.trial');
    expect(d.querySelector('.eqfal-print-brand svg')).not.toBeNull(); expect(d.querySelector('.eqfal-print-brand')).toHaveTextContent('EQFAL');
    expect(d).toHaveTextContent('2026'); expect(d).toHaveTextContent('SAR');
  });
  it('falls back to company name + EQFAL when there is no logo', async () => {
    const d = await mount({ logoDataUrl: null, logoPng: null, eqfalPng: null });
    expect(d.querySelector('img.eqfal-print-logo')).toBeNull();
    expect(d.querySelector('.eqfal-print-company-name')).toHaveTextContent('Acme Co'); expect(d.querySelector('.eqfal-print-brand svg')).not.toBeNull();
  });
  it('a broken logo image is dropped without blocking the report', async () => {
    const d = await mount({ logoDataUrl: 'data:image/png;base64,AAAA', logoPng: null, eqfalPng: null });
    const img = await waitFor(() => { const i = d.querySelector('img.eqfal-print-logo'); expect(i).not.toBeNull(); return i!; });
    fireEvent.error(img);
    await waitFor(() => expect(d.querySelector('img.eqfal-print-logo')).toBeNull());
    expect(d.querySelector('tbody')).not.toBeNull(); expect(d.querySelector('.eqfal-print-brand svg')).not.toBeNull();
  });
  it('a failing branding load still leaves printing available (fallback header)', async () => {
    mocks.load.mockRejectedValue(new Error('boom'));
    const { ExportButtons } = await import('../components/ExportButtons');
    render(<CompanyProvider allowedCompanies={[{ id: 'c1', name: 'Acme Co' }]} initialCompanyId="c1"><ExportButtons language="en" document={doc()} /></CompanyProvider>);
    await Promise.resolve();
    fireEvent.click(screen.getByRole('button', { name: 'Print / Save PDF' }));
    expect(document.body.querySelector('.eqfal-print-doc .eqfal-print-brand')).not.toBeNull();
  });
});
