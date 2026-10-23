import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'tsdown';
import {
  assertEngineLoadsLazily,
  engineReachability,
  filesReachableFrom,
  importsOf,
} from './import-graph.mjs';

const ENGINE = 'fake-engine';

// Builds `files` with tsdown as a package that depends on `fake-engine`, which tsdown keeps external. tsdown
// names `//#region` markers relative to the working directory, so it runs from the fixture as in a package.
async function builtFixture(files) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'import-graph-')));
  const manifest = { name: 'fixture', type: 'module', dependencies: { [ENGINE]: '1.0.0' } };
  for (const [relativePath, body] of Object.entries({ 'package.json': JSON.stringify(manifest), ...files })) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), body);
  }
  const outDir = path.join(root, 'dist');
  const previousDirectory = process.cwd();
  process.chdir(root);
  try {
    await build({
      config: false,
      cwd: root,
      entry: { index: path.join(root, 'src/index.ts') },
      outDir,
      format: 'esm',
      dts: false,
      fixedExtension: false,
      logLevel: 'silent',
    });
  } finally {
    process.chdir(previousDirectory);
  }
  return outDir;
}

const RENDERER_CHUNK =
  "import { render } from 'fake-engine';\nexport default (text: string) => render(text);\n";

test('detects an engine imported statically through a shared module', async () => {
  const dist = await builtFixture({
    'src/index.ts': "export { show } from './helpers';\n",
    'src/helpers.ts':
      "import { render } from 'fake-engine';\nexport const show = (text: string) => render(text);\n",
  });
  const reachability = engineReachability(dist, ENGINE);
  assert.deepEqual(reachability.staticallyImportedBy, ['index.js']);
  assert.throws(
    () => assertEngineLoadsLazily(dist, ENGINE),
    /fake-engine is imported statically by index\.js/,
  );
});

test('passes an engine reached only through a dynamic import()', async () => {
  const dist = await builtFixture({
    'src/index.ts': "export const load = () => import('./Renderer');\n",
    'src/Renderer.ts': RENDERER_CHUNK,
  });
  assert.deepEqual(engineReachability(dist, ENGINE), { staticallyImportedBy: [], isReached: true });
  assert.doesNotThrow(() => assertEngineLoadsLazily(dist, ENGINE));
});

test('a source module counts as the engine by its region marker', async () => {
  const dist = await builtFixture({
    'src/index.ts': "export { default as render } from './Renderer';\n",
    'src/Renderer.ts': 'export default (text: string) => text.toUpperCase();\n',
  });
  assert.throws(
    () => assertEngineLoadsLazily(dist, 'src/Renderer.ts'),
    /src\/Renderer\.ts is imported statically by index\.js/,
  );
});

test('fails when the engine is never reached, so a misspelled engine name cannot pass', async () => {
  const dist = await builtFixture({
    'src/index.ts': "export const load = () => import('./Renderer');\n",
    'src/Renderer.ts': RENDERER_CHUNK,
  });
  assert.throws(() => assertEngineLoadsLazily(dist, 'fake-engin'), /fake-engin is never imported/);
});

test('reads an import that follows a one-line block comment, and skips commented-out imports', () => {
  const code = [
    "/* @__PURE__ */ import { render } from 'fake-engine';",
    "/*#__PURE__*/ import 'side-effect';",
    "// import { old } from 'commented-out';",
    " * import { documented } from 'in-a-jsdoc';",
    "export const load = () => /* chunk */ import('./Renderer.js');",
  ].join('\n');
  assert.deepEqual(importsOf(code), {
    static: ['fake-engine', 'side-effect'],
    dynamic: ['./Renderer.js'],
    urls: [],
  });
});

test('reads module URLs: new URL(…, import.meta.url), bare or wrapped in new Worker', () => {
  const code = [
    "const workerSrc = new URL('fake-engine/worker.mjs', import.meta.url).href;",
    "const worker = new Worker(new URL( './reader.js' , import.meta.url ), { type: 'module' });",
    "const page = new URL('./not-a-module-url.html', location.href);",
  ].join('\n');
  assert.deepEqual(importsOf(code).urls, ['fake-engine/worker.mjs', './reader.js']);
});

const WORKER_URL_CHUNK =
  "export const workerUrl = () => new URL('fake-engine/worker.mjs', import.meta.url).href;\n";

test("an engine's worker URL in the entry graph counts as a static load", async () => {
  const dist = await builtFixture({
    'src/index.ts': "export { workerUrl } from './worker';\n",
    'src/worker.ts': WORKER_URL_CHUNK,
  });
  assert.throws(
    () => assertEngineLoadsLazily(dist, ENGINE),
    /fake-engine is imported statically by index\.js/,
  );
});

test("an engine's worker URL reached only through import() passes", async () => {
  const dist = await builtFixture({
    'src/index.ts': "export const load = () => import('./worker');\n",
    'src/worker.ts': WORKER_URL_CHUNK,
  });
  assert.deepEqual(engineReachability(dist, ENGINE), { staticallyImportedBy: [], isReached: true });
});

test('a worker chunk started from a module URL is followed only through dynamic imports', async () => {
  const dist = await builtFixture({
    'src/index.ts': "export const start = () => new Worker(new URL('./reader.js', import.meta.url));\n",
  });
  await writeFile(path.join(dist, 'reader.js'), "import 'fake-engine';\n");
  assert.deepEqual(filesReachableFrom(dist, 'index.js'), ['index.js']);
  assert.deepEqual(filesReachableFrom(dist, 'index.js', { throughDynamicImports: true }), [
    'index.js',
    'reader.js',
  ]);
  assert.doesNotThrow(() => assertEngineLoadsLazily(dist, ENGINE));
});
