import { SaxesParser } from 'saxes';
import { ReaderError, type ReadWork, type ReaderCaps } from '../types';
import type { ZipArchive } from './zip';

type PlainXml = { xmlns: false; fragment: boolean; position: false };

/**
 * Callbacks for one streamed XML part. Element names arrive without their namespace prefix (`x:row` is
 * `row`). `isDone` lets a reader stop the stream once it has what it needs.
 *
 * @example
 * ```ts
 * const handlers: XmlHandlers = { open: (name) => void names.push(name) };
 * ```
 */
export interface XmlHandlers {
  open?: (name: string, attributes: Record<string, string>) => void;
  close?: (name: string) => void;
  text?: (text: string) => void;
  isDone?: () => boolean;
}

/**
 * The name without its namespace prefix: `x:row` is `row`.
 *
 * @example
 * ```ts
 * localName('r:id'); // 'id'
 * ```
 */
export function localName(name: string): string {
  return name.slice(name.indexOf(':') + 1);
}

/**
 * An attribute by its local name, whatever its prefix (`r:id` and `id` both answer `id`).
 *
 * @example
 * ```ts
 * attribute({ 'r:id': 'rId1' }, 'id'); // 'rId1'
 * ```
 */
export function attribute(attributes: Record<string, string>, name: string): string | undefined {
  if (Object.hasOwn(attributes, name)) return attributes[name];
  for (const key in attributes) if (localName(key) === name) return attributes[key];
  return undefined;
}

const tooMuchXml = (): ReaderError =>
  new ReaderError(
    'too_large',
    'This workbook nests its XML too deeply, or has too many or too large XML elements, to preview.',
  );

const MOST_XML_NODE_CHARACTERS = 1024 * 1024;

interface SaxesBuffers {
  text: string;
  name: string;
  piTarget: string;
  entity: string;
  attribList: { name: string; value: string }[];
}

function bufferedCharacters(parser: SaxesParser<PlainXml>): number {
  const buffers = parser as unknown as SaxesBuffers;
  let size = buffers.text.length + buffers.name.length + buffers.piTarget.length + buffers.entity.length;
  for (const pending of buffers.attribList) size += pending.name.length + pending.value.length;
  return size;
}

function refuseHugeNodes(parser: SaxesParser<PlainXml>): void {
  const write = parser.write.bind(parser);
  parser.write = (chunk) => {
    write(chunk);
    if (bufferedCharacters(parser) > MOST_XML_NODE_CHARACTERS) throw tooMuchXml();
    return parser;
  };
}

/**
 * A SAX parser wired to `handlers`. It refuses a `<!DOCTYPE`, so no entity can expand, counts every
 * element into `work.xmlElements`, and turns malformed XML into a `load_error`. Nesting deeper than
 * `caps.maxXmlDepth`, or more than `caps.maxXmlElements` elements for the workbook, is `too_large`, so
 * the parser's own stack and the work stay bounded. So is a single node (text, name, comment, attributes)
 * the parser has buffered past 1 Mi characters after a write, as saxes holds a whole node before handing
 * it on; Excel's own cell text is at most 32,767 characters, a few times that once escaped.
 *
 * @example
 * ```ts
 * const parser = xmlParser({ open: (name) => names.push(name) }, work, DEFAULT_CAPS);
 * parser.write('<a><b/></a>').close();
 * ```
 */
export function xmlParser(
  handlers: XmlHandlers,
  work: ReadWork,
  caps: ReaderCaps,
  options: { fragment?: boolean } = {},
): SaxesParser<PlainXml> {
  let depth = 0;
  const parser = new SaxesParser<PlainXml>({
    xmlns: false,
    fragment: options.fragment ?? false,
    position: false,
  });
  parser.on('doctype', () => {
    throw new ReaderError(
      'load_error',
      'This workbook has a DOCTYPE in its XML, which is refused for safety.',
    );
  });
  parser.on('opentag', (tag) => {
    depth++;
    if (++work.xmlElements > caps.maxXmlElements || depth > caps.maxXmlDepth) throw tooMuchXml();
    handlers.open?.(localName(tag.name), tag.attributes);
    if (tag.isSelfClosing) handlers.close?.(localName(tag.name));
  });
  parser.on('closetag', (tag) => {
    depth--;
    if (!tag.isSelfClosing) handlers.close?.(localName(tag.name));
  });
  if (handlers.text) {
    parser.on('text', handlers.text);
    parser.on('cdata', handlers.text);
  }
  refuseHugeNodes(parser);
  return parser;
}

const STOP_READING = new Error('The reader has what it needs from this part.');

const asReaderError = (error: unknown): ReaderError =>
  error instanceof ReaderError
    ? error
    : new ReaderError(
        'load_error',
        `This workbook could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );

/**
 * Streams one part of the archive through a SAX parser into `handlers`, stopping early once
 * `handlers.isDone()` is true. A missing optional part is skipped when `isOptional` is set.
 *
 * @example
 * ```ts
 * readXmlPart(archive, 'xl/workbook.xml', { open: onOpen }, work, DEFAULT_CAPS);
 * ```
 */
export function readXmlPart(
  archive: ZipArchive,
  path: string,
  handlers: XmlHandlers,
  work: ReadWork,
  caps: ReaderCaps,
  isOptional = false,
): void {
  if (isOptional && !archive.names.has(path)) return;
  const stopsOnceDone: XmlHandlers = {
    ...handlers,
    open: (name, attributes) => {
      if (handlers.isDone?.()) throw STOP_READING;
      handlers.open?.(name, attributes);
    },
  };
  const parser = xmlParser(stopsOnceDone, work, caps);
  try {
    archive.streamText(path, (text) => {
      parser.write(text);
      return !handlers.isDone?.();
    });
    if (!handlers.isDone?.()) parser.close();
  } catch (error) {
    if (error !== STOP_READING) throw asReaderError(error);
  }
}
