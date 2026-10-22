// Test-only builder for small digital PDFs with real embedded text. Text uses a Type0/Identity-H font whose ToUnicode CMap maps each glyph
// id to its character, so pdf.js extracts Arabic and English text without any font program. Arabic runs are written in visual order, as
// real Arabic PDFs store them.
export type PdfTextItem = { text: string; x: number; y: number };

const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
const isArabic = (s: string) => /[\u0621-\u064a\ufb50-\ufdff\ufe70-\ufeff]/.test(s);

export function buildTextPdf(pages: PdfTextItem[][], options: { encrypted?: boolean } = {}): Buffer {
  const chars = [...new Set(pages.flat().flatMap((item) => [...item.text]))];
  const cid = new Map(chars.map((c, i) => [c, i + 1]));
  // Visual order of an RTL run: the whole string reversed, with embedded LTR runs (digits, Latin) put back in reading order.
  const visual = (s: string) => [...s].reverse().join('').replace(/[0-9A-Za-z](?:[0-9A-Za-z.,:\-+/|# ]*[0-9A-Za-z])?/g, (run) => [...run].reverse().join(''));
  const encode = (s: string) => `<${[...(isArabic(s) ? visual(s) : s)].map((c) => hex4(cid.get(c)!)).join('')}>`;
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Test-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange
${chars.length} beginbfchar
${chars.map((c, i) => `<${hex4(i + 1)}> <${hex4(c.codePointAt(0)!)}>`).join('\n')}
endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;

  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('');
  const descendant = add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 400 >>');
  const toUnicode = add(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
  objects[font - 1] = `<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>`;
  const kids: number[] = [];
  for (const items of pages) {
    const content = items.map((i) => `BT /F1 9 Tf ${i.x} ${i.y} Td ${encode(i.text)} Tj ET`).join('\n');
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const encrypt = options.encrypted ? add(`<< /Filter /Standard /V 1 /R 2 /O <${'AB'.repeat(32)}> /U <${'CD'.repeat(32)}> /P -4 >>`) : null;

  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'utf8');
}
