// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import { assertNoNestedRules } from '../../../scripts/css-nesting.mjs';
import {
  assertEngineLoadsLazily,
  filesReachableFrom,
  importsOf,
  modulesIn,
} from '../../../scripts/import-graph.mjs';

const DIST = new URL('../dist/', import.meta.url);
const distText = (file: string): string => readFileSync(new URL(file, DIST), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
};

test.each([
  'lexical',
  '@lexical/react/LexicalComposer',
  '@lexical/markdown',
  '@lexical/table',
  '@lexical/link',
  'src/LexicalMarkdownEditor.tsx',
  'src/sync.ts',
  'src/transformers/index.ts',
  'src/plugins/SlashMenuPlugin.tsx',
])('no Lexical code in the entry graph: importing the entry never loads %s', (engine) => {
  expect(() => assertEngineLoadsLazily(DIST, engine)).not.toThrow();
});

test('every lexical and @lexical/* dependency is pinned exactly to the same version', () => {
  const lexical = Object.entries(packageJson.dependencies).filter(
    ([name]) => name === 'lexical' || name.startsWith('@lexical/'),
  );
  expect(lexical.length).toBeGreaterThan(5);
  expect(new Set(lexical.map(([, version]) => version))).toEqual(new Set(['0.52.0']));
});

test('no Lexical type leaks into the public declarations', () => {
  expect(distText('index.d.ts')).not.toMatch(/from ['"](lexical|@lexical\/)/);
  expect(distText('index.d.ts')).not.toMatch(/import\(['"](lexical|@lexical\/)/);
});

test('@workspacekit/react stays external: imported by specifier, none of its modules bundled', () => {
  const files = filesReachableFrom(DIST, 'index.js', { throughDynamicImports: true });
  expect(importsOf(distText('index.js')).static).toContain('@workspacekit/react/renderer-kit');
  const bundledModules = files.flatMap((file) => modulesIn(distText(file)));
  expect(bundledModules.filter((module) => !module.startsWith('src/'))).toEqual([]);
});

test('every chunk keeps the use client directive', () => {
  const javascriptFiles = readdirSync(DIST).filter((file) => file.endsWith('.js'));
  expect(javascriptFiles.length).toBeGreaterThan(1);
  for (const file of javascriptFiles) expect(distText(file).startsWith("'use client'"), file).toBe(true);
});

test('styles.css is shipped, lives in @layer fs and has no nested rules (Ruling P4-6)', () => {
  expect(distText('styles.css')).toMatch(/^@layer fs \{/m);
  expect(() => assertNoNestedRules(distText('styles.css'), 'dist/styles.css')).not.toThrow();
});
