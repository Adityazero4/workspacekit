import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportedNamesOf, PUBLIC_PACKAGES } from '../../../scripts/agent-docs.mjs';

const API_FOLDER = path.join('apps', 'docs', 'content', 'api');
const API_BASE_URL = '/api';
const TYPEDOC_BIN = path.join('apps', 'docs', 'node_modules', 'typedoc', 'bin', 'typedoc');
const TYPEDOC_TSCONFIG = path.join('apps', 'docs', 'tsconfig.typedoc.json');
const DECLARATION_FILE = /^\.\/dist\/(.+\/)?index\.d\.ts$/;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,5}) /;
const SECTION_HEADING = /^## (.+)$/;
const EXPORT_HEADING = /^#### (.+?)(?: \[#([\w-]+)\])?$/;
const MODULE_LINK = /\[([^\]]*)\]\(([^)\s#]+\.md)(#[^)\s]*)?\)/g;

const slugOf = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

function mapOutsideFences(markdown, mapLine) {
  let isInsideFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        isInsideFence = !isInsideFence;
        return line;
      }
      return isInsideFence ? line : mapLine(line);
    })
    .join('\n');
}

/**
 * Lists the TypeDoc input for every public entry point: the `src` file behind each types export, and the name
 * TypeDoc gives that module. Stylesheet exports are skipped.
 *
 * @example
 * const [entry] = await apiEntries(process.cwd(), ['core']);
 * console.log(entry.specifier, entry.sourceFile); // @workspacekit/core packages/core/src/index.ts
 */
export async function apiEntries(root, packages = PUBLIC_PACKAGES) {
  const entries = [];
  for (const folderName of packages) {
    const manifest = JSON.parse(
      await readFile(path.join(root, 'packages', folderName, 'package.json'), 'utf8'),
    );
    for (const [key, target] of Object.entries(manifest.exports)) {
      const declaration = DECLARATION_FILE.exec(target.types ?? '');
      if (!declaration) continue;
      const sourceFile = `packages/${folderName}/src/${declaration[1] ?? ''}index.ts`;
      entries.push({
        folderName,
        specifier: key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`,
        sourceFile,
        moduleName: sourceFile.replace(/^packages\//, '').replace(/\/index\.ts$/, ''),
      });
    }
  }
  return entries;
}

function linkRewriter(entry, entries) {
  const byModule = new Map(entries.map((candidate) => [candidate.moduleName, candidate]));
  const directory = path.posix.dirname(`${entry.moduleName}.md`);
  return (match, text, file, anchor) => {
    const moduleName = path.posix.join(directory, file).replace(/\.md$/, '');
    const target = byModule.get(moduleName);
    if (!target) return text;
    const hash = anchor ?? `#${slugOf(target.specifier)}`;
    return `[${text}](${target.folderName === entry.folderName ? '' : `${API_BASE_URL}/${target.folderName}`}${hash})`;
  };
}

const INLINE_CODE_SPLIT = /(`+[^`]*`+)/;

function inertText(line) {
  return line
    .split(INLINE_CODE_SPLIT)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/(?<!\\)</g, '&lt;').replace(/(?<!\\)\{/g, '\\{'),
    )
    .join('');
}

function sectionOf(entry, entries, markdown) {
  const rewriteLink = linkRewriter(entry, entries);
  const body = mapOutsideFences(markdown.replace(/^# .*\n/, ''), (line) =>
    inertText(line.replace(HEADING, '$1# ')).replace(MODULE_LINK, rewriteLink),
  );
  return `## ${entry.specifier}\n${body.replace(/^\n*/, '\n').trimEnd()}\n`;
}

const slugOfHeading = (heading) => slugOf(heading.replace(/\\/g, ''));

function anchorsOf(section) {
  return linesOutsideFences(section).flatMap((line) => {
    const match = EXPORT_HEADING.exec(line);
    return match ? [match[2] ?? slugOfHeading(match[1])] : [];
  });
}

function withUniqueAnchors(section, specifier, claimed) {
  const prefix = slugOf(specifier);
  const namesBySlug = new Map();
  const unique = mapOutsideFences(section, (line) => {
    const match = EXPORT_HEADING.exec(line);
    if (!match || match[2]) return line;
    const slug = slugOfHeading(match[1]);
    const isOtherName = namesBySlug.has(slug) && namesBySlug.get(slug) !== match[1];
    namesBySlug.set(slug, match[1]);
    if (!claimed.has(slug) && !isOtherName) return line;
    let id = `${prefix}-${slug}`;
    for (let copy = 2; claimed.has(id); copy += 1) id = `${prefix}-${slug}-${copy}`;
    claimed.add(id);
    return `${line} [#${id}]`;
  });
  for (const anchor of anchorsOf(section)) claimed.add(anchor);
  return unique;
}

function frontMatter(title, description) {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

function indexPage(packageEntries) {
  const lines = packageEntries.map(
    ({ specifier, folderName }) => `- [${specifier}](${API_BASE_URL}/${folderName})`,
  );
  return `${frontMatter('API reference', 'Every export of every package, generated from its TSDoc.')}${lines.join('\n')}\n`;
}

/**
 * Turns TypeDoc's Markdown, one file per module, into the pages the site serves: one page per package with a
 * section for each entry point, an index page and the navigation file. Links between modules become anchors
 * on the same page or links to another package's page.
 *
 * @example
 * const pages = assembleApiPages(new Map([['core/src', '# core/src\n']]), entries);
 * console.log([...pages.keys()]); // ['core.md', 'index.md', 'meta.json']
 */
export function assembleApiPages(modules, entries) {
  const folderNames = [...new Set(entries.map((entry) => entry.folderName))];
  const pages = new Map();
  for (const folderName of folderNames) {
    const own = entries.filter((entry) => entry.folderName === folderName);
    const claimed = new Set();
    const sections = own.map((entry) =>
      withUniqueAnchors(
        sectionOf(entry, entries, modules.get(entry.moduleName) ?? ''),
        entry.specifier,
        claimed,
      ),
    );
    const title = own[0].specifier;
    const page = `${frontMatter(title, `API reference for ${title}, generated from its TSDoc.`)}${sections.join('\n')}`;
    const duplicates = duplicateExportAnchors(page);
    if (duplicates.length > 0) {
      throw new Error(
        `${folderName}.md: ${duplicates.map((name) => `"${name}"`).join(', ')} would get the same anchor as an earlier export. Rename one export or give it a different heading.`,
      );
    }
    pages.set(`${folderName}.md`, page);
  }
  pages.set(
    'index.md',
    indexPage(folderNames.map((folderName) => entries.find((e) => e.folderName === folderName))),
  );
  pages.set(
    'meta.json',
    `${JSON.stringify({ title: 'API reference', pages: ['index', ...folderNames] }, null, 2)}\n`,
  );
  return pages;
}

function linesOutsideFences(markdown) {
  const lines = [];
  mapOutsideFences(markdown, (line) => {
    lines.push(line);
    return line;
  });
  return lines;
}

function exportNamesBySection(markdown) {
  const sections = new Map();
  let names = new Set();
  for (const line of linesOutsideFences(markdown)) {
    const section = SECTION_HEADING.exec(line)?.[1];
    if (section) sections.set(section, (names = new Set()));
    const heading = EXPORT_HEADING.exec(line)?.[1];
    if (heading) names.add(heading.replace(/\\/g, '').replace(/\(\)$/, ''));
  }
  return sections;
}

function duplicateExportAnchors(markdown) {
  const seen = new Set();
  const duplicates = new Set();
  for (const line of linesOutsideFences(markdown)) {
    const heading = EXPORT_HEADING.exec(line)?.[1];
    if (heading === undefined) continue;
    const name = heading.replace(/\\/g, '').replace(/\(\)$/, '');
    const anchor = EXPORT_HEADING.exec(line)[2] ?? slugOf(heading);
    if (seen.has(anchor)) duplicates.add(name);
    seen.add(anchor);
  }
  return [...duplicates];
}

/**
 * Returns a problem for every exported name that has no heading on its package's API page.
 *
 * @example
 * const expected = [{ folderName: 'core', specifier: '@workspacekit/core', names: ['joinPath'] }];
 * const problems = missingExports(pages, expected);
 */
export function missingExports(pages, expected) {
  return expected.flatMap(({ folderName, specifier, names }) => {
    const headings = exportNamesBySection(pages.get(`${folderName}.md`) ?? '').get(specifier) ?? new Set();
    return names
      .filter((name) => !headings.has(name))
      .map((name) => `${specifier}: the export ${name} has no heading in ${API_BASE_URL}/${folderName}.`);
  });
}

async function runTypedoc(root, entries, outputFolder) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, TYPEDOC_BIN),
      '--plugin',
      'typedoc-plugin-markdown',
      '--tsconfig',
      path.join(root, TYPEDOC_TSCONFIG),
      '--skipErrorChecking',
      '--entryPointStrategy',
      'resolve',
      '--outputFileStrategy',
      'modules',
      '--hidePageHeader',
      '--hideBreadcrumbs',
      '--disableSources',
      '--readme',
      'none',
      '--out',
      outputFolder,
      ...entries.map((entry) => path.join(root, entry.sourceFile)),
    ],
    { cwd: path.join(root, 'apps', 'docs'), stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('TypeDoc failed. Its output is above.');
}

async function readModules(outputFolder, entries) {
  const modules = new Map();
  for (const { moduleName } of entries) {
    const file = path.join(outputFolder, `${moduleName}.md`);
    if (!existsSync(file)) throw new Error(`TypeDoc wrote no page for ${moduleName}. Look for ${file}.`);
    modules.set(moduleName, await readFile(file, 'utf8'));
  }
  return modules;
}

async function expectedExports(root, packages) {
  const expected = [];
  for (const folderName of packages) {
    const entries = await exportedNamesOf(root, folderName);
    if (entries.length === 0) {
      throw new Error(`packages/${folderName} has no built types. Run its build first.`);
    }
    for (const entry of entries) expected.push({ folderName, ...entry });
  }
  return expected;
}

/**
 * Runs TypeDoc once over every public entry point and writes the API pages to `apps/docs/content/api`.
 * Throws when an exported name has no heading, so a stale or partial reference never ships.
 *
 * @example
 * await generateApiReference({ root: process.cwd() });
 */
export async function generateApiReference({ root, packages = PUBLIC_PACKAGES }) {
  const entries = await apiEntries(root, packages);
  const scratch = await mkdtemp(path.join(tmpdir(), 'api-reference-'));
  try {
    await runTypedoc(root, entries, scratch);
    const pages = assembleApiPages(await readModules(scratch, entries), entries);
    const problems = missingExports(pages, await expectedExports(root, packages));
    if (problems.length > 0) throw new Error(`${problems.join('\n')}\nThe API reference is incomplete.`);
    await rm(path.join(root, API_FOLDER), { recursive: true, force: true });
    await mkdir(path.join(root, API_FOLDER), { recursive: true });
    for (const [file, text] of pages) await writeFile(path.join(root, API_FOLDER, file), text);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  await generateApiReference({ root });
}
