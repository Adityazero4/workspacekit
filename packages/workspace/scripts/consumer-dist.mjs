import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const WORKSPACE_PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const QUICK_START_PAGE = fileURLToPath(new URL('../test/quickstart/page.tsx', import.meta.url));
const PDFJS_DATA_DIRECTORIES = ['cmaps', 'standard_fonts', 'wasm'];
const ENTRY_ID = 'virtual:quick-start-entry';
const ENTRY_SOURCE = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import Files from './page.tsx';
createRoot(document.body).render(createElement(Files));
`;

const installedIn = (packageRoot, name) => realpathSync(join(packageRoot, 'node_modules', name));
const packageDirectory = (name) => installedIn(WORKSPACE_PACKAGE, name);

function linkInstalledPackages(app) {
  const installed = {
    '@scope/workspace': WORKSPACE_PACKAGE,
    '@scope/core': packageDirectory('@scope/core'),
    react: packageDirectory('react'),
    'react-dom': packageDirectory('react-dom'),
  };
  for (const [name, directory] of Object.entries(installed)) {
    mkdirSync(dirname(join(app, 'node_modules', name)), { recursive: true });
    symlinkSync(directory, join(app, 'node_modules', name), 'dir');
  }
}

function copyPdfjsDataInto(publicDirectory) {
  const pdfjs = installedIn(packageDirectory('@scope/pdf'), 'pdfjs-dist');
  for (const directory of PDFJS_DATA_DIRECTORIES) {
    cpSync(join(pdfjs, directory), join(publicDirectory, 'pdfjs', directory), { recursive: true });
  }
}

const quickStartEntry = {
  name: 'quick-start-entry',
  resolveId: (id) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : undefined),
  load: (id) => (id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined),
};

function filesUnder(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1));
}

function assertEmitted(outDir) {
  const files = filesUnder(outDir);
  const scripts = files.filter((file) => /\.m?js$/.test(file));
  const textOf = (file) => readFileSync(join(outDir, file), 'utf8');
  assert.ok(
    files.some((file) => /pdf\.worker\.min-[\w-]+\.mjs$/.test(file)),
    "pdf.js's worker is emitted",
  );
  assert.ok(
    scripts.some((file) => /worker-[\w-]+\.js$/.test(file) && textOf(file).includes('sharedStrings')),
    'the spreadsheet reader worker is emitted',
  );
  assert.ok(
    scripts.some((file) => /defineProperty\(Promise,\s*"withResolvers"/.test(textOf(file))),
    'the Promise.withResolvers polyfill is kept',
  );
  assert.ok(
    scripts.some((file) => textOf(file).includes("Object.defineProperty(Promise, 'withResolvers'")),
    "the worker wrapper's Promise.withResolvers polyfill is kept",
  );
  assert.deepEqual(
    scripts.filter((file) => textOf(file).includes('pdfjs-dist/legacy/build/pdf.worker')),
    [],
    "no chunk still names pdf.js's worker by package path",
  );
  return files.length;
}

const app = mkdtempSync(join(tmpdir(), 'fs-quick-start-'));
try {
  linkInstalledPackages(app);
  cpSync(QUICK_START_PAGE, join(app, 'page.tsx'));
  copyPdfjsDataInto(join(app, 'public'));
  const outDir = join(app, 'dist');
  await build({
    root: app,
    configFile: false,
    logLevel: 'error',
    plugins: [quickStartEntry],
    build: { outDir, rollupOptions: { input: ENTRY_ID } },
  });
  const emitted = assertEmitted(outDir);
  process.stdout.write(`consumer:dist: the quick start builds against dist (${emitted} files emitted)\n`);
} finally {
  rmSync(app, { recursive: true, force: true });
}
