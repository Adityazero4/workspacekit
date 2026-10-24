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
const dependencies: Record<string, string> = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).dependencies;

test.each([
  '@aiden0z/pptx-renderer',
  'jszip',
  'src/PptxDocument.tsx',
  'src/slides.ts',
  'src/limits.ts',
  'src/slideWork.ts',
  'src/imageSize.ts',
])('no engine code in the entry graph: importing the entry never loads %s', (engine) => {
  expect(() => assertEngineLoadsLazily(DIST, engine)).not.toThrow();
});

test('@aiden0z/pptx-renderer is pinned exactly to 1.4.0, and jszip to the version it resolves', () => {
  expect(dependencies['@aiden0z/pptx-renderer']).toBe('1.4.0');
  expect(dependencies.jszip).toBe('3.10.2');
});

test('@workspacekit/react/renderer-kit stays external: imported by specifier, none of its modules bundled', () => {
  const files = filesReachableFrom(DIST, 'index.js', { throughDynamicImports: true });
  const kitImporters = files.filter((file) =>
    importsOf(distText(file)).static.includes('@workspacekit/react/renderer-kit'),
  );
  expect(kitImporters.length).toBeGreaterThan(0);
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
