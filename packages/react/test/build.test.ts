// @vitest-environment node
import { readFileSync } from 'node:fs';
import { test, expect } from 'vitest';

// Runs against the output of `pnpm --filter @scope/react build`.
const dist = (): string => readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
const publicTypes = (): string => readFileSync(new URL('../dist/index.d.ts', import.meta.url), 'utf8');

const NEXT_TOP_LEVEL_LINE = /\n(?=[^\s})\]])/g;

const exportedNames = (): string[] => {
  const statement = /export \{([^}]*)\};\s*$/.exec(dist());
  return statement ? statement[1]!.split(',').map((name) => name.trim().split(/\s+as\s+/)[0]!) : [];
};
const isComponentOrHook = (name: string): boolean => /^(use[A-Z]|[A-Z][a-z])/.test(name);
const bodyOf = (name: string): string => {
  const source = dist();
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
    `cannot locate ${name} in dist/index.js: teach bodyOf this declaration form or add an explicit exemption`,
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
