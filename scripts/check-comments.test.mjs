import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appAndExampleTargets, checkSource, unknownNamesInExamples } from './check-comments.mjs';

const messages = (text, requireDocs = true) =>
  checkSource('src/a.ts', text, requireDocs).map((p) => p.message);

const documented = (declaration) => `/**\n * Summary.\n *\n * @example\n * use();\n */\n${declaration}`;

test('accepts JSDoc with an example on exported declarations and their members', () => {
  assert.deepEqual(messages(documented('export function a(): void {}')), []);
  assert.deepEqual(messages(documented('export interface B {\n  /** Member doc. */\n  x: number;\n}')), []);
  assert.deepEqual(
    messages(documented("export const C = {\n  /** Route doc. */\n  list: 'GET list',\n};")),
    [],
  );
});

test('rejects inline comments, block comments and JSDoc on internal declarations', () => {
  assert.equal(messages('const a = 1; // why\n', false).length, 1);
  assert.equal(messages('/* label */\nconst a = 1;\n', false).length, 1);
  assert.equal(messages('/** Internal. */\nfunction a(): void {}\n', false).length, 1);
  assert.equal(
    messages(documented('export function a(): object {\n  return {\n    /** Not API. */\n    x: 1,\n  };\n}'))
      .length,
    1,
  );
});

test('allows machine directives and ignores comment-like text in strings', () => {
  const source = [
    '/// <reference types="node" />',
    '// eslint-disable-next-line no-console -- demo',
    'const url = "https://example.com"; /* eslint-enable */',
    '// @ts-expect-error -- demo',
    'const b: number = "x";',
  ].join('\n');
  assert.deepEqual(messages(source, false), []);
});

test('requires JSDoc and an example on every exported declaration', () => {
  assert.match(messages('export const a = 1;\n')[0], /has no JSDoc/);
  assert.match(messages('/** Summary only. */\nexport type B = string;\n')[0], /has no @example/);
  assert.deepEqual(messages("export * from './x';\nexport { y } from './y';\n"), []);
});

test('requires rule names and a `-- reason` on every eslint-disable', () => {
  assert.deepEqual(
    messages('// eslint-disable-next-line no-console -- demo output\nconsole.log(1);\n', false),
    [],
  );
  assert.match(messages('// eslint-disable-next-line no-console\nconsole.log(1);\n', false)[0], /-- reason/);
  assert.match(
    messages('// eslint-disable-next-line no-console --   \nconsole.log(1);\n', false)[0],
    /-- reason/,
  );
  assert.match(messages('/* eslint-disable */\nconsole.log(1);\n', false)[0], /name the rules/);
  assert.match(messages('// eslint-disable-line -- because\n', false)[0], /name the rules/);
});

test('requires exactly one @example per export', () => {
  const twoExamples =
    '/**\n * Summary.\n *\n * @example\n * a();\n * @example\n * b();\n */\nexport function a(): void {}\n';
  assert.match(messages(twoExamples)[0], /2 @example tags; keep exactly one/);
});

test('requires JSDoc on public members of exported classes but not on private ones', () => {
  const withMembers = (members) => documented(`export class A {\n${members}\n}`);
  assert.deepEqual(messages(withMembers('  #cache = 1;\n  private secret = 2;\n  constructor() {}')), []);
  assert.match(messages(withMembers('  visible = 1;'))[0], /public member `visible` of `A` has no JSDoc/);
  assert.deepEqual(messages(withMembers('  /** Documented. */\n  visible = 1;')), []);
  assert.equal(messages(withMembers('  /** Not API. */\n  #hidden = 1;')).length, 1);
});

test('rejects create… and use… calls in an @example that no package source exports or the example defines', () => {
  const known = new Set(['httpAdapter', 'useFileSystem']);
  const withExample = (example) =>
    `/**\n * Summary.\n *\n * @example\n${example}\n */\nexport const a = 1;\n`;
  const unknown = (example) =>
    unknownNamesInExamples('src/a.ts', withExample(example), known).map((p) => p.message);
  assert.deepEqual(unknown(" * const fs = useFileSystem();\n * httpAdapter('/api/fs');"), []);
  assert.deepEqual(unknown(' * function useCounter() {}\n * useCounter();'), []);
  const definedBelow = `${withExample(' * createBucket();')}export function createBucket(): void {}\n`;
  assert.deepEqual(unknownNamesInExamples('src/a.ts', definedBelow, known), []);
  assert.deepEqual(unknown(" * <Provider adapter={createHttpAdapter({ baseUrl: '/api/fs' })} />"), [
    '@example calls `createHttpAdapter`, which no package source exports',
  ]);
});

test('rejects JSDoc lines longer than 110 columns, prose and example code alike', () => {
  const longProse = `/**\n * ${'word '.repeat(22)}too long.\n *\n * @example\n * use();\n */\nexport function a(): void {}\n`;
  assert.deepEqual(messages(longProse), ['JSDoc line is 122 columns; wrap it at 110']);
  const longExample = `/**\n * Summary.\n *\n * @example\n * use(${"'x', ".repeat(22)});\n */\nexport function a(): void {}\n`;
  assert.match(messages(longExample)[0], /^JSDoc line is \d+ columns; wrap it at 110$/);
  const exactly110 = `/**\n * ${'x'.repeat(107)}\n *\n * @example\n * use();\n */\nexport function a(): void {}\n`;
  assert.deepEqual(messages(exactly110), []);
});

test('scans example sources like app sources', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'check-comments-'));
  const file = path.join(root, 'examples', 'demo', 'src', 'index.ts');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'export const a = 1;\n');
  assert.deepEqual(await appAndExampleTargets(root), [{ file, requireDocs: true }]);
});

test('scans app sources, needing docs only outside tests and config, and skips generated folders', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'check-comments-'));
  const write = (relative) => {
    const file = path.join(root, 'apps', 'site', relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'export const a = 1;\n');
  };
  ['app/page.tsx', 'test/landing.e2e.ts', 'playwright.config.ts', '.source/server.ts', 'out/x.js'].forEach(
    write,
  );
  const found = (await appAndExampleTargets(root)).map(({ file, requireDocs }) => [
    path.relative(path.join(root, 'apps', 'site'), file),
    requireDocs,
  ]);
  assert.deepEqual(found.sort(), [
    ['app/page.tsx', true],
    ['playwright.config.ts', false],
    ['test/landing.e2e.ts', false],
  ]);
});
