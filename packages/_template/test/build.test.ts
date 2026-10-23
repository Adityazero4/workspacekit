// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  assertEngineLoadsLazily,
  filesReachableFrom,
  importsOf,
  modulesIn,
} from '../../../scripts/import-graph.mjs';

// Runs against the output of `pnpm --filter @scope/template build`.
const DIST = new URL('../dist/', import.meta.url);
const distText = (file: string): string => readFileSync(new URL(file, DIST), 'utf8');

// A copied package adds its engine here, such as 'pdfjs-dist'.
test.each(['src/TemplateText.tsx', 'src/TemplateRenderer.tsx'])(
  'importing the entry never loads %s',
  (engine) => {
    expect(() => assertEngineLoadsLazily(DIST, engine)).not.toThrow();
  },
);

test('@scope/react/renderer-kit stays external: imported by specifier, none of its modules bundled', () => {
  const files = filesReachableFrom(DIST, 'index.js', { throughDynamicImports: true });
  expect(importsOf(distText('index.js')).static).toContain('@scope/react/renderer-kit');
  const bundledModules = files.flatMap((file) => modulesIn(distText(file)));
  expect(bundledModules.filter((module) => !module.startsWith('src/'))).toEqual([]);
});

test('every chunk keeps the use client directive', () => {
  const javascriptFiles = readdirSync(DIST).filter((file) => file.endsWith('.js'));
  expect(javascriptFiles.length).toBeGreaterThan(1);
  for (const file of javascriptFiles) expect(distText(file).startsWith("'use client'"), file).toBe(true);
});
