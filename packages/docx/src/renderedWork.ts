import { DOCX_LIMITS, refuseOver } from './limits';

interface ModelNode {
  type?: string;
  children?: ModelNode[];
  id?: string;
  src?: string;
  imageHref?: { id?: string };
  break?: string;
  sectionProps?: unknown;
  pageBreakBefore?: boolean;
  styleName?: string;
}

interface ModelPart {
  path?: string;
  rels?: { id: string; target: string }[] | null;
  body?: ModelNode;
  rootElement?: ModelNode;
  notes?: ModelNode[];
}

/**
 * The parts of docx-preview's parsed document that `assertRenderWithinLimits` counts.
 *
 * @example
 * ```ts
 * const parsed = (await parseAsync(archive)) as ParsedDocx;
 * ```
 */
export interface ParsedDocx {
  rels?: unknown[] | null;
  parts: ModelPart[];
  documentPart?: ModelPart;
  footnotesPart?: ModelPart;
  endnotesPart?: ModelPart;
  numberingPart?: ModelPart & { domNumberings?: { bullet?: { src?: string } }[] };
  stylesPart?: { styles?: { id?: string; paragraphProps?: { pageBreakBefore?: boolean } }[] };
}

interface Work {
  elements: number;
  lookups: number;
  imageBytes: number;
  pageBreaks: number;
  noteReferences: Map<string, number>;
}

interface Counting {
  fileSizes: Map<string, number>;
  pageBreakingStyles: Set<string | undefined>;
  limits: typeof DOCX_LIMITS;
}

const RELATIONSHIP_LOOKUPS: ReadonlySet<string> = new Set(['hyperlink', 'image', 'vmlElement', 'altChunk']);
const NOTE_REFERENCES: ReadonlySet<string> = new Set(['footnoteReference', 'endnoteReference']);
const PART_BASE = 'http://docx/';
const BASE64_GROWTH = 4 / 3;

function partPathOf(target: string, folder: string): string {
  try {
    return decodeURIComponent(new URL(target, PART_BASE + folder).pathname.slice(1));
  } catch {
    return folder + target;
  }
}

function sizeOfRelatedFile(
  part: ModelPart | undefined,
  fileSizes: Map<string, number>,
): (id?: string) => number {
  const folder = part?.path?.slice(0, part.path.lastIndexOf('/') + 1) ?? '';
  const sizes = new Map<string, number>();
  for (const { id, target } of part?.rels ?? []) {
    sizes.set(id, Math.max(sizes.get(id) ?? 0, fileSizes.get(partPathOf(target, folder)) ?? 0));
  }
  return (id) => (id === undefined ? 0 : (sizes.get(id) ?? 0));
}

function startsPage(node: ModelNode, counting: Counting): boolean {
  if (node.type === 'break') return node.break === 'page';
  if (node.type !== 'paragraph') return false;
  return Boolean(
    node.sectionProps || node.pageBreakBefore || counting.pageBreakingStyles.has(node.styleName),
  );
}

function countNode(work: Work, node: ModelNode, sizeOf: (id?: string) => number, counting: Counting): void {
  work.elements++;
  if (node.type && RELATIONSHIP_LOOKUPS.has(node.type)) work.lookups++;
  if (node.type === 'image') work.imageBytes += sizeOf(node.src);
  if (node.type === 'vmlElement') work.imageBytes += sizeOf(node.imageHref?.id);
  if (node.type && NOTE_REFERENCES.has(node.type)) {
    const key = `${node.type} ${node.id}`;
    work.noteReferences.set(key, (work.noteReferences.get(key) ?? 0) + 1);
  }
  if (startsPage(node, counting)) work.pageBreaks++;
}

function workOf(roots: (ModelNode | undefined)[], part: ModelPart | undefined, counting: Counting): Work {
  const work: Work = { elements: 0, lookups: 0, imageBytes: 0, pageBreaks: 0, noteReferences: new Map() };
  const sizeOf = sizeOfRelatedFile(part, counting.fileSizes);
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    countNode(work, node, sizeOf, counting);
    if (!Array.isArray(node.children)) continue;
    refuseOver(counting.limits.elements, work.elements + pending.length + node.children.length, 'elements');
    for (const child of node.children) pending.push(child);
  }
  return work;
}

function addTimes(total: Work, work: Work, times: number): void {
  total.elements += work.elements * times;
  total.lookups += work.lookups * times;
  total.imageBytes += work.imageBytes * times;
}

function addReferencesTimes(total: Work, work: Work, times: number): void {
  for (const [key, count] of work.noteReferences) {
    total.noteReferences.set(key, (total.noteReferences.get(key) ?? 0) + count * times);
  }
}

function notesByReference(parsed: ParsedDocx, counting: Counting): Map<string, Work> {
  const notes = new Map<string, Work>();
  for (const [kind, part] of [
    ['footnoteReference', parsed.footnotesPart],
    ['endnoteReference', parsed.endnotesPart],
  ] as const) {
    for (const note of part?.notes ?? []) notes.set(`${kind} ${note.id}`, workOf([note], part, counting));
  }
  return notes;
}

function bulletImageBytes(parsed: ParsedDocx, counting: Counting): number {
  const sizeOf = sizeOfRelatedFile(parsed.numberingPart, counting.fileSizes);
  return (parsed.numberingPart?.domNumberings ?? []).reduce(
    (total, { bullet }) => total + sizeOf(bullet?.src),
    0,
  );
}

function renderedWorkOf(parsed: ParsedDocx, counting: Counting): Work {
  const body = workOf([parsed.documentPart?.body], parsed.documentPart, counting);
  const pages = body.pageBreaks + 1;
  const rendered: Work = { ...body, noteReferences: new Map(body.noteReferences) };
  for (const part of parsed.parts) {
    if (!part.rootElement) continue;
    const headerOrFooter = workOf([part.rootElement], part, counting);
    addTimes(rendered, headerOrFooter, pages);
    addReferencesTimes(rendered, headerOrFooter, pages);
  }
  const notes = notesByReference(parsed, counting);
  for (const [key, references] of rendered.noteReferences) {
    const note = notes.get(key);
    if (note) addTimes(rendered, note, references);
  }
  rendered.imageBytes += bulletImageBytes(parsed, counting);
  return rendered;
}

/**
 * Counts the work rendering a parsed document would do, before it is rendered, and throws
 * `DocumentLimitExceeded` when it is over `limits`: relationships; elements, with each header and footer
 * counted once per page (page breaks, section breaks and page-breaking paragraphs, plus one) and each
 * footnote and endnote once per reference; relationship lookups; and image bytes as `data:` URLs, once per
 * place each image is shown, using `fileSizes` from `repackWithinLimits`. The model is walked without
 * recursion and the walk itself stops at the element limit.
 *
 * @example
 * ```ts
 * const { archive, fileSizes } = repackWithinLimits(bytes);
 * assertRenderWithinLimits((await parseAsync(archive)) as ParsedDocx, fileSizes);
 * ```
 */
export function assertRenderWithinLimits(
  parsed: ParsedDocx,
  fileSizes: Map<string, number>,
  limits: typeof DOCX_LIMITS = DOCX_LIMITS,
): void {
  const relationships = [parsed, ...parsed.parts].reduce(
    (total, part) => total + (part.rels?.length ?? 0),
    0,
  );
  refuseOver(limits.relationships, relationships, 'relationships');
  const pageBreakingStyles = new Set(
    parsed.stylesPart?.styles
      ?.filter((style) => style.paragraphProps?.pageBreakBefore)
      .map((style) => style.id),
  );
  const rendered = renderedWorkOf(parsed, { fileSizes, pageBreakingStyles, limits });
  refuseOver(limits.elements, rendered.elements, 'rendered elements');
  refuseOver(limits.relationshipLookups, rendered.lookups * relationships, 'relationship lookups');
  refuseOver(limits.imageUrlBytes, rendered.imageBytes * BASE64_GROWTH, 'bytes of images');
}
