// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const javascriptFiles = (): string[] => readdirSync(DIST).filter((file) => file.endsWith('.js'));
const require = createRequire(import.meta.url);
const PINNED_PDFJS: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  .dependencies['pdfjs-dist'];

test.each([
  'pdfjs-dist',
  'src/PdfDocumentView.tsx',
  'src/PdfPage.tsx',
  'src/loadDocument.ts',
  'src/linkService.ts',
  'src/PasswordPrompt.tsx',
  'src/useShownDocument.ts',
])('no pdf.js code in the entry graph: importing the entry never loads %s', (engine) => {
  expect(() => assertEngineLoadsLazily(DIST, engine)).not.toThrow();
});

test("the worker is pdf.js's own build, named by a module URL in the lazy chunk", () => {
  const workerUrls = javascriptFiles().flatMap((file) => importsOf(distText(file)).urls);
  expect(workerUrls).toEqual(['pdfjs-dist/legacy/build/pdf.worker.min.mjs']);
  expect(importsOf(distText('index.js')).urls).toEqual([]);
});

const LEGACY_CORE = 'pdfjs-dist/legacy/build/pdf.mjs';
const LEGACY_VIEWER = 'pdfjs-dist/legacy/web/pdf_viewer.mjs';

test('pdf.js core is imported before its viewer module, which reads globalThis.pdfjsLib when evaluated', () => {
  const viewerImporters = javascriptFiles().filter((file) =>
    importsOf(distText(file)).static.includes(LEGACY_VIEWER),
  );
  expect(viewerImporters.length).toBeGreaterThan(0);
  for (const file of viewerImporters) {
    const specifiers = importsOf(distText(file)).static;
    expect(specifiers.indexOf(LEGACY_CORE), file).toBeGreaterThanOrEqual(0);
    expect(specifiers.indexOf(LEGACY_CORE), file).toBeLessThan(specifiers.indexOf(LEGACY_VIEWER));
  }
});

test('only the legacy build is referenced (Ruling P4-5), so a bundle never holds two copies of pdf.js', () => {
  const pdfjsSpecifiers = javascriptFiles()
    .flatMap((file) => Object.values(importsOf(distText(file))).flat())
    .filter((specifier) => specifier === 'pdfjs-dist' || specifier.startsWith('pdfjs-dist/'));
  expect(pdfjsSpecifiers.length).toBeGreaterThan(0);
  expect(pdfjsSpecifiers.filter((specifier) => !specifier.startsWith('pdfjs-dist/legacy/'))).toEqual([]);
});

test('the worker and the API are the pinned pdf.js version, so their handshake cannot mismatch', () => {
  expect(PINNED_PDFJS).toMatch(/^\d+\.\d+\.\d+$/);
  const versionBanner = `pdfjsVersion = ${PINNED_PDFJS}`;
  for (const file of [LEGACY_CORE, 'pdfjs-dist/legacy/build/pdf.worker.min.mjs']) {
    expect(readFileSync(require.resolve(file), 'utf8'), file).toContain(versionBanner);
  }
});

test('@workspacekit/react/renderer-kit stays external: imported by specifier, none of its modules bundled', () => {
  const files = filesReachableFrom(DIST, 'index.js', { throughDynamicImports: true });
  const staticImports = filesReachableFrom(DIST, 'index.js').flatMap(
    (file) => importsOf(distText(file)).static,
  );
  expect(staticImports).toContain('@workspacekit/react/renderer-kit');
  const bundledModules = files.flatMap((file) => modulesIn(distText(file)));
  expect(bundledModules.filter((module) => !module.startsWith('src/'))).toEqual([]);
});

test('the lazy chunk installs the Promise.withResolvers polyfill by an explicit call that tree-shaking keeps', () => {
  const lazyChunks = javascriptFiles().filter((file) =>
    importsOf(distText(file)).static.includes(LEGACY_CORE),
  );
  expect(lazyChunks.length).toBeGreaterThan(0);
  for (const file of lazyChunks) {
    expect(distText(file), file).toMatch(/Object\.defineProperty\(Promise, "withResolvers"/);
    expect(distText(file), file).toMatch(/installPromiseWithResolvers\(\) \? polyfilledWorkerUrl\(/);
  }
});

test('every chunk keeps the use client directive', () => {
  expect(javascriptFiles().length).toBeGreaterThan(1);
  for (const file of javascriptFiles()) expect(distText(file).startsWith("'use client'"), file).toBe(true);
});

test("styles.css holds our parts and pdf.js's text and annotation layers, scoped, flat and in @layer fs", () => {
  const css = distText('styles.css');
  const outsideLayer = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@layer fs \{[\s\S]*\}\s*$/, '');
  expect(outsideLayer.trim()).toBe('');
  expect(css).toContain("[data-fs-part='pdf-viewer'] {");
  expect(css).toMatch(/\.textLayer \{/);
  expect(css).toMatch(/\.annotationLayer \{/);
  expect(css).toContain('--total-scale-factor');
  expect(css).not.toMatch(/:root|url\(images\//);
  expect(css).toContain('Mozilla Foundation');
  expect(() => assertNoNestedRules(css, 'dist/styles.css')).not.toThrow();
});
