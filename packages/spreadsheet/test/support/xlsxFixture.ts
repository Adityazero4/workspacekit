import { strToU8, zipSync } from 'fflate';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';

export interface FixtureSheet {
  name: string;
  body: string;
  state?: 'hidden';
}

export interface FixtureWorkbook {
  sheets: FixtureSheet[];
  sharedStrings?: string[] | string;
  styles?: string;
  theme?: string;
  date1904?: boolean;
  parts?: Record<string, string | Uint8Array>;
}

const escapeXml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export const worksheet = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}" xmlns:r="${RELS}">${body}</worksheet>`;

export const sheetData = (rows: string[][]): string =>
  `<sheetData>${rows
    .map((cells, row) => `<row r="${row + 1}">${cells.join('')}</row>`)
    .join('')}</sheetData>`;

export const numberCell = (reference: string, value: number, style = 0): string =>
  `<c r="${reference}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;
export const inlineCell = (reference: string, text: string): string =>
  `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
export const formulaCell = (reference: string, formula: string, cached?: number): string =>
  `<c r="${reference}"><f>${escapeXml(formula)}</f>${cached === undefined ? '' : `<v>${cached}</v>`}</c>`;

function sharedStringsPart(strings: string[] | string): string {
  if (typeof strings === 'string') return strings;
  const items = strings.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join('');
  return `<?xml version="1.0"?><sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
}

function workbookParts(workbook: FixtureWorkbook): Record<string, string> {
  const sheets = workbook.sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="rId${index + 1}"/>`,
    )
    .join('');
  const sheetRelationships = workbook.sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="${RELS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('');
  const extra = [
    workbook.sharedStrings &&
      `<Relationship Id="rS" Type="${RELS}/sharedStrings" Target="sharedStrings.xml"/>`,
    workbook.styles && `<Relationship Id="rT" Type="${RELS}/styles" Target="styles.xml"/>`,
    workbook.theme && `<Relationship Id="rH" Type="${RELS}/theme" Target="theme/theme1.xml"/>`,
  ].join('');
  return {
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${MAIN}" xmlns:r="${RELS}">${workbook.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_RELS}">${sheetRelationships}${extra}</Relationships>`,
  };
}

export function xlsxBytes(workbook: FixtureWorkbook): Uint8Array {
  const parts: Record<string, string | Uint8Array> = workbookParts(workbook);
  workbook.sheets.forEach((sheet, index) => {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = worksheet(sheet.body);
  });
  if (workbook.sharedStrings) parts['xl/sharedStrings.xml'] = sharedStringsPart(workbook.sharedStrings);
  if (workbook.styles) parts['xl/styles.xml'] = workbook.styles;
  if (workbook.theme) parts['xl/theme/theme1.xml'] = workbook.theme;
  Object.assign(parts, workbook.parts);
  return zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([path, body]) => [path, typeof body === 'string' ? strToU8(body) : body]),
    ),
  );
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;

export function withDeclaredSize(zip: Uint8Array, entryName: string, declaredSize: number): Uint8Array {
  const patched = zip.slice();
  const view = new DataView(patched.buffer);
  let end = patched.byteLength - 22;
  while (view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) end--;
  const count = view.getUint16(end + 10, true);
  for (let index = 0, offset = view.getUint32(end + 16, true); index < count; index++) {
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(patched.subarray(offset + 46, offset + 46 + nameLength));
    if (view.getUint32(offset, true) === CENTRAL_DIRECTORY_ENTRY && name === entryName) {
      view.setUint32(offset + 24, declaredSize, true);
    }
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return patched;
}
