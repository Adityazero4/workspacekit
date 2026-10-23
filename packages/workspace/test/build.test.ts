// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { filesReachableFrom, importsOf } from '../../../scripts/import-graph.mjs';

const DIST = new URL('../dist/', import.meta.url);
const distText = (file: string): string => readFileSync(new URL(file, DIST), 'utf8');
const RENDERER_PACKAGES = ['code', 'docx', 'markdown', 'pdf', 'pptx', 'spreadsheet'];
const dependenciesOf = (name: string): string[] =>
  Object.keys(
    JSON.parse(readFileSync(new URL(`../../${name}/package.json`, import.meta.url), 'utf8')).dependencies ??
      {},
  );
const ENGINES = [
  ...new Set(RENDERER_PACKAGES.flatMap(dependenciesOf).filter((name) => !name.startsWith('@scope/'))),
];

test('the entry is one file: every renderer package and engine stays outside it', () => {
  expect(filesReachableFrom(DIST, 'index.js', { throughDynamicImports: true })).toEqual(['index.js']);
});

test('importing the entry loads only React, @scope/react and the renderer package entries', () => {
  const { static: staticImports, dynamic } = importsOf(distText('index.js'));
  const allowed = new Set(['react', 'react/jsx-runtime', 'react/compiler-runtime', '@scope/react']);
  RENDERER_PACKAGES.forEach((name) => allowed.add(`@scope/${name}`));
  expect(staticImports.filter((specifier) => !allowed.has(specifier))).toEqual([]);
  expect(dynamic).toEqual([]);
});

test.each(ENGINES)('the entry never names the %s engine', (engine) => {
  const { static: staticImports, dynamic } = importsOf(distText('index.js'));
  expect([...staticImports, ...dynamic].filter((specifier) => specifier.startsWith(engine))).toEqual([]);
});

test('the entry keeps the use client directive', () => {
  expect(distText('index.js').startsWith("'use client'")).toBe(true);
});

test('styles.css imports @scope/react first, then every renderer package', () => {
  const imports = [...distText('styles.css').matchAll(/@import '([^']+)'/g)].map((match) => match[1]);
  expect(imports).toEqual([
    '@scope/react/styles.css',
    ...RENDERER_PACKAGES.map((name) => `@scope/${name}/styles.css`),
  ]);
});
