import { strToU8, Zip, ZipDeflate, zipSync, zlibSync, type Zippable } from 'fflate';

const RELATIONSHIP_TYPE_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const NAMESPACES =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const GROUP_HEADER =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
const EMU_PER_PX = 9525;

export interface Relationship {
  id: string;
  type:
    | 'slide'
    | 'slideLayout'
    | 'slideMaster'
    | 'theme'
    | 'image'
    | 'hyperlink'
    | 'video'
    | 'media'
    | 'chart'
    | 'font';
  target: string;
  external?: boolean;
}

export interface SlideFixture {
  shapes?: string;
  background?: string;
  relationships?: Relationship[];
}

export interface PptxFixture {
  slides: SlideFixture[];
  master?: SlideFixture;
  media?: Record<string, Uint8Array>;
  widthPx?: number;
  heightPx?: number;
  extraParts?: Record<string, string>;
  extraBinaryParts?: Record<string, Uint8Array>;
  presentationChildren?: string;
  presentationRelationships?: Relationship[];
}

const xmlAttribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export function relationshipsXml(relationships: Relationship[]): string {
  const entries = relationships.map(
    ({ id, type, target, external }) =>
      `<Relationship Id="${id}" Type="${RELATIONSHIP_TYPE_BASE}${type}" Target="${xmlAttribute(target)}"` +
      `${external ? ' TargetMode="External"' : ''}/>`,
  );
  return (
    XML_DECLARATION +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join('')}</Relationships>`
  );
}

const box = (xPx: number, yPx: number, widthPx: number, heightPx: number): string =>
  `<a:xfrm><a:off x="${xPx * EMU_PER_PX}" y="${yPx * EMU_PER_PX}"/>` +
  `<a:ext cx="${widthPx * EMU_PER_PX}" cy="${heightPx * EMU_PER_PX}"/></a:xfrm>`;

let shapeIds = 10;

export function textShape(text: string, options: { link?: string; y?: number } = {}): string {
  const run = options.link
    ? `<a:r><a:rPr lang="en-US"><a:hlinkClick r:id="${options.link}"/></a:rPr><a:t>${text}</a:t></a:r>`
    : `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${shapeIds++}" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${box(48, options.y ?? 48, 600, 60)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p>${run}</a:p></p:txBody></p:sp>`
  );
}

export function picture(blip: string, options: { nvPr?: string } = {}): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${shapeIds++}" name="Picture"/><p:cNvPicPr/>` +
    `<p:nvPr>${options.nvPr ?? ''}</p:nvPr></p:nvPicPr>` +
    `<p:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${box(100, 150, 200, 120)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

export function shapeFilledWith(blip: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${shapeIds++}" name="Filled"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${box(400, 150, 200, 120)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr></p:sp>`
  );
}

const CHART_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

export function chartFrame(relationshipId: string): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${shapeIds++}" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/>` +
    `</p:nvGraphicFramePr><p:xfrm><a:off x="${100 * EMU_PER_PX}" y="${150 * EMU_PER_PX}"/>` +
    `<a:ext cx="${400 * EMU_PER_PX}" cy="${250 * EMU_PER_PX}"/></p:xfrm><a:graphic>` +
    `<a:graphicData uri="${CHART_NAMESPACE}"><c:chart xmlns:c="${CHART_NAMESPACE}" r:id="${relationshipId}"/>` +
    '</a:graphicData></a:graphic></p:graphicFrame>'
  );
}

const literalPoints = (values: string[]): string =>
  `<c:ptCount val="${values.length}"/>` +
  values.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('');

export const BAR_CHART: string =
  `${XML_DECLARATION}<c:chartSpace xmlns:c="${CHART_NAMESPACE}" ${NAMESPACES}><c:chart><c:plotArea><c:layout/>` +
  '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/>' +
  `<c:tx><c:v>Sales</c:v></c:tx><c:cat><c:strLit>${literalPoints(['North', 'South'])}</c:strLit></c:cat>` +
  `<c:val><c:numLit>${literalPoints(['3', '5'])}</c:numLit></c:val></c:ser>` +
  '<c:axId val="1"/><c:axId val="2"/></c:barChart></c:plotArea></c:chart></c:chartSpace>';

export const imageBackground = (blip: string): string =>
  `<p:bg><p:bgPr><a:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;

const slideXml = (root: 'sld' | 'sldLayout' | 'sldMaster', slide: SlideFixture, tail = ''): string =>
  `${XML_DECLARATION}<p:${root} ${NAMESPACES}><p:cSld>${slide.background ?? ''}` +
  `<p:spTree>${GROUP_HEADER}${slide.shapes ?? ''}</p:spTree></p:cSld>${tail}</p:${root}>`;

const COLOR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

const colorScheme = (): string => {
  const colors: Record<string, string> = {
    dk1: '000000',
    lt1: 'FFFFFF',
    dk2: '1F1F1F',
    lt2: 'EEEEEE',
    accent1: '1F4E79',
    accent2: 'C55A11',
    accent3: '7F7F7F',
    accent4: 'BF9000',
    accent5: '2E75B6',
    accent6: '548235',
    hlink: '0563C1',
    folHlink: '954F72',
  };
  const entries = Object.entries(colors).map(
    ([name, value]) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`,
  );
  return `<a:clrScheme name="Fixture">${entries.join('')}</a:clrScheme>`;
};

const THEME =
  `${XML_DECLARATION}<a:theme ${NAMESPACES} name="Fixture"><a:themeElements>${colorScheme()}` +
  '<a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Arial"/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Fixture"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme>' +
  '</a:themeElements></a:theme>';

function presentationXml(slideCount: number, widthPx: number, heightPx: number, children = ''): string {
  const slideIds = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rIdS${index + 1}"/>`,
  );
  return (
    `${XML_DECLARATION}<p:presentation ${NAMESPACES}>` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${slideIds.join('')}</p:sldIdLst>` +
    `<p:sldSz cx="${widthPx * EMU_PER_PX}" cy="${heightPx * EMU_PER_PX}"/>${children}</p:presentation>`
  );
}

const CONTENT_TYPES =
  `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/></Types>';

/**
 * A minimal `.pptx`: a theme, one master and one layout, and `slides`, each with its own shapes, background and
 * relationships (the layout relationship is added). `media` files go under `ppt/media/`.
 */
export function pptxFiles(fixture: PptxFixture): Zippable {
  const { slides, master = {}, media = {}, widthPx = 960, heightPx = 540 } = fixture;
  const files: Zippable = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    'ppt/presentation.xml': strToU8(
      presentationXml(slides.length, widthPx, heightPx, fixture.presentationChildren),
    ),
    'ppt/_rels/presentation.xml.rels': strToU8(
      relationshipsXml([
        { id: 'rIdM', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
        { id: 'rIdT', type: 'theme', target: 'theme/theme1.xml' },
        ...(fixture.presentationRelationships ?? []),
        ...slides.map((_, index): Relationship => ({
          id: `rIdS${index + 1}`,
          type: 'slide',
          target: `slides/slide${index + 1}.xml`,
        })),
      ]),
    ),
    'ppt/theme/theme1.xml': strToU8(THEME),
    'ppt/slideMasters/slideMaster1.xml': strToU8(
      slideXml(
        'sldMaster',
        master,
        `${COLOR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdL"/></p:sldLayoutIdLst>`,
      ),
    ),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(
      relationshipsXml([
        { id: 'rIdL', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rIdT', type: 'theme', target: '../theme/theme1.xml' },
        ...(master.relationships ?? []),
      ]),
    ),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(slideXml('sldLayout', {})),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(
      relationshipsXml([{ id: 'rIdM', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]),
    ),
  };
  slides.forEach((slide, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(slideXml('sld', slide));
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(
      relationshipsXml([
        { id: 'rIdLayout', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
        ...(slide.relationships ?? []),
      ]),
    );
  });
  for (const [name, bytes] of Object.entries(media)) files[`ppt/media/${name}`] = bytes;
  for (const [name, text] of Object.entries(fixture.extraParts ?? {})) files[name] = strToU8(text);
  Object.assign(files, fixture.extraBinaryParts);
  return files;
}

export const pptxBytes = (fixture: PptxFixture): Uint8Array => zipSync(pptxFiles(fixture));

export const textSlides = (count: number): SlideFixture[] =>
  Array.from({ length: count }, (_, index) => ({ shapes: textShape(`Slide text ${index + 1}`) }));

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const CENTRAL_DIRECTORY_UNCOMPRESSED_SIZE = 24;

/**
 * Rewrites the uncompressed size the central directory record of `name` declares to `declaredSize`, so the
 * archive says that file is small while it inflates to its real size.
 */
export function withDeclaredSize(archive: Uint8Array, name: string, declaredSize: number): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 46 <= archive.length; offset++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) continue;
    const nameLength = view.getUint16(offset + 28, true);
    if (decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength)) === name) {
      view.setUint32(offset + CENTRAL_DIRECTORY_UNCOMPRESSED_SIZE, declaredSize, true);
    }
  }
  return archive;
}

const MEBIBYTE = 1024 * 1024;

/**
 * A valid `.pptx` (a one-slide deck) plus `ppt/media/bomb.bin`: `inflatedMebibytes` MiB of zeros, deflated
 * while streaming so the test never holds the inflated bytes. The archive is a few hundred KiB.
 */
export function inflationBomb(inflatedMebibytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, bytes] of Object.entries(pptxFiles({ slides: textSlides(1) }))) {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(bytes as Uint8Array, true);
  }
  const bomb = new ZipDeflate('ppt/media/bomb.bin', { level: 9 });
  zip.add(bomb);
  const zeros = new Uint8Array(MEBIBYTE);
  for (let written = 0; written < inflatedMebibytes; written++) {
    bomb.push(zeros, written === inflatedMebibytes - 1);
  }
  zip.end();
  const archive = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
}

/** A chart's graphic frame (see `chartFrame`) drawn `widthPx` by `heightPx`. */
export const chartFrameSized = (relationshipId: string, widthPx: number, heightPx: number): string =>
  chartFrame(relationshipId).replace(
    /<a:ext cx="\d+" cy="\d+"\/>/,
    `<a:ext cx="${widthPx * EMU_PER_PX}" cy="${heightPx * EMU_PER_PX}"/>`,
  );

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
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

const concatenated = (parts: Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

/** A valid black-and-white PNG of `width` × `height` pixels, a few KiB however large it is. */
export function pngOfSize(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 1;
  const rows = zlibSync(new Uint8Array((1 + Math.ceil(width / 8)) * height), { level: 9 });
  return concatenated([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', header),
    pngChunk('IDAT', rows),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

/** `font` (a TrueType font) wrapped as an uncompressed Embedded OpenType file, as PowerPoint embeds fonts. */
export function embeddedOpenType(font: Uint8Array): Uint8Array {
  const headerBytes = 96;
  const eot = new Uint8Array(headerBytes + font.length);
  const view = new DataView(eot.buffer);
  view.setUint32(0, eot.length, true);
  view.setUint32(4, font.length, true);
  view.setUint32(8, 0x00010000, true);
  view.setUint16(34, 0x504c, true);
  eot.set(font, headerBytes);
  return eot;
}
