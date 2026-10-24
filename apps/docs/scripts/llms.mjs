import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_PACKAGES, readDocsUrl } from '../../../scripts/agent-docs.mjs';
import { resolveIncludePath } from '../lib/includePath.mjs';
import { includeFilesOf, readPages } from './check-content.mjs';

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;
const SUMMARY_LINE = /^> (.+)$/m;
const QUICK_START_URLS = ['/docs/getting-started/next', '/docs/getting-started/vite'];
const CODING_AGENTS_URL = '/docs/coding-agents';
const RECIPES_URL = '/docs/recipes/';
const API_FOLDER = path.join('apps', 'docs', 'content', 'api');
const CORE_API_PAGE = path.join(API_FOLDER, 'core.md');
const ADAPTER_CONTRACT_TYPES = [
  'FileSystemAdapter',
  'Entry',
  'EntryKind',
  'CallOptions',
  'TransferOptions',
  'ChangeEvent',
  'FsError',
  'FsErrorKind',
];
const HELPER_SOURCES = ['path.ts', 'errors.ts'];
const EXPORTED_FUNCTION = /^export function (\w+)/gm;
const CONTRACT_PREFACE = `Conventions every adapter follows:

- \`list(path, { depth, signal })\` returns the descendants of \`path\` down to \`depth\` levels below it as one flat array with full paths from the root. \`depth: 1\` is the direct children. \`path\` itself is not included, and a missing folder throws \`not_found\`.
- Return a \`kind: 'directory'\` entry for every folder in the window. An empty folder is a directory entry with nothing listed under it; there is no placeholder file. \`meta: { incomplete: true }\` means the children are unknown, not empty.
- A file's \`size\` is its byte length; a directory has \`size: null\` or none. \`mtimeMs\` is the version and must change when the content changes; for a directory it is optional (a missing value sorts as 0).
- The UI calls \`create(path, 'file')\` for a new empty file, then \`write\` for edits and autosave. \`write\` must also create a missing file. \`create\` on an existing path throws \`conflict\`.
- Optional methods switch the UI on: \`create\` (New file, New folder), \`write\` (editing; without it the editors are read-only), \`move\` (rename, drag), \`copy\` (copy, paste, duplicate), \`delete\`, \`search\` (search box), \`upload\`, \`download\`, \`url\` (media and PDF streaming), \`stat\`, and \`watch\` (live updates; without it the workspace polls).`;
const SAME_PAGE_LINK = /\[(`[^`]+`)\]\(#[^)]*\)/g;

/**
 * Splits a page into its front matter fields (`title`, `description`) and its body.
 *
 * @example
 * const { title, body } = frontMatterOf('---\ntitle: S3 store\n---\n\nText.\n');
 * console.log(title); // S3 store
 */
export function frontMatterOf(text) {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { title: '', description: '', body: text };
  const fields = Object.fromEntries(
    match[1]
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
  );
  return {
    title: fields.title ?? '',
    description: fields.description ?? '',
    body: text.slice(match[0].length),
  };
}

async function describePackage(root, folderName) {
  const folder = path.join(root, 'packages', folderName);
  const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
  const llms = await readFile(path.join(folder, 'llms.txt'), 'utf8');
  return { folderName, name: manifest.name, summary: SUMMARY_LINE.exec(llms)?.[1] ?? '' };
}

function pageLine(docsUrl, page, label = '') {
  const { title, description } = frontMatterOf(page.text);
  return `- [${label}${title}](${docsUrl}${page.url})${description ? `: ${description}` : ''}`;
}

function renderLlmsTxt(docsUrl, pages, packages) {
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const lines = [
    '# workspacekit',
    '',
    '> workspacekit is an open-source (Apache-2.0) React library that gives an app a file tree, search, tabs, upload and viewers over a directory on a server, with live updates when an agent changes files.',
    '',
  ];
  lines.push('## Start here', '');
  for (const url of QUICK_START_URLS) lines.push(pageLine(docsUrl, byUrl.get(url), 'Quick start: '));
  lines.push(pageLine(docsUrl, byUrl.get(CODING_AGENTS_URL)));
  lines.push('', '## Packages', '');
  for (const { folderName, name, summary } of packages) {
    lines.push(`- [${name}](${docsUrl}/api/${folderName}): ${summary}`);
  }
  lines.push('', '## Recipes', '');
  for (const page of pages.filter((candidate) => candidate.url.startsWith(RECIPES_URL))) {
    lines.push(pageLine(docsUrl, page));
  }
  lines.push('', '## Optional', '', `- [Every docs page as one file](${docsUrl}/llms-full.txt)`);
  return `${lines.join('\n')}\n`;
}

/**
 * Reads the files that a page's live `<Include>` tags embed, as fenced blocks. A file the `Include`
 * component would refuse makes this throw, so a crafted tag cannot publish anything outside `examples/`.
 *
 * @example
 * const sections = await embeddedFiles(process.cwd(), '<Include file="examples/recipes/src/theming.css" />');
 */
export async function embeddedFiles(root, body) {
  const sections = [];
  for (const file of includeFilesOf(body)) {
    const code = (await readFile(await resolveIncludePath(root, file), 'utf8')).trimEnd();
    sections.push(`Embedded file ${file}:\n\n\`\`\`\`${path.extname(file).slice(1)}\n${code}\n\`\`\`\``);
  }
  return sections;
}

/**
 * Copies the sections for the adapter contract (`FileSystemAdapter`, `Entry`, the option types, `ChangeEvent`
 * and the error kinds) out of the generated `@workspacekit/core` API page, so an agent that reads only
 * `llms-full.txt` has the exact signatures. Throws when the page or a section is missing: run
 * `api-reference.mjs` first.
 *
 * @example
 * const contract = await adapterContract(process.cwd());
 */
export async function adapterContract(root, corePage = CORE_API_PAGE) {
  const page = await readFile(path.join(root, corePage), 'utf8').catch(() => {
    throw new Error(`${corePage} is missing. Run node apps/docs/scripts/api-reference.mjs first.`);
  });
  const lines = page.split('\n');
  const sections = ADAPTER_CONTRACT_TYPES.map((name) => {
    const start = lines.findIndex((line) => line === `#### ${name}`);
    if (start < 0) throw new Error(`${corePage} has no section for ${name}.`);
    const length = lines.slice(start).findIndex((line, offset) => offset > 0 && line === '***');
    const end = length < 0 ? lines.length : start + length;
    return lines.slice(start, end).join('\n').replace(SAME_PAGE_LINK, '$1').trim();
  });
  const helpers = await coreHelpers(root, lines, corePage);
  return `# The @workspacekit/core adapter contract\n\n${CONTRACT_PREFACE}\n\nThe types below are copied from the API page for @workspacekit/core.\n\n${sections.join('\n\n')}\n\n## Helpers exported by @workspacekit/core\n\nUse these instead of building paths or errors by hand.\n\n${helpers}`;
}

async function publicCoreNames(root) {
  const snapshot = await readFile(path.join(root, 'api', 'core.txt'), 'utf8');
  return new Set(
    snapshot
      .split('\n')
      .filter((line) => line.startsWith('@workspacekit/core '))
      .map((line) => line.slice('@workspacekit/core '.length)),
  );
}

async function coreHelpers(root, apiLines, corePage) {
  const items = [];
  const isPublic = await publicCoreNames(root);
  for (const file of HELPER_SOURCES) {
    const source = await readFile(path.join(root, 'packages', 'core', 'src', file), 'utf8');
    for (const [, name] of source.matchAll(EXPORTED_FUNCTION)) {
      if (!isPublic.has(name)) continue;
      const start = apiLines.findIndex((line) => line === `#### ${name}()`);
      if (start < 0) throw new Error(`${corePage} has no section for ${name}().`);
      const summary = apiLines.slice(start + 1).find((line) => line.trim() !== '' && !line.startsWith('>'));
      items.push(`- \`${name}\`: ${summary.trim()}`);
    }
  }
  return items.join('\n');
}

async function renderPage(root, docsUrl, page) {
  const { title, body } = frontMatterOf(page.text);
  const parts = [
    `# ${title}`,
    `Address: ${docsUrl}${page.url}`,
    body.trim(),
    ...(await embeddedFiles(root, body)),
  ];
  return parts.join('\n\n');
}

async function renderLlmsFullTxt(root, docsUrl, pages, packages, corePage) {
  const intro = [
    '# workspacekit: all documentation pages',
    `The API reference is not repeated here, except the @workspacekit/core adapter contract at the end. Each package has its own page:\n\n${packages
      .map(({ folderName, name }) => `- ${name}: ${docsUrl}/api/${folderName}`)
      .join('\n')}`,
  ];
  const rendered = [];
  for (const page of pages) rendered.push(await renderPage(root, docsUrl, page));
  rendered.push(await adapterContract(root, corePage));
  return `${[...intro, ...rendered].join('\n\n---\n\n')}\n`;
}

async function readApiPages(root) {
  const folder = path.join(root, API_FOLDER);
  if (!existsSync(folder)) return [];
  const files = (await readdir(folder)).filter((file) => file.endsWith('.md')).sort();
  const pages = [];
  for (const file of files) {
    const name = file.replace(/\.md$/, '');
    pages.push({
      url: name === 'index' ? '/api' : `/api/${name}`,
      text: await readFile(path.join(folder, file), 'utf8'),
    });
  }
  return pages;
}

function notFoundMarkdown(docsUrl) {
  return [
    '# Page not found',
    '',
    'There is no workspacekit page at this address.',
    '',
    `- [Home](${docsUrl}/)`,
    `- [Documentation](${docsUrl}/docs)`,
    `- [Site map for agents](${docsUrl}/llms.txt)`,
    '',
  ].join('\n');
}

async function renderMarkdownPages(root, docsUrl, pages, llmsTxt) {
  const files = new Map([
    ['index.md', llmsTxt],
    ['404.md', notFoundMarkdown(docsUrl)],
  ]);
  for (const page of [...pages, ...(await readApiPages(root))]) {
    files.set(`${page.url.slice(1)}.md`, `${await renderPage(root, docsUrl, page)}\n`);
  }
  return files;
}

/**
 * Builds the text of `llms.txt` (a curated map), `llms-full.txt` (every docs page) and one Markdown file per
 * page, keyed by its path under the site (`docs/styling.md`, `index.md` for the home page, `404.md`), from
 * the pages under `content/docs` and `content/api`. Agents that ask for `text/markdown` are served these.
 * The result depends only on the repository's files and `NEXT_PUBLIC_SITE_URL`, so two builds are identical.
 *
 * `corePage` is the repository-relative path of the generated `@workspacekit/core` API page that the adapter
 * contract is copied from; tests point it at a small checked-in fixture.
 *
 * @example
 * const { llmsTxt, llmsFullTxt, markdownPages } = await buildLlms(process.cwd());
 */
export async function buildLlms(root, corePage = CORE_API_PAGE) {
  const docsUrl = process.env.NEXT_PUBLIC_SITE_URL ?? (await readDocsUrl(root));
  const pages = await readPages(root);
  const packages = [];
  for (const folderName of PUBLIC_PACKAGES) packages.push(await describePackage(root, folderName));
  const llmsTxt = renderLlmsTxt(docsUrl, pages, packages);
  return {
    llmsTxt,
    llmsFullTxt: await renderLlmsFullTxt(root, docsUrl, pages, packages, corePage),
    markdownPages: await renderMarkdownPages(root, docsUrl, pages, llmsTxt),
  };
}

/**
 * Writes `public/llms.txt`, `public/llms-full.txt` and the per-page Markdown files for the site.
 *
 * @example
 * await writeLlms(process.cwd());
 */
export async function writeLlms(root) {
  const { llmsTxt, llmsFullTxt, markdownPages } = await buildLlms(root);
  const publicFolder = path.join(root, 'apps', 'docs', 'public');
  await mkdir(publicFolder, { recursive: true });
  await writeFile(path.join(publicFolder, 'llms.txt'), llmsTxt);
  await writeFile(path.join(publicFolder, 'llms-full.txt'), llmsFullTxt);
  for (const [file, text] of markdownPages) {
    await mkdir(path.dirname(path.join(publicFolder, file)), { recursive: true });
    await writeFile(path.join(publicFolder, file), text);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await writeLlms(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
}
