import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkApi, writeApiSnapshots } from './check-api.mjs';

async function makeRepo({
  name = '@workspacekit/demo',
  declarations = 'export declare const alpha: number;\nexport declare const beta: number;\n',
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'check-api-'));
  const packageDir = path.join(root, 'packages', 'demo');
  await mkdir(path.join(packageDir, 'dist'), { recursive: true });
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name, exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } }),
  );
  await writeFile(path.join(packageDir, 'dist', 'index.d.ts'), declarations);
  return { root, packageDir, options: { root, packages: ['demo'] } };
}

const snapshotFile = (root) => path.join(root, 'api', 'demo.txt');

test('writeApiSnapshots writes one sorted "<entry> <name>" line per export', async () => {
  const { root, options } = await makeRepo({
    declarations: 'export declare const zeta: number;\nexport declare const alpha: number;\n',
  });
  await writeApiSnapshots(options);
  assert.equal(
    await readFile(snapshotFile(root), 'utf8'),
    '@workspacekit/demo alpha\n@workspacekit/demo zeta\n',
  );
});

test('checkApi passes when the snapshot matches the built types', async () => {
  const { options } = await makeRepo();
  await writeApiSnapshots(options);
  assert.deepEqual(await checkApi(options), []);
});

test('checkApi reports an added name, naming the entry', async () => {
  const { options, packageDir } = await makeRepo();
  await writeApiSnapshots(options);
  await writeFile(
    path.join(packageDir, 'dist', 'index.d.ts'),
    'export declare const alpha: number;\nexport declare const beta: number;\nexport declare const gamma: number;\n',
  );
  const problems = await checkApi(options);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /added.*@workspacekit\/demo.*gamma/s);
  assert.match(problems[0], /pnpm api/);
});

test('checkApi reports a removed name, naming the entry', async () => {
  const { options, packageDir } = await makeRepo();
  await writeApiSnapshots(options);
  await writeFile(path.join(packageDir, 'dist', 'index.d.ts'), 'export declare const alpha: number;\n');
  const problems = await checkApi(options);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /removed.*@workspacekit\/demo.*beta/s);
});

test('checkApi reports a missing snapshot', async () => {
  const { options } = await makeRepo();
  const problems = await checkApi(options);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /api\/demo\.txt is missing/);
  assert.match(problems[0], /pnpm api/);
});

test('checkApi asks for a build when the types file is missing', async () => {
  const { options, packageDir } = await makeRepo();
  await writeApiSnapshots(options);
  await rm(path.join(packageDir, 'dist', 'index.d.ts'));
  const problems = await checkApi(options);
  assert.match(problems[0], /Build the package first/);
});

test('a snapshot that lists applyBatch fails, because core must not export it', async () => {
  const { options, root } = await makeRepo({
    name: '@workspacekit/core',
    declarations: 'export declare const createTreeStore: number;\nexport declare const applyBatch: number;\n',
  });
  await writeApiSnapshots(options);
  const problems = await checkApi(options);
  assert.ok(problems.some((problem) => /applyBatch.*not allowed|not allowed.*applyBatch/s.test(problem)));
  await writeFile(snapshotFile(root), '@workspacekit/core applyBatch\n@workspacekit/core createTreeStore\n');
  const fromSnapshot = await checkApi(options);
  assert.ok(fromSnapshot.some((problem) => problem.includes('applyBatch')));
});
