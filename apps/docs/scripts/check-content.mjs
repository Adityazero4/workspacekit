import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { includeRefusal } from '../lib/includePath.mjs';
import { checkDocumentFences, extractFences, PUBLIC_PACKAGES } from '../../../scripts/agent-docs.mjs';

const CONTENT_FOLDER = path.join('apps', 'docs', 'content', 'docs');
const DOCS_BASE_URL = '/docs';
const RECIPES_URL = `${DOCS_BASE_URL}/recipes/`;
const SITE_ROOT_FILES = new Set(['/llms.txt', '/llms-full.txt']);
const SHELL_LANGUAGES = new Set(['sh', 'bash', 'shell']);
const COMMENTS = /\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g;
const INLINE_CODE = /`[^`\n]*`/g;
const PRE_BLOCK = /<pre[\s>]/;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
const HEADING_LINE = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+)/g;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?\s*$/gm;
const HREF_ATTRIBUTE = /\bhref=(?:"([^"]*)"|'([^']*)')/g;
const EXTERNAL_LINK = /^[a-z][a-z0-9+.-]*:/i;
const INCLUDE_TAG = /<Include\s+file="([^"]+)"/g;
const PART_ATTRIBUTE = /data-fs-part\s*[~|^$*]?=\s*["']?([a-z][a-z0-9-]*)/g;
const CLASS_NAMES_OBJECT = /classNames\s*[=:]\s*\{+([^{}]*)\}/g;
const CLASS_NAMES_REFERENCE = /classNames\s*(?:=\s*\{|:|=)\s*([A-Za-z_$][\w$]*)\s*\}?/g;
const NAMED_OBJECT = (name) =>
  new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*\\{([^{}]*)\\}`, 'g');
const OBJECT_KEY = /["']?([a-z][a-z0-9-]*)["']?\s*:/g;
const PARTS_ARRAY = /export const [A-Z_]*PARTS\b[^=]*?\]\s*=\s*\[([^\]]*)\]/;
const QUOTED_NAME = /'([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g;

/**
 * The packages that define part names.
 *
 * @example
 * PART_PACKAGES.includes('react'); // true
 */
export const PART_PACKAGES = ['react', 'code', 'pdf', 'docx', 'pptx', 'spreadsheet', 'markdown'];

/**
 * The file each recipe page must embed, by page URL. A recipe page that is not listed here fails, so a new
 * recipe cannot skip the rule.
 *
 * @example
 * RECIPE_SOURCES['/docs/recipes/s3']; // ['examples/recipes/src/s3Store.ts']
 */
export const RECIPE_SOURCES = {
  '/docs/recipes/s3': ['examples/recipes/src/s3Store.ts'],
  '/docs/recipes/custom-adapter': ['examples/vite-memory/src/fileSystemAccessAdapter.ts'],
  '/docs/recipes/custom-renderer': ['examples/recipes/src/customRenderer.tsx'],
  '/docs/recipes/theming': ['examples/recipes/src/theming.tsx', 'examples/recipes/src/theming.css'],
  '/docs/recipes/standalone-pdf': ['examples/recipes/src/standalonePdf.tsx'],
  '/docs/recipes/server-route': [
    'examples/next-agent-workspace/app/api/files/[...path]/route.ts',
    'examples/next-agent-workspace/app/page.tsx',
  ],
};

async function* mdxFilesUnder(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) yield* mdxFilesUnder(full);
    else if (entry.isFile() && entry.name.endsWith('.mdx')) yield full;
  }
}

function urlOfPage(root, file) {
  const relative = path.relative(path.join(root, CONTENT_FOLDER), file).split(path.sep).join('/');
  const withoutExtension = relative.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '');
  return withoutExtension === '' ? DOCS_BASE_URL : `${DOCS_BASE_URL}/${withoutExtension}`;
}

/**
 * Reads every documentation page: its file, its label (the path from the repository root), its URL under
 * `/docs` and its text.
 *
 * @example
 * const pages = await readPages(process.cwd());
 * console.log(pages.map((page) => page.url));
 */
export async function readPages(root) {
  const folder = path.join(root, CONTENT_FOLDER);
  if (!existsSync(folder)) return [];
  const pages = [];
  for await (const file of mdxFilesUnder(folder)) {
    pages.push({
      file,
      label: path.relative(root, file),
      url: urlOfPage(root, file),
      text: await readFile(file, 'utf8'),
    });
  }
  return pages.sort((a, b) => (a.label < b.label ? -1 : 1));
}

function withoutFences(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const marker = FENCE_LINE.exec(line)?.[1];
    if (fence === null && marker) fence = marker[0];
    else if (fence !== null && marker && marker[0] === fence) fence = null;
    else if (fence === null) kept.push(line);
  }
  return kept.join('\n');
}

function slugOf(heading) {
  return heading
    .replace(/[`*_]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * The anchors of a page: one slug per heading outside code fences, with `-1`, `-2` after a repeat, as
 * Fumadocs makes them.
 *
 * @example
 * headingSlugs('## Live updates\n\n## Live updates\n'); // Set { 'live-updates', 'live-updates-1' }
 */
export function headingSlugs(text) {
  const slugs = new Set();
  const seen = new Map();
  for (const line of withoutFences(text).split('\n')) {
    const heading = HEADING_LINE.exec(line)?.[1];
    if (heading === undefined) continue;
    const slug = slugOf(heading);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    slugs.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return slugs;
}

function proseOf(text) {
  return withoutFences(text).replace(COMMENTS, '');
}

function linksOf(text) {
  const prose = proseOf(text).replace(INLINE_CODE, '');
  const attributes = [...prose.matchAll(HREF_ATTRIBUTE)].map((match) => match[1] ?? match[2]);
  return [
    ...[...prose.matchAll(MARKDOWN_LINK)].map((match) => match[1]),
    ...[...prose.matchAll(REFERENCE_DEFINITION)].map((match) => match[1]),
    ...attributes,
  ];
}

function brokenLinkIn(page, link, pagesByUrl) {
  if (EXTERNAL_LINK.test(link) && !link.startsWith('/')) return null;
  if (!link.startsWith('/') && !link.startsWith('#')) {
    return `${page.label}: the link ${link} is relative. Use an absolute /docs/... link.`;
  }
  const hashAt = link.indexOf('#');
  const pathname = hashAt === -1 ? link : link.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : decodeURIComponent(link.slice(hashAt + 1));
  const url = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (url === '/' || SITE_ROOT_FILES.has(url)) return null;
  const target = url === '' ? page : pagesByUrl.get(url);
  if (!target) {
    return `${page.label}: the link ${link} does not match any page. Fix the path or add the page.`;
  }
  if (hash !== '' && !headingSlugs(target.text).has(hash)) {
    return `${page.label}: the link ${link} points at a heading that ${target.label} does not have.`;
  }
  return null;
}

/**
 * Returns a problem for every internal link (`/docs/...#heading`, `#heading`, or a site-root file) that does
 * not resolve to a page and, when it has a fragment, a heading on that page. External links are ignored.
 *
 * @example
 * const problems = checkLinks([{ label: 'a.mdx', url: '/docs/a', text: '[b](/docs/b)' }]);
 */
export function checkLinks(pages) {
  const pagesByUrl = new Map(pages.map((page) => [page.url, page]));
  return pages.flatMap((page) =>
    linksOf(page.text)
      .map((link) => brokenLinkIn(page, link, pagesByUrl))
      .filter((problem) => problem !== null),
  );
}

/**
 * Lists the files named by the live `<Include file="...">` tags of a page: tags inside code fences or
 * comments are not live. The site build and `llms-full.txt` read exactly these files.
 *
 * @example
 * includeFilesOf('<Include file="examples/a.ts" />'); // ['examples/a.ts']
 */
export function includeFilesOf(text) {
  return [...proseOf(text).matchAll(INCLUDE_TAG)].map((match) => match[1]);
}

function includeProblem(page, file, root) {
  if (includeRefusal(root, file) === null) return null;
  return `${page.label}: <Include file="${file}" /> must name an existing .ts, .tsx or .css file under examples/ (no dot segments, no symlinks out).`;
}

/**
 * Returns a problem for every live `<Include>` tag, on any page outside the recipes, whose file `Include`
 * would refuse. Recipe pages get the same check from `checkRecipePages`.
 *
 * @example
 * const problems = checkIncludes(pages, process.cwd());
 */
export function checkIncludes(pages, root) {
  return pages
    .filter((page) => !page.url.startsWith(RECIPES_URL))
    .flatMap((page) => includeFilesOf(page.text).map((file) => includeProblem(page, file, root)))
    .filter((problem) => problem !== null);
}

function pastedCodeProblems(page) {
  const fences = extractFences(page.text)
    .filter((fence) => !SHELL_LANGUAGES.has(fence.language))
    .map(
      (fence) =>
        `${page.label}:${fence.line} a recipe page must not paste code. Embed the tested file with <Include file="examples/..." />; only sh, bash and shell fences are allowed.`,
    );
  if (PRE_BLOCK.test(proseOf(page.text))) {
    fences.push(`${page.label}: a recipe page must not paste code in a <pre> block. Use <Include />.`);
  }
  return fences;
}

function recipeProblems(page, root, sources) {
  const includes = includeFilesOf(page.text);
  const problems = pastedCodeProblems(page);
  const expected = sources[page.url];
  if (!expected) {
    problems.push(`${page.label}: ${page.url} is not in RECIPE_SOURCES. Add the file it embeds.`);
  }
  if (includes.length === 0) {
    problems.push(`${page.label}: a recipe page needs an <Include file="examples/..." />.`);
  }
  for (const file of includes) {
    const problem = includeProblem(page, file, root);
    if (problem) problems.push(problem);
  }
  for (const file of expected ?? []) {
    if (!includes.includes(file)) problems.push(`${page.label}: this recipe must embed ${file}.`);
  }
  return problems;
}

/**
 * Returns the problems on recipe pages (the pages under `/docs/recipes/`): any fence other than a shell
 * line, or a raw `pre` block, instead of the `Include` component; an `Include` that is commented out;
 * an `Include` path the component would refuse (not a plain `.ts`, `.tsx` or `.css` file under `examples/`);
 * a page that does not embed the file `RECIPE_SOURCES` maps to it; and a page missing from that map.
 *
 * @example
 * const problems = checkRecipePages(pages, process.cwd(), RECIPE_SOURCES);
 */
export function checkRecipePages(pages, root, sources = RECIPE_SOURCES) {
  return pages
    .filter((page) => page.url.startsWith(RECIPES_URL))
    .flatMap((page) => recipeProblems(page, root, sources));
}

/**
 * Reads every valid part name from the `*PARTS` arrays of the named packages' `src/parts.ts`: the `PARTS` of
 * `@scope/react` and the `*_PARTS` of each renderer package. Throws when a file or its array is missing.
 *
 * @example
 * const parts = await readValidParts(process.cwd(), ['react', 'pdf']);
 * parts.has('tree-row'); // true
 */
export async function readValidParts(root, packages) {
  const parts = new Set();
  for (const name of packages) {
    const label = `packages/${name}/src/parts.ts`;
    const file = path.join(root, label);
    if (!existsSync(file)) throw new Error(`${label} is missing, so part names cannot be checked.`);
    const array = PARTS_ARRAY.exec(await readFile(file, 'utf8'));
    if (!array) throw new Error(`${label} has no exported *PARTS array, so part names cannot be checked.`);
    for (const match of array[1].matchAll(QUOTED_NAME)) parts.add(match[1]);
  }
  return parts;
}

function classNamesKeys(text) {
  const objects = [...text.matchAll(CLASS_NAMES_OBJECT)].map((match) => match[1]);
  const referenced = new Set([...text.matchAll(CLASS_NAMES_REFERENCE)].map((match) => match[1]));
  for (const name of text.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([A-Za-z_$][\w$]*)\s*;/g,
  )) {
    if (referenced.has(name[1])) referenced.add(name[2]);
  }
  for (const name of referenced) {
    objects.push(...[...text.matchAll(NAMED_OBJECT(name))].map((match) => match[1]));
  }
  return objects.flatMap((object) => [...object.matchAll(OBJECT_KEY)].map((key) => key[1]));
}

function mentionedParts(text) {
  return [...[...text.matchAll(PART_ATTRIBUTE)].map((match) => match[1]), ...classNamesKeys(text)];
}

/**
 * Returns a problem for every part name a page mentions, in `data-fs-part="..."` or as a `classNames` key,
 * that is not in `validParts`.
 *
 * @example
 * const problems = checkPartNames(pages, new Set(['tree-row']));
 */
export function checkPartNames(pages, validParts) {
  return pages.flatMap((page) =>
    [...new Set(mentionedParts(page.text))]
      .filter((part) => !validParts.has(part))
      .map(
        (part) =>
          `${page.label}: "${part}" is not a part name. Use a name from PARTS or a renderer package's *_PARTS.`,
      ),
  );
}

/**
 * Returns every way the documentation pages are wrong: a pasted recipe, a TS or TSX fence that does not
 * typecheck against the packages' `dist` (unless its first line is `// not-compiled: <reason>`), a broken
 * internal link, and a part name that does not exist.
 *
 * @example
 * const problems = await checkContent({ root: process.cwd() });
 */
export async function checkContent({
  root,
  packages = PUBLIC_PACKAGES,
  partPackages = PART_PACKAGES,
  recipeSources = RECIPE_SOURCES,
}) {
  const pages = await readPages(root);
  const problems = [];
  let validParts = new Set();
  try {
    validParts = await readValidParts(root, partPackages);
  } catch (error) {
    problems.push(error.message);
  }
  const fenceProblems = await checkDocumentFences({
    root,
    packages,
    documents: pages.map(({ file, label, text }) => ({ file, label, text })),
  });
  return [
    ...problems,
    ...checkRecipePages(pages, root, recipeSources),
    ...checkIncludes(pages, root),
    ...checkLinks(pages),
    ...(validParts.size > 0 ? checkPartNames(pages, validParts) : []),
    ...fenceProblems,
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const problems = await checkContent({ root });
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `check-content: ${problems.length} problem(s). Fix the pages under apps/docs/content/docs.`,
    );
    process.exit(1);
  }
}
