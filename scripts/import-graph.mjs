import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STATIC_IMPORT = /(?:\bfrom\s*|^import\s*)["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const URL_OF_MODULE = /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
const LEADING_BLOCK_COMMENT = /^(\s*)\/\*.*?\*\/\s*/gm;
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*).*$/gm;
const REGION = /^\/\/#region (\S+)$/gm;

const directoryUrl = (directory) =>
  directory instanceof URL ? directory : pathToFileURL(directory.endsWith('/') ? directory : `${directory}/`);

const specifiersOf = (code, pattern) =>
  [...code.replace(LEADING_BLOCK_COMMENT, '$1').replace(COMMENT_LINE, '').matchAll(pattern)].map(
    (match) => match[1],
  );

/**
 * The import specifiers in one built file, split into `static` (`import … from`, `export … from`, bare
 * `import '…'`), `dynamic` (`import('…')`) and `urls` (`new URL('…', import.meta.url)`, the form bundlers
 * resolve for workers, as in `new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url))`).
 * A URL loads nothing when the module is imported; the code that uses it does, later, like an `import()`.
 * Comment lines are skipped; a one-line block comment before an import (`/* @__PURE__ *\/ import …`) is not.
 *
 * @example
 * importsOf("import { a } from 'react';\nconst load = () => import('./Chunk.js');");
 * // { static: ['react'], dynamic: ['./Chunk.js'], urls: [] }
 */
export function importsOf(code) {
  return {
    static: specifiersOf(code, STATIC_IMPORT),
    dynamic: specifiersOf(code, DYNAMIC_IMPORT),
    urls: specifiersOf(code, URL_OF_MODULE),
  };
}

/**
 * The source modules bundled into one built file, from the `//#region <module>` markers tsdown writes.
 *
 * @example
 * modulesIn(readFileSync('dist/index.js', 'utf8')); // ['src/index.ts', 'src/match.ts']
 */
export function modulesIn(code) {
  return [...code.matchAll(REGION)].map((match) => match[1]);
}

/**
 * The files of `distDirectory` (a path or a `file:` URL) that loading `entry` pulls in, as paths relative
 * to it, following relative static imports, and, when `throughDynamicImports` is set, dynamic `import()`s
 * and module URLs too (so a worker chunk started with `new Worker(new URL('./worker.js', import.meta.url))`
 * counts as reached lazily). It stays inside `distDirectory`: bare specifiers (other packages, workspace
 * ones included) are not followed.
 *
 * @example
 * filesReachableFrom('packages/pdf/dist', 'index.js'); // ['index.js', 'match-x1.js']
 */
export function filesReachableFrom(distDirectory, entry, { throughDynamicImports = false } = {}) {
  const base = directoryUrl(distDirectory);
  const reached = new Set();
  const visit = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    const imports = importsOf(readFileSync(new URL(file, base), 'utf8'));
    const followed = throughDynamicImports
      ? [...imports.static, ...imports.dynamic, ...imports.urls]
      : imports.static;
    for (const specifier of followed.filter((candidate) => candidate.startsWith('.'))) {
      visit(new URL(specifier, new URL(file, base)).href.slice(base.href.length));
    }
  };
  visit(entry);
  return [...reached];
}

/**
 * Where `engine` turns up in the files loading `entry` pulls in. `engine` is a package specifier (matching
 * subpaths too, so `@codemirror/view/x` is `@codemirror/view`) or a bundled source module such as
 * `src/Renderer.tsx`. `staticallyImportedBy` lists the files reached without a dynamic `import()` that
 * import, contain or name a URL of it (`new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`
 * names `pdfjs-dist`, so a worker URL in the entry graph is caught too); `isReached` says whether any file
 * reachable at all does.
 *
 * @example
 * engineReachability('packages/pdf/dist', 'pdfjs-dist'); // { staticallyImportedBy: [], isReached: true }
 */
export function engineReachability(distDirectory, engine, entry = 'index.js') {
  const base = directoryUrl(distDirectory);
  const isEngineSpecifier = (specifier) => specifier === engine || specifier.startsWith(`${engine}/`);
  const holdsEngine = (file, includeDynamic) => {
    const code = readFileSync(new URL(file, base), 'utf8');
    const imports = importsOf(code);
    const specifiers = includeDynamic
      ? [...imports.static, ...imports.dynamic, ...imports.urls]
      : [...imports.static, ...imports.urls];
    return specifiers.some(isEngineSpecifier) || modulesIn(code).includes(engine);
  };
  return {
    staticallyImportedBy: filesReachableFrom(base, entry).filter((file) => holdsEngine(file, false)),
    isReached: filesReachableFrom(base, entry, { throughDynamicImports: true }).some((file) =>
      holdsEngine(file, true),
    ),
  };
}

/**
 * Throws unless `engine` is reachable from `entry` only through a dynamic `import()`, so importing a
 * package's entry never loads its engine. Also throws when the engine is never reached, so a misspelled
 * engine name cannot pass. See `engineReachability` for what `engine` may be.
 *
 * @example
 * test('importing the entry never loads pdf.js', () => {
 *   assertEngineLoadsLazily(new URL('../dist/', import.meta.url), 'pdfjs-dist');
 * });
 */
export function assertEngineLoadsLazily(distDirectory, engine, entry = 'index.js') {
  const { staticallyImportedBy, isReached } = engineReachability(distDirectory, engine, entry);
  if (staticallyImportedBy.length > 0) {
    throw new Error(
      `${engine} is imported statically by ${staticallyImportedBy.join(', ')}, so importing ${entry} loads it. ` +
        'Import it only from the module that `load: () => import(…)` points at.',
    );
  }
  if (!isReached) {
    throw new Error(
      `${engine} is never imported from ${entry}, not even through import(). ` +
        'Check the engine name against the specifier or the //#region marker in dist.',
    );
  }
}
