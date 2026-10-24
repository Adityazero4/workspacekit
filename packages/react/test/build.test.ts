// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { test, expect } from 'vitest';
import { assertNoNestedRules } from '../../../scripts/css-nesting.mjs';
import { filesReachableFrom, importsOf, modulesIn } from '../../../scripts/import-graph.mjs';

// Runs against the output of `pnpm --filter @workspacekit/react build`.
const DIST = new URL('../dist/', import.meta.url);
const distText = (file: string): string => readFileSync(new URL(file, DIST), 'utf8');
const resolveInDist = (fromFile: string, specifier: string): string =>
  new URL(specifier, new URL(fromFile, DIST)).href.slice(DIST.href.length);
const allImportsOf = (file: string): string[] => {
  const imports = importsOf(distText(file));
  return [...imports.static, ...imports.dynamic];
};
const chunksLoadedBy = (entry: string): string[] =>
  filesReachableFrom(DIST, entry, { throughDynamicImports: true });

const dist = (): string => distText('index.js');
const publicTypes = (): string => distText('index.d.ts');
const mainBundle = (): string => chunksLoadedBy('index.js').map(distText).join('\n');

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

const MODULES_A_PROVIDER_FREE_SUBPATH_MAY_CONTAIN = [
  /^src\/renderers\/(?!directory\/)/,
  /^src\/renderer-kit\//,
  /^src\/cx\.ts$/,
  /^src\/viewer\/errors\.ts$/,
  /^src\/viewer\/registry\.ts$/,
  /^\\0rolldown\/runtime\.js$/,
];
const PACKAGES_A_PROVIDER_FREE_SUBPATH_MAY_IMPORT = new Set([
  '@workspacekit/core/docs',
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
  const subpathFiles = chunksLoadedBy('renderers/index.js');
  expect(subpathFiles).not.toContain('index.js');
  const modules = subpathFiles.flatMap((file) => modulesIn(distText(file)));
  expect(modules).toContain('src/renderers/text/TextViewer.tsx');
  expect(
    modules.filter(
      (module) => !MODULES_A_PROVIDER_FREE_SUBPATH_MAY_CONTAIN.some((allowed) => allowed.test(module)),
    ),
  ).toEqual([]);
  const packages = subpathFiles.flatMap(allImportsOf).filter((specifier) => !specifier.startsWith('.'));
  expect(packages.filter((specifier) => !PACKAGES_A_PROVIDER_FREE_SUBPATH_MAY_IMPORT.has(specifier))).toEqual(
    [],
  );

  const rendererChunks = importsOf(distText('index.js')).dynamic.map((specifier) =>
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

const RENDERER_KIT_EXPORTS = [
  'ClassNames',
  'FileInfo',
  'MATCH_SCORE',
  'MatchScore',
  'PageGeometry',
  'Part',
  'Renderer',
  'RendererInput',
  'RendererProps',
  'RendererSource',
  'SVG_ANIMATION_ELEMENTS',
  'StaleNotice',
  'StaleNoticeProps',
  'StandaloneFile',
  'StandaloneLoadOptions',
  'StandaloneRoot',
  'StandaloneRootProps',
  'StandaloneSource',
  'StandaloneViewerProps',
  'ViewerError',
  'ViewerErrorKind',
  'VirtualPages',
  'VirtualPagesHandle',
  'VirtualPagesProps',
  'confineDeclarations',
  'defineRenderer',
  'keepWebOrMailLink',
  'lineBreakOf',
  'mediaUrlOfBlob',
  'partProps',
  'safeFontSource',
  'safeUrlOrNull',
  'stepZoom',
  'svgAttributeFetches',
  'useSettledAnnouncement',
  'useStandaloneBytes',
  'viewerError',
  'withLfLineBreaks',
  'withLineBreak',
  'zoomTowards',
];

function declarationFilesReachableFrom(entry: string): string[] {
  const reached = new Set<string>();
  const visit = (file: string): void => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const specifier of allImportsOf(file).filter((candidate) => candidate.startsWith('.'))) {
      visit(resolveInDist(file, specifier).replace(/\.js$/, '.d.ts'));
    }
  };
  visit(entry);
  return [...reached];
}

const exportedNamesOf = (declarationFile: string): string[] => {
  const text = distText(declarationFile);
  const listed = /^export \{([^}]*)\};\s*$/m.exec(text)?.[1]?.split(',') ?? [];
  const declared = [...text.matchAll(/^export declare (?:function|const|class) (\w+)/gm)].map(
    (match) => match[1]!,
  );
  return [
    ...listed.map((name) =>
      name
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .at(-1)!,
    ),
    ...declared,
  ];
};

const docCommentOf = (name: string, declarationFiles: string[]): string | undefined => {
  const declaration = new RegExp(
    String.raw`/\*\*((?:(?!\*/)[\s\S])*)\*/\s*(?:export\s+)?(?:declare\s+)?(?:function|const|interface|type|class)\s+${name}\b`,
  );
  return declarationFiles.map((file) => declaration.exec(distText(file))?.[1]).find(Boolean);
};

test('renderer-kit subpath exports exactly the documented helpers and types renderer packages build on', () => {
  expect(exportedNamesOf('renderer-kit/index.d.ts').sort()).toEqual([...RENDERER_KIT_EXPORTS].sort());
});

test('renderer-kit subpath pulls in no tree, provider or Radix code', () => {
  const kitFiles = chunksLoadedBy('renderer-kit/index.js');
  expect(kitFiles).not.toContain('index.js');
  const modules = kitFiles.flatMap((file) => modulesIn(distText(file)));
  expect(modules).toContain('src/renderers/StandaloneRoot.tsx');
  expect(
    modules.filter(
      (module) => !MODULES_A_PROVIDER_FREE_SUBPATH_MAY_CONTAIN.some((allowed) => allowed.test(module)),
    ),
  ).toEqual([]);
  const packages = kitFiles.flatMap(allImportsOf).filter((specifier) => !specifier.startsWith('.'));
  expect(packages.filter((specifier) => !PACKAGES_A_PROVIDER_FREE_SUBPATH_MAY_IMPORT.has(specifier))).toEqual(
    [],
  );
});

test.each(exportedNamesOf('renderer-kit/index.d.ts'))(
  'renderer-kit export %s has TSDoc with exactly one @example',
  (name) => {
    const doc = docCommentOf(name, declarationFilesReachableFrom('renderer-kit/index.d.ts'));
    expect(doc, `no TSDoc found on the declaration of ${name} in the kit's .d.ts files`).toBeDefined();
    expect(doc!.match(/@example/g), name).toHaveLength(1);
  },
);

test('the shipped styles.css has no nested rules (Ruling P4-6)', () => {
  expect(() => assertNoNestedRules(distText('styles.css'), 'dist/styles.css')).not.toThrow();
});
