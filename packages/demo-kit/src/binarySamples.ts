import { strToU8, zipSync, zlibSync } from 'fflate';

const FIXED_ARCHIVE_TIME = Date.UTC(2024, 0, 1);

const SPREADSHEET_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SALES_ROWS: Array<[region: string, firstQuarter: number, secondQuarter: number]> = [
  ['North', 120, 135],
  ['South', 98, 110],
  ['East', 143, 151],
];

const escapeXml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const textCell = (reference: string, text: string): string =>
  `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
const numberCell = (reference: string, value: number): string => `<c r="${reference}"><v>${value}</v></c>`;
const sumCell = (reference: string, range: string, total: number): string =>
  `<c r="${reference}"><f>SUM(${range})</f><v>${total}</v></c>`;

function salesSheetRows(): string[][] {
  const header = [textCell('A1', 'Region'), textCell('B1', 'Q1'), textCell('C1', 'Q2')];
  const regions = SALES_ROWS.map(([region, firstQuarter, secondQuarter], index) => [
    textCell(`A${index + 2}`, region),
    numberCell(`B${index + 2}`, firstQuarter),
    numberCell(`C${index + 2}`, secondQuarter),
  ]);
  const lastRow = SALES_ROWS.length + 1;
  const totalRow = lastRow + 1;
  const total = (column: 1 | 2): number => SALES_ROWS.reduce((sum, row) => sum + row[column], 0);
  const totals = [
    textCell(`A${totalRow}`, 'Total'),
    sumCell(`B${totalRow}`, `B2:B${lastRow}`, total(1)),
    sumCell(`C${totalRow}`, `C2:C${lastRow}`, total(2)),
  ];
  return [header, ...regions, totals];
}

const spreadsheetParts = (): Record<string, string> => ({
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${SPREADSHEET_MAIN}" xmlns:r="${OFFICE_RELATIONSHIPS}"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SPREADSHEET_MAIN}"><sheetData>${salesSheetRows()
    .map((cells, index) => `<row r="${index + 1}">${cells.join('')}</row>`)
    .join('')}</sheetData></worksheet>`,
});

/**
 * A small one-sheet quarterly sales workbook, built in code so no binary file is committed. The same bytes
 * come out on every call.
 *
 * @example
 * ```ts
 * const files = { 'data/sales.xlsx': salesWorkbook() };
 * ```
 */
export function salesWorkbook(): Uint8Array {
  const entries = Object.entries(spreadsheetParts()).map(([path, xml]) => [path, strToU8(xml)] as const);
  return zipSync(Object.fromEntries(entries), { mtime: FIXED_ARCHIVE_TIME });
}

const PDF_PAGE_TEXT = 'Hello from the demo kit';

function pdfObjects(): string[] {
  const content = `BT /F1 24 Tf 72 700 Td (${PDF_PAGE_TEXT}) Tj ET`;
  return [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
}

/**
 * A one-page PDF with a line of Helvetica text, written as a string so the byte offsets in its
 * cross-reference table are exact.
 *
 * @example
 * ```ts
 * const files = { 'docs/welcome.pdf': welcomeDocument() };
 * ```
 */
export function welcomeDocument(): Uint8Array {
  const objects = pdfObjects();
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`;
  return strToU8(body + trailer);
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GRADIENT_SIZE = 16;
const BITS_PER_CHANNEL = 8;
const RGB_COLOR_TYPE = 2;
const SCANLINE_FILTER_NONE = 0;

const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let remainder = byte;
  for (let bit = 0; bit < 8; bit++) {
    remainder = remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
  }
  return remainder >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(strToU8(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function gradientScanlines(): Uint8Array {
  const rowLength = 1 + GRADIENT_SIZE * 3;
  const scanlines = new Uint8Array(rowLength * GRADIENT_SIZE);
  for (let row = 0; row < GRADIENT_SIZE; row++) {
    scanlines[row * rowLength] = SCANLINE_FILTER_NONE;
    for (let column = 0; column < GRADIENT_SIZE; column++) {
      const pixel = row * rowLength + 1 + column * 3;
      scanlines.set([column * 16, row * 16, 160], pixel);
    }
  }
  return scanlines;
}

/**
 * A 16 by 16 colour gradient PNG, encoded in code. Compression is deterministic, so every call returns the
 * same bytes.
 *
 * @example
 * ```ts
 * const files = { 'assets/gradient.png': gradientImage() };
 * ```
 */
export function gradientImage(): Uint8Array {
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, GRADIENT_SIZE);
  headerView.setUint32(4, GRADIENT_SIZE);
  header.set([BITS_PER_CHANNEL, RGB_COLOR_TYPE, 0, 0, 0], 8);
  const chunks = [
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlibSync(gradientScanlines())),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.length;
  }
  return png;
}
