// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { test, expect } from 'vitest';

// Runs against the output of `pnpm --filter @scope/react build`.
const DIST = new URL('../dist/', import.meta.url);
const distText = (file: string): string => readFileSync(new URL(file, DIST), 'utf8');
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^import\s*)["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const COMMENT_LINE = /^\s*(?:\/\/|\/?\*).*$/gm;
const specifiersOf = (code: string, pattern: RegExp): string[] =>
  [...code.replace(COMMENT_LINE, '').matchAll(pattern)].map((match) => match[1]!);
const resolveInDist = (fromFile: string, specifier: string): string =>
  new URL(specifier, new URL(fromFile, DIST)).href.slice(DIST.href.length);
const modulesIn = (code: string): string[] =>
  [...code.matchAll(/^\/\/#region (\S+)$/gm)].map((match) => match[1]!);

function filesReachableFrom(entry: string): string[] {
  const reached = new Set<string>();
  const visit = (file: string): void => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const specifier of specifiersOf(distText(file), IMPORT_SPECIFIER)) {
      if (specifier.startsWith('.')) visit(resolveInDist(file, specifier));
    }
  };
  visit(entry);
  return [...reached];
}

const dist = (): string => distText('index.js');
const publicTypes = (): string => distText('index.d.ts');
const mainBundle = (): string => filesReachableFrom('index.js').map(distText).join('\n');

const NEXT_TOP_LEVEL_LINE = /\n(?=[^\s})\]])/g;

const exportedNames = (): string[] => {
  const statement = /export \{([^}]*)\};\s*$/.exec(dist());
  return statement ? statement[1]!.split(',').map((name) => name.trim().split(/\s+as\s+/)[0]!) : [];
};
const isComponentOrHook = (name: string): boolean => /^(use[A-Z]|[A-Z][a-z])/.test(name);
const bodyOf = (name: string): string => {
  const source = mainBundle();
  const declaration = new RegExp(`^(?:function ${name}\\(|(?:const|let) ${name} = )`, 'm').exec(source);
  if (!declaration) return '';
  NEXT_TOP_LEVEL_LINE.lastIndex = declaration.index + 1;
  const end = NEXT_TOP_LEVEL_LINE.exec(source)?.index ?? source.length;
  return source.slice(declaration.index, end);
};

const statements = (name: string): string[] =>
  bodyOf(name)
    .replace(/^[^{]*\{/, '')
    .replace(/\}\s*$/, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const EXEMPT: Record<string, { reason: string; shape: (name: string) => boolean }> = {
  useFileSystem: {
    reason: 'reads the context and throws outside a provider, nothing to memoize',
    shape: (name) =>
      /^const ctx = useContext\(FsContext\);$/.test(statements(name)[0] ?? '') &&
      /^if \(!ctx\) throw new Error\(/.test(statements(name)[1] ?? '') &&
      statements(name)[2] === 'return ctx;' &&
      statements(name).length === 3,
  },
  useTreeSnapshot: {
    reason: 'returns one useSyncExternalStore read of the provider store, nothing to memoize',
    shape: (name) =>
      statements(name).join(' ') ===
      'const { store } = useFileSystem(); return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);',
  },
  useUiValue: {
    reason: 'returns one useSyncExternalStore read of its argument, nothing to memoize',
    shape: (name) =>
      statements(name).join(' ') === 'return useSyncExternalStore(store.subscribe, store.get, store.get);',
  },
  useConflictResolver: {
    reason: 'returns one stable member of the provider internals, nothing to memoize',
    shape: (name) =>
      statements(name).join(' ') === 'const { conflicts } = useFileSystemInternals(); return conflicts.ask;',
  },
  useFileViewer: {
    reason: 'returns the state half of the compiled useFileViewerAndViewedFile, nothing to memoize',
    shape: (name) => statements(name).join(' ') === 'return useFileViewerAndViewedFile(path, options)[0];',
  },
  Icons: {
    reason: 'an exported object of one-element SVG components, not a component itself',
    shape: (name) => bodyOf(name).startsWith(`const ${name} = {`),
  },
};

const componentsAndHooks = exportedNames().filter(isComponentOrHook);
const mustBeCompiled = componentsAndHooks.filter((name) => !(name in EXEMPT));

test('dist keeps the use client directive', () => {
  expect(dist().startsWith("'use client'")).toBe(true);
});

test('the export list is parsed and covers the known components and hooks', () => {
  expect(mustBeCompiled).toEqual(
    expect.arrayContaining([
      'FileSystemProvider',
      'useEntryState',
      'useExpanded',
      'useSelected',
      'useFileTree',
      'FileTree',
    ]),
  );
});

test.each(mustBeCompiled)('%s is compiled by React Compiler (uses the compiler cache)', (name) => {
  const body = bodyOf(name);
  expect(
    body,
    `cannot locate ${name} in dist/index.js or its chunks: teach bodyOf this declaration form or add an explicit exemption`,
  ).not.toBe('');
  expect(body).toMatch(/\bc\(\d+\)/);
});

test.each(Object.entries(EXEMPT).map(([name, { reason }]) => [name, reason]))(
  '%s is exempt from compilation: %s',
  (name) => {
    expect(componentsAndHooks).toContain(name);
    expect(
      EXEMPT[name]!.shape(name),
      `${name} changed shape in dist; re-check whether it needs compiling`,
    ).toBe(true);
  },
);

test.each([
  'remapMovedPaths',
  'attachRevealHost',
  'followedMoves',
  'isRevealing',
  'UploadsController',
  'ConflictQueue',
  'RevealHost',
  'FollowedMove',
  'FileSystemInternals',
])('the public types do not mention the internal %s', (name) => {
  expect(publicTypes()).not.toMatch(new RegExp(`\\b${name}\\b`));
});

const MODULES_THE_RENDERERS_SUBPATH_MAY_CONTAIN = [
  /^src\/renderers\/(?!directory\/)/,
  /^src\/cx\.ts$/,
  /^src\/viewer\/errors\.ts$/,
  /^\\0rolldown\/runtime\.js$/,
];
const PACKAGES_THE_RENDERERS_SUBPATH_MAY_IMPORT = new Set([
  'react',
  'react/jsx-runtime',
  'react/compiler-runtime',
  '@tanstack/react-virtual',
  'utif2',
]);

const LIGHT_RENDERER_MODULES = [
  'src/renderers/text/TextViewer.tsx',
  'src/renderers/directory/DirectoryViewer.tsx',
  'src/renderers/unsupported/UnsupportedViewer.tsx',
  'src/renderers/html/HtmlViewer.tsx',
  'src/renderers/image/ImageViewer.tsx',
  'src/renderers/media/AudioViewer.tsx',
  'src/renderers/media/VideoViewer.tsx',
  'src/renderers/tiff/TiffViewer.tsx',
];

test('renderers subpath pulls in no tree, provider or Radix code; each renderer is its own chunk', () => {
  const subpathFiles = filesReachableFrom('renderers/index.js');
  expect(subpathFiles).not.toContain('index.js');
  const modules = subpathFiles.flatMap((file) => modulesIn(distText(file)));
  expect(modules).toContain('src/renderers/text/TextViewer.tsx');
  expect(
    modules.filter(
      (module) => !MODULES_THE_RENDERERS_SUBPATH_MAY_CONTAIN.some((allowed) => allowed.test(module)),
    ),
  ).toEqual([]);
  const packages = subpathFiles.flatMap((file) =>
    specifiersOf(distText(file), IMPORT_SPECIFIER).filter((specifier) => !specifier.startsWith('.')),
  );
  expect(packages.filter((specifier) => !PACKAGES_THE_RENDERERS_SUBPATH_MAY_IMPORT.has(specifier))).toEqual(
    [],
  );

  const rendererChunks = specifiersOf(distText('index.js'), DYNAMIC_IMPORT).map((specifier) =>
    resolveInDist('index.js', specifier),
  );
  const chunkOf = (module: string): string[] =>
    rendererChunks.filter((chunk) => modulesIn(distText(chunk)).includes(module));
  const chunks = LIGHT_RENDERER_MODULES.map(chunkOf);
  for (const [index, found] of chunks.entries()) expect(found, LIGHT_RENDERER_MODULES[index]).toHaveLength(1);
  expect(new Set(chunks.flat()).size).toBe(LIGHT_RENDERER_MODULES.length);
  for (const chunk of chunks.flat()) {
    const others = LIGHT_RENDERER_MODULES.filter((module) => modulesIn(distText(chunk)).includes(module));
    expect(others, chunk).toHaveLength(1);
  }
  expect(modulesIn(dist()).filter((module) => module.startsWith('src/renderers/'))).toEqual([]);
});

test('every client chunk keeps the use client directive', () => {
  const javascriptFiles = readdirSync(DIST, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.js'),
  );
  expect(javascriptFiles).toContain('renderers/index.js');
  for (const file of javascriptFiles) expect(distText(file).startsWith("'use client'"), file).toBe(true);
});
