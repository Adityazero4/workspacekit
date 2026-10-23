import { strToU8, zipSync, type Zippable } from 'fflate';

const RELATIONSHIP_TYPES = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  aFChunk: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  fontTable: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable',
  font: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font',
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
} as const;

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');

export interface Relationship {
  id: string;
  type: keyof typeof RELATIONSHIP_TYPES;
  target: string;
  external?: boolean;
}

export interface DocxFixture {
  body: string;
  relationships?: Relationship[];
  parts?: Record<string, string | Uint8Array>;
  partRelationships?: Record<string, Relationship[]>;
}

const xmlAttribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

function relationshipsXml(relationships: Relationship[]): string {
  const entries = relationships.map(
    ({ id, type, target, external }) =>
      `<Relationship Id="${id}" Type="${RELATIONSHIP_TYPES[type]}" Target="${xmlAttribute(target)}"` +
      `${external ? ' TargetMode="External"' : ''}/>`,
  );
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join('')}</Relationships>`
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="htm" ContentType="text/html"/>' +
  '<Override PartName="/word/document.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const LETTER_PAGE =
  '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr>';

/**
 * A `.docx` file built in memory: `body` is the WordprocessingML inside `<w:body>` (a letter-sized section
 * is appended), `relationships` go into `word/_rels/document.xml.rels`, `parts` are extra files by path and
 * `partRelationships` the `.rels` of those parts (such as the font table's).
 */
export function docxBytes(fixture: DocxFixture): Uint8Array {
  const files: Zippable = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(
      relationshipsXml([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' }]),
    ),
    'word/document.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<w:document ${NAMESPACES}><w:body>${fixture.body}${LETTER_PAGE}</w:body></w:document>`,
    ),
    'word/_rels/document.xml.rels': strToU8(relationshipsXml(fixture.relationships ?? [])),
  };
  for (const [path, content] of Object.entries(fixture.parts ?? {})) {
    files[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  for (const [path, relationships] of Object.entries(fixture.partRelationships ?? {})) {
    const slash = path.lastIndexOf('/');
    files[`${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`] = strToU8(
      relationshipsXml(relationships),
    );
  }
  return zipSync(files);
}

/** A paragraph of plain runs. */
export const paragraph = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** An underlined hyperlink run, to a relationship (`r:id`) or a bookmark (`w:anchor`). */
export const hyperlink = (target: { id: string } | { anchor: string }, text: string): string =>
  `<w:p><w:hyperlink ${'id' in target ? `r:id="${target.id}"` : `w:anchor="${target.anchor}"`}>` +
  `<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`;

/** A page break. */
export const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/** A paragraph that starts bookmark `name`. */
export const bookmarkedParagraph = (name: string, text: string): string =>
  `<w:p><w:bookmarkStart w:id="0" w:name="${name}"/><w:r><w:t>${text}</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>`;

/** A `styles.xml` part with one paragraph style whose font name is `fontName` (unescaped by docx-preview). */
export const stylesWithFont = (fontName: string): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<w:styles ${NAMESPACES}><w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/>` +
  `<w:rPr><w:rFonts w:ascii="${xmlAttribute(fontName)}"/></w:rPr></w:style></w:styles>`;

/** A `fontTable.xml` part with one font embedded from relationship `rFont`. */
export const FONT_TABLE: string =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<w:fonts ${NAMESPACES}><w:font w:name="Probe Sans">` +
  '<w:embedRegular r:id="rFont" w:fontKey="{00000000-0000-0000-0000-000000000000}"/></w:font></w:fonts>';

/** An inline picture whose blip is relationship `id`. */
export const picture = (id: string): string =>
  '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Picture"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
  `<pic:nvPicPr><pic:cNvPr id="1" name="Picture"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/>` +
  '</pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></pic:spPr>' +
  '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';

/** A run holding one `w:sym` character of `font`. */
export const symbol = (font: string, hexCode: string): string =>
  `<w:p><w:r><w:sym w:font="${font}" w:char="${hexCode}"/></w:r></w:p>`;

/** The WordprocessingML namespace declarations, for parts other than the document. */
export const WORD_NAMESPACES: string = NAMESPACES;
