import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * The folders under `packages/` that ship `README.md`, `AGENTS.md` and `llms.txt`.
 *
 * @example
 * for (const folder of PUBLIC_PACKAGES) console.log(`packages/${folder}/llms.txt`);
 */
export const PUBLIC_PACKAGES = [
  'core',
  'server',
  'react',
  'code',
  'pdf',
  'docx',
  'pptx',
  'spreadsheet',
  'markdown',
  'workspace',
  'demo-kit',
  'create-workspace',
];

const SHIPPED_DOCS = ['README.md', 'AGENTS.md', 'llms.txt'];
const BLOCK_START = '<!-- common-mistakes:start -->';
const BLOCK_END = '<!-- common-mistakes:end -->';
const QUICK_START_START = '<!-- quick-start:start -->';
const QUICK_START_END = '<!-- quick-start:end -->';
const RECIPES_FOLDER = path.join('examples', 'recipes', 'src');
const RELATIVE_IMPORT_LINE = /^import\s.*from\s+'\.[^']*';\n/gm;
const RE_EXPORT_SOURCE = /\bfrom\s+'(\.[^']+)'/;
const FIXTURE_FOLDER = '.agent-docs-fixture';
const NOT_COMPILED_MARKER = /^\/\/ not-compiled:/;
const LANGUAGE_ALIASES = { typescript: 'ts', javascript: 'js', mjs: 'js', cjs: 'js' };
const COMPILED_LANGUAGES = new Set(['ts', 'tsx', 'js', 'jsx']);
const UNCOMPILED_LANGUAGES = new Set([
  'sh',
  'bash',
  'shell',
  'console',
  'json',
  'jsonc',
  'css',
  'html',
  'yaml',
  'yml',
  'text',
  'txt',
  'diff',
  'md',
  'markdown',
]);
const OPENING_FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;
const VITE_STUB = `export interface UserConfig {
  worker?: { format?: 'es' | 'iife' };
  optimizeDeps?: { include?: string[]; exclude?: string[] };
}
export function defineConfig(config: UserConfig): UserConfig;
`;
const AMBIENT_DECLARATIONS = 'declare function isSignedIn(request: Request): boolean | Promise<boolean>;\n';
const THIRD_PARTY_TYPES = ['react', 'react-dom', '@types/react', '@types/react-dom', '@types/node'];
const SCOPED_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](@workspacekit\/[^'"]+)['"]/g;
const SENTENCE = /^(.*?[.!?])(\s|$)/s;

const readText = (file) => readFile(file, 'utf8');
const collapse = (text) => text.replace(/\s+/g, ' ').trim();
const firstSentence = (text) => collapse(SENTENCE.exec(collapse(text))?.[1] ?? text);

/**
 * Splits Markdown into every fenced code block (backtick or tilde, any length, indented or not), including a
 * block that is never closed.
 *
 * @example
 * const [fence] = extractFences('```ts\nconst a = 1;\n```\n');
 * console.log(fence.language, fence.line, fence.isClosed); // ts 1 true
 */
export function extractFences(markdown) {
  const fences = [];
  let open = null;
  const finish = (isClosed) => {
    fences.push({ language: open.language, line: open.line, code: open.lines.join('\n'), isClosed });
    open = null;
  };
  markdown.split('\n').forEach((text, index) => {
    if (!open) {
      const match = OPENING_FENCE.exec(text);
      if (match) {
        const language = LANGUAGE_ALIASES[match[3].toLowerCase()] ?? match[3].toLowerCase();
        open = { indent: match[1].length, marker: match[2], language, line: index + 1, lines: [] };
      }
      return;
    }
    const closing = CLOSING_FENCE.exec(text);
    if (closing && closing[1][0] === open.marker[0] && closing[1].length >= open.marker.length) finish(true);
    else open.lines.push(text.replace(new RegExp(`^\\s{0,${open.indent}}`), ''));
  });
  if (open) finish(false);
  return fences;
}

/**
 * Reads `DOCS_URL` from `packages/demo-kit/src/site.ts`, the one place the docs address is written.
 *
 * @example
 * const docsUrl = await readDocsUrl(process.cwd());
 */
export async function readDocsUrl(root) {
  const source = await readText(path.join(root, 'packages', 'core', 'src', 'docs', 'index.ts'));
  const match = /DOCS_URL: string = '([^']+)'/.exec(source);
  if (!match) throw new Error('packages/core/src/docs/index.ts must export DOCS_URL as a string literal.');
  return match[1];
}

async function loadPackage(root, folderName) {
  const folder = path.join(root, 'packages', folderName);
  const manifest = JSON.parse(await readText(path.join(folder, 'package.json')));
  const entries = Object.entries(manifest.exports).map(([key, target]) => ({
    root,
    specifier: key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`,
    typesFile: typeof target === 'object' ? path.join(folder, target.types) : null,
    targetFile: path.join(folder, typeof target === 'object' ? target.types : target),
  }));
  return { root, folderName, folder, manifest, entries };
}

function exportsOfEntries(entries) {
  const typed = entries.filter((entry) => entry.typesFile && existsSync(entry.typesFile));
  const program = ts.createProgram(
    typed.map((entry) => entry.typesFile),
    {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      skipLibCheck: true,
      types: [],
      noEmit: true,
    },
  );
  const checker = program.getTypeChecker();
  return typed.map((entry) => {
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry.typesFile));
    const symbols = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    const exported = symbols.map((symbol) => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const summary = ts.displayPartsToString(target.getDocumentationComment(checker));
      return { name: symbol.name, summary: summary ? firstSentence(summary) : '' };
    });
    return { ...entry, exported: exported.sort((a, b) => (a.name < b.name ? -1 : 1)) };
  });
}

function readmeSections(readme) {
  const sections = [];
  for (const chunk of readme.split(/^## /m).slice(1)) {
    const [heading, ...rest] = chunk.split('\n');
    const paragraphs = rest
      .join('\n')
      .split('```')[0]
      .split(/\n\s*\n/);
    const prose = paragraphs.map((text) => collapse(text).replace(/^- /, '')).find(Boolean);
    sections.push({ heading: heading.trim(), summary: prose ? firstSentence(prose) : '' });
  }
  return sections;
}

function readmeSummary(readme) {
  const afterTitle = readme.replace(/^# .*\n/, '').trim();
  return firstSentence(afterTitle.split(/\n\s*\n/)[0] ?? '');
}

const README_INSTALL_COMMAND = /^npm (?:install|create) .+$/m;

function installCommand(manifest, readme) {
  return README_INSTALL_COMMAND.exec(readme)?.[0] ?? `npm install ${manifest.name}`;
}

function renderLlmsTxt({ manifest, folderName }, readme, entriesWithExports, docsUrl) {
  const lines = [`# ${manifest.name}`, '', `> ${readmeSummary(readme)}`, ''];
  lines.push(
    `- API reference: ${docsUrl}/api/${folderName}`,
    `- Install: \`${installCommand(manifest, readme)}\``,
    '',
  );
  lines.push('## README sections', '');
  for (const { heading, summary } of readmeSections(readme)) {
    lines.push(summary ? `- ${heading}: ${summary}` : `- ${heading}`);
  }
  lines.push('', '## Entry points', '');
  for (const entry of Object.keys(manifest.exports)) {
    const specifier = entry === '.' ? manifest.name : `${manifest.name}/${entry.slice(2)}`;
    lines.push(`- \`${specifier}\`${entry.endsWith('.css') ? ' (stylesheet)' : ''}`);
  }
  for (const entry of entriesWithExports) {
    lines.push('', `## Exports of \`${entry.specifier}\``, '');
    for (const { name, summary } of entry.exported) {
      lines.push(summary ? `- \`${name}\`: ${summary}` : `- \`${name}\``);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Lists the names a package exports from each entry point, read from its built type declarations.
 *
 * @example
 * const [entry] = await exportedNamesOf(process.cwd(), 'core');
 * console.log(entry.specifier, entry.names.length);
 */
export async function exportedNamesOf(root, folderName) {
  const loaded = await loadPackage(root, folderName);
  return exportsOfEntries(loaded.entries).map(({ specifier, exported }) => ({
    specifier,
    names: exported.map(({ name }) => name),
  }));
}

function missingTypesFiles(loaded) {
  return loaded.entries
    .filter((entry) => entry.typesFile && !existsSync(entry.typesFile))
    .map((entry) => `${path.relative(loaded.root, entry.typesFile)}`);
}

async function expectedLlmsTxt(root, folderName, docsUrl) {
  const loaded = await loadPackage(root, folderName);
  const missing = missingTypesFiles(loaded);
  if (missing.length) {
    throw new Error(
      `${folderName}: the types file ${missing.join(', ')} is missing. Build the package first.`,
    );
  }
  const readme = await readText(path.join(loaded.folder, 'README.md'));
  const exported = exportsOfEntries(loaded.entries);
  return { loaded, text: renderLlmsTxt(loaded, readme, exported, docsUrl), exported };
}

function blockBounds(text) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start < 0 || end < start) return null;
  return { from: start + BLOCK_START.length, to: end };
}

async function resolveRecipeSource(root, recipeFile) {
  const recipe = path.join(root, RECIPES_FOLDER, recipeFile);
  const specifier = RE_EXPORT_SOURCE.exec(await readText(recipe))?.[1];
  if (!specifier) throw new Error(`${RECIPES_FOLDER}/${recipeFile} must re-export the example it embeds.`);
  const base = path.resolve(path.dirname(recipe), specifier);
  const target = ['.ts', '.tsx'].map((extension) => base + extension).find((file) => existsSync(file));
  if (!target) {
    throw new Error(`${RECIPES_FOLDER}/${recipeFile} re-exports ${specifier}, which does not exist.`);
  }
  return readText(target);
}

const DOC_COMMENT = /\/\*\*[\s\S]*?\*\/\n/g;

function withoutDocComments(source) {
  return source.replace(DOC_COMMENT, '');
}

async function quickStartMarkdown(root) {
  const server = withoutDocComments(await resolveRecipeSource(root, 'serverRoute.ts')).replace(
    RELATIVE_IMPORT_LINE,
    '',
  );
  const client = withoutDocComments(await resolveRecipeSource(root, 'clientPage.tsx'));
  return [
    'On the server, expose a directory. `authorize` is required, and `isSignedIn` is yours to write: it must verify the session or token.',
    '',
    `\`\`\`ts\n${server.trim()}\n\`\`\``,
    '',
    'In the browser, render it.',
    '',
    `\`\`\`tsx\n${client.trim()}\n\`\`\``,
  ].join('\n');
}

function quickStartBounds(text) {
  const start = text.indexOf(QUICK_START_START);
  const end = text.indexOf(QUICK_START_END);
  if (start < 0 || end < start) return null;
  return { from: start + QUICK_START_START.length, to: end };
}

async function syncQuickStart(root) {
  const file = path.join(root, 'README.md');
  if (!existsSync(file)) return;
  const text = await readText(file);
  const bounds = quickStartBounds(text);
  if (!bounds) return;
  const block = await quickStartMarkdown(root);
  await writeFile(file, `${text.slice(0, bounds.from)}\n\n${block}\n\n${text.slice(bounds.to)}`);
}

async function checkQuickStart(root) {
  const file = path.join(root, 'README.md');
  if (!existsSync(file)) return [];
  const bounds = quickStartBounds(await readText(file));
  if (!bounds) {
    return [`README.md needs the quick-start markers (${QUICK_START_START} ... ${QUICK_START_END}).`];
  }
  const text = await readText(file);
  const expected = await quickStartMarkdown(root);
  return text.slice(bounds.from, bounds.to).trim() === expected
    ? []
    : [`README.md: the quick start differs from ${RECIPES_FOLDER}. Run pnpm agent-docs.`];
}

async function agentsFiles(root, folders) {
  const files = folders.map((name) => path.join(root, 'packages', name, 'AGENTS.md'));
  const rootFile = path.join(root, 'AGENTS.md');
  return existsSync(rootFile) ? [rootFile, ...files] : files;
}

async function syncCommonMistakes(root, folders) {
  const block = await readText(path.join(root, 'docs-src', 'common-mistakes.md'));
  for (const file of await agentsFiles(root, folders)) {
    const text = await readText(file);
    const bounds = blockBounds(text);
    if (bounds) {
      await writeFile(file, `${text.slice(0, bounds.from)}\n\n${block.trim()}\n\n${text.slice(bounds.to)}`);
    }
  }
}

/**
 * Rewrites every package's `llms.txt`, copies `docs-src/common-mistakes.md` between the markers of every
 * `AGENTS.md`, and copies the recipe sources between the quick-start markers of the root `README.md`.
 *
 * @example
 * await generateAgentDocs({ root: process.cwd(), packages: PUBLIC_PACKAGES });
 */
export async function generateAgentDocs({ root, packages, docsUrl, syncBlocks = true }) {
  const url = docsUrl ?? (await readDocsUrl(root));
  for (const folderName of packages) {
    const { loaded, text } = await expectedLlmsTxt(root, folderName, url);
    await writeFile(path.join(loaded.folder, 'llms.txt'), text);
  }
  if (syncBlocks) {
    await syncCommonMistakes(root, packages);
    await syncQuickStart(root);
  }
}

function listedNames(llmsText, specifier) {
  const heading = `## Exports of \`${specifier}\``;
  const section = llmsText.split(/^## /m).find((chunk) => `## ${chunk}`.startsWith(heading)) ?? '';
  return new Set([...section.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]));
}

async function checkLlmsTxt(root, folderName, docsUrl) {
  const loaded = await loadPackage(root, folderName);
  const label = `packages/${folderName}/llms.txt`;
  const missing = missingTypesFiles(loaded);
  if (missing.length) {
    return missing.map((file) => `${label}: the types file ${file} is missing. Build the package first.`);
  }
  const exported = exportsOfEntries(loaded.entries);
  const readmeFile = path.join(loaded.folder, 'README.md');
  if (!existsSync(readmeFile)) return [`packages/${folderName}/README.md is missing.`];
  const file = path.join(loaded.folder, 'llms.txt');
  if (!existsSync(file)) return [`${label} is missing. Run pnpm agent-docs.`];
  const actual = await readText(file);
  const expected = renderLlmsTxt(loaded, await readText(readmeFile), exported, docsUrl);
  const problems = actual === expected ? [] : [`${label} is stale. Run pnpm agent-docs.`];
  for (const entry of exported) {
    if (entry.exported.length === 0) problems.push(`${label}: \`${entry.specifier}\` has no exports.`);
    const listed = listedNames(actual, entry.specifier);
    for (const { name } of entry.exported) {
      if (!listed.has(name)) {
        problems.push(`${label} does not list the export \`${name}\` of \`${entry.specifier}\`.`);
      }
    }
  }
  return problems;
}

async function checkShippedFiles(root, folderName) {
  const { manifest } = await loadPackage(root, folderName);
  const missing = SHIPPED_DOCS.filter((name) => !manifest.files?.includes(name));
  const label = `packages/${folderName}/package.json`;
  return missing.length ? [`${label} "files" must list ${missing.join(', ')}.`] : [];
}

async function checkApiLink(root, folderName, docsUrl) {
  const file = path.join(root, 'packages', folderName, 'README.md');
  const link = `${docsUrl}/api/${folderName}`;
  const text = existsSync(file) ? await readText(file) : '';
  return text.includes(link)
    ? []
    : [`packages/${folderName}/README.md must link the API reference at ${link}.`];
}

async function checkCommonMistakes(root, folders) {
  const block = await readText(path.join(root, 'docs-src', 'common-mistakes.md'));
  const problems = [];
  for (const file of await agentsFiles(root, folders)) {
    const label = path.relative(root, file);
    const text = existsSync(file) ? await readText(file) : '';
    const bounds = blockBounds(text);
    if (!bounds) {
      problems.push(`${label} needs the common-mistakes markers (${BLOCK_START} ... ${BLOCK_END}).`);
    } else if (text.slice(bounds.from, bounds.to).trim() !== block.trim()) {
      problems.push(
        `${label}: the common-mistakes block differs from docs-src/common-mistakes.md. Run pnpm agent-docs.`,
      );
    }
  }
  return problems;
}

async function documentsOf(root, folders) {
  const documents = [];
  for (const file of [
    path.join(root, 'README.md'),
    path.join(root, 'AGENTS.md'),
    ...folders.flatMap((name) => [
      path.join(root, 'packages', name, 'README.md'),
      path.join(root, 'packages', name, 'AGENTS.md'),
    ]),
  ]) {
    if (existsSync(file)) {
      documents.push({ file, label: path.relative(root, file), text: await readText(file) });
    }
  }
  return documents;
}

function fenceProblem(document, fence) {
  const where = `${document.label}:${fence.line}`;
  if (!fence.isClosed) {
    return `${where} unclosed code fence. Close it, or the rest of the file is not checked.`;
  }
  if (fence.language === '') return `${where} a code fence needs a language (use text for plain output).`;
  if (!COMPILED_LANGUAGES.has(fence.language) && !UNCOMPILED_LANGUAGES.has(fence.language)) {
    return `${where} unknown fence language "${fence.language}". Use ts, tsx, js, jsx, or one of: ${[...UNCOMPILED_LANGUAGES].join(', ')}.`;
  }
  return null;
}

function fencesToCompile(documents) {
  const compiled = [];
  const problems = [];
  for (const document of documents) {
    for (const fence of extractFences(document.text)) {
      const problem = fenceProblem(document, fence);
      const firstLine = fence.code.trimStart().split('\n')[0];
      if (problem) problems.push(problem);
      else if (!COMPILED_LANGUAGES.has(fence.language)) continue;
      else if (!NOT_COMPILED_MARKER.test(firstLine)) compiled.push({ ...fence, document });
      else if (!/not-compiled:\s*\S/.test(firstLine)) {
        problems.push(`${document.label}:${fence.line} a not-compiled fence needs a reason after the colon.`);
      }
    }
  }
  return { compiled, problems };
}

function publicEntries(packages) {
  return new Map(packages.flatMap((loaded) => loaded.entries.map((entry) => [entry.specifier, entry])));
}

function importProblems(fences, entries) {
  const problems = [];
  for (const fence of fences) {
    for (const [, specifier] of fence.code.matchAll(SCOPED_SPECIFIER)) {
      const entry = entries.get(specifier);
      const where = `${fence.document.label}:${fence.line}`;
      if (!entry) problems.push(`${where} ${specifier} is not a public entry point.`);
      else if (!existsSync(entry.targetFile)) {
        problems.push(
          `${where} ${specifier} points at ${path.relative(entry.root, entry.targetFile)}, which does not exist.`,
        );
      }
    }
  }
  return problems;
}

async function linkIfPresent(target, candidates, name) {
  const source = candidates.find((candidate) => existsSync(path.join(candidate, 'node_modules', name)));
  if (!source) return false;
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(realpathSync(path.join(source, 'node_modules', name)), target);
  return true;
}

async function writeFixture(root, loadedPackages, fences) {
  const fixture = path.join(root, FIXTURE_FOLDER);
  await rm(fixture, { recursive: true, force: true });
  await mkdir(fixture, { recursive: true });
  for (const { manifest, folder } of loadedPackages) {
    const target = path.join(fixture, 'node_modules', manifest.name);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(folder, target);
  }
  const linkedTypes = [];
  for (const name of THIRD_PARTY_TYPES) {
    const target = path.join(fixture, 'node_modules', name);
    const isLinked = await linkIfPresent(
      target,
      loadedPackages.map((loaded) => loaded.folder),
      name,
    );
    if (isLinked && name.startsWith('@types/')) linkedTypes.push(name.slice('@types/'.length));
  }
  const files = fences.map((fence, index) => ({
    fence,
    file: path.join(fixture, `fence-${index}.${fence.language}`),
  }));
  for (const { fence, file } of files) await writeFile(file, `${fence.code}\nexport {};\n`);
  await writeFile(path.join(fixture, 'ambient.d.ts'), AMBIENT_DECLARATIONS);
  await mkdir(path.join(fixture, 'node_modules', 'vite'), { recursive: true });
  await writeFile(
    path.join(fixture, 'node_modules', 'vite', 'package.json'),
    '{"name":"vite","types":"index.d.ts"}',
  );
  await writeFile(path.join(fixture, 'node_modules', 'vite', 'index.d.ts'), VITE_STUB);
  const config = {
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'react-jsx',
      noEmit: true,
      skipLibCheck: true,
      allowJs: true,
      checkJs: true,
      noUncheckedSideEffectImports: false,
      types: linkedTypes,
    },
    include: ['fence-*', 'ambient.d.ts'],
  };
  await writeFile(path.join(fixture, 'tsconfig.json'), JSON.stringify(config, null, 2));
  return { fixture, files };
}

function describeDiagnostic(diagnostic, files) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  const match = files.find(({ file }) => file === diagnostic.file?.fileName);
  if (!match || diagnostic.start === undefined) return `fence fixture: TS${diagnostic.code} ${message}`;
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${match.fence.document.label}:${match.fence.line + line + 1} TS${diagnostic.code} ${message}`;
}

function diagnosticsOf(fixture) {
  const configPath = path.join(fixture, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(String(diagnostic.messageText));
      },
    },
  );
  const program = ts.createProgram(
    parsed.fileNames.map((name) => path.resolve(name)),
    parsed.options,
  );
  return ts.getPreEmitDiagnostics(program);
}

async function typecheckFences(root, folders, documents) {
  const loadedPackages = await Promise.all(folders.map((name) => loadPackage(root, name)));
  const { compiled, problems } = fencesToCompile(documents);
  problems.push(...importProblems(compiled, publicEntries(loadedPackages)));
  if (compiled.length === 0) return problems;
  const { fixture, files } = await writeFixture(root, loadedPackages, compiled);
  try {
    for (const diagnostic of diagnosticsOf(fixture)) problems.push(describeDiagnostic(diagnostic, files));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
  return problems;
}

async function checkFences(root, folders) {
  return typecheckFences(root, folders, await documentsOf(root, folders));
}

/**
 * Returns the problems in the code fences of any documents, such as the docs site's MDX pages: a fence
 * without a language, an import of a non-public path, and a TS, TSX, JS or JSX fence that does not typecheck
 * against the packages' `dist` types. A fence whose first line is `// not-compiled: <reason>` is skipped.
 *
 * @example
 * const problems = await checkDocumentFences({
 *   root: process.cwd(),
 *   packages: PUBLIC_PACKAGES,
 *   documents: [{ label: 'guide.mdx', text: '```ts\nconst n: number = 1;\n```\n' }],
 * });
 */
export async function checkDocumentFences({ root, packages, documents }) {
  return typecheckFences(root, packages, documents);
}

/**
 * Returns every way the agent docs are wrong: a stale or incomplete `llms.txt`, a `files` list that omits a
 * shipped document, a common-mistakes block that differs from its source, an import of a non-public path,
 * and a TS or TSX fence that does not typecheck against the packages' `dist` types.
 *
 * @example
 * const problems = await checkAgentDocs({ root: process.cwd(), packages: PUBLIC_PACKAGES });
 */
export async function checkAgentDocs({ root, packages, docsUrl }) {
  const url = docsUrl ?? (await readDocsUrl(root));
  const problems = [];
  for (const folderName of packages) {
    problems.push(
      ...(await checkLlmsTxt(root, folderName, url)),
      ...(await checkShippedFiles(root, folderName)),
      ...(await checkApiLink(root, folderName, url)),
    );
  }
  problems.push(
    ...(await checkCommonMistakes(root, packages)),
    ...(await checkQuickStart(root)),
    ...(await checkFences(root, packages)),
  );
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--check')) {
    const problems = await checkAgentDocs({ root, packages: PUBLIC_PACKAGES });
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) {
      console.error(`agent-docs: ${problems.length} problem(s). Fix the docs, then run pnpm agent-docs.`);
      process.exit(1);
    }
  } else {
    await generateAgentDocs({ root, packages: PUBLIC_PACKAGES });
  }
}
