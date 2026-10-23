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
const READER_ENGINES = ['fflate', 'saxes', 'papaparse', 'numfmt'];

test.each([
  '@tanstack/react-virtual',
  ...READER_ENGINES,
  'fast-formula-parser',
  'src/SpreadsheetDocument.tsx',
  'src/grid/Grid.tsx',
  'src/reader/client.ts',
  'src/reader/worker.ts',
])('importing the entry never loads %s; it is reached only lazily', (engine) => {
  expect(() => assertEngineLoadsLazily(DIST, engine)).not.toThrow();
});

test('the main-thread viewer chunk never imports the reader engines: they run only in the worker', () => {
  const viewerChunk = importsOf(distText('index.js')).dynamic.find((file) =>
    file.includes('SpreadsheetDocument'),
  )!;
  const mainThreadFiles = filesReachableFrom(DIST, viewerChunk.slice(2));
  const mainThreadImports = mainThreadFiles.flatMap((file) => {
    const found = importsOf(distText(file));
    return [...found.static, ...found.dynamic];
  });
  expect(
    mainThreadImports.filter((specifier) => [...READER_ENGINES, 'fast-formula-parser'].includes(specifier)),
  ).toEqual([]);
  expect(mainThreadFiles.flatMap((file) => modulesIn(distText(file)))).not.toContain(
    'src/reader/xlsx/zip.ts',
  );
});

test('@scope/react/renderer-kit stays external: imported by specifier, none of its modules bundled', () => {
  const files = filesReachableFrom(DIST, 'index.js', { throughDynamicImports: true });
  expect(importsOf(distText('index.js')).static).toContain('@scope/react/renderer-kit');
  const bundledModules = files.flatMap((file) => modulesIn(distText(file)));
  expect(bundledModules.filter((module) => !module.startsWith('src/'))).toEqual([]);
});

test('the reader is its own worker entry: its engines are imported by specifier, none bundled', () => {
  const files = filesReachableFrom(DIST, 'worker.js', { throughDynamicImports: true });
  const imports = files.map((file) => importsOf(distText(file)));
  expect(imports.flatMap((found) => found.static)).toEqual(expect.arrayContaining(READER_ENGINES));
  const bundledModules = files.flatMap((file) => modulesIn(distText(file)));
  expect(bundledModules).toContain('src/reader/worker.ts');
  const outsideTheReader = bundledModules.filter((module) => !module.startsWith('src/reader/'));
  expect(outsideTheReader).toEqual(['src/grid/model.ts']);
});

test('the formula engine loads only through import(), once a formula without a stored result is found', () => {
  const files = filesReachableFrom(DIST, 'worker.js');
  const imports = files.map((file) => importsOf(distText(file)));
  expect(imports.flatMap((found) => found.static)).not.toContain('fast-formula-parser');
  expect(imports.flatMap((found) => found.dynamic)).toContain('fast-formula-parser');
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
